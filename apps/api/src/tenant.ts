import type { ErrorResponse } from "@ai-triage/contracts";
import type { MemberRole } from "@ai-triage/core";
import { getMembership } from "@ai-triage/db";
import { createMiddleware } from "hono/factory";
import type { AppDeps } from "./deps";

export interface TenantContext {
  tenantId: string;
  role: MemberRole;
  user: { id: string; email: string; name: string };
  /** The user has TOTP turned on. */
  twoFactorEnabled: boolean;
  /** An admin who must turn on 2FA before admin-only routes work (REQUIRE_ADMIN_2FA). */
  twoFactorRequired: boolean;
}

export type TenantEnv = { Variables: { tenant: TenantContext } };

/**
 * Resolves the session's active tenant and the user's role in it. 401 without a session; 403 when
 * the session has no active tenant or the user isn't a member of it (memberships are re-checked on
 * every request, so a removed member loses access immediately). Handlers then use
 * `c.var.tenant.tenantId` with withTenantTx().
 */
export const requireTenant = (deps: Pick<AppDeps, "db" | "auth" | "requireAdmin2fa">) =>
  createMiddleware<TenantEnv>(async (c, next) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Not signed in" }, 401);
    const tenantId = session.session.activeOrganizationId;
    const membership = tenantId ? await getMembership(deps.db, session.user.id, tenantId) : null;
    if (!tenantId || !membership) return c.json({ error: "No access to a tenant" }, 403);
    const { id, email, name } = session.user;
    const twoFactorEnabled = session.user.twoFactorEnabled === true;
    c.set("tenant", {
      tenantId,
      role: membership.role,
      user: { id, email, name },
      twoFactorEnabled,
      twoFactorRequired: deps.requireAdmin2fa && membership.role === "admin" && !twoFactorEnabled,
    });
    await next();
  });

/**
 * Use after requireTenant(). A route only an admin may use also needs the admin's 2FA when the
 * deployment requires it (403 `two_factor_required`); routes reviewers share don't.
 */
export const requireRole = (...roles: MemberRole[]) =>
  createMiddleware<TenantEnv>(async (c, next) => {
    if (!roles.includes(c.var.tenant.role)) return c.json({ error: "Insufficient role" }, 403);
    if (roles.every((r) => r === "admin") && c.var.tenant.twoFactorRequired) {
      const body: ErrorResponse = {
        error: "Turn on two-factor authentication (Settings → Security) to use admin settings.",
        code: "two_factor_required",
      };
      return c.json(body, 403);
    }
    await next();
  });
