import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createConfigVersion } from "./configs";
import { createPool, withTenantTx } from "./index";
import {
  actions,
  evalDatasets,
  evalItems,
  evalRuns,
  extractions,
  llmCalls,
  processingRuns,
  reviewTasks,
} from "./schema";
import type { TenantTx } from "./tenant-tx";
import { expectPgError, insertConfigFixture, insertDocument, newTenant, PG, testDbUrls, testUser } from "./testing";

// Database-level guarantees from docs/architecture.md §4/§10 that don't depend on app code.

const { appUrl } = testDbUrls();
const app = createPool(appUrl);
afterAll(() => app.end());

let tenantId: string;
let ids: {
  configId: string;
  documentId: string;
  runId: string;
  schemaVersionId: string;
  evalRunId: string;
  evalItemId: string;
};

beforeAll(async () => {
  tenantId = await newTenant(app);
  ids = await withTenantTx(app, tenantId, async (tx) => {
    const { input, schemas } = await insertConfigFixture(tx);
    const config = await createConfigVersion(tx, input);
    const doc = await insertDocument(tx);
    const [run] = await tx.db
      .insert(processingRuns)
      .values({ tenantId, documentId: doc.id, configId: config.id, trigger: "ingest" })
      .returning();
    const [dataset] = await tx.db
      .insert(evalDatasets)
      .values({ tenantId, name: `ds-${randomUUID()}` })
      .returning();
    const [item] = await tx.db
      .insert(evalItems)
      .values({
        tenantId,
        datasetId: dataset?.id ?? "",
        sourceKey: "k",
        sourceMime: "application/pdf",
        contentKey: `sha256:${randomUUID()}`,
        expectedCategory: "invoice",
        split: "dev",
        origin: "seed",
      })
      .returning();
    const [evalRun] = await tx.db
      .insert(evalRuns)
      .values({
        tenantId,
        datasetId: dataset?.id ?? "",
        configId: config.id,
        split: "dev",
        llmMode: "replay",
        itemCount: 1,
      })
      .returning();
    return {
      configId: config.id,
      documentId: doc.id,
      runId: run?.id ?? "",
      schemaVersionId: schemas[0]?.id ?? "",
      evalRunId: evalRun?.id ?? "",
      evalItemId: item?.id ?? "",
    };
  });
});

const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenantTx(app, tenantId, fn);

const call = (overrides: Partial<typeof llmCalls.$inferInsert>): typeof llmCalls.$inferInsert => ({
  tenantId,
  stage: "classify",
  attempt: 1,
  mode: "replay",
  model: "claude-opus-5-5",
  effort: "low",
  requestHash: randomUUID(),
  ...overrides,
});

describe("llm_calls", () => {
  it("requires exactly one execution context", async () => {
    await expectPgError(
      inTenant(({ db }) => db.insert(llmCalls).values(call({}))),
      PG.checkViolation,
    );
    await expectPgError(
      inTenant(({ db }) =>
        db
          .insert(llmCalls)
          .values(call({ processingRunId: ids.runId, evalRunId: ids.evalRunId, evalItemId: ids.evalItemId })),
      ),
      PG.checkViolation,
    );
    await expectPgError(
      inTenant(({ db }) => db.insert(llmCalls).values(call({ evalRunId: ids.evalRunId }))),
      PG.checkViolation,
    );
    // Each valid context on its own is fine.
    await inTenant(({ db }) =>
      db
        .insert(llmCalls)
        .values([
          call({ processingRunId: ids.runId, stage: "extract", attempt: 9 }),
          call({ evalRunId: ids.evalRunId, evalItemId: ids.evalItemId, attempt: 9 }),
        ]),
    );
  });

  it("allows many attempts but only one canonical per context and stage", async () => {
    await inTenant(({ db }) =>
      db
        .insert(llmCalls)
        .values([
          call({ processingRunId: ids.runId, attempt: 1, canonical: true }),
          call({ processingRunId: ids.runId, attempt: 2 }),
        ]),
    );
    await expectPgError(
      inTenant(({ db }) =>
        db.insert(llmCalls).values(call({ processingRunId: ids.runId, attempt: 3, canonical: true })),
      ),
      PG.uniqueViolation,
    );
  });
});

describe("review_tasks", () => {
  it("requires an extraction for review and audit tasks", async () => {
    await expectPgError(
      inTenant(({ db }) => db.insert(reviewTasks).values({ tenantId, documentId: ids.documentId, kind: "review" })),
      PG.checkViolation,
    );
  });

  it("allows only one open task per document", async () => {
    const documentId = await inTenant(async (tx) => (await insertDocument(tx)).id);
    await inTenant(({ db }) => db.insert(reviewTasks).values({ tenantId, documentId, kind: "processing_failed" }));
    await expectPgError(
      inTenant(({ db }) => db.insert(reviewTasks).values({ tenantId, documentId, kind: "unclassified" })),
      PG.uniqueViolation,
    );
  });

  it("keeps a claim all-or-nothing", async () => {
    const documentId = await inTenant(async (tx) => (await insertDocument(tx)).id);
    await expectPgError(
      inTenant(({ db }) =>
        db.insert(reviewTasks).values({ tenantId, documentId, kind: "processing_failed", status: "claimed" }),
      ),
      PG.checkViolation,
    );
  });
});

describe("actions", () => {
  it("can't exist without a document, so evals can't create one", async () => {
    const extractionId = await inTenant(async ({ db }) => {
      const [extraction] = await db
        .insert(extractions)
        .values({
          tenantId,
          documentId: ids.documentId,
          revision: 1,
          author: "user",
          createdBy: await testUser(app),
          category: "invoice",
          schemaVersionId: ids.schemaVersionId,
          fields: {},
        })
        .returning();
      return extraction?.id ?? "";
    });
    await expectPgError(
      inTenant(({ db }) =>
        db.insert(actions).values({ tenantId, extractionId, payload: {} } as typeof actions.$inferInsert),
      ),
      PG.notNullViolation,
    );
    // With its document it's accepted, and only once per extraction.
    await inTenant(({ db }) =>
      db.insert(actions).values({ tenantId, documentId: ids.documentId, extractionId, payload: {} }),
    );
    await expectPgError(
      inTenant(({ db }) =>
        db.insert(actions).values({ tenantId, documentId: ids.documentId, extractionId, payload: {} }),
      ),
      PG.uniqueViolation,
    );
  });
});
