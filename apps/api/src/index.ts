import { setTimeout as sleep } from "node:timers/promises";
import { APP_VERSION, assertEnv, callModeOf, getLlmMode, resolvePublicUrls } from "@ai-triage/core";
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
import { log } from "./log";
import { rateLimitsFromEnv } from "./rate-limit";
import { systemResolve } from "./webhook-url";

let urls: ReturnType<typeof resolvePublicUrls>;
try {
  assertEnv(process.env, "api");
  urls = resolvePublicUrls(process.env);
} catch (err) {
  exitOnStartupError(err);
}
for (const warning of urls.warnings) log.warn(warning);
const port = Number(process.env.API_PORT ?? 8787);
// The web app and the API share one origin (the API under /api), so cookies, CORS and the Origin
// check all use it.
const webOrigin = urls.origin;
const secret = process.env.BETTER_AUTH_SECRET as string;
const databaseUrl = process.env.DATABASE_URL as string;

const pool = createPool(databaseUrl);
await checkStartup(pool, process.env, "api").catch(exitOnStartupError);
const db = createDb(pool);
const baseURL = urls.authBaseUrl;
const trustedProxies = (process.env.TRUSTED_PROXIES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const google = googleConfigFromEnv(process.env);
const googleSignIn = google !== null && isRealGoogle(google);
const auth = createAuth({ db, secret, baseURL, webOrigin, trustedProxies, google: googleSignIn ? google : null });

// The api only enqueues (inside tenant transactions); the worker supervises and runs jobs.
const boss = createBoss(databaseUrl, { supervise: false, schedule: false });
boss.on("error", (err) => log.error("pg-boss error", { err }));
await boss.start();

const storage = createStorage(storageConfigFromEnv());
// Presigned uploads go straight from the browser to storage, which must allow the web origin.
await storage.allowBrowserOrigins([webOrigin]).catch((err: Error) => {
  log.warn("could not set storage CORS", { origin: webOrigin, err });
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
  apiBaseUrl: urls.apiBaseUrl,
  metricsToken: process.env.METRICS_TOKEN || null,
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info("api listening", { port: info.port, publicUrl: urls.origin, version: APP_VERSION });
}) as import("node:http").Server;
// A slow client can't hold a connection open forever: headers within 30 s, the whole request
// (Postmark payloads can be ~29 MB) within 2 minutes.
server.headersTimeout = 30_000;
server.requestTimeout = 120_000;

// SIGTERM: stop accepting, let in-flight requests finish for up to 10 s, then close the pools.
let stopping = false;
const shutdown = async () => {
  if (stopping) process.exit(1);
  stopping = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const drained = await Promise.race([closed.then(() => true), sleep(10_000).then(() => false)]);
  if (!drained) server.closeAllConnections();
  await boss.stop({ graceful: true, timeout: 5_000 });
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
