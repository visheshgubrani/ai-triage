import { type DeliverJob, WEBHOOK_EVENT } from "@ai-triage/core";
import {
  loadDelivery,
  markDelivered,
  markDeliveryFailed,
  recordAttempt,
  webhookTarget,
  withTenantTx,
} from "@ai-triage/db";
import { postWebhook } from "@ai-triage/webhooks";
import type { DeliveryDeps } from "./deps";

// `action.deliver` (docs/architecture.md §5): read the action and the tenant's webhook target, POST
// with no transaction open, then record the outcome. Delivery is at least once: a crash after the
// receiver answered but before the commit sends it again, with the same Idempotency-Key.

/**
 * Delivers one action. Returns after a success or a permanent failure (the action is marked failed);
 * throws on a transient failure so pg-boss retries, then dead-letters to `action.failed`.
 */
export async function deliverAction(deps: DeliveryDeps, job: DeliverJob): Promise<void> {
  const target = await withTenantTx(deps.pool, job.tenantId, async (tx) => {
    const action = await loadDelivery(tx, job.actionId);
    return action ? { action, ...(await webhookTarget(tx, deps.keys, deps.now())) } : null;
  });
  // Delivered already (a duplicate job), or failed and not redelivered: nothing to do.
  if (target?.action.status !== "pending") return;
  const fail = (error: string) =>
    withTenantTx(deps.pool, job.tenantId, (tx) =>
      markDeliveryFailed(tx, { actionId: job.actionId, error, countAttempt: true }),
    );
  if (!target.url || target.secrets.length === 0) {
    await fail("no webhook URL configured for this tenant");
    return;
  }

  const outcome = await postWebhook({
    fetch: deps.fetch,
    url: target.url,
    secrets: target.secrets,
    idempotencyKey: job.actionId,
    event: WEBHOOK_EVENT,
    body: JSON.stringify(target.action.payload),
    now: deps.now(),
    timeoutMs: deps.timeoutMs,
  });
  if (outcome.ok) {
    await withTenantTx(deps.pool, job.tenantId, (tx) => markDelivered(tx, { actionId: job.actionId, at: deps.now() }));
  } else if (outcome.permanent) {
    await fail(outcome.error);
  } else {
    await withTenantTx(deps.pool, job.tenantId, (tx) =>
      recordAttempt(tx, { actionId: job.actionId, error: outcome.error }),
    );
    throw new Error(outcome.error);
  }
}

/** `action.failed`: a delivery ran out of retries. Its last attempt was already counted. */
export async function deliveryFailed(deps: DeliveryDeps, job: DeliverJob, source: { output: unknown }): Promise<void> {
  const output = source.output as { message?: unknown } | null;
  const message = typeof output?.message === "string" ? output.message : "retries exhausted";
  await withTenantTx(deps.pool, job.tenantId, (tx) =>
    markDeliveryFailed(tx, { actionId: job.actionId, error: `retries exhausted: ${message}`, countAttempt: false }),
  );
}
