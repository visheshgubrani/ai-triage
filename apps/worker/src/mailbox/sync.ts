import { MAILBOX_BACKFILL_MAX_MESSAGES, MAILBOX_RESYNC_MAX_DAYS, type MailboxSyncJob, QUEUES } from "@ai-triage/core";
import {
  commitSync,
  createDb,
  dueMailboxes,
  mailboxTokenStore,
  recordAudit,
  recordSyncProblem,
  SYSTEM_ACTOR,
  sendTenantJob,
  syncState,
  type TenantTx,
  withTenantTx,
} from "@ai-triage/db";
import {
  getProfile,
  HistoryExpiredError,
  listHistory,
  listMessages,
  MailboxAuthError,
  MailboxRateLimitError,
  withAccessToken,
} from "@ai-triage/mailbox";
import { log } from "../observe";
import type { MailboxDeps } from "./deps";

// Mailbox sync (docs/architecture.md §5). Every minute the poll enqueues one `mailbox.sync` per due
// mailbox (an exclusive queue: never two at once for one mailbox). A sync reads the cursor, asks
// Gmail what's new with no transaction open, then commits the new cursor, the ledger rows and one
// `mailbox.fetch` job per new message together. A crash before that commit changes nothing; a
// message listed twice is fetched once.

/** A synced mailbox is due again this long after a sync, so the next minute's poll picks it up. */
const SYNC_INTERVAL_MS = 50_000;
/** After a failed sync (Google down, a bad response), wait this long. */
const RETRY_MS = 5 * 60_000;

/** The cron job: one sync per due mailbox. */
export async function pollMailboxes(deps: MailboxDeps): Promise<number> {
  if (!deps.google) return 0;
  const due = await dueMailboxes(createDb(deps.pool), deps.now());
  for (const { tenantId, id } of due) {
    const job: MailboxSyncJob = { tenantId, connectionId: id };
    await sendTenantJob(deps.boss, tenantId, QUEUES.mailboxSync, job, { singletonKey: id });
  }
  return due.length;
}

const reauthAudit = (connectionId: string, email: string) => (tx: TenantTx) =>
  recordAudit(tx, SYSTEM_ACTOR("mailbox sync"), {
    action: "mailbox.reauth_required",
    target: { type: "mailbox", id: connectionId },
    details: { email },
  });

/** Ids in first-seen order, each once (history repeats a message that's added and then labelled). */
const unique = (ids: string[]) => [...new Set(ids)];

export async function syncMailbox(deps: MailboxDeps, job: MailboxSyncJob): Promise<void> {
  const { tenantId, connectionId } = job;
  const google = deps.google;
  if (!google) return;
  const state = await withTenantTx(deps.pool, tenantId, (tx) => syncState(tx, connectionId));
  if (!state || state.status !== "active" || !state.historyId) return;
  const startHistoryId = state.historyId;

  const store = mailboxTokenStore(
    deps.pool,
    deps.keys,
    tenantId,
    connectionId,
    deps.now,
    reauthAudit(connectionId, state.email),
  );
  let found: { ids: string[]; cursor: string; more: boolean };
  try {
    found = await withAccessToken(
      google,
      store,
      async (token) => {
        const ids: string[] = [];
        if (state.backfillDays) {
          const q = `newer_than:${state.backfillDays}d`;
          ids.push(
            ...(await listMessages(google, token, { labelId: state.labelId, q, max: MAILBOX_BACKFILL_MAX_MESSAGES })),
          );
        }
        try {
          let pageToken: string | null = null;
          for (;;) {
            const page = await listHistory(google, token, {
              startHistoryId,
              labelId: state.labelId,
              pageToken,
              maxResults: deps.limits.syncBatch,
            });
            ids.push(...page.messageIds);
            if (!page.nextPageToken) return { ids, cursor: page.historyId, more: false };
            // Enough for one sync: resume after the last record taken, at the next poll.
            if (ids.length >= deps.limits.syncBatch) {
              return { ids, cursor: page.lastHistoryId ?? startHistoryId, more: true };
            }
            pageToken = page.nextPageToken;
          }
        } catch (err) {
          if (!(err instanceof HistoryExpiredError)) throw err;
          // Gmail no longer has history this old. Take the cursor first, then list what arrived
          // since the last sync (bounded): anything arriving in between is in both, and dedupes.
          const { historyId } = await getProfile(google, token);
          const since = Math.max(
            (state.lastSyncedAt ?? state.createdAt).getTime() - 3_600_000,
            deps.now().getTime() - MAILBOX_RESYNC_MAX_DAYS * 86_400_000,
          );
          const q = `after:${Math.floor(since / 1000)}`;
          ids.push(
            ...(await listMessages(google, token, { labelId: state.labelId, q, max: deps.limits.syncBatch * 5 })),
          );
          return { ids, cursor: historyId, more: false };
        }
      },
      deps.now,
    );
  } catch (err) {
    // A dead grant is already marked for reconnecting (the token store did it, and audited it).
    if (err instanceof MailboxAuthError) return;
    const now = deps.now();
    const retryAt =
      err instanceof MailboxRateLimitError
        ? new Date(now.getTime() + err.retryAfterSeconds * 1000)
        : new Date(now.getTime() + RETRY_MS);
    log.warn("mailbox sync failed", { mailbox: connectionId, err });
    await withTenantTx(deps.pool, tenantId, (tx) =>
      recordSyncProblem(tx, connectionId, "Couldn't reach Gmail; retrying in a few minutes.", now, retryAt),
    );
    return;
  }

  const now = deps.now();
  await withTenantTx(deps.pool, tenantId, (tx) =>
    commitSync(tx, deps.boss, {
      connectionId,
      expectedVersion: state.cursorVersion,
      historyId: found.cursor,
      messageIds: unique(found.ids),
      backfillDone: state.backfillDays !== null,
      now,
      nextSyncAt: found.more ? now : new Date(now.getTime() + SYNC_INTERVAL_MS),
    }),
  );
}
