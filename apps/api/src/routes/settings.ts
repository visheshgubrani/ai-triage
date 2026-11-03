import { type ErrorResponse, WebhookSettingsRequest, type WebhookSettingsResponse } from "@ai-triage/contracts";
import { getWebhookSettings, rotateWebhookSecret, setWebhook, withTenantTx } from "@ai-triage/db";
import { Hono } from "hono";
import type { AppDeps } from "../deps";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";

/**
 * The tenant's webhook target (admins only). Deliveries go only here (docs/architecture.md §3). The
 * signing secret is returned once, when it is created or rotated.
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
        return { settings: await getWebhookSettings(tx), secret };
      });
      return c.json(body, 200);
    })
    .post("/webhook/rotate", async (c) => {
      const body: WebhookSettingsResponse = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const secret = await rotateWebhookSecret(tx);
        return { settings: await getWebhookSettings(tx), secret };
      });
      return c.json(body, 200);
    });
