import { randomUUID } from "node:crypto";
import { ApiKeyCreated, ApiKeyList, ErrorResponse, MeResponse } from "@ai-triage/contracts";
import {
  addMembership,
  createApiKey,
  createTenant,
  ensurePasswordUser,
  listAuditEvents,
  resolveApiKey,
  withTenantTx,
} from "@ai-triage/db";
import { DEMO_PASSWORD } from "@ai-triage/db/seed";
import { afterAll, describe, expect, it } from "vitest";
import { cookiesOf, createTestApp, mergeCookies as merge, totp, WEB_ORIGIN } from "./test-app";

// Accounts (docs/security.md, M6): TOTP through the app's own /api/auth routes, the admin 2FA
// requirement, and API keys managed from Settings.

const t = await createTestApp({ requireAdmin2fa: true });
const { app, pool, db } = t;
afterAll(t.close);

const auth = (path: string, body: unknown, cookie = "") =>
  app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN, cookie },
    body: JSON.stringify(body),
  });

async function freshAdmin() {
  const { id: tenantId } = await createTenant(pool, { name: "Acct", slug: `acct-${randomUUID().slice(0, 8)}` });
  const email = `admin-${randomUUID().slice(0, 8)}@test.test`;
  const userId = await ensurePasswordUser(db, { email, name: "Admin", password: DEMO_PASSWORD });
  await addMembership(db, userId, tenantId, "admin");
  const signIn = await auth("/sign-in/email", { email, password: DEMO_PASSWORD });
  return { tenantId, email, cookie: cookiesOf(signIn) };
}

describe("two-factor authentication", () => {
  it("locks admin settings until 2FA is on, then signs in with a TOTP code", async () => {
    const admin = await freshAdmin();
    const me = MeResponse.parse(await (await app.request("/me", { headers: { cookie: admin.cookie } })).json());
    expect(me).toMatchObject({ twoFactorEnabled: false, twoFactorRequired: true });
    const locked = await app.request("/settings/webhook", { headers: { cookie: admin.cookie } });
    expect(locked.status).toBe(403);
    expect(ErrorResponse.parse(await locked.json()).code).toBe("two_factor_required");

    // Enroll: the URI carries the secret; the first verified code turns 2FA on.
    const enabled = (await (await auth("/two-factor/enable", { password: DEMO_PASSWORD }, admin.cookie)).json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    expect(enabled.backupCodes.length).toBeGreaterThan(0);
    const secret = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
    const verified = await auth("/two-factor/verify-totp", { code: totp(secret) }, admin.cookie);
    expect(verified.status).toBe(200);
    const cookie = merge(admin.cookie, cookiesOf(verified));
    expect((await app.request("/settings/webhook", { headers: { cookie } })).status).toBe(200);
    const { events } = await withTenantTx(pool, admin.tenantId, (tx) => listAuditEvents(tx, { limit: 5 }));
    expect(events.map((e) => e.action)).toContain("auth.two_factor_enabled");

    // A new sign-in now stops after the password and needs a code.
    const password = await auth("/sign-in/email", { email: admin.email, password: DEMO_PASSWORD });
    expect(await password.json()).toMatchObject({ twoFactorRedirect: true });
    expect((await auth("/two-factor/verify-totp", { code: "000000" }, cookiesOf(password))).ok).toBe(false);
    const code = await auth("/two-factor/verify-totp", { code: totp(secret) }, cookiesOf(password));
    expect(code.status).toBe(200);
    expect((await app.request("/me", { headers: { cookie: cookiesOf(code) } })).status).toBe(200);
  });
});

describe("API keys", () => {
  async function adminWith2fa() {
    const admin = await freshAdmin();
    const enabled = (await (await auth("/two-factor/enable", { password: DEMO_PASSWORD }, admin.cookie)).json()) as {
      totpURI: string;
    };
    const secret = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
    const verified = await auth("/two-factor/verify-totp", { code: totp(secret) }, admin.cookie);
    return { ...admin, cookie: merge(admin.cookie, cookiesOf(verified)) };
  }

  it("creates a key shown once, lists it by prefix, and revokes it", async () => {
    const admin = await adminWith2fa();
    const send = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { cookie: admin.cookie, origin: WEB_ORIGIN, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const created = ApiKeyCreated.parse(
      await (await send("POST", "/settings/api-keys", { name: "ERP", expiresInDays: 30 })).json(),
    );
    expect(await resolveApiKey(db, created.key)).toMatchObject({ tenantId: admin.tenantId });
    const list = ApiKeyList.parse(await (await send("GET", "/settings/api-keys")).json());
    expect(list.keys).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.key);

    expect((await send("POST", `/settings/api-keys/${created.apiKey.id}/revoke`)).status).toBe(200);
    expect(await resolveApiKey(db, created.key)).toBeNull();
    const { events } = await withTenantTx(pool, admin.tenantId, (tx) => listAuditEvents(tx, { limit: 10 }));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["api_key.created", "api_key.revoked"]));
  });

  it("refuses an expired key", async () => {
    const { id: tenantId } = await createTenant(pool, { name: "Exp", slug: `exp-${randomUUID().slice(0, 8)}` });
    const { key } = await withTenantTx(pool, tenantId, (tx) =>
      createApiKey(tx, { name: "old", expiresAt: new Date(Date.now() - 1000) }),
    );
    expect(await resolveApiKey(db, key)).toBeNull();
  });
});
