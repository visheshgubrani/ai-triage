import { createHmac } from "node:crypto";
import { egressPolicy } from "@ai-triage/core/pipeline";
import {
  addMembership,
  createAuth,
  createBoss,
  createDb,
  createPool,
  ensurePasswordUser,
  keyRingFromEnv,
  type PgBoss,
} from "@ai-triage/db";
import { DEMO_PASSWORD } from "@ai-triage/db/seed";
import { testDbUrls } from "@ai-triage/db/testing";
import type { GoogleConfig } from "@ai-triage/mailbox";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { createApp } from "./app";
import { type RateLimits, rateLimitsFromEnv } from "./rate-limit";

// Builds the real app against the scratch test database and the local storage service.

export const WEB_ORIGIN = "http://localhost:3000";
export const POSTMARK = { user: "postmark", password: "test-postmark-password" };

/** A Google client for tests: its endpoints are never really called (tests stub fetch). */
export const TEST_GOOGLE: GoogleConfig = {
  clientId: "test-client.apps.googleusercontent.com",
  clientSecret: "test-google-secret",
  oauthUrl: "https://accounts.google.com",
  tokenUrl: "https://oauth2.googleapis.com",
  apiUrl: "https://gmail.googleapis.com",
};

/**
 * Test DNS: every name resolves to a public address, except names starting with "private.", which
 * resolve into 10/8 (to exercise the SSRF check).
 */
const testResolve = async (hostname: string) => [hostname.startsWith("private.") ? "10.0.0.7" : "93.184.215.14"];

export async function createTestApp(
  options: {
    maxFileBytes?: number;
    webhookAllowedHosts?: string[];
    rateLimits?: RateLimits;
    requireAdmin2fa?: boolean;
    /** Turns Google on (sign-in, mailboxes); off by default, as without GOOGLE_CLIENT_ID. */
    google?: GoogleConfig;
  } = {},
) {
  // Tests may pin the clock (to let a lease run out); otherwise it's real time.
  let fixedNow: Date | null = null;
  const { appUrl } = testDbUrls();
  const pool = createPool(appUrl);
  const db = createDb(pool);
  const google = options.google ?? null;
  const auth = createAuth({
    db,
    secret: "test-only-secret-0123456789abcdef0123456789",
    baseURL: "http://localhost:8787",
    webOrigin: WEB_ORIGIN,
    google,
  });
  const boss: PgBoss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  const storage = createStorage(storageConfigFromEnv());
  const app = createApp({
    db,
    pool,
    auth,
    boss,
    storage,
    limits: { maxFileBytes: options.maxFileBytes ?? 20 * 2 ** 20 },
    postmark: POSTMARK,
    webOrigin: WEB_ORIGIN,
    hsts: false,
    trustedProxies: [],
    now: () => fixedNow ?? new Date(),
    webhookEgress: { policy: egressPolicy(options.webhookAllowedHosts ?? []), resolve: testResolve },
    keys: keyRingFromEnv({}),
    // Every test file signs in as the demo users from the same (unknown) address, and the counters
    // live in the shared test database: limits stay out of the way unless a test sets its own.
    inboundDomain: null,
    requireAdmin2fa: options.requireAdmin2fa ?? false,
    rateLimits: options.rateLimits ?? rateLimitsFromEnv({ RATE_LIMIT_SCALE: "10000" }),
    llmMode: "replay",
    google,
  });

  /** Pins the app's clock (null: real time again). */
  function setNow(at: Date | null) {
    fixedNow = at;
  }

  /** Signs in and returns the session cookie header, or the failed response's status. */
  async function signIn(email: string, password = DEMO_PASSWORD): Promise<{ status: number; cookie: string }> {
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return { status: res.status, cookie };
  }

  /** A user with `role` in `tenantId`, signed in. */
  async function memberCookie(tenantId: string, role: "admin" | "reviewer" | "viewer") {
    const email = `${role}-${tenantId.slice(0, 8)}@test.test`;
    const userId = await ensurePasswordUser(db, { email, name: role, password: DEMO_PASSWORD });
    await addMembership(db, userId, tenantId, role);
    return (await signIn(email)).cookie;
  }

  async function close() {
    await boss.stop({ graceful: false });
    await pool.end();
  }

  return { app, pool, db, boss, storage, signIn, memberCookie, setNow, close };
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), as authenticator apps compute it. */
export function totp(base32Secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32Secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** The cookies a response sets, as a Cookie header. */
export const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Cookie headers merged by name, later ones winning (Better Auth replaces the session cookie). */
export const mergeCookies = (...headers: string[]) => {
  const jar = new Map<string, string>();
  for (const pair of headers.flatMap((h) => h.split("; ")).filter(Boolean)) jar.set(pair.split("=")[0] ?? "", pair);
  return [...jar.values()].filter((pair) => !pair.endsWith("=")).join("; ");
};
