import { randomUUID } from "node:crypto";
import { MIN_CALIB_ITEMS, QUEUES } from "@ai-triage/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss, type PgBoss } from "./boss";
import { createCandidateConfig, getConfig } from "./configs";
import {
  activateConfig,
  commitEvalResult,
  createEvalRun,
  EvalRequestError,
  freezeCalibratedConfig,
  getOrCreateDataset,
  insertEvalItem,
  type NewEvalResult,
} from "./evals";
import { createPool, withTenantTx } from "./index";
import { productionMetrics } from "./metrics";
import { buildPipelineConfig } from "./pipeline-config";
import { insertDecision } from "./review";
import { evalRuns, llmCalls, reviewTasks } from "./schema";
import type { TenantTx } from "./tenant-tx";
import { newTenant, seedReviewTask, testDbUrls, testUser } from "./testing";

// The eval data layer (docs/architecture.md §8, §10): runs and their jobs commit together, the last
// item finishes the run exactly once, duplicates change nothing, and Freeze makes a frozen child.

const { appUrl } = testDbUrls();
const pool = createPool(appUrl);
let boss: PgBoss;
beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await pool.end();
});

async function setup(items = 3) {
  const tenantId = await newTenant(pool);
  const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenantTx(pool, tenantId, fn);
  const { configId, datasetId, itemIds } = await inTenant(async (tx) => {
    const config = await buildPipelineConfig(tx);
    const dataset = await getOrCreateDataset(tx);
    const itemIds: string[] = [];
    for (let i = 0; i < items; i++) {
      const { id } = await insertEvalItem(tx, {
        datasetId: dataset.id,
        source: { sourceKey: `k${i}`, sourceMime: "application/pdf", sourceTitle: null, contentKey: randomUUID() },
        expectedCategory: "invoice",
        expectedFields: {},
        split: i === 0 ? "calib" : "dev",
        origin: "seed",
      });
      itemIds.push(id);
    }
    return { configId: config.id, datasetId: dataset.id, itemIds };
  });
  return { tenantId, inTenant, configId, datasetId, itemIds };
}

const jobsOf = async (runId: string) => {
  const { rows } = await pool.query("select data from pgboss.job where name = $1 and data->>'evalRunId' = $2", [
    QUEUES.evalItem,
    runId,
  ]);
  return rows.map((r) => r.data as { evalItemId: string });
};

const refused = async (promise: Promise<unknown>, code: string) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EvalRequestError);
  expect((err as EvalRequestError).code).toBe(code);
};

function result(runId: string, itemId: string, overrides: Partial<NewEvalResult> = {}): NewEvalResult {
  return {
    evalRunId: runId,
    evalItemId: itemId,
    predictedCategory: "invoice",
    predictedFields: {},
    score: 0.95,
    decision: "auto",
    reasons: [],
    gateResults: null,
    grade: { categoryCorrect: true, requiredCorrect: true, fullyCorrect: true, fieldScores: {} },
    proposedAction: null,
    classifyCallId: null,
    extractCallId: null,
    error: null,
    ...overrides,
  };
}

const attempt = (tx: TenantTx, runId: string, itemId: string, stage: "classify" | "extract", attemptNo = 1) =>
  tx.db
    .insert(llmCalls)
    .values({
      tenantId: tx.tenantId,
      evalRunId: runId,
      evalItemId: itemId,
      stage,
      attempt: attemptNo,
      mode: "replay",
      model: "openai:gpt-6.1-terra",
      effort: "low",
      requestHash: randomUUID(),
      costUsd: "0.001000",
      latencyMs: 1000,
    })
    .returning({ id: llmCalls.id })
    .then((rows) => rows[0]?.id ?? "");

describe("createEvalRun", () => {
  it("enqueues one job per active item of the split, with the run", async () => {
    const s = await setup(3);
    const { runId, itemCount } = await s.inTenant((tx) =>
      createEvalRun(tx, boss, { datasetId: s.datasetId, split: "dev", configId: s.configId, llmMode: "replay" }),
    );
    expect(itemCount).toBe(2);
    expect((await jobsOf(runId)).map((j) => j.evalItemId).sort()).toEqual(s.itemIds.slice(1).sort());
  });

  it("leaves neither run nor jobs when the transaction rolls back", async () => {
    const s = await setup(2);
    let runId = "";
    await expect(
      s.inTenant(async (tx) => {
        ({ runId } = await createEvalRun(tx, boss, {
          datasetId: s.datasetId,
          split: "dev",
          configId: s.configId,
          llmMode: "replay",
        }));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await jobsOf(runId)).toEqual([]);
    expect(await s.inTenant(({ db }) => db.select().from(evalRuns).where(eq(evalRuns.id, runId)))).toEqual([]);
  });

  it("refuses test runs on an unfrozen config, and empty splits", async () => {
    const s = await setup(1);
    await refused(
      s.inTenant((tx) =>
        createEvalRun(tx, boss, { datasetId: s.datasetId, split: "test", configId: s.configId, llmMode: "replay" }),
      ),
      "config_not_frozen",
    );
    await refused(
      s.inTenant((tx) =>
        createEvalRun(tx, boss, { datasetId: s.datasetId, split: "dev", configId: s.configId, llmMode: "replay" }),
      ),
      "empty_split",
    );
  });
});

describe("insertEvalItem", () => {
  it("returns the existing item for content already in the dataset", async () => {
    const s = await setup(0);
    const source = { sourceKey: "a", sourceMime: "application/pdf", sourceTitle: "a.pdf", contentKey: "sha256:x" };
    const base = {
      datasetId: s.datasetId,
      source,
      expectedCategory: "invoice",
      expectedFields: {},
      origin: "seed" as const,
    };
    const first = await s.inTenant((tx) => insertEvalItem(tx, { ...base, split: "dev" }));
    const again = await s.inTenant((tx) =>
      insertEvalItem(tx, { ...base, split: "test", source: { ...source, sourceKey: "b" } }),
    );
    expect(again).toEqual({ id: first.id, split: "dev", duplicate: true });
  });
});

describe("commitEvalResult", () => {
  it("finishes the run exactly once when concurrent commits complete it", async () => {
    const s = await setup(6);
    const { runId } = await s.inTenant((tx) =>
      createEvalRun(tx, boss, { datasetId: s.datasetId, split: "dev", configId: s.configId, llmMode: "replay" }),
    );
    const items = s.itemIds.slice(1);
    const calls = await s.inTenant(async (tx) => {
      const out: { id: string; classify: string }[] = [];
      for (const id of items) out.push({ id, classify: await attempt(tx, runId, id, "classify") });
      return out;
    });
    const outcomes = await Promise.all(
      calls.map((c) => s.inTenant((tx) => commitEvalResult(tx, result(runId, c.id, { classifyCallId: c.classify })))),
    );
    expect(outcomes.filter((o) => o.inserted)).toHaveLength(5);
    expect(outcomes.filter((o) => o.finished)).toHaveLength(1);
    const [run] = await s.inTenant(({ db }) => db.select().from(evalRuns).where(eq(evalRuns.id, runId)));
    expect(run).toMatchObject({ status: "done", aggregates: { n: 5, errors: 0 } });
    expect((run?.aggregates as { totalUsd?: number } | undefined)?.totalUsd).toBeCloseTo(0.005);
  });

  it("ignores a duplicate result and leaves its attempt non-canonical", async () => {
    const s = await setup(3);
    const { runId } = await s.inTenant((tx) =>
      createEvalRun(tx, boss, { datasetId: s.datasetId, split: "dev", configId: s.configId, llmMode: "replay" }),
    );
    const item = s.itemIds[1] ?? "";
    const [first, second] = await s.inTenant(async (tx) => [
      await attempt(tx, runId, item, "classify", 1),
      await attempt(tx, runId, item, "classify", 2),
    ]);
    expect(await s.inTenant((tx) => commitEvalResult(tx, result(runId, item, { classifyCallId: first })))).toEqual({
      inserted: true,
      finished: false,
    });
    expect(await s.inTenant((tx) => commitEvalResult(tx, result(runId, item, { classifyCallId: second })))).toEqual({
      inserted: false,
      finished: false,
    });
    const canonical = await s.inTenant(({ db }) =>
      db
        .select({ id: llmCalls.id })
        .from(llmCalls)
        .where(and(eq(llmCalls.evalRunId, runId), eq(llmCalls.canonical, true))),
    );
    expect(canonical).toEqual([{ id: first }]);
  });
});

describe("freeze and activate", () => {
  it("freezes a finished calib run's config as a child with the chosen thresholds", async () => {
    const s = await setup(1);
    const { runId } = await s.inTenant((tx) =>
      createEvalRun(tx, boss, { datasetId: s.datasetId, split: "calib", configId: s.configId, llmMode: "replay" }),
    );
    const change = { category: "invoice", threshold: 0.8, automation: "auto_when_confident" as const, auditRate: 0.2 };
    await refused(
      s.inTenant((tx) => freezeCalibratedConfig(tx, { runId, name: "Frozen", categories: [change] })),
      "run_not_done",
    );
    await s.inTenant((tx) => commitEvalResult(tx, result(runId, s.itemIds[0] ?? "")));
    // One calib invoice is too few to set a threshold on.
    await refused(
      s.inTenant((tx) => freezeCalibratedConfig(tx, { runId, name: "Frozen", categories: [change] })),
      "too_few_calib_items",
    );
    await s.inTenant(async (tx) => {
      for (let i = 0; i < MIN_CALIB_ITEMS - 1; i++) {
        await insertEvalItem(tx, {
          datasetId: s.datasetId,
          source: { sourceKey: `more${i}`, sourceMime: "application/pdf", sourceTitle: null, contentKey: randomUUID() },
          expectedCategory: "invoice",
          expectedFields: {},
          split: "calib",
          origin: "seed",
        });
      }
    });

    const frozen = await s.inTenant((tx) =>
      freezeCalibratedConfig(tx, { runId, name: "Frozen", categories: [change] }),
    );
    const parent = await s.inTenant((tx) => getConfig(tx, s.configId));
    expect(frozen.frozenAt).toBeInstanceOf(Date);
    expect(frozen).toMatchObject({
      parentId: s.configId,
      classifyModel: parent?.classifyModel,
      extractPromptVersionId: parent?.extractPromptVersionId,
      policy: parent?.policy,
    });
    expect(frozen.categories.map((c) => c.category).sort()).toEqual(parent?.categories.map((c) => c.category).sort());
    expect(frozen.categories.find((c) => c.category === "invoice")).toMatchObject({
      threshold: 0.8,
      automation: "auto_when_confident",
      auditRate: 0.2,
    });

    // An unfrozen version that auto-approves can't be activated; one that reviews everything can.
    const unfrozen = await s.inTenant((tx) =>
      createCandidateConfig(tx, { parentId: s.configId, name: "Uncalibrated", categories: [change] }),
    );
    await refused(
      s.inTenant((tx) => activateConfig(tx, unfrozen.id)),
      "config_not_frozen",
    );
    await s.inTenant((tx) => activateConfig(tx, s.configId));
    await s.inTenant((tx) => activateConfig(tx, frozen.id));
  });

  it("only freezes from calib runs", async () => {
    const s = await setup(2);
    const { runId } = await s.inTenant((tx) =>
      createEvalRun(tx, boss, { datasetId: s.datasetId, split: "dev", configId: s.configId, llmMode: "replay" }),
    );
    await refused(
      s.inTenant((tx) => freezeCalibratedConfig(tx, { runId, name: "x", categories: [] })),
      "not_calib_run",
    );
  });
});

describe("productionMetrics", () => {
  it("weights audited auto-approvals and counts a required-field edit as wrong", async () => {
    const s = await setup(0);
    const reviewer = await testUser(pool);
    const window = { since: new Date(Date.now() - 60_000), until: new Date(Date.now() + 60_000) };
    await s.inTenant(async (tx) => {
      for (const outcome of ["approve", "edit_approve", "reclassify"] as const) {
        const seeded = await seedReviewTask(tx, { kind: "audit" });
        const [task] = await tx.db.select().from(reviewTasks).where(eq(reviewTasks.id, seeded.taskId));
        if (!task) throw new Error("no task");
        await insertDecision(tx, {
          task,
          reviewerId: reviewer,
          outcome,
          extractionId: seeded.extractionId,
          diff: outcome === "edit_approve" ? [{ field: "total", before: 110, after: 111 }] : null,
        });
      }
      const seeded = await seedReviewTask(tx);
      await tx.db.insert(llmCalls).values({
        tenantId: tx.tenantId,
        processingRunId: seeded.runId,
        stage: "classify",
        attempt: 1,
        canonical: true,
        mode: "live",
        model: "openai:gpt-6.1-terra",
        effort: "low",
        requestHash: randomUUID(),
        costUsd: "0.002000",
        latencyMs: 800,
      });
    });
    const m = await s.inTenant((tx) => productionMetrics(tx, window));
    expect(m.audit).toEqual([
      { category: "invoice", auditRate: 0.1, precision: expect.objectContaining({ k: 1, n: 3 }) },
    ]);
    expect(m.auditPrecision).toMatchObject({ n: 3, k: 1 });
    expect(m.auditPrecision.rate).toBeCloseTo(1 / 3);
    expect(m.spend).toEqual({ calls: 1, recordedUsd: 0.002, liveUsd: 0.002 });
    expect(m.replay).toBe(false);
    expect(m.latencyByStage).toEqual([{ stage: "classify", n: 1, p50Ms: 800, p95Ms: 800 }]);
    expect(m.routing.find((r) => r.category === "invoice")).toMatchObject({ routed: 4, audited: 3, review: 1 });
  });
});
