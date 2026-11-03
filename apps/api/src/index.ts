import { assertAppRole, createAuth, createBoss, createDb, createPool } from "@ai-triage/db";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { serve } from "@hono/node-server";
import { createApp } from "./app";

const port = Number(process.env.API_PORT ?? 8787);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error("BETTER_AUTH_SECRET is not set (see .env.example)");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set (see .env.example)");

const pool = createPool(databaseUrl);
await assertAppRole(pool);
const db = createDb(pool);
const auth = createAuth({
  db,
  secret,
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
  trustedOrigins: [webOrigin],
});

// The api only enqueues (inside tenant transactions); the worker supervises and runs jobs.
const boss = createBoss(databaseUrl, { supervise: false, schedule: false });
boss.on("error", (err) => console.error("pg-boss error", err));
await boss.start();

const storage = createStorage(storageConfigFromEnv());
// Presigned uploads go straight from the browser to storage, which must allow the web origin.
await storage.allowBrowserOrigins([webOrigin]).catch((err: Error) => {
  console.warn(`could not set storage CORS for ${webOrigin}: ${err.message}`);
});

const { POSTMARK_INBOUND_USER: postmarkUser, POSTMARK_INBOUND_PASSWORD: postmarkPassword } = process.env;
const app = createApp({
  db,
  pool,
  auth,
  boss,
  storage,
  limits: { maxFileBytes: Number(process.env.MAX_FILE_MB ?? 20) * 2 ** 20 },
  postmark: postmarkUser && postmarkPassword ? { user: postmarkUser, password: postmarkPassword } : null,
  webOrigin,
  now: () => new Date(),
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});

const shutdown = async () => {
  server.close();
  await boss.stop({ graceful: true });
  await pool.end();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
