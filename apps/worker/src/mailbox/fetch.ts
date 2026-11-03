import { type MailboxFetchJob, QUEUES } from "@ai-triage/core";
import { normalizeEml } from "@ai-triage/core/pipeline";
import {
  createDb,
  fetchState,
  hitRateLimit,
  type MessageOutcome,
  mailboxTokenStore,
  markMailboxMessage,
  recordAudit,
  SYSTEM_ACTOR,
  withTenantTx,
} from "@ai-triage/db";
import { ingestEmail, MAX_ATTACHMENTS } from "@ai-triage/ingest";
import {
  getMessageMeta,
  getRawMessage,
  MailboxAuthError,
  MailboxRateLimitError,
  MessageGoneError,
  NOT_INBOUND_LABELS,
  withAccessToken,
} from "@ai-triage/mailbox";
import type { MailboxDeps } from "./deps";

// `mailbox.fetch`: downloads one message the sync listed and ingests it as a document (source
// `gmail`), the way an .eml is ingested, keeping the raw message as the source of record. The
// ledger row says what happened, and commits with the document. Retried by pg-boss on errors worth
// retrying; dead-lettered to `mailbox.failed`, which marks the row failed.

/** While a mailbox waits to be reconnected, its queued messages are retried this often. */
const REAUTH_RETRY_MS = 15 * 60_000;
/** Inbound email per tenant shares the Postmark bucket (apps/api/src/rate-limit.ts). */
const INBOUND_WINDOW_SECONDS = 3600;

/** Postmark's body limit for the same file limit: attachments are base64-encoded (4/3) plus headroom. */
const rawLimit = (maxFileBytes: number) => Math.ceil(maxFileBytes * 1.4) + 2 ** 20;

async function settle(deps: MailboxDeps, job: MailboxFetchJob, outcome: MessageOutcome) {
  await withTenantTx(deps.pool, job.tenantId, (tx) => markMailboxMessage(tx, job.connectionId, job.messageId, outcome));
}

/** Puts the message back for later (a rate limit, a mailbox to reconnect): a new job, the same row. */
async function defer(deps: MailboxDeps, job: MailboxFetchJob, until: Date) {
  await settle(deps, job, { status: "deferred" });
  await deps.boss.send(QUEUES.mailboxFetch, job, { startAfter: until });
}

export async function fetchMessage(deps: MailboxDeps, job: MailboxFetchJob): Promise<void> {
  const google = deps.google;
  if (!google) return;
  const state = await withTenantTx(deps.pool, job.tenantId, (tx) => fetchState(tx, job.connectionId, job.messageId));
  if (!state || !["queued", "deferred"].includes(state.messageStatus)) return;
  const now = deps.now();
  if (state.connectionStatus === "disconnected") {
    return settle(deps, job, { status: "skipped", reason: "disconnected" });
  }
  if (state.connectionStatus === "reauth_required") {
    return defer(deps, job, new Date(now.getTime() + REAUTH_RETRY_MS));
  }

  // Counted before downloading, like a Postmark delivery; over the limit, the message waits.
  const hit = await hitRateLimit(createDb(deps.pool), `tenant:${job.tenantId}:inbound`, INBOUND_WINDOW_SECONDS, now);
  if (hit.count > deps.limits.inboundPerHour) return defer(deps, job, hit.resetAt);

  const store = mailboxTokenStore(deps.pool, deps.keys, job.tenantId, job.connectionId, deps.now, (tx) =>
    recordAudit(tx, SYSTEM_ACTOR("mailbox sync"), {
      action: "mailbox.reauth_required",
      target: { type: "mailbox", id: job.connectionId },
    }),
  );
  let message: Awaited<ReturnType<typeof getRawMessage>> | MessageOutcome;
  try {
    message = await withAccessToken(
      google,
      store,
      async (token): Promise<Awaited<ReturnType<typeof getRawMessage>> | MessageOutcome> => {
        const meta = await getMessageMeta(google, token, job.messageId);
        const receivedAt = meta.internalDate ? new Date(Number(meta.internalDate)) : null;
        const facts = { sizeBytes: meta.sizeEstimate, receivedAt };
        if (meta.labelIds.some((l) => (NOT_INBOUND_LABELS as readonly string[]).includes(l))) {
          return { status: "skipped", reason: "not_inbound", ...facts };
        }
        if (meta.sizeEstimate > rawLimit(deps.limits.maxFileBytes))
          return { status: "skipped", reason: "too_large", ...facts };
        return getRawMessage(google, token, job.messageId);
      },
      deps.now,
    );
  } catch (err) {
    if (err instanceof MessageGoneError) return settle(deps, job, { status: "skipped", reason: "deleted" });
    if (err instanceof MailboxAuthError) return defer(deps, job, new Date(now.getTime() + REAUTH_RETRY_MS));
    if (err instanceof MailboxRateLimitError) {
      return defer(deps, job, new Date(now.getTime() + err.retryAfterSeconds * 1000));
    }
    throw err;
  }
  if ("status" in message) return settle(deps, job, message);

  const facts = {
    sizeBytes: message.raw.byteLength,
    receivedAt: message.internalDate ? new Date(Number(message.internalDate)) : null,
  };
  let email: Awaited<ReturnType<typeof normalizeEml>>;
  try {
    email = await normalizeEml(message.raw);
  } catch {
    return settle(deps, job, { status: "skipped", reason: "unreadable", ...facts });
  }
  // The limits every email has (checkEmailLimits), recorded instead of refused.
  if (email.attachments.length > MAX_ATTACHMENTS) {
    return settle(deps, job, { status: "skipped", reason: "too_many_attachments", ...facts });
  }
  if (email.attachments.some((a) => a.size > deps.limits.maxFileBytes)) {
    return settle(deps, job, { status: "skipped", reason: "too_large", ...facts });
  }

  await ingestEmail(deps, job.tenantId, email, {
    source: "gmail",
    eml: message.raw,
    within: (tx, result) =>
      markMailboxMessage(tx, job.connectionId, job.messageId, {
        status: result.duplicate ? "duplicate" : "ingested",
        documentId: result.documentId,
        ...facts,
      }),
  });
}

/** `mailbox.failed`: the fetch kept failing, so the message is marked failed (it stays in Gmail). */
export async function fetchFailed(deps: MailboxDeps, job: MailboxFetchJob): Promise<void> {
  await settle(deps, job, { status: "failed", reason: "retries_exhausted" });
}
