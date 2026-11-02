import { randomUUID } from "node:crypto";
import { QUEUES } from "@ai-triage/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  advanceDocument,
  buildPipelineConfig,
  createBoss,
  createPool,
  failRun,
  findReusableAttempt,
  ingestDocument,
  insertAttempt,
  insertModelExtraction,
  type LlmCallContext,
  markCanonical,
  type NewLlmAttempt,
  type PgBoss,
  setCurrentExtraction,
  stageJobId,
  upsertOpenTask,
  withTenantTx,
} from "./index";
import { documents, processingRuns, reviewTasks } from "./schema";
import { newTenant, testDbUrls } from "./testing";

const { appUrl } = testDbUrls();
const app = createPool(appUrl);
let boss: PgBoss;
let tenantId: string;

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  tenantId = await newTenant(app);
  await withTenantTx(app, tenantId, (tx) => buildPipelineConfig(tx));
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await app.end();
});

const ingest = (externalId = randomUUID()) =>
  withTenantTx(app, tenantId, (tx) =>
    ingestDocument(tx, boss, { source: "api", externalId, sourceKey: `t/${tenantId}/a/${externalId}`, title: "t" }),
  );

const docRow = (documentId: string) =>
  withTenantTx(
    app,
    tenantId,
    async ({ db }) => (await db.select().from(documents).where(eq(documents.id, documentId)))[0],
  );

describe("ingestDocument", () => {
  it("creates the document, run #1 and a parse job with a deterministic id; a duplicate is a no-op", async () => {
    const externalId = randomUUID();
    const first = await ingest(externalId);
    expect(first.duplicate).toBe(false);
    const doc = await docRow(first.documentId);
    expect(doc).toMatchObject({ processingStatus: "received", reviewStatus: "not_required", deliveryStatus: "none" });
    const runId = doc?.currentRunId ?? "";
    expect(await boss.getJobById(QUEUES.parse, stageJobId(runId, "parse"))).toMatchObject({
      data: { tenantId, documentId: first.documentId, runId },
    });

    const again = await ingest(externalId);
    expect(again).toEqual({ documentId: first.documentId, duplicate: true });
    const runs = await withTenantTx(app, tenantId, ({ db }) =>
      db.select().from(processingRuns).where(eq(processingRuns.documentId, first.documentId)),
    );
    expect(runs).toHaveLength(1);
  });

  it("refuses a tenant without an active config", async () => {
    const other = await newTenant(app);
    await expect(
      withTenantTx(app, other, (tx) => ingestDocument(tx, boss, { source: "api", externalId: "x", sourceKey: "k" })),
    ).rejects.toThrow("no active pipeline config");
  });
});

describe("stage guards", () => {
  it("advances only from the expected status of the current run", async () => {
    const { documentId } = await ingest();
    const runId = (await docRow(documentId))?.currentRunId ?? "";
    const advance = (from: "received" | "parsed", run = runId) =>
      withTenantTx(app, tenantId, (tx) => advanceDocument(tx, { documentId, runId: run, from, to: "parsed" }));
    expect(await advance("parsed")).toBe(false); // wrong status
    expect(await advance("received", randomUUID())).toBe(false); // stale run
    expect(await advance("received")).toBe(true);
    expect(await advance("received")).toBe(false); // duplicate job
  });

  it("fails a run only from the status the failing stage expected", async () => {
    const { documentId } = await ingest();
    const runId = (await docRow(documentId))?.currentRunId ?? "";
    const fail = (expectedStatus: "parsed" | "received") =>
      withTenantTx(app, tenantId, (tx) =>
        failRun(tx, { runId, expectedStatus, reason: "parse_error", message: "bad" }),
      );
    expect(await fail("parsed")).toBe(false);
    expect(await docRow(documentId)).toMatchObject({ processingStatus: "received" });

    expect(await fail("received")).toBe(true);
    expect(await docRow(documentId)).toMatchObject({ processingStatus: "failed", reviewStatus: "pending" });
    const tasks = await withTenantTx(app, tenantId, ({ db }) =>
      db.select().from(reviewTasks).where(eq(reviewTasks.documentId, documentId)),
    );
    expect(tasks).toMatchObject([{ kind: "processing_failed", status: "pending", reasons: ["parse_error"] }]);
    const run = await withTenantTx(app, tenantId, ({ db }) =>
      db.select().from(processingRuns).where(eq(processingRuns.id, runId)),
    );
    expect(run[0]).toMatchObject({ status: "failed", error: "parse_error: bad" });
  });
});

describe("extractions and tasks", () => {
  it("numbers revisions per document and reopens a claimed task with its claim cleared", async () => {
    const { documentId } = await ingest();
    const runId = (await docRow(documentId))?.currentRunId ?? "";
    const result = await withTenantTx(app, tenantId, async (tx) => {
      const [schema] = await tx.db.query.categorySchemaVersions.findMany({ limit: 1 });
      const extraction = await insertModelExtraction(tx, {
        documentId,
        runId,
        category: schema?.category ?? "",
        schemaVersionId: schema?.id ?? "",
        fields: {},
        validationErrors: [],
      });
      await setCurrentExtraction(tx, documentId, extraction.id);
      const taskId = await upsertOpenTask(tx, {
        documentId,
        kind: "review",
        extractionId: extraction.id,
        reasons: ["a"],
      });
      return { extraction, taskId };
    });
    expect(result.extraction.revision).toBe(1);

    // Claim it (as a seeded user), then reopen it as an audit task.
    await withTenantTx(app, tenantId, async (tx) => {
      const [user] = await tx.db.query.users.findMany({ limit: 1 });
      await tx.db
        .update(reviewTasks)
        .set({ status: "claimed", claimToken: randomUUID(), claimedBy: user?.id, leaseExpiresAt: new Date() })
        .where(eq(reviewTasks.id, result.taskId));
      const reopened = await upsertOpenTask(tx, {
        documentId,
        kind: "audit",
        extractionId: result.extraction.id,
        reasons: ["b"],
      });
      expect(reopened).toBe(result.taskId);
    });
    const [task] = await withTenantTx(app, tenantId, ({ db }) =>
      db.select().from(reviewTasks).where(eq(reviewTasks.id, result.taskId)),
    );
    expect(task).toMatchObject({
      kind: "audit",
      status: "pending",
      reasons: ["b"],
      claimToken: null,
      claimedBy: null,
      leaseExpiresAt: null,
    });
  });
});

describe("llm attempts", () => {
  const attempt = (overrides: Partial<NewLlmAttempt> = {}): NewLlmAttempt => ({
    stage: "classify",
    mode: "replay",
    model: "claude-opus-5-5",
    effort: "low",
    requestHash: "h",
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: 0.0001,
    priceId: null,
    latencyMs: 100,
    stopReason: "end_turn",
    servedByFallback: false,
    requestId: "req_1",
    response: { content: [] },
    error: null,
    ...overrides,
  });

  it("keeps every racing attempt, reuses the latest success, and marks one canonical", async () => {
    const { documentId } = await ingest();
    const runId = (await docRow(documentId))?.currentRunId ?? "";
    const ctx: LlmCallContext = { runId };
    const rows = await Promise.all(Array.from({ length: 4 }, () => insertAttempt(app, tenantId, ctx, attempt())));
    expect(rows.map((r) => r.attempt).sort()).toEqual([1, 2, 3, 4]);

    await insertAttempt(app, tenantId, ctx, attempt({ response: null, error: "overloaded" }));
    const reusable = await withTenantTx(app, tenantId, (tx) => findReusableAttempt(tx, ctx, "classify"));
    expect(reusable?.attempt).toBe(4);
    expect(await withTenantTx(app, tenantId, (tx) => findReusableAttempt(tx, ctx, "extract"))).toBeNull();

    expect(
      await withTenantTx(app, tenantId, (tx) => markCanonical(tx, { id: rows[0]?.id ?? "", ctx, stage: "extract" })),
    ).toBe(false);
    expect(
      await withTenantTx(app, tenantId, (tx) => markCanonical(tx, { id: rows[0]?.id ?? "", ctx, stage: "classify" })),
    ).toBe(true);
  });
});
