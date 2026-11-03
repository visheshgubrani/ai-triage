import { auditDraw } from "@ai-triage/core/pipeline";
import { assertAppRole, createBoss, createPool } from "@ai-triage/db";
import { createTransport, getLlmMode } from "@ai-triage/llm";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { workerConfig } from "./config";
import { registerDelivery } from "./delivery/register";
import { createDbLlmGateway } from "./llm";
import { registerPipeline } from "./pipeline/register";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
const config = workerConfig();
const mode = getLlmMode();

// Runs as the app role: RLS applies, and pg-boss's schema and queues were installed by
// `pnpm db:migrate`, so this instance never migrates (see packages/db/src/boss.ts).
const pool = createPool(connectionString);
await assertAppRole(pool);

// Workers need a direct (non-pooled) connection: see docs/architecture.md §3.
const boss = createBoss(connectionString);
boss.on("error", (err) => console.error("pg-boss error", err));
await boss.start();

await registerPipeline(
  boss,
  {
    pool,
    boss,
    storage: createStorage(storageConfigFromEnv()),
    llm: createDbLlmGateway({ pool, mode, transport: createTransport(mode, config.cassetteDir) }),
    limits: { maxPdfPages: config.maxPdfPages },
    auditDraw,
    now: () => new Date(),
  },
  { llmConcurrency: config.llmConcurrency },
);
// Signed webhooks for approved actions. These deps have no LLM or storage: delivery only posts.
await registerDelivery(boss, { pool, boss, fetch, now: () => new Date(), timeoutMs: config.webhookTimeoutMs });

console.log(`worker started (llm mode: ${mode}${mode === "replay" ? `, cassettes: ${config.cassetteDir}` : ""})`);

const shutdown = async () => {
  await boss.stop({ graceful: true });
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
