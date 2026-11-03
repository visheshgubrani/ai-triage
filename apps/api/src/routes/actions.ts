import type { DeliveryFailureList, RedeliverResponse } from "@ai-triage/contracts";
import {
  listDeliveryFailures,
  loadDelivery,
  ReviewError,
  recordAudit,
  requeueAction,
  withTenantTx,
} from "@ai-triage/db";
import { Hono } from "hono";
import { userActor } from "../audit";
import type { AppDeps } from "../deps";
import { limitUserWrites } from "../rate-limit";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { idParam } from "./documents";

/** The outbox: the "Delivery failures" view and manual Redeliver (same Idempotency-Key, new attempt). */
export const actionRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(requireTenant(deps), limitUserWrites(deps, deps.rateLimits.writesPerUser))
    .get("/failed", async (c) => {
      const rows = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) => listDeliveryFailures(tx));
      const body: DeliveryFailureList = {
        failures: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
      return c.json(body, 200);
    })
    .post("/:id/redeliver", requireRole("admin", "reviewer"), idParam, async (c) => {
      const actionId = c.req.valid("param").id;
      const found = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        if (!(await loadDelivery(tx, actionId))) return false;
        if (!(await requeueAction(tx, deps.boss, actionId))) {
          throw new ReviewError("not_redeliverable", "Only a failed or delivered action can be redelivered.");
        }
        await recordAudit(tx, userActor(c, deps), {
          action: "action.redelivered",
          target: { type: "action", id: actionId },
        });
        return true;
      });
      if (!found) return c.json({ error: "Not found" }, 404);
      const body: RedeliverResponse = { actionId, status: "pending" };
      return c.json(body, 200);
    });
