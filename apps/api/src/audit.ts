import type { AuditActor } from "@ai-triage/db";
import type { Context } from "hono";
import { clientIp } from "./client-ip";
import type { AppDeps } from "./deps";
import type { TenantEnv } from "./tenant";

/** The signed-in member behind this request, with its request context, for recordAudit(). */
export const userActor = (c: Context<TenantEnv>, deps: AppDeps): AuditActor => ({
  type: "user",
  id: c.var.tenant.user.id,
  label: c.var.tenant.user.email,
  ip: clientIp(c, deps.trustedProxies),
  userAgent: c.req.header("user-agent") ?? null,
  requestId: c.get("requestId"),
});
