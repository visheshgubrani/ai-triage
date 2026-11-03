import {
  type AuditEventList,
  AuditQuery,
  BudgetRequest,
  type BudgetSettings,
  type ErrorResponse,
  type InboundSettings,
  WebhookSettingsRequest,
  type WebhookSettingsResponse,
} from "@ai-triage/contracts";
import {
  getBudget,
  getWebhookSettings,
  listAuditEvents,
  listInboundAddresses,
  recordAudit,
  rotateInboundAddress,
  rotateWebhookSecret,
  setBudgetCap,
  setWebhook,
  withTenantTx,
} from "@ai-triage/db";
import { Hono } from "hono";
import { userActor } from "../audit";
import type { AppDeps } from "../deps";
import { limitUserWrites } from "../rate-limit";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";
import { webhookUrlProblem } from "../webhook-url";

/**
 * Tenant settings (admins only). The webhook target: deliveries go only here (docs/architecture.md
 * §3), and the signing secret is returned once, when it is created or rotated. The audit log of
 * security-relevant changes (docs/security.md).
 */
export const settingsRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(requireTenant(deps.db, deps.auth), requireRole("admin"), limitUserWrites(deps, deps.rateLimits.writesPerUser))
    .get("/webhook", async (c) => {
      const settings = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        getWebhookSettings(tx, deps.keys, deps.now()),
      );
      return c.json(settings, 200);
    })
    .put("/webhook", validate("json", WebhookSettingsRequest), async (c) => {
      const { url } = c.req.valid("json");
      // Deliveries must not reach the operator's network (SSRF): public https hosts only, unless
      // the operator allowlisted the host (WEBHOOK_ALLOWED_HOSTS).
      const problem = url ? await webhookUrlProblem(url, deps.webhookEgress) : null;
      if (problem) {
        const body: ErrorResponse = {
          error: `The webhook URL ${problem}.`,
          issues: [{ field: "url", path: "/url", message: problem }],
        };
        return c.json(body, 400);
      }
      const body: WebhookSettingsResponse = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const { secret } = await setWebhook(tx, deps.keys, { url });
        await recordAudit(tx, userActor(c, deps), {
          action: "settings.webhook_updated",
          details: { url, secretCreated: secret !== null },
        });
        return { settings: await getWebhookSettings(tx, deps.keys, deps.now()), secret };
      });
      return c.json(body, 200);
    })
    .post("/webhook/rotate", async (c) => {
      const body: WebhookSettingsResponse = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const secret = await rotateWebhookSecret(tx, deps.keys, deps.now());
        await recordAudit(tx, userActor(c, deps), { action: "settings.webhook_secret_rotated" });
        return { settings: await getWebhookSettings(tx, deps.keys, deps.now()), secret };
      });
      return c.json(body, 200);
    })
    .get("/inbound", async (c) => {
      const body: InboundSettings = {
        addresses: await withTenantTx(deps.pool, c.var.tenant.tenantId, listInboundAddresses),
      };
      return c.json(body, 200);
    })
    .post("/inbound/rotate", async (c) => {
      const body = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx): Promise<InboundSettings | null> => {
        if (!deps.inboundDomain && (await listInboundAddresses(tx)).length === 0) return null;
        const { from, to } = await rotateInboundAddress(tx, deps.inboundDomain ?? undefined);
        await recordAudit(tx, userActor(c, deps), { action: "settings.inbound_rotated", details: { from, to } });
        return { addresses: [to] };
      });
      if (!body) {
        const error: ErrorResponse = { error: "No inbound domain is configured (INBOUND_DOMAIN)." };
        return c.json(error, 409);
      }
      return c.json(body, 200);
    })
    .get("/budget", async (c) => {
      const body: BudgetSettings = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        getBudget(tx, deps.now()),
      );
      return c.json(body, 200);
    })
    .put("/budget", validate("json", BudgetRequest), async (c) => {
      const { capUsd } = c.req.valid("json");
      const body: BudgetSettings = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const before = await getBudget(tx, deps.now());
        await setBudgetCap(tx, capUsd, deps.now());
        await recordAudit(tx, userActor(c, deps), {
          action: "settings.budget_updated",
          details: { fromUsd: before.capUsd, toUsd: capUsd },
        });
        return getBudget(tx, deps.now());
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
