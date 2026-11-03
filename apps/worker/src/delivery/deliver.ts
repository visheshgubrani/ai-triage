import { type DeliverJob, WEBHOOK_EVENT, WEBHOOK_HEADERS } from "@ai-triage/core";
import { loadDelivery, markDelivered, markDeliveryFailed, recordAttempt, withTenantTx } from "@ai-triage/db";
import type { DeliveryDeps } from "./deps";
import { signWebhook } from "./sign";

// `action.deliver` (docs/architecture.md §5): read the action and the tenant's webhook target, POST
// with no transaction open, then record the outcome. Delivery is at least once: a crash after the
// receiver answered but before the commit sends it again, with the same Idempotency-Key.

type Outcome = { ok: true } | { ok: false; permanent: boolean; error: string };

/** The receiver said no in a way retrying won't change. 408, 425 and 429 mean "try again later". */
const isPermanent = (status: number) =>
  (status >= 300 && status < 400) || (status >= 400 && status < 500 && ![408, 425, 429].includes(status));

async function post(deps: DeliveryDeps, url: string, secret: string, actionId: string, body: string): Promise<Outcome> {
  try {
    const res = await deps.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "ai-triage-webhooks/1",
        [WEBHOOK_HEADERS.idempotencyKey]: actionId,
        [WEBHOOK_HEADERS.event]: WEBHOOK_EVENT,
        [WEBHOOK_HEADERS.signature]: signWebhook(secret, body, deps.now()),
      },
      body,
      // A redirect is a misconfigured URL: don't follow it, and don't send the payload somewhere else.
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const text = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, permanent: isPermanent(res.status), error: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
  } catch (err) {
    const error =
      err instanceof Error && err.name === "TimeoutError" ? `timed out after ${deps.timeoutMs} ms` : String(err);
    return { ok: false, permanent: false, error };
  }
}

/**
 * Delivers one action. Returns after a success or a permanent failure (the action is marked failed);
 * throws on a transient failure so pg-boss retries, then dead-letters to `action.failed`.
 */
export async function deliverAction(deps: DeliveryDeps, job: DeliverJob): Promise<void> {
  const target = await withTenantTx(deps.pool, job.tenantId, (tx) => loadDelivery(tx, job.actionId));
  // Delivered already (a duplicate job), or failed and not redelivered: nothing to do.
  if (target?.action.status !== "pending") return;
  const fail = (error: string) =>
    withTenantTx(deps.pool, job.tenantId, (tx) =>
      markDeliveryFailed(tx, { actionId: job.actionId, error, countAttempt: true }),
    );
  if (!target.url || !target.secret) {
    await fail("no webhook URL configured for this tenant");
    return;
  }

  const outcome = await post(deps, target.url, target.secret, job.actionId, JSON.stringify(target.action.payload));
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
