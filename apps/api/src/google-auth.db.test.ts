import { randomUUID } from "node:crypto";
import { AuthProvidersResponse, ErrorResponse } from "@ai-triage/contracts";
import { addMembership, createTenant, ensurePasswordUser, listAuditEvents, withTenantTx } from "@ai-triage/db";
import { DEMO_PASSWORD } from "@ai-triage/db/seed";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookiesOf, createTestApp, mergeCookies, TEST_GOOGLE, totp, WEB_ORIGIN } from "./test-app";

// Sign in with Google (phase 6, M1). Google's token endpoint is stubbed: Better Auth only decodes the
// ID token it returns (it comes straight from Google over TLS), so an unsigned one carries the
// profile. Checked here: linking only verified emails, no sign-up for strangers, no Google tokens
// kept, the TOTP step after Google, and the recent sign-in rule for passwordless 2FA changes.

const t = await createTestApp({ google: TEST_GOOGLE });
const { app, db, pool } = t;
afterAll(t.close);

/** The profile the stubbed token endpoint puts in the next ID token. */
let profile: Record<string, unknown> = {};
const realFetch = globalThis.fetch;
const idToken = (claims: Record<string, unknown>) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: "https://accounts.google.com", aud: TEST_GOOGLE.clientId, iat: now, exp: now + 3600 };
  return `${part({ alg: "RS256", kid: "test" })}.${part({ ...payload, ...claims })}.signature`;
};
vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(`${TEST_GOOGLE.tokenUrl}/token`)) return realFetch(input, init);
  return Response.json({
    access_token: "ya29.test-access-token",
    refresh_token: "1//test-refresh-token",
    expires_in: 3599,
    token_type: "Bearer",
    scope: "openid email profile",
    id_token: idToken(profile),
  });
});

const post = (path: string, body: unknown, cookie = "") =>
  app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN, cookie },
    body: JSON.stringify(body),
  });

/** A Google account's profile claims (`sub` is the account id). */
const googleProfile = (email: string, extra: Record<string, unknown> = {}) => ({
  sub: `g-${randomUUID()}`,
  email,
  email_verified: true,
  name: "Ada Google",
  picture: "https://example.test/ada.png",
  ...extra,
});

/** Starts a Google sign-in (or, with `link`, links Google to the signed-in user), then returns from Google. */
async function viaGoogle(claims: Record<string, unknown>, options: { cookie?: string; link?: boolean } = {}) {
  profile = claims;
  const cookie = options.cookie ?? "";
  const start = options.link
    ? await post("/link-social", { provider: "google", callbackURL: `${WEB_ORIGIN}/settings/security` }, cookie)
    : await post(
        "/sign-in/social",
        { provider: "google", callbackURL: `${WEB_ORIGIN}/`, errorCallbackURL: `${WEB_ORIGIN}/sign-in` },
        cookie,
      );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state") ?? "";
  const jar = mergeCookies(cookie, cookiesOf(start));
  const res = await app.request(`/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie: jar },
  });
  return { status: res.status, location: res.headers.get("location") ?? "", cookie: mergeCookies(jar, cookiesOf(res)) };
}

async function sessionOf(cookie: string) {
  const res = await app.request("/api/auth/get-session", { headers: { cookie } });
  return (await res.json()) as { user: { id: string; email: string } } | null;
}

async function memberUser(options: { verified?: boolean } = {}) {
  const { id: tenantId } = await createTenant(pool, { name: "G", slug: `g-${randomUUID().slice(0, 8)}` });
  const email = `ada-${randomUUID().slice(0, 8)}@test.test`;
  const userId = await ensurePasswordUser(db, { email, name: "Ada", password: DEMO_PASSWORD });
  if (options.verified === false) await pool.query("update users set email_verified = false where id = $1", [userId]);
  await addMembership(db, userId, tenantId, "admin");
  return { tenantId, userId, email };
}

async function googleAccounts(userId: string) {
  const { rows } = await pool.query<{
    id: string;
    accountId: string;
    accessToken: string | null;
    refreshToken: string | null;
    idToken: string | null;
  }>(
    `select id, account_id as "accountId", access_token as "accessToken", refresh_token as "refreshToken",
            id_token as "idToken"
     from accounts where user_id = $1 and provider_id = 'google'`,
    [userId],
  );
  return rows;
}

/** Makes a user Google-only (no password to sign in or confirm with). */
const dropPassword = (userId: string) =>
  pool.query("delete from accounts where user_id = $1 and provider_id = 'credential'", [userId]);

beforeEach(() => {
  profile = {};
});

describe("Sign in with Google", () => {
  it("is offered when the instance has a Google client", async () => {
    const res = await app.request("/auth/providers");
    expect(AuthProvidersResponse.parse(await res.json())).toEqual({ google: true });
  });

  it("signs in an existing verified user, links the account, keeps no Google tokens and audits the link", async () => {
    const { tenantId, userId, email } = await memberUser();
    const signIn = await viaGoogle(googleProfile(email.toUpperCase()));
    expect(signIn.location).toBe(`${WEB_ORIGIN}/`);
    expect((await sessionOf(signIn.cookie))?.user.id).toBe(userId);

    const [account] = await googleAccounts(userId);
    expect(account).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
    const { events } = await withTenantTx(pool, tenantId, (tx) => listAuditEvents(tx, { limit: 10 }));
    expect(events.map((e) => e.action)).toContain("auth.google_linked");

    // The second time, it's a plain sign-in to the linked account (and still no tokens are kept).
    const again = await viaGoogle({ ...googleProfile(email), sub: account?.accountId });
    expect((await sessionOf(again.cookie))?.user.id).toBe(userId);
    expect(await googleAccounts(userId)).toMatchObject([{ accessToken: null, refreshToken: null }]);
  });

  it("creates no user for an email nobody invited", async () => {
    const email = `stranger-${randomUUID().slice(0, 8)}@test.test`;
    const res = await viaGoogle(googleProfile(email));
    expect(res.location).toBe(`${WEB_ORIGIN}/sign-in?error=not_invited&error_description=Not+invited+to+any+workspace`);
    expect(await sessionOf(res.cookie)).toBeNull();
    expect((await pool.query("select 1 from users where email = $1", [email])).rowCount).toBe(0);
  });

  it("links only when Google verified the email, and only to a verified user", async () => {
    const verified = await memberUser();
    const unverifiedGoogle = await viaGoogle(googleProfile(verified.email, { email_verified: false }));
    expect(new URL(unverifiedGoogle.location).searchParams.get("error")).toBe("account_not_linked");
    expect(await googleAccounts(verified.userId)).toEqual([]);

    // Someone who accepted an invitation with a password hasn't proven the email: Google can't
    // take that account over (they link Google themselves, signed in).
    const invitee = await memberUser({ verified: false });
    const takeover = await viaGoogle(googleProfile(invitee.email));
    expect(new URL(takeover.location).searchParams.get("error")).toBe("account_not_linked");
    expect(await googleAccounts(invitee.userId)).toEqual([]);

    const session = await post("/sign-in/email", { email: invitee.email, password: DEMO_PASSWORD });
    const linked = await viaGoogle(googleProfile(invitee.email), { cookie: cookiesOf(session), link: true });
    expect(linked.location).toBe(`${WEB_ORIGIN}/settings/security`);
    expect(await googleAccounts(invitee.userId)).toHaveLength(1);
  });

  it("asks a user with 2FA for the code after Google, as after a password", async () => {
    const { userId, email } = await memberUser();
    const password = await post("/sign-in/email", { email, password: DEMO_PASSWORD });
    const enabled = (await (
      await post("/two-factor/enable", { password: DEMO_PASSWORD }, cookiesOf(password))
    ).json()) as {
      totpURI: string;
    };
    const secret = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
    expect((await post("/two-factor/verify-totp", { code: totp(secret) }, cookiesOf(password))).ok).toBe(true);

    const google = await viaGoogle(googleProfile(email));
    expect(google.location).toBe(`${WEB_ORIGIN}/sign-in?step=two-factor`);
    expect(await sessionOf(google.cookie)).toBeNull();

    expect((await post("/two-factor/verify-totp", { code: "000000" }, google.cookie)).ok).toBe(false);
    const verified = await post("/two-factor/verify-totp", { code: totp(secret) }, google.cookie);
    expect(verified.status).toBe(200);
    expect((await sessionOf(mergeCookies(google.cookie, cookiesOf(verified))))?.user.id).toBe(userId);
  });

  it("lets a Google-only user set up 2FA without a password, but only soon after signing in", async () => {
    const { userId, email } = await memberUser();
    // Make the user Google-only: link Google, then drop the password account.
    await viaGoogle(googleProfile(email));
    await dropPassword(userId);
    const [account] = await googleAccounts(userId);
    const signIn = await viaGoogle({ ...googleProfile(email), sub: account?.accountId });

    const enable = await post("/two-factor/enable", {}, signIn.cookie);
    expect(enable.status).toBe(200);

    t.setNow(new Date(Date.now() + 11 * 60_000));
    try {
      const late = await post("/two-factor/enable", {}, signIn.cookie);
      expect(late.status).toBe(403);
      expect(ErrorResponse.parse(await late.json()).code).toBe("recent_sign_in_required");
    } finally {
      t.setNow(null);
    }
  });

  it("won't unlink the last way to sign in", async () => {
    const { userId, email } = await memberUser();
    await viaGoogle(googleProfile(email));
    await dropPassword(userId);
    const [account] = await googleAccounts(userId);
    const signIn = await viaGoogle({ ...googleProfile(email), sub: account?.accountId });
    const res = await post("/unlink-account", { accountId: account?.id }, signIn.cookie);
    expect(res.status).toBe(400);
    expect(await googleAccounts(userId)).toHaveLength(1);
  });

  it("unlinks Google from a user who also has a password, and audits it", async () => {
    const { tenantId, userId, email } = await memberUser();
    await viaGoogle(googleProfile(email));
    const [account] = await googleAccounts(userId);
    const session = await post("/sign-in/email", { email, password: DEMO_PASSWORD });
    const res = await post("/unlink-account", { accountId: account?.id }, cookiesOf(session));
    expect(res.status).toBe(200);
    expect(await googleAccounts(userId)).toEqual([]);
    const { events } = await withTenantTx(pool, tenantId, (tx) => listAuditEvents(tx, { limit: 10 }));
    expect(events.map((e) => e.action)).toContain("auth.google_unlinked");
  });
});
