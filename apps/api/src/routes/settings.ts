import {
  type AuditEventList,
  AuditQuery,
  type ErrorResponse,
  WebhookSettingsRequest,
  type WebhookSettingsResponse,
} from "@ai-triage/contracts";
import {
  getWebhookSettings,
  listAuditEvents,
  recordAudit,
  rotateWebhookSecret,
  setWebhook,
  withTenantTx,
} from "@ai-triage/db";
import { Hono } from "hono";
import { userActor } from "../audit";
import type { AppDeps } from "../deps";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";

/**
 * Tenant settings (admins only). The webhook target: deliveries go only here (docs/architecture.md
 * §3), and the signing secret is returned once, when it is created or rotated. The audit log of
 * security-relevant changes (docs/security.md).
 */
export const settingsRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(requireTenant(deps.db, deps.auth), requireRole("admin"))
    .get("/webhook", async (c) => {
      const settings = await withTenantTx(deps.pool, c.var.tenant.tenantId, getWebhookSettings);
      return c.json(settings, 200);
    })
    .put("/webhook", validate("json", WebhookSettingsRequest), async (c) => {
      const { url } = c.req.valid("json");
      if (url && !url.startsWith("https://") && !deps.webhooks.allowHttp) {
        const body: ErrorResponse = {
          error: "The webhook URL must use https.",
          issues: [{ field: "url", path: "/url", message: "must use https (http is allowed only in development)" }],
        };
        return c.json(body, 400);
      }
      const body: WebhookSettingsResponse = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const { secret } = await setWebhook(tx, { url });
        await recordAudit(tx, userActor(c, deps), {
          action: "settings.webhook_updated",
          details: { url, secretCreated: secret !== null },
        });
        return { settings: await getWebhookSettings(tx), secret };
      });
      return c.json(body, 200);
    })
    .post("/webhook/rotate", async (c) => {
      const body: WebhookSettingsResponse = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const secret = await rotateWebhookSecret(tx);
        await recordAudit(tx, userActor(c, deps), { action: "settings.webhook_secret_rotated" });
        return { settings: await getWebhookSettings(tx), secret };
      });
      return c.json(body, 200);
    })
    .get("/audit", validate("query", AuditQuery), async (c) => {
      const { cursor } = c.req.valid("query");
      const page = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        listAuditEvents(tx, { cursor, limit: 50 }),
      );
      const body: AuditEventList = {
        events: page.events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
        nextCursor: page.nextCursor,
      };
      return c.json(body, 200);
    });
