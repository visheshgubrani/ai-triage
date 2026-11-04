import { MeResponse } from "@ai-triage/contracts";
import { ensurePasswordUser } from "@ai-triage/db";
import { DEMO_PASSWORD } from "@ai-triage/db/seed";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp, WEB_ORIGIN } from "./test-app";

// Sign-in → session → tenant resolution, against the seeded demo tenant in the test database.

const { app, server, db, signIn, close } = await createTestApp();
afterAll(close);

describe("paths", () => {
  it("serves the UI routes under /api only, and health at both", async () => {
    expect((await server.request("/api/me")).status).toBe(401);
    expect((await server.request("/me")).status).toBe(404);
    expect((await server.request("/api/health")).status).toBe(200);
    expect((await server.request("/health")).status).toBe(200);
  });

  it("keeps Better Auth at /api/auth", async () => {
    const res = await server.request("/api/auth/get-session");
    expect(res.status).toBe(200);
    const signUp = await server.request("/api/auth/sign-up/email", { method: "POST", headers: { origin: WEB_ORIGIN } });
    expect(signUp.status).toBe(404);
  });
});

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

describe("GET /auth/providers", () => {
  it("offers no Google sign-in without a Google client", async () => {
    expect(await (await app.request("/auth/providers")).json()).toEqual({ google: false });
    const social = await app.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ provider: "google", callbackURL: `${WEB_ORIGIN}/` }),
    });
    expect(social.ok).toBe(false);
  });
});
