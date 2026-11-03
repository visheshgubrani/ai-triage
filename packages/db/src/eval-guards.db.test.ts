import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfigVersion, freezeConfig } from "./configs";
import { createPool, withTenantTx } from "./index";
import { evalDatasets, evalItems, evalResults, evalRuns } from "./schema";
import type { TenantTx } from "./tenant-tx";
import { expectPgError, insertConfigFixture, newTenant, PG, testDbUrls } from "./testing";

// Eval guards (0008_eval_guards.sql): labels, results and finished runs can't be rewritten, and
// test-split runs need a frozen config (docs/architecture.md §8, §10).

const { appUrl } = testDbUrls();
const app = createPool(appUrl);
afterAll(() => app.end());

let tenantId: string;
let datasetId: string;
let configId: string;
const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenantTx(app, tenantId, fn);

beforeAll(async () => {
  tenantId = await newTenant(app);
  ({ datasetId, configId } = await inTenant(async (tx) => {
    const { input } = await insertConfigFixture(tx);
    const config = await createConfigVersion(tx, input);
    const [dataset] = await tx.db.insert(evalDatasets).values({ tenantId, name: "Main" }).returning();
    return { datasetId: dataset?.id ?? "", configId: config.id };
  }));
});

const item = (overrides: Partial<typeof evalItems.$inferInsert> = {}) =>
  inTenant(async ({ db }) => {
    const [row] = await db
      .insert(evalItems)
      .values({
        tenantId,
        datasetId,
        sourceKey: `t/${tenantId}/x/${randomUUID()}/source`,
        sourceMime: "application/pdf",
        contentKey: `sha256:${randomUUID()}`,
        expectedCategory: "invoice",
        split: "dev",
        origin: "seed",
        ...overrides,
      })
      .returning();
    if (!row) throw new Error("no item");
    return row;
  });

const run = (overrides: Partial<typeof evalRuns.$inferInsert> = {}) =>
  inTenant(async ({ db }) => {
    const [row] = await db
      .insert(evalRuns)
      .values({ tenantId, datasetId, configId, split: "dev", llmMode: "replay", itemCount: 1, ...overrides })
      .returning();
    if (!row) throw new Error("no run");
    return row;
  });

describe("eval_items", () => {
  it("can't be edited or deleted, only retired once", async () => {
    const { id } = await item();
    await expectPgError(
      inTenant(({ db }) => db.update(evalItems).set({ expectedCategory: "contract" }).where(eq(evalItems.id, id))),
      PG.integrityViolation,
    );
    await expectPgError(
      inTenant(({ db }) => db.delete(evalItems).where(eq(evalItems.id, id))),
      PG.integrityViolation,
    );
    await inTenant(({ db }) => db.update(evalItems).set({ retiredAt: new Date() }).where(eq(evalItems.id, id)));
    await expectPgError(
      inTenant(({ db }) => db.update(evalItems).set({ retiredAt: new Date() }).where(eq(evalItems.id, id))),
      PG.integrityViolation,
    );
  });

  it("holds the same content once per dataset, unless the earlier item is retired", async () => {
    const contentKey = `sha256:${randomUUID()}`;
    const first = await item({ contentKey });
    await expectPgError(item({ contentKey, split: "calib" }), PG.uniqueViolation);
    await inTenant(({ db }) => db.update(evalItems).set({ retiredAt: new Date() }).where(eq(evalItems.id, first.id)));
    await expect(item({ contentKey, split: "calib" })).resolves.toMatchObject({ contentKey });
  });
});

describe("eval_runs", () => {
  it("refuses a test-split run on an unfrozen config", async () => {
    await expectPgError(run({ split: "test" }), PG.integrityViolation);
    const frozen = await inTenant(async (tx) => {
      const { input } = await insertConfigFixture(tx);
      const config = await createConfigVersion(tx, input);
      await freezeConfig(tx, config.id);
      return config;
    });
    await expect(run({ split: "test", configId: frozen.id })).resolves.toMatchObject({ split: "test" });
  });

  it("records progress while active, and nothing once finished", async () => {
    const { id } = await run();
    await expectPgError(
      inTenant(({ db }) => db.update(evalRuns).set({ split: "calib" }).where(eq(evalRuns.id, id))),
      PG.integrityViolation,
    );
    await inTenant(({ db }) =>
      db
        .update(evalRuns)
        .set({ status: "done", startedAt: new Date(), finishedAt: new Date(), aggregates: { n: 1 } })
        .where(eq(evalRuns.id, id)),
    );
    await expectPgError(
      inTenant(({ db }) =>
        db
          .update(evalRuns)
          .set({ aggregates: { n: 2 } })
          .where(eq(evalRuns.id, id)),
      ),
      PG.integrityViolation,
    );
    await expectPgError(
      inTenant(({ db }) => db.delete(evalRuns).where(eq(evalRuns.id, id))),
      PG.integrityViolation,
    );
  });

  it("needs at least one item", async () => {
    await expectPgError(run({ itemCount: 0 }), PG.checkViolation);
  });
});

describe("eval_results", () => {
  it("is insert-only, with an error reason exactly when there is an error", async () => {
    const [{ id: evalItemId }, { id: evalRunId }] = await Promise.all([item(), run()]);
    const grades = { categoryCorrect: false, requiredCorrect: false, fullyCorrect: false };
    await expectPgError(
      inTenant(({ db }) =>
        db.insert(evalResults).values({ tenantId, evalRunId, evalItemId, ...grades, error: "boom" }),
      ),
      PG.checkViolation,
    );
    const [result] = await inTenant(({ db }) =>
      db
        .insert(evalResults)
        .values({ tenantId, evalRunId, evalItemId, ...grades, error: "no cassette", errorReason: "cassette_missing" })
        .returning(),
    );
    await expectPgError(
      inTenant(({ db }) =>
        db
          .update(evalResults)
          .set({ categoryCorrect: true })
          .where(eq(evalResults.id, result?.id ?? "")),
      ),
      PG.integrityViolation,
    );
    await expectPgError(
      inTenant(({ db }) => db.delete(evalResults).where(eq(evalResults.id, result?.id ?? ""))),
      PG.integrityViolation,
    );
  });
});

describe("row-level security on eval tables", () => {
  it("hides another tenant's datasets, items and runs", async () => {
    const [{ id: itemId }, { id: runId }] = await Promise.all([item(), run()]);
    const other = await newTenant(app);
    const seen = await withTenantTx(app, other, async ({ db }) => ({
      datasets: await db.select().from(evalDatasets).where(eq(evalDatasets.id, datasetId)),
      items: await db.select().from(evalItems).where(eq(evalItems.id, itemId)),
      runs: await db.select().from(evalRuns).where(eq(evalRuns.id, runId)),
    }));
    expect(seen).toEqual({ datasets: [], items: [], runs: [] });
  });
});
