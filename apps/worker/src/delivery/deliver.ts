import { type DeliverJob, WEBHOOK_EVENT, WEBHOOK_HEADERS } from "@ai-triage/core";
import {
  loadDelivery,
  markDelivered,
  markDeliveryFailed,
  recordAttempt,
  webhookTarget,
  withTenantTx,
} from "@ai-triage/db";
import type { DeliveryDeps } from "./deps";
import { isEgressBlocked } from "./egress";
import { signWebhook } from "./sign";

// `action.deliver` (docs/architecture.md §5): read the action and the tenant's webhook target, POST
// with no transaction open, then record the outcome. Delivery is at least once: a crash after the
// receiver answered but before the commit sends it again, with the same Idempotency-Key.

type Outcome = { ok: true } | { ok: false; permanent: boolean; error: string };

/** The receiver said no in a way retrying won't change. 408, 425 and 429 mean "try again later". */
const isPermanent = (status: number) =>
  (status >= 300 && status < 400) || (status >= 400 && status < 500 && ![408, 425, 429].includes(status));

/** How much of a receiver's error response is read (and the start of it kept in last_error). */
const MAX_RESPONSE_BYTES = 4096;

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString("utf8");
}

async function post(
  deps: DeliveryDeps,
  url: string,
  secrets: readonly string[],
  actionId: string,
  body: string,
): Promise<Outcome> {
  try {
    const res = await deps.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "ai-triage-webhooks/1",
        [WEBHOOK_HEADERS.idempotencyKey]: actionId,
        [WEBHOOK_HEADERS.event]: WEBHOOK_EVENT,
        [WEBHOOK_HEADERS.signature]: signWebhook(secrets, actionId, body, deps.now()),
      },
      body,
      // A redirect is a misconfigured URL: don't follow it, and don't send the payload somewhere else.
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const text = (await readCapped(res).catch(() => "")).slice(0, 300);
    return { ok: false, permanent: isPermanent(res.status), error: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
  } catch (err) {
    // The URL (or what it resolves to) isn't allowed: retrying won't change that.
    if (isEgressBlocked(err)) {
      return {
        ok: false,
        permanent: true,
        error: "webhook URL not allowed: it must be public https (see docs/security.md)",
      };
    }
    // Members can read this, so it stays generic: no addresses or socket details.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      permanent: false,
      error: timedOut ? `timed out after ${deps.timeoutMs} ms` : "connection failed",
    };
  }
}

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

  const outcome = await post(deps, target.url, target.secrets, job.actionId, JSON.stringify(target.action.payload));
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
