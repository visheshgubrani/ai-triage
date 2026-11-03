import { recordAudit, userSecurityState, withTenantTx } from "@ai-triage/db";
import type { Context } from "hono";
import { clientIp } from "./client-ip";
import type { AppDeps } from "./deps";
import { overLimit } from "./rate-limit";

// The Better Auth endpoints the web uses (docs/security.md): an allowlist, rate limits keyed on the
// trusted client IP (and the account, for sign-in), and audit events when 2FA is turned on or off.

/**
 * Everything else under /api/auth is 404: organization endpoints (members, roles, invitations)
 * have no UI or audit yet, and sign-up is closed anyway.
 */
export const AUTH_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/sign-in/email",
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
  if (!TWO_FACTOR_CHANGES.has(c.req.path)) return deps.auth.handler(c.req.raw);

  // Turning 2FA on or off is recorded in every tenant the user belongs to.
  const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
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
      for (const tenantId of after.tenantIds) {
        await withTenantTx(deps.pool, tenantId, (tx) =>
          recordAudit(tx, actor, { action, target: { type: "user", id: session.user.id } }),
        );
      }
    }
  }
  return res;
}
