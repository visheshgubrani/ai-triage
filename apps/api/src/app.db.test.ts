import { MeResponse } from "@ai-triage/contracts";
import { createAuth, createDb, createPool, ensurePasswordUser } from "@ai-triage/db";
import { DEMO_PASSWORD } from "@ai-triage/db/seed";
import { testDbUrls } from "@ai-triage/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";

// Sign-in → session → tenant resolution, against the seeded demo tenant in the test database.

const WEB_ORIGIN = "http://localhost:3000";
const pool = createPool(testDbUrls().appUrl);
const db = createDb(pool);
const auth = createAuth({
  db,
  secret: "test-only-secret-0123456789abcdef0123456789",
  baseURL: "http://localhost:8787",
  trustedOrigins: [WEB_ORIGIN],
});
const app = createApp({ db, auth, webOrigin: WEB_ORIGIN });
afterAll(() => pool.end());

/** Signs in and returns the session cookie header, or the failed response's status. */
async function signIn(email: string, password: string): Promise<{ status: number; cookie: string }> {
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

describe("GET /me", () => {
  it("returns the user's tenant and role after sign-in", async () => {
    const { status, cookie } = await signIn("admin@demo.test", DEMO_PASSWORD);
    expect(status).toBe(200);
    const res = await app.request("/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    const me = MeResponse.parse(await res.json());
    expect(me).toMatchObject({ user: { email: "admin@demo.test" }, tenant: { slug: "demo" }, role: "admin" });

    const reviewer = await signIn("reviewer@demo.test", DEMO_PASSWORD);
    const reviewerMe = MeResponse.parse(
      await (await app.request("/me", { headers: { cookie: reviewer.cookie } })).json(),
    );
    expect(reviewerMe.role).toBe("reviewer");
  });

  it("is 401 without a session", async () => {
    expect((await app.request("/me")).status).toBe(401);
  });

  it("rejects a wrong password", async () => {
    expect((await signIn("admin@demo.test", "wrong-password")).status).toBe(401);
  });

  it("is 403 for a user with no tenant", async () => {
    await ensurePasswordUser(db, { email: "loner@demo.test", name: "Loner", password: DEMO_PASSWORD });
    const { status, cookie } = await signIn("loner@demo.test", DEMO_PASSWORD);
    expect(status).toBe(200);
    expect((await app.request("/me", { headers: { cookie } })).status).toBe(403);
  });

  it("keeps public sign-up closed", async () => {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email: "new@demo.test", password: "new-password-123", name: "New" }),
    });
    expect(res.ok).toBe(false);
  });
});
