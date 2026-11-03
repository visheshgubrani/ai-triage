import { type Effort, EVAL_SPLITS, type EvalSplit, isModelRef, type ModelRef, modelInfo } from "@ai-triage/core";
import { auditDraw } from "@ai-triage/core/pipeline";
import {
  buildPipelineConfig,
  createBoss,
  createEvalRun,
  createPool,
  DEMO_CATEGORY_SETTINGS,
  DEMO_MODEL,
  freezeCalibratedConfig,
  type PgBoss,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, testDbUrls } from "@ai-triage/db/testing";
import { type FixtureItem, loadManifest } from "@ai-triage/fixtures";
import { isRecorded, replayTransport } from "@ai-triage/llm";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerConfig } from "../config";
import { importFixtureDataset, ingestFixture } from "../fixtures";
import { createDbLlmGateway } from "../llm";
import { drainTenantJobs } from "../pipeline/drain";
import { drainEvalJobs } from "./drain";

// Eval runs in replay mode over every fixture (docs/architecture.md §10): the eval runner must send
// exactly the requests production sends, so it replays from the cassettes the recorder made through
// the real pipeline, and reaches the same category and decision for every item. Then calib, Freeze
// and test, as the evals page would. Runs per model once its cassette set is recorded.

const config = workerConfig();
const { appUrl } = testDbUrls();
const pool = createPool(appUrl);
const storage = createStorage(storageConfigFromEnv());
const manifest = await loadManifest(config.fixturesDir);
let boss: PgBoss;

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await pool.end();
});

/** The model at low effort (or its only one), as the recorder records it. */
function stageModel(model: ModelRef): { model: ModelRef; effort: Effort } {
  const { efforts } = modelInfo(model);
  return { model, effort: efforts.includes("low") ? "low" : (efforts[0] ?? "none") };
}

// The demo's routing without audit sampling, so production's decisions are comparable.
const categories = Object.fromEntries(
  Object.entries(DEMO_CATEGORY_SETTINGS).map(([k, v]) => [k, { ...v, auditRate: 0 }]),
);

const MODELS: ModelRef[] = [DEMO_MODEL.model, "deepseek:deepseek-flash"].filter(
  (m): m is ModelRef => isModelRef(m) && isRecorded(config.cassetteDir, m),
);

describe.skipIf(MODELS.length === 0).each(MODELS)("eval runs in replay (%s)", (model) => {
  const llm = createDbLlmGateway({ pool, mode: "replay", transport: replayTransport(config.cassetteDir) });
  const limits = { maxPdfPages: config.maxPdfPages };

  /** Production's outcome per fixture: the category and routing decision the pipeline reached. */
  async function production(): Promise<
    Map<string, { category: string | null; decision: string | null; failed: boolean }>
  > {
    const tenantId = await newTenant(pool);
    await withTenantTx(pool, tenantId, (tx) =>
      buildPipelineConfig(tx, { classify: stageModel(model), extract: stageModel(model), categories }),
    );
    const docs = new Map<string, FixtureItem>();
    for (const item of manifest.items) {
      const { documentId } = await ingestFixture({ pool, boss, storage }, tenantId, item, config.fixturesDir, {
        maxFileBytes: config.maxFileBytes,
      });
      docs.set(documentId, item);
    }
    await drainTenantJobs({ pool, boss, storage, llm, limits, auditDraw, now: () => new Date() }, tenantId);
    const rows = await withTenantTx(
      pool,
      tenantId,
      async (tx) =>
        (
          await tx.queueDb.executeSql(`
          select d.id, d.processing_status, c.category, x.decision
          from documents d
          left join classifications c on c.run_id = d.current_run_id
          left join extractions x on x.id = d.current_extraction_id`)
        ).rows as { id: string; processing_status: string; category: string | null; decision: string | null }[],
    );
    return new Map(
      rows.map((r) => [
        docs.get(r.id)?.id ?? "",
        {
          category: r.category,
          // Production routes `other` to a human without an extraction; the eval records that as review.
          decision: r.decision ?? (r.category === "other" ? "review" : null),
          failed: r.processing_status === "failed",
        },
      ]),
    );
  }

  let expected: Awaited<ReturnType<typeof production>>;
  let tenantId: string;
  let datasetId: string;
  let configId: string;
  const results = new Map<
    EvalSplit,
    { fixture: string; predicted_category: string | null; decision: string | null; error_reason: string | null }[]
  >();
  const runIds = new Map<EvalSplit, string>();

  beforeAll(async () => {
    expected = await production();
    tenantId = await newTenant(pool);
    configId = await withTenantTx(pool, tenantId, async (tx) => {
      const c = await buildPipelineConfig(tx, { classify: stageModel(model), extract: stageModel(model), categories });
      return c.id;
    });
    ({ datasetId } = await importFixtureDataset({
      pool,
      storage,
      tenantId,
      items: manifest.items,
      fixturesDir: config.fixturesDir,
    }));
    const deps = { pool, storage, llm, limits, llmMode: "replay" as const, now: () => new Date() };
    const runSplit = async (split: EvalSplit, runConfigId: string) => {
      const { runId } = await withTenantTx(pool, tenantId, (tx) =>
        createEvalRun(tx, boss, { datasetId, split, configId: runConfigId, llmMode: "replay" }),
      );
      runIds.set(split, runId);
      await drainEvalJobs(deps, boss, tenantId);
      results.set(
        split,
        await withTenantTx(
          pool,
          tenantId,
          async (tx) =>
            (
              await tx.queueDb.executeSql(
                `select substring(i.origin_ref from 9) as fixture, r.predicted_category, r.decision, r.error_reason
                 from eval_results r join eval_items i on i.id = r.eval_item_id where r.eval_run_id = $1`,
                [runId],
              )
            ).rows as never,
        ),
      );
    };
    await runSplit("dev", configId);
    await runSplit("calib", configId);
    // Freeze with the demo thresholds unchanged (calib is too small to choose them), then test.
    const frozen = await withTenantTx(pool, tenantId, async (tx) =>
      freezeCalibratedConfig(tx, {
        runId: runIds.get("calib") ?? "",
        name: "frozen",
        categories: [],
      }),
    );
    await runSplit("test", frozen.id);
  });

  it("covers every fixture, with no missing cassette", () => {
    const all = EVAL_SPLITS.flatMap((s) => results.get(s) ?? []);
    expect(all.map((r) => r.fixture).sort()).toEqual(manifest.items.map((i) => i.id).sort());
    expect(all.filter((r) => r.error_reason === "cassette_missing")).toEqual([]);
  });

  it("reaches production's category and decision for every item", () => {
    for (const r of EVAL_SPLITS.flatMap((s) => results.get(s) ?? [])) {
      const prod = expected.get(r.fixture);
      expect(prod, r.fixture).toBeDefined();
      expect({ fixture: r.fixture, failed: r.error_reason !== null }).toEqual({
        fixture: r.fixture,
        failed: prod?.failed,
      });
      if (r.error_reason) continue;
      expect({ fixture: r.fixture, category: r.predicted_category, decision: r.decision }).toEqual({
        fixture: r.fixture,
        category: prod?.category,
        decision: prod?.decision,
      });
    }
  });

  it("finishes each run, costing exactly the sum of its llm_calls, all replayed", async () => {
    for (const split of EVAL_SPLITS) {
      const runId = runIds.get(split);
      const [row] = await withTenantTx(
        pool,
        tenantId,
        async (tx) =>
          (
            await tx.queueDb.executeSql(
              `select r.status, (r.aggregates->>'totalUsd')::float8 as total, r.aggregates->>'replay' as replay,
                      (select coalesce(sum(cost_usd), 0)::float8 from llm_calls c where c.eval_run_id = r.id) as calls,
                      (select count(*)::int from llm_calls c where c.eval_run_id = r.id and c.mode <> 'replay') as live
               from eval_runs r where r.id = $1`,
              [runId],
            )
          ).rows as { status: string; total: number; calls: number; replay: string; live: number }[],
      );
      expect(row).toMatchObject({ status: "done", replay: "true", live: 0 });
      expect(row?.total).toBeCloseTo(row?.calls ?? -1, 6);
    }
  });
});
