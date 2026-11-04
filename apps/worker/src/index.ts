import { assertEnv } from "@ai-triage/core";
import { auditDraw, egressPolicyFromEnv } from "@ai-triage/core/pipeline";
import { checkStartup, createBoss, createPool, exitOnStartupError, keyRingFromEnv } from "@ai-triage/db";
import { callModeOf, createTransport, getLlmMode } from "@ai-triage/llm";
import { googleConfigFromEnv } from "@ai-triage/mailbox";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { workerConfig } from "./config";
import { createGuardedFetch } from "./delivery/egress";
import { registerDelivery } from "./delivery/register";
import { registerEvals } from "./evals/register";
import { createDbLlmGateway } from "./llm";
import { registerMailbox } from "./mailbox/register";
import { registerMaintenance } from "./maintenance/register";
import { registerPipeline } from "./pipeline/register";
import { abortInFlight } from "./shutdown";

try {
  assertEnv(process.env, "worker");
} catch (err) {
  exitOnStartupError(err);
}
const connectionString = process.env.DATABASE_URL as string;
const config = workerConfig();
const mode = getLlmMode();

// Runs as the app role: RLS applies, and pg-boss's schema and queues were installed by
// `pnpm db:migrate`, so this instance never migrates (see packages/db/src/boss.ts).
// Model calls hold no connection (short transactions), so the pool needs less than one per slot.
const pool = createPool(connectionString, {
  max:
    Number(process.env.DB_POOL_MAX) ||
    4 + 2 * config.llmConcurrency + config.evalConcurrency + config.mailboxConcurrency,
});
await checkStartup(pool, process.env, "worker").catch(exitOnStartupError);

// Workers need a direct (non-pooled) connection: pg-boss uses LISTEN (docs/configuration.md, DATABASE_URL).
const boss = createBoss(connectionString);
boss.on("error", (err) => console.error("pg-boss error", err));
await boss.start();

const storage = createStorage(storageConfigFromEnv());
const llm = createDbLlmGateway({ pool, mode, transport: createTransport(mode, config.cassetteDir) });
// Files are parsed in a sandboxed thread, bounded in time and memory (src/parse/sandbox.ts).
const limits = {
  maxPdfPages: config.maxPdfPages,
  sandbox: { timeoutMs: config.parseTimeoutMs, maxMemoryMb: config.parseMaxMemoryMb },
};
const now = () => new Date();

await registerPipeline(
  boss,
  { pool, boss, storage, llm, limits, auditDraw, now },
  { llmConcurrency: config.llmConcurrency },
);
// Eval runs: the same parsing, requests and evaluation, but results only (no queue, actions or delivery).
await registerEvals(
  boss,
  { pool, storage, llm, limits, llmMode: callModeOf(mode), now },
  { concurrency: config.evalConcurrency },
);
// Signed webhooks for approved actions. These deps have no LLM or storage: delivery only posts.
// Webhook URLs are tenant-chosen, so every connection goes through the SSRF guard.
await registerDelivery(boss, {
  pool,
  boss,
  keys: keyRingFromEnv(process.env),
  fetch: createGuardedFetch(egressPolicyFromEnv(process.env)),
  now: () => new Date(),
  timeoutMs: config.webhookTimeoutMs,
});

await registerMaintenance(boss, { pool, boss, storage, now: () => new Date() });

// Gmail mailbox sync: Google's endpoints are fixed (not tenant-chosen), so the plain fetch is used.
const google = googleConfigFromEnv(process.env);
await registerMailbox(
  boss,
  {
    pool,
    boss,
    storage,
    keys: keyRingFromEnv(process.env),
    google: google ? { config: google, fetch } : null,
    limits: {
      maxFileBytes: config.maxFileBytes,
      syncBatch: config.mailboxSyncBatch,
      inboundPerHour: config.inboundPerHour,
    },
    now,
  },
  { fetchConcurrency: config.mailboxConcurrency },
);

console.log(
  `worker started (llm mode: ${mode}${mode === "replay" ? `, cassettes: ${config.cassetteDir}` : ""}; ` +
    `gmail sync: ${google ? "on" : "off, no GOOGLE_CLIENT_ID"})`,
);

// SIGTERM: stop fetching, let running jobs finish for up to the grace period, then abort their model
// calls so they retry elsewhere at once. A second signal exits immediately.
let stopping = false;
const shutdown = async () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log(`worker stopping: finishing running jobs (up to ${config.shutdownGraceMs} ms)`);
  const abortTimer = setTimeout(abortInFlight, config.shutdownGraceMs);
  try {
    await boss.stop({ graceful: true, timeout: config.shutdownGraceMs + 5000 });
  } finally {
    clearTimeout(abortTimer);
    await pool.end();
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
