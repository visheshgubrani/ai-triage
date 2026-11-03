import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Effort, isModelRef, modelInfo, parseModelRef } from "@ai-triage/core";
import { auditDraw } from "@ai-triage/core/pipeline";
import {
  buildPipelineConfig,
  createBoss,
  createPool,
  createTenant,
  DEMO_CATEGORY_SETTINGS,
  DEMO_MODEL,
  getActiveConfig,
  loadClassification,
  loadDocument,
  MODEL_PRICE_SEED,
  startRun,
  withTenantTx,
} from "@ai-triage/db";
import { loadManifest } from "@ai-triage/fixtures";
import {
  cassettePath,
  getLlmMode,
  liveTransport,
  providerKeyEnv,
  recordTransport,
  replayTransport,
  type Transport,
} from "@ai-triage/llm";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { workerConfig } from "../config";
import { ingestFixture } from "../fixtures";
import { createDbLlmGateway } from "../llm";
import { drainTenantJobs } from "../pipeline/drain";

// `LLM_MODE=record pnpm cassettes:record --yes [--all] [--cap <usd>] [--model <ref>]`
// Runs every fixture through the real pipeline against the live model API and saves each response
// as a cassette (fixtures/cassettes), so replay mode (the default, and CI) never needs a key.
// This SPENDS MONEY. By default only requests without a cassette are sent; --all re-records all.
// It uses a fresh scratch tenant each run, with its own daily budget cap.

const { values } = parseArgs({
  options: {
    yes: { type: "boolean" },
    all: { type: "boolean" },
    cap: { type: "string", default: "25" },
    // Both stages use this model, at low effort (or its only effort). The default is the demo's model.
    model: { type: "string", default: DEMO_MODEL.model },
  },
});
const config = workerConfig();
const capUsd = Number(values.cap);

if (getLlmMode() !== "record") throw new Error("set LLM_MODE=record to record cassettes");
const model = values.model;
if (!isModelRef(model)) throw new Error(`unknown model "${model}" (see MODEL_CATALOG in packages/core)`);
const { efforts } = modelInfo(model);
const effort: Effort = efforts.includes("low") ? "low" : (efforts[0] ?? "none");
const keyEnv = providerKeyEnv(parseModelRef(model).provider);
if (!process.env[keyEnv] && parseModelRef(model).provider !== "compat") throw new Error(`${keyEnv} is not set`);
const price = MODEL_PRICE_SEED.find((p) => p.model === model && p.promptTokensAbove === 0);
if (!price) throw new Error(`no seeded price for ${model}`);
const manifest = await loadManifest(config.fixturesDir);
// Worst case per document: both calls hit max_tokens (4,096 + 16,000 output tokens) with ~10k
// input tokens each, at the model's base price. Real runs cost a small fraction of this.
const worstCase =
  (manifest.items.length * ((4096 + 16000) * Number(price.output) + 2 * 10_000 * Number(price.input))) / 1e6;
console.log(
  `Recording ${values.all ? "all" : "missing"} cassettes for ${manifest.items.length} fixtures (${model}, ${effort} effort).\n` +
    `Worst case if every call hit max_tokens: about $${worstCase.toFixed(0)}; spending stops at the $${capUsd} cap.`,
);
if (!values.yes) {
  console.log("Re-run with --yes to proceed.");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
const pool = createPool(databaseUrl);
const boss = createBoss(databaseUrl, { supervise: false, schedule: false });
await boss.start();
try {
  const slug = `cassette-recorder-${Date.now()}`;
  const { id: tenantId } = await createTenant(pool, { name: "Cassette recorder", slug });
  await withTenantTx(pool, tenantId, async (tx) => {
    await buildPipelineConfig(tx, {
      name: "Cassette recording",
      classify: { model, effort },
      extract: { model, effort },
      categories: DEMO_CATEGORY_SETTINGS,
    });
    await tx.queueDb.executeSql("update tenant_settings set daily_llm_cap_usd = $1", [capUsd.toFixed(2)]);
  });

  // Missing-only: serve requests that already have a cassette from it, record the rest.
  const record = recordTransport(liveTransport(), config.cassetteDir);
  const replay = replayTransport(config.cassetteDir);
  const transport: Transport = values.all
    ? record
    : {
        send: (request, meta) =>
          (existsSync(cassettePath(config.cassetteDir, meta.hash)) ? replay : record).send(request, meta),
      };

  const storage = createStorage(storageConfigFromEnv());
  const documents = new Map<string, string>();
  for (const item of manifest.items) {
    const { documentId } = await ingestFixture({ pool, boss, storage }, tenantId, item, config.fixturesDir, {
      maxFileBytes: config.maxFileBytes,
    });
    documents.set(item.id, documentId);
  }
  const deps = {
    pool,
    boss,
    storage,
    llm: createDbLlmGateway({ pool, mode: "record", transport }),
    limits: { maxPdfPages: config.maxPdfPages },
    auditDraw,
    now: () => new Date(),
  };
  await drainTenantJobs(deps, tenantId);

  // A reviewer reclassifying a misclassified fixture to its label sends a forced-category extract
  // request; record those too, so that natural reclassify works in the replay demo.
  const reclassified = await withTenantTx(pool, tenantId, async (tx) => {
    const active = await getActiveConfig(tx);
    if (!active) throw new Error("recorder tenant has no active config");
    let n = 0;
    for (const item of manifest.items) {
      const documentId = documents.get(item.id);
      const document = documentId ? await loadDocument(tx, documentId) : null;
      if (!document?.currentRunId || item.expectedCategory === "other") continue;
      const predicted = (await loadClassification(tx, document.currentRunId))?.category;
      if (!predicted || predicted === item.expectedCategory) continue;
      await startRun(tx, boss, {
        documentId: document.id,
        configId: active.id,
        trigger: "reclassify",
        forcedCategory: item.expectedCategory,
      });
      n++;
    }
    return n;
  });
  console.log(`reclassify pass: ${reclassified} misclassified fixture(s) re-extracted with their labeled category`);
  if (reclassified > 0) await drainTenantJobs(deps, tenantId);

  const summary = await withTenantTx(pool, tenantId, async (tx) => {
    const calls = await tx.queueDb.executeSql(
      "select count(*)::int as calls, count(*) filter (where mode = 'live')::int as live, coalesce(sum(cost_usd) filter (where mode = 'live'), 0)::float as spent from llm_calls",
    );
    const docs = await tx.queueDb.executeSql(
      "select processing_status as status, count(*)::int as n from documents group by 1 order by 1",
    );
    const failed = await tx.queueDb.executeSql(
      "select d.title, r.error from documents d join processing_runs r on r.id = d.current_run_id where d.processing_status = 'failed'",
    );
    return {
      calls: calls.rows[0] as { calls: number; live: number; spent: number },
      docs: docs.rows,
      failed: failed.rows,
    };
  });
  console.log(`documents by status: ${JSON.stringify(summary.docs)}`);
  for (const f of summary.failed) console.log(`  failed: ${JSON.stringify(f)}`);
  console.log(
    `llm calls: ${summary.calls.calls} (${summary.calls.live} live), actual spend $${summary.calls.spent.toFixed(4)}`,
  );
  await writeFile(
    join(config.cassetteDir, "recorded.json"),
    `${JSON.stringify({ recordedAt: new Date().toISOString(), fixtures: manifest.items.length, liveCalls: summary.calls.live, spentUsd: Number(summary.calls.spent.toFixed(4)) }, null, 2)}\n`,
  );
  console.log(`done: cassettes are in ${config.cassetteDir}; commit them (and recorded.json).`);
} finally {
  await boss.stop({ graceful: true });
  await pool.end();
}
