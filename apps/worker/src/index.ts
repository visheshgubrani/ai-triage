import { PIPELINE_STAGES, QUEUES } from "@ai-triage/core";
import { assertAppRole, createBoss, createPool } from "@ai-triage/db";
import { getLlmMode } from "@ai-triage/llm";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

// Runs as the app role: RLS applies, and pg-boss's schema and queues were installed by
// `pnpm db:migrate`, so this instance never migrates (see packages/db/src/boss.ts).
const pool = createPool(connectionString);
await assertAppRole(pool);

// Workers need a direct (non-pooled) connection: see docs/architecture.md §3.
const boss = createBoss(connectionString);
boss.on("error", (err) => console.error("pg-boss error", err));

await boss.start();

// Smoke-test queue proving the wiring end to end. The pipeline handlers (doc.parse, doc.classify,
// doc.extract, doc.route, action.deliver) arrive in phase 2.
await boss.work<{ at: string }>(QUEUES.ping, async ([job]) => {
  console.log(`worker: ping received (sent ${job?.data.at})`);
});
await boss.send(QUEUES.ping, { at: new Date().toISOString() });

console.log(`worker started (llm mode: ${getLlmMode()}, stages planned: ${PIPELINE_STAGES.join(" → ")})`);

const shutdown = async () => {
  await boss.stop({ graceful: true });
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
