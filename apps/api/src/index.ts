import { assertEnv, callModeOf, getLlmMode } from "@ai-triage/core";
import { egressPolicyFromEnv } from "@ai-triage/core/pipeline";
import {
  checkStartup,
  createAuth,
  createBoss,
  createDb,
  createPool,
  exitOnStartupError,
  keyRingFromEnv,
} from "@ai-triage/db";
import { googleConfigFromEnv, isRealGoogle } from "@ai-triage/mailbox";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { parseTrustedProxies } from "./client-ip";
import { rateLimitsFromEnv } from "./rate-limit";
import { systemResolve } from "./webhook-url";

try {
  assertEnv(process.env, "api");
} catch (err) {
  exitOnStartupError(err);
}
const port = Number(process.env.API_PORT ?? 8787);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const secret = process.env.BETTER_AUTH_SECRET as string;
const databaseUrl = process.env.DATABASE_URL as string;

const pool = createPool(databaseUrl);
await checkStartup(pool, process.env, "api").catch(exitOnStartupError);
const db = createDb(pool);
const baseURL = process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`;
const trustedProxies = (process.env.TRUSTED_PROXIES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const google = googleConfigFromEnv(process.env);
const googleSignIn = google !== null && isRealGoogle(google);
const auth = createAuth({ db, secret, baseURL, webOrigin, trustedProxies, google: googleSignIn ? google : null });

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
  hsts: baseURL.startsWith("https://"),
  trustedProxies: parseTrustedProxies(trustedProxies.join(",")),
  now: () => new Date(),
  webhookEgress: { policy: egressPolicyFromEnv(process.env), resolve: systemResolve },
  keys: keyRingFromEnv(process.env),
  rateLimits: rateLimitsFromEnv(process.env),
  inboundDomain: process.env.INBOUND_DOMAIN || null,
  // On unless turned off explicitly, or for the local demo (whose admin has a published password anyway).
  requireAdmin2fa: process.env.REQUIRE_ADMIN_2FA
    ? process.env.REQUIRE_ADMIN_2FA === "true"
    : process.env.TRIAGE_DEMO !== "true",
  llmMode: callModeOf(getLlmMode()),
  google,
  googleSignIn,
  googleFetch: fetch,
  apiBaseUrl: baseURL,
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
