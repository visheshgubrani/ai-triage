import {
  addMembership,
  createAuth,
  createBoss,
  createDb,
  createPool,
  ensurePasswordUser,
  type PgBoss,
} from "@ai-triage/db";
import { DEMO_PASSWORD } from "@ai-triage/db/seed";
import { testDbUrls } from "@ai-triage/db/testing";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { createApp } from "./app";

// Builds the real app against the scratch test database and the local storage service.

export const WEB_ORIGIN = "http://localhost:3000";
export const POSTMARK = { user: "postmark", password: "test-postmark-password" };

export async function createTestApp(options: { maxFileBytes?: number; allowHttpWebhooks?: boolean } = {}) {
  // Tests may pin the clock (to let a lease run out); otherwise it's real time.
  let fixedNow: Date | null = null;
  const { appUrl } = testDbUrls();
  const pool = createPool(appUrl);
  const db = createDb(pool);
  const auth = createAuth({
    db,
    secret: "test-only-secret-0123456789abcdef0123456789",
    baseURL: "http://localhost:8787",
    trustedOrigins: [WEB_ORIGIN],
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
    webhooks: { allowHttp: options.allowHttpWebhooks ?? false },
    llmMode: "replay",
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
