import type { ErrorResponse } from "@ai-triage/contracts";
import { hasPassword, recordUserAudit, userSecurityState } from "@ai-triage/db";
import type { Context } from "hono";
import { clientIp } from "./client-ip";
import type { AppDeps } from "./deps";
import { overLimit } from "./rate-limit";

// The Better Auth endpoints the web uses (docs/security.md): an allowlist, rate limits keyed on the
// trusted client IP (and the account, for sign-in), audit events when 2FA is turned on or off, and a
// recent sign-in for 2FA changes by users without a password. Linking Google is audited in
// packages/db/src/auth.ts.

/**
 * Everything else under /api/auth is 404: Better Auth's organization endpoints (the app has its own
 * members and invitations routes), sign-up (closed), and update-user (it could set fields such as
 * the Workspace domain).
 */
export const AUTH_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-in/social",
  "/api/auth/callback/google",
  "/api/auth/link-social",
  "/api/auth/list-accounts",
  "/api/auth/unlink-account",
  "/api/auth/sign-out",
  "/api/auth/get-session",
  "/api/auth/change-password",
  "/api/auth/list-sessions",
  "/api/auth/revoke-session",
  "/api/auth/revoke-other-sessions",
  "/api/auth/two-factor/enable",
  "/api/auth/two-factor/disable",
  "/api/auth/two-factor/get-totp-uri",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
  "/api/auth/two-factor/generate-backup-codes",
]);

/** Code checks: six digits can be guessed, so they get a tight limit (Better Auth also locks out). */
const CODE_PATHS = new Set(["/api/auth/two-factor/verify-totp", "/api/auth/two-factor/verify-backup-code"]);
/** Calls that can turn 2FA on (the first verified code after enabling) or off. */
const TWO_FACTOR_CHANGES = new Set(["/api/auth/two-factor/verify-totp", "/api/auth/two-factor/disable"]);
/** Calls that set up, show or remove a second factor: Better Auth asks for the password, if there is one. */
const TWO_FACTOR_SETUP = new Set([
  "/api/auth/two-factor/enable",
  "/api/auth/two-factor/disable",
  "/api/auth/two-factor/get-totp-uri",
  "/api/auth/two-factor/generate-backup-codes",
]);
/**
 * Without a password to confirm with (a Google-only user), a 2FA change needs a session this
 * recent, so a stolen session cookie can't turn 2FA off or read the TOTP secret. A user with 2FA
 * passed TOTP to get that session.
 */
export const RECENT_SIGN_IN_SECONDS = 10 * 60;

/** The account a sign-in attempt is for (read from a copy, so Better Auth still gets the body). */
async function signInEmail(request: Request): Promise<string> {
  try {
    const body = (await request.clone().json()) as { email?: unknown };
    return typeof body.email === "string" ? body.email.trim().toLowerCase() : "none";
  } catch {
    return "none";
  }
}

async function limited(c: Context, deps: AppDeps): Promise<Response | null> {
  const ip = clientIp(c, deps.trustedProxies) ?? "unknown";
  const { rateLimits } = deps;
  if (c.req.path === "/api/auth/sign-in/social") return overLimit(c, deps, rateLimits.signInPerIp, `ip:${ip}:sign-in`);
  if (c.req.path === "/api/auth/sign-in/email") {
    return (
      (await overLimit(c, deps, rateLimits.signInPerIp, `ip:${ip}:sign-in`)) ??
      (await overLimit(c, deps, rateLimits.signInPerEmail, `email:${await signInEmail(c.req.raw)}:sign-in`))
    );
  }
  if (CODE_PATHS.has(c.req.path)) return overLimit(c, deps, rateLimits.signInPerIp, `ip:${ip}:2fa`);
  return overLimit(c, deps, rateLimits.authPerIp, `ip:${ip}:auth`);
}

export async function handleAuth(c: Context, deps: AppDeps): Promise<Response> {
  if (!AUTH_PATHS.has(c.req.path)) return c.notFound();
  const refused = await limited(c, deps);
  if (refused) return refused;
  const watched = TWO_FACTOR_CHANGES.has(c.req.path) || TWO_FACTOR_SETUP.has(c.req.path);
  if (!watched) return deps.auth.handler(c.req.raw);

  const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
  if (session && TWO_FACTOR_SETUP.has(c.req.path) && !(await hasPassword(deps.db, session.user.id))) {
    const age = (deps.now().getTime() - new Date(session.session.createdAt).getTime()) / 1000;
    if (age > RECENT_SIGN_IN_SECONDS) {
      const body: ErrorResponse = {
        error: "Sign in again to change two-factor authentication.",
        code: "recent_sign_in_required",
      };
      return c.json(body, 403);
    }
  }
  if (!TWO_FACTOR_CHANGES.has(c.req.path)) return deps.auth.handler(c.req.raw);

  // Turning 2FA on or off is recorded in every tenant the user belongs to.
  const before = session ? await userSecurityState(deps.db, session.user.id) : null;
  const res = await deps.auth.handler(c.req.raw);
  if (session && before && res.ok) {
    const after = await userSecurityState(deps.db, session.user.id);
    if (after.twoFactorEnabled !== before.twoFactorEnabled) {
      const actor = {
        type: "user" as const,
        id: session.user.id,
        label: session.user.email,
        ip: clientIp(c, deps.trustedProxies),
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId"),
      };
      const action = after.twoFactorEnabled ? "auth.two_factor_enabled" : "auth.two_factor_disabled";
      await recordUserAudit(deps.pool, session.user.id, actor, {
        action,
        target: { type: "user", id: session.user.id },
      });
    }
  }
  return res;
}
