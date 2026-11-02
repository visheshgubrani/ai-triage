import type { MemberRole } from "@ai-triage/core";
import { type Auth, type Db, getMembership } from "@ai-triage/db";
import { createMiddleware } from "hono/factory";

export interface TenantContext {
  tenantId: string;
  role: MemberRole;
  user: { id: string; email: string; name: string };
}

export type TenantEnv = { Variables: { tenant: TenantContext } };

/**
 * Resolves the session's active tenant and the user's role in it. 401 without a session; 403 when
 * the session has no active tenant or the user isn't a member of it (memberships are re-checked on
 * every request, so a removed member loses access immediately). Handlers then use
 * `c.var.tenant.tenantId` with withTenantTx().
 */
export const requireTenant = (db: Db, auth: Auth) =>
  createMiddleware<TenantEnv>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Not signed in" }, 401);
    const tenantId = session.session.activeOrganizationId;
    const membership = tenantId ? await getMembership(db, session.user.id, tenantId) : null;
    if (!tenantId || !membership) return c.json({ error: "No access to a tenant" }, 403);
    const { id, email, name } = session.user;
    c.set("tenant", { tenantId, role: membership.role, user: { id, email, name } });
    await next();
  });

/** Use after requireTenant(). */
export const requireRole = (...roles: MemberRole[]) =>
  createMiddleware<TenantEnv>(async (c, next) => {
    if (!roles.includes(c.var.tenant.role)) return c.json({ error: "Insufficient role" }, 403);
    await next();
  });
