import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { cookiesOf, mergeCookies, TEST_GOOGLE, WEB_ORIGIN } from "./test-app";

// A stand-in for Google in API tests. Better Auth's Google provider posts to Google's token
// endpoint and only decodes the ID token it gets back (it comes straight from Google over TLS), so
// stubbing that one URL on the global fetch lets an unsigned ID token carry any profile.

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

/** A Google account's ID token claims (`sub` is the account id). */
export const googleProfile = (email: string, extra: Record<string, unknown> = {}) => ({
  sub: `g-${randomUUID()}`,
  email,
  email_verified: true,
  name: "Ada Google",
  picture: "https://example.test/ada.png",
  ...extra,
});

export function stubGoogle(app: App) {
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

  /**
   * Starts a Google sign-in (or, with `link`, links Google to the signed-in user), returns from
   * Google with `claims` as the profile, and gives back where Better Auth redirected plus the cookies.
   */
  async function viaGoogle(
    claims: Record<string, unknown>,
    options: { cookie?: string; link?: boolean; callbackPath?: string } = {},
  ) {
    profile = claims;
    const cookie = options.cookie ?? "";
    const callbackURL = `${WEB_ORIGIN}${options.callbackPath ?? (options.link ? "/settings/security" : "/")}`;
    const start = options.link
      ? await post("/link-social", { provider: "google", callbackURL }, cookie)
      : await post(
          "/sign-in/social",
          { provider: "google", callbackURL, errorCallbackURL: `${WEB_ORIGIN}/sign-in` },
          cookie,
        );
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";
    const jar = mergeCookies(cookie, cookiesOf(start));
    const res = await app.request(`/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: jar },
    });
    return {
      status: res.status,
      location: res.headers.get("location") ?? "",
      cookie: mergeCookies(jar, cookiesOf(res)),
    };
  }

  async function sessionOf(cookie: string) {
    const res = await app.request("/api/auth/get-session", { headers: { cookie } });
    return (await res.json()) as {
      user: { id: string; email: string };
      session: { activeOrganizationId: string | null };
    } | null;
  }

  return { viaGoogle, sessionOf, post };
}
