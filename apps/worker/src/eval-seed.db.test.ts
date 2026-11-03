import {
  buildPipelineConfig,
  createBoss,
  createPool,
  DEMO_CATEGORY_SETTINGS,
  DEMO_MODEL,
  type PgBoss,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, testDbUrls } from "@ai-triage/db/testing";
import { loadManifest } from "@ai-triage/fixtures";
import { isRecorded, replayTransport } from "@ai-triage/llm";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerConfig } from "./config";
import { DEEPSEEK_MODEL, seedEvalDemo } from "./eval-seed";
import { drainEvalJobs } from "./evals/drain";
import { createDbLlmGateway } from "./llm";

// The demo's eval seed: the Main dataset and its first runs, added once, which the worker then
// finishes in replay from the committed cassettes.

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

describe.skipIf(!isRecorded(config.cassetteDir, DEMO_MODEL.model))("seedEvalDemo", () => {
  it("adds the dataset and runs once, and the runs finish in replay", async () => {
    const tenantId = await newTenant(pool);
    await withTenantTx(pool, tenantId, (tx) =>
      buildPipelineConfig(tx, { classify: DEMO_MODEL, extract: DEMO_MODEL, categories: DEMO_CATEGORY_SETTINGS }),
    );
    // A few items per split keep this quick; the full set is the eval e2e test's job.
    const items = ["dev", "calib", "test"].flatMap((split) =>
      manifest.items.filter((i) => i.split === split).slice(0, 3),
    );
    const input = {
      pool,
      boss,
      storage,
      tenantId,
      manifest: { ...manifest, items },
      fixturesDir: config.fixturesDir,
      cassetteDir: config.cassetteDir,
    };
    const deepseek = isRecorded(config.cassetteDir, DEEPSEEK_MODEL);

    const first = await seedEvalDemo(input);
    expect(first).toMatchObject({ itemsAdded: 9, runsQueued: deepseek ? 4 : 3 });
    expect(await seedEvalDemo(input)).toMatchObject({ itemsAdded: 0, runsQueued: 0 });

    const llm = createDbLlmGateway({ pool, mode: "replay", transport: replayTransport(config.cassetteDir) });
    await drainEvalJobs(
      { pool, storage, llm, limits: { maxPdfPages: config.maxPdfPages }, llmMode: "replay", now: () => new Date() },
      boss,
      tenantId,
    );
    const runs = await withTenantTx(
      pool,
      tenantId,
      async (tx) =>
        (
          await tx.queueDb.executeSql(
            `select r.split, r.status, c.name, c.frozen_at is not null as frozen,
                  (select count(*)::int from eval_results e where e.eval_run_id = r.id and e.error_reason = 'cassette_missing') as missing
           from eval_runs r join pipeline_configs c on c.id = r.config_id order by r.split, c.version`,
          )
        ).rows,
    );
    // The runs share one transaction (and so one created_at): compare them by split and config version.
    expect(runs).toEqual([
      { split: "calib", status: "done", name: expect.any(String), frozen: false, missing: 0 },
      { split: "dev", status: "done", name: expect.any(String), frozen: false, missing: 0 },
      ...(deepseek
        ? [{ split: "dev", status: "done", name: "DeepSeek Flash candidate", frozen: false, missing: 0 }]
        : []),
      { split: "test", status: "done", name: "Demo config (frozen)", frozen: true, missing: 0 },
    ]);
  });
});
