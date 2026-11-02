import { assertAppRole, createAuth, createDb, createPool } from "@ai-triage/db";
import { serve } from "@hono/node-server";
import { createApp } from "./app";

const port = Number(process.env.API_PORT ?? 8787);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error("BETTER_AUTH_SECRET is not set (see .env.example)");

const pool = createPool();
await assertAppRole(pool);
const db = createDb(pool);
const auth = createAuth({
  db,
  secret,
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
  trustedOrigins: [webOrigin],
});
const app = createApp({ db, auth, webOrigin });

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});

const shutdown = () => {
  server.close();
  void pool.end();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
