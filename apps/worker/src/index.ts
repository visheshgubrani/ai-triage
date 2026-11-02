import { PIPELINE_STAGES } from "@ai-triage/core";
import { getLlmMode } from "@ai-triage/llm";
import { PgBoss } from "pg-boss";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

// Workers need a direct (non-pooled) connection: see docs/architecture.md §3.
const boss = new PgBoss(connectionString);
boss.on("error", (err) => console.error("pg-boss error", err));

await boss.start();

// Smoke-test queue proving the wiring end to end. The pipeline queues
// (doc.parse, doc.classify, doc.extract, doc.route, action.deliver) arrive in phase 2.
const PING = "system.ping";
await boss.createQueue(PING);
await boss.work<{ at: string }>(PING, async ([job]) => {
  console.log(`worker: ping received (sent ${job?.data.at})`);
});
await boss.send(PING, { at: new Date().toISOString() });

console.log(`worker started (llm mode: ${getLlmMode()}, stages planned: ${PIPELINE_STAGES.join(" → ")})`);

const shutdown = async () => {
  await boss.stop({ graceful: true });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
