import {
  ClaimNextRequest,
  type ClaimNextResponse,
  type ClaimResponse,
  ClaimTokenRequest,
  DecisionRequest,
  type HeartbeatResponse,
  type InboxAge,
  InboxQuery,
  type InboxResponse,
  type InboxTask,
  type ReleaseResponse,
} from "@ai-triage/contracts";
import {
  type Claim,
  claimNext,
  claimTask,
  heartbeat,
  inboxCounts,
  listInbox,
  releaseClaim,
  withTenantTx,
} from "@ai-triage/db";
import { Hono } from "hono";
import type { AppDeps } from "../deps";
import { decide } from "../review";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";
import { idParam } from "./documents";

const AGE_MS: Record<InboxAge, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

const inboxTask = (r: Awaited<ReturnType<typeof listInbox>>[number]): InboxTask => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  claim: r.claim && { ...r.claim, leaseExpiresAt: r.claim.leaseExpiresAt?.toISOString() ?? "" },
});

const claimBody = (claim: Claim): ClaimResponse => ({
  taskId: claim.taskId,
  documentId: claim.documentId,
  claimToken: claim.claimToken,
  leaseExpiresAt: claim.leaseExpiresAt.toISOString(),
});

/**
 * The review queue (docs/architecture.md §7). Any member may read the inbox; claiming and deciding
 * need the reviewer or admin role. Refusals carry a `code` (see REVIEW_ERROR_STATUS).
 */
export const reviewRoutes = (deps: AppDeps) => {
  const reviewer = requireRole("admin", "reviewer");
  return new Hono<TenantEnv>()
    .use(requireTenant(deps.db, deps.auth))
    .get("/tasks", validate("query", InboxQuery), async (c) => {
      const q = c.req.valid("query");
      const now = deps.now();
      const filter = {
        kind: q.kind,
        category: q.category,
        reasonCode: q.reason,
        olderThan: q.olderThan ? new Date(now.getTime() - AGE_MS[q.olderThan]) : undefined,
        mineUserId: q.mine ? c.var.tenant.user.id : undefined,
      };
      const body: InboxResponse = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => ({
        tasks: (await listInbox(tx, { now, filter })).map(inboxTask),
        counts: await inboxCounts(tx),
      }));
      return c.json(body, 200);
    })
    .get("/tasks/:id", idParam, async (c) => {
      const [row] = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        listInbox(tx, { now: deps.now(), filter: { taskId: c.req.valid("param").id } }),
      );
      if (!row) return c.json({ error: "Not found" }, 404);
      return c.json(inboxTask(row), 200);
    })
    .post("/claim-next", reviewer, validate("json", ClaimNextRequest), async (c) => {
      const filter = c.req.valid("json");
      const claim = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        claimNext(tx, { userId: c.var.tenant.user.id, now: deps.now(), filter }),
      );
      const body: ClaimNextResponse = { claim: claim && claimBody(claim) };
      return c.json(body, 200);
    })
    .post("/tasks/:id/claim", reviewer, idParam, async (c) => {
      const claim = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        claimTask(tx, { taskId: c.req.valid("param").id, userId: c.var.tenant.user.id, now: deps.now() }),
      );
      if (!claim) return c.json({ error: "Not found" }, 404);
      return c.json(claimBody(claim), 200);
    })
    .post("/tasks/:id/heartbeat", reviewer, idParam, validate("json", ClaimTokenRequest), async (c) => {
      const lease = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        heartbeat(tx, {
          taskId: c.req.valid("param").id,
          userId: c.var.tenant.user.id,
          claimToken: c.req.valid("json").claimToken,
          now: deps.now(),
        }),
      );
      const body: HeartbeatResponse = { leaseExpiresAt: lease.toISOString() };
      return c.json(body, 200);
    })
    .post("/tasks/:id/release", reviewer, idParam, validate("json", ClaimTokenRequest), async (c) => {
      const released = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        releaseClaim(tx, {
          taskId: c.req.valid("param").id,
          userId: c.var.tenant.user.id,
          claimToken: c.req.valid("json").claimToken,
          now: deps.now(),
        }),
      );
      const body: ReleaseResponse = { released };
      return c.json(body, 200);
    })
    .post("/tasks/:id/decisions", reviewer, idParam, validate("json", DecisionRequest), async (c) => {
      const result = await decide(deps, c.var.tenant, c.req.valid("param").id, c.req.valid("json"));
      if (!result) return c.json({ error: "Not found" }, 404);
      return c.json(result, 200);
    });
};
