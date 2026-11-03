import type { EvalSplit, ModelRef } from "@ai-triage/core";
import {
  createCandidateConfig,
  createEvalRun,
  DEMO_MODEL,
  freezeConfig,
  getActiveConfig,
  listConfigs,
  listRuns,
  type PgBoss,
  type Pool,
  type TenantTx,
  withTenantTx,
} from "@ai-triage/db";
import type { FixtureManifest } from "@ai-triage/fixtures";
import { isRecorded } from "@ai-triage/llm";
import type { Storage } from "@ai-triage/storage";
import { importFixtureDataset } from "./fixtures";
import { recordedStage } from "./recorded-model";

// The demo's eval data (`pnpm db:seed`): the fixtures as the labeled Main dataset, and the runs the
// evals page shows on first load, enqueued for the worker (in replay, from the committed cassettes):
//   dev on the demo config, and on a DeepSeek Flash candidate (once its cassettes are recorded);
//   calib on the demo config; test on a frozen copy of the demo config.
// The frozen copy keeps the demo thresholds: calib has 1 to 5 items per category, too few to choose
// thresholds from (the sweep's Wilson bounds show it). Idempotent: only missing pieces are added.

export const DEEPSEEK_MODEL: ModelRef = "deepseek:deepseek-flash";
const DEEPSEEK_CANDIDATE = "DeepSeek Flash candidate";
const FROZEN_DEMO = "Demo config (frozen)";

export interface EvalSeedResult {
  datasetId: string;
  itemsAdded: number;
  runsQueued: number;
  skipped: string[];
}

export async function seedEvalDemo(input: {
  pool: Pool;
  boss: PgBoss;
  storage: Storage;
  tenantId: string;
  manifest: FixtureManifest;
  fixturesDir: string;
  cassetteDir: string;
}): Promise<EvalSeedResult> {
  const { pool, boss, tenantId } = input;
  const { datasetId, added } = await importFixtureDataset({
    pool,
    storage: input.storage,
    tenantId,
    items: input.manifest.items,
    fixturesDir: input.fixturesDir,
  });
  const skipped: string[] = [];
  const runsQueued = await withTenantTx(pool, tenantId, async (tx) => {
    const demo = await getActiveConfig(tx);
    if (!demo || demo.classifyModel !== DEMO_MODEL.model || demo.extractModel !== DEMO_MODEL.model) {
      skipped.push(`the active config doesn't use ${DEMO_MODEL.model}, so there are no cassettes for its runs`);
      return 0;
    }
    if (!isRecorded(input.cassetteDir, DEMO_MODEL.model)) {
      skipped.push(`no recorded cassettes for ${DEMO_MODEL.model}`);
      return 0;
    }
    const runs = await listRuns(tx, { datasetId });
    const configs = await listConfigs(tx);
    let queued = 0;
    const ensureRun = async (configId: string, split: EvalSplit) => {
      if (runs.some((r) => r.run.configId === configId && r.run.split === split)) return;
      await createEvalRun(tx, boss, { datasetId, split, configId, llmMode: "replay" });
      queued++;
    };
    const ensureConfig = async (name: string, create: (tx: TenantTx) => Promise<string>) =>
      configs.find((c) => c.name === name)?.id ?? (await create(tx));

    await ensureRun(demo.id, "dev");
    if (isRecorded(input.cassetteDir, DEEPSEEK_MODEL)) {
      const deepseek = await ensureConfig(DEEPSEEK_CANDIDATE, async (t) => {
        const stage = recordedStage(input.cassetteDir, DEEPSEEK_MODEL);
        return (
          await createCandidateConfig(t, {
            parentId: demo.id,
            name: DEEPSEEK_CANDIDATE,
            classify: stage,
            extract: stage,
          })
        ).id;
      });
      await ensureRun(deepseek, "dev");
    } else {
      skipped.push(`no recorded cassettes for ${DEEPSEEK_MODEL}, so no second model to compare`);
    }
    await ensureRun(demo.id, "calib");
    const frozen = await ensureConfig(FROZEN_DEMO, async (t) => {
      const config = await createCandidateConfig(t, { parentId: demo.id, name: FROZEN_DEMO });
      await freezeConfig(t, config.id);
      return config.id;
    });
    await ensureRun(frozen, "test");
    return queued;
  });
  return { datasetId, itemsAdded: added, runsQueued, skipped };
}
