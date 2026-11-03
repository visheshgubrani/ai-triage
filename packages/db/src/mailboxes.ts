import { randomUUID } from "node:crypto";
import {
  type JoinRole,
  type MailboxFetchJob,
  type MailboxMessageReason,
  type MailboxMessageStatus,
  type MailboxProvider,
  type MailboxStatus,
  OAUTH_STATE_TTL_SECONDS,
  type OAuthPurpose,
  QUEUES,
} from "@ai-triage/core";
import { and, desc, eq, gt, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import type pg from "pg";
import { deterministicJobId, enqueue, type PgBoss } from "./boss";
import { decryptSecret, encryptSecret, type KeyRing } from "./crypto";
import type { Db } from "./index";
import { mailboxConnections, mailboxMessages, oauthStates } from "./schema";
import { type TenantTx, withTenantTx } from "./tenant-tx";

// Mailbox connections (docs/architecture.md §5). The API writes them through an OAuth round trip;
// the worker reads their tokens and advances their cursor (see sync helpers further down). Tokens
// never leave this module unencrypted except to the caller that asked for them.

/** AAD for a connection's tokens: a ciphertext can't be moved to another connection or tenant. */
const tokenAad = (tenantId: string, connectionId: string) => `${tenantId}:mailbox:${connectionId}`;

// ── OAuth round trips ───────────────────────────────────────────────────────────────────────

export interface OAuthStateInput {
  userId: string;
  purpose: OAuthPurpose;
  codeVerifier: string;
  backfillDays?: number | null;
  joinRole?: JoinRole | null;
  now: Date;
}

/** Starts a round trip; the returned id is the `state` parameter. */
export async function createOAuthState(tx: TenantTx, input: OAuthStateInput): Promise<string> {
  const [row] = await tx.db
    .insert(oauthStates)
    .values({
      tenantId: tx.tenantId,
      userId: input.userId,
      purpose: input.purpose,
      codeVerifier: input.codeVerifier,
      backfillDays: input.backfillDays ?? null,
      joinRole: input.joinRole ?? null,
      expiresAt: new Date(input.now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000),
    })
    .returning({ id: oauthStates.id });
  if (!row) throw new Error("oauth state insert returned nothing");
  return row.id;
}

/**
 * Ends a round trip: the state is used once, by the user who started it, before it expires.
 * Null for anything else (replayed, someone else's, expired, or another tenant's under RLS).
 */
export async function consumeOAuthState(tx: TenantTx, input: { state: string; userId: string; now: Date }) {
  const [row] = await tx.db
    .update(oauthStates)
    .set({ usedAt: input.now })
    .where(
      and(
        eq(oauthStates.id, input.state),
        eq(oauthStates.userId, input.userId),
        isNull(oauthStates.usedAt),
        gt(oauthStates.expiresAt, input.now),
      ),
    )
    .returning();
  return row ?? null;
}

/** Drops round trips that finished or expired more than a day ago (maintenance). */
export async function pruneOAuthStates(tx: TenantTx, now: Date): Promise<number> {
  const rows = await tx.db
    .delete(oauthStates)
    .where(lt(oauthStates.expiresAt, new Date(now.getTime() - 86_400_000)))
    .returning({ id: oauthStates.id });
  return rows.length;
}

// ── Connections ─────────────────────────────────────────────────────────────────────────────

export interface ConnectionGrant {
  provider: MailboxProvider;
  email: string;
  providerAccountId: string | null;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  scopes: string[];
  /** The provider's cursor now: a new connection syncs mail from here on. */
  historyId: string;
  backfillDays: number | null;
  connectedBy: string;
  now: Date;
}

/**
 * Connects a mailbox, or reconnects one the tenant already has (same provider and address). A
 * reconnect after `reauth_required` or a pause keeps the cursor, so mail that arrived meanwhile is
 * still synced; after a disconnect it starts again from now.
 */
export async function connectMailbox(
  tx: TenantTx,
  keys: KeyRing,
  grant: ConnectionGrant,
): Promise<{ id: string; reconnected: boolean }> {
  const email = grant.email.toLowerCase();
  const [existing] = await tx.db
    .select({ id: mailboxConnections.id, status: mailboxConnections.status, historyId: mailboxConnections.historyId })
    .from(mailboxConnections)
    .where(and(eq(mailboxConnections.provider, grant.provider), eq(mailboxConnections.email, email)))
    .for("update");
  const id = existing?.id ?? randomUUID();
  const aad = tokenAad(tx.tenantId, id);
  const values = {
    providerAccountId: grant.providerAccountId,
    status: "active" as const,
    refreshTokenEnc: encryptSecret(keys, grant.refreshToken, aad),
    accessTokenEnc: encryptSecret(keys, grant.accessToken, aad),
    accessTokenExpiresAt: grant.accessTokenExpiresAt,
    scopes: grant.scopes,
    backfillDays: grant.backfillDays,
    nextSyncAt: grant.now,
    lastError: null,
    lastErrorAt: null,
    connectedBy: grant.connectedBy,
  };
  if (existing) {
    const keepCursor = existing.status !== "disconnected" && existing.historyId !== null;
    await tx.db
      .update(mailboxConnections)
      .set({
        ...values,
        ...(keepCursor
          ? {}
          : { historyId: grant.historyId, cursorVersion: sql`${mailboxConnections.cursorVersion} + 1` }),
      })
      .where(eq(mailboxConnections.id, id));
    return { id, reconnected: true };
  }
  await tx.db
    .insert(mailboxConnections)
    .values({ id, tenantId: tx.tenantId, provider: grant.provider, email, historyId: grant.historyId, ...values });
  return { id, reconnected: false };
}

export interface ConnectionSummary {
  id: string;
  provider: MailboxProvider;
  email: string;
  status: MailboxStatus;
  labelId: string;
  labelName: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  createdAt: Date;
}

const summaryColumns = {
  id: mailboxConnections.id,
  provider: mailboxConnections.provider,
  email: mailboxConnections.email,
  status: mailboxConnections.status,
  labelId: mailboxConnections.labelId,
  labelName: mailboxConnections.labelName,
  lastSyncedAt: mailboxConnections.lastSyncedAt,
  lastError: mailboxConnections.lastError,
  lastErrorAt: mailboxConnections.lastErrorAt,
  createdAt: mailboxConnections.createdAt,
};

/** The tenant's mailboxes, without tokens. Disconnected ones are left out. */
export async function listMailboxes(tx: TenantTx): Promise<ConnectionSummary[]> {
  const rows = await tx.db
    .select(summaryColumns)
    .from(mailboxConnections)
    .where(sql`${mailboxConnections.status} <> 'disconnected'`)
    .orderBy(mailboxConnections.createdAt);
  return rows as ConnectionSummary[];
}

export async function getMailbox(tx: TenantTx, id: string): Promise<ConnectionSummary | null> {
  const [row] = await tx.db.select(summaryColumns).from(mailboxConnections).where(eq(mailboxConnections.id, id));
  return (row as ConnectionSummary | undefined) ?? null;
}

/** The connection's tokens, decrypted (null once disconnected). */
export async function mailboxTokens(tx: TenantTx, keys: KeyRing, id: string) {
  const [row] = await tx.db
    .select({
      refreshTokenEnc: mailboxConnections.refreshTokenEnc,
      accessTokenEnc: mailboxConnections.accessTokenEnc,
      accessTokenExpiresAt: mailboxConnections.accessTokenExpiresAt,
    })
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, id));
  if (!row?.refreshTokenEnc) return null;
  const aad = tokenAad(tx.tenantId, id);
  return {
    refreshToken: decryptSecret(keys, row.refreshTokenEnc, aad),
    accessToken: row.accessTokenEnc ? decryptSecret(keys, row.accessTokenEnc, aad) : null,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
  };
}

/** Keeps a refreshed access token (encrypted) so the next job doesn't refresh again. */
export async function storeAccessToken(tx: TenantTx, keys: KeyRing, id: string, token: string, expiresAt: Date) {
  await tx.db
    .update(mailboxConnections)
    .set({ accessTokenEnc: encryptSecret(keys, token, tokenAad(tx.tenantId, id)), accessTokenExpiresAt: expiresAt })
    .where(eq(mailboxConnections.id, id));
}

/**
 * The connection's tokens as a TokenStore (packages/mailbox `withAccessToken`): each read and write
 * is its own short transaction. `onRevoked` runs after the connection is marked for reconnecting.
 */
export function mailboxTokenStore(
  pool: pg.Pool,
  keys: KeyRing,
  tenantId: string,
  connectionId: string,
  now: () => Date,
  onRevoked?: (tx: TenantTx) => Promise<void>,
) {
  return {
    read: () => withTenantTx(pool, tenantId, (tx) => mailboxTokens(tx, keys, connectionId)),
    save: (token: string, expiresAt: Date) =>
      withTenantTx(pool, tenantId, (tx) => storeAccessToken(tx, keys, connectionId, token, expiresAt)),
    revoked: () =>
      withTenantTx(pool, tenantId, async (tx) => {
        if ((await markReauthRequired(tx, connectionId, now())) && onRevoked) await onRevoked(tx);
      }),
  };
}

/** Changes the intake label (the cursor stays: history is per mailbox, not per label), or pauses. */
export async function updateMailbox(
  tx: TenantTx,
  id: string,
  change: { labelId?: string; labelName?: string; paused?: boolean },
  now: Date,
): Promise<ConnectionSummary | null> {
  const current = await getMailbox(tx, id);
  if (!current || current.status === "disconnected") return null;
  const status =
    change.paused === undefined || current.status === "reauth_required"
      ? current.status
      : change.paused
        ? "paused"
        : "active";
  await tx.db
    .update(mailboxConnections)
    .set({
      ...(change.labelId ? { labelId: change.labelId, labelName: change.labelName ?? change.labelId } : {}),
      status,
      ...(status === "active" && current.status !== "active" ? { nextSyncAt: now } : {}),
    })
    .where(eq(mailboxConnections.id, id));
  return getMailbox(tx, id);
}

/** Forgets the tokens and the cursor; the row and its ledger stay (documents keep their source). */
export async function disconnectMailbox(tx: TenantTx, id: string): Promise<void> {
  await tx.db
    .update(mailboxConnections)
    .set({
      status: "disconnected",
      refreshTokenEnc: null,
      accessTokenEnc: null,
      accessTokenExpiresAt: null,
      historyId: null,
      backfillDays: null,
      cursorVersion: sql`${mailboxConnections.cursorVersion} + 1`,
    })
    .where(eq(mailboxConnections.id, id));
}

/** The provider refused the grant: stop polling until an admin reconnects. */
export async function markReauthRequired(tx: TenantTx, id: string, now: Date): Promise<boolean> {
  const rows = await tx.db
    .update(mailboxConnections)
    .set({
      status: "reauth_required",
      accessTokenEnc: null,
      accessTokenExpiresAt: null,
      lastError: "The mailbox's access was revoked or expired: reconnect it.",
      lastErrorAt: now,
    })
    .where(and(eq(mailboxConnections.id, id), eq(mailboxConnections.status, "active")))
    .returning({ id: mailboxConnections.id });
  return rows.length > 0;
}

/** The newest ledger rows of a mailbox, for its activity list. */
export async function recentMailboxMessages(tx: TenantTx, connectionId: string, limit = 20) {
  return tx.db
    .select({
      id: mailboxMessages.id,
      providerMessageId: mailboxMessages.providerMessageId,
      status: mailboxMessages.status,
      reason: mailboxMessages.reason,
      documentId: mailboxMessages.documentId,
      sizeBytes: mailboxMessages.sizeBytes,
      receivedAt: mailboxMessages.receivedAt,
      createdAt: mailboxMessages.createdAt,
    })
    .from(mailboxMessages)
    .where(eq(mailboxMessages.connectionId, connectionId))
    .orderBy(desc(mailboxMessages.createdAt))
    .limit(limit);
}

/** Re-encrypts every mailbox token under the ring's primary key (`pnpm secrets:rotate-key`). */
export async function reencryptMailboxTokens(tx: TenantTx, keys: KeyRing): Promise<number> {
  const rows = await tx.db
    .select({
      id: mailboxConnections.id,
      refreshTokenEnc: mailboxConnections.refreshTokenEnc,
      accessTokenEnc: mailboxConnections.accessTokenEnc,
    })
    .from(mailboxConnections)
    .where(sql`${mailboxConnections.refreshTokenEnc} is not null`);
  for (const row of rows) {
    const aad = tokenAad(tx.tenantId, row.id);
    const again = (enc: string | null) => (enc ? encryptSecret(keys, decryptSecret(keys, enc, aad), aad) : null);
    await tx.db
      .update(mailboxConnections)
      .set({ refreshTokenEnc: again(row.refreshTokenEnc), accessTokenEnc: again(row.accessTokenEnc) })
      .where(eq(mailboxConnections.id, row.id));
  }
  return rows.length;
}

// ── Sync (the worker) ───────────────────────────────────────────────────────────────────────

/** Mailboxes due for a sync, across tenants: the cron poll runs before any tenant is known. */
export async function dueMailboxes(db: Db, now: Date): Promise<{ tenantId: string; id: string }[]> {
  const { rows } = await db.execute<{ tenant_id: string; id: string }>(
    sql`select tenant_id, id from public.due_mailbox_connections(${now.toISOString()}::timestamptz)`,
  );
  return rows.map((r) => ({ tenantId: r.tenant_id, id: r.id }));
}

export interface SyncState {
  status: MailboxStatus;
  email: string;
  labelId: string;
  historyId: string | null;
  cursorVersion: number;
  backfillDays: number | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
}

export async function syncState(tx: TenantTx, id: string): Promise<SyncState | null> {
  const [row] = await tx.db
    .select({
      status: mailboxConnections.status,
      email: mailboxConnections.email,
      labelId: mailboxConnections.labelId,
      historyId: mailboxConnections.historyId,
      cursorVersion: mailboxConnections.cursorVersion,
      backfillDays: mailboxConnections.backfillDays,
      lastSyncedAt: mailboxConnections.lastSyncedAt,
      createdAt: mailboxConnections.createdAt,
    })
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, id));
  return (row as SyncState | undefined) ?? null;
}

/** The fetch job of one message: a repeated sync of the same message sends no second job. */
export const mailboxFetchJobId = (connectionId: string, messageId: string) =>
  deterministicJobId("mailbox-fetch", connectionId, messageId);

export interface SyncCommit {
  connectionId: string;
  /** The cursor_version the sync read; the commit is refused if another sync moved it since. */
  expectedVersion: number;
  historyId: string;
  messageIds: string[];
  /** The connect-time import ran: don't run it again. */
  backfillDone: boolean;
  now: Date;
  nextSyncAt: Date;
}

/**
 * Commits one sync (invariant 3): advances the cursor first (a compare-and-set on cursor_version,
 * which also locks the row), then adds the new messages to the ledger and enqueues a fetch for each
 * one the ledger hadn't seen, all in one transaction. A message seen again (history repeats them;
 * a resync relists them) gets no second row or job. Refused, it changes nothing.
 */
export async function commitSync(
  tx: TenantTx,
  boss: PgBoss,
  input: SyncCommit,
): Promise<{ committed: boolean; queued: number }> {
  const [advanced] = await tx.db
    .update(mailboxConnections)
    .set({
      historyId: input.historyId,
      cursorVersion: sql`${mailboxConnections.cursorVersion} + 1`,
      lastSyncedAt: input.now,
      nextSyncAt: input.nextSyncAt,
      lastError: null,
      lastErrorAt: null,
      ...(input.backfillDone ? { backfillDays: null } : {}),
    })
    .where(
      and(
        eq(mailboxConnections.id, input.connectionId),
        eq(mailboxConnections.cursorVersion, input.expectedVersion),
        eq(mailboxConnections.status, "active"),
      ),
    )
    .returning({ id: mailboxConnections.id });
  if (!advanced) return { committed: false, queued: 0 };
  if (input.messageIds.length === 0) return { committed: true, queued: 0 };

  const added = await tx.db
    .insert(mailboxMessages)
    .values(
      input.messageIds.map((providerMessageId) => ({
        tenantId: tx.tenantId,
        connectionId: input.connectionId,
        providerMessageId,
      })),
    )
    .onConflictDoNothing({ target: [mailboxMessages.connectionId, mailboxMessages.providerMessageId] })
    .returning({ messageId: mailboxMessages.providerMessageId });
  for (const { messageId } of added) {
    const job: MailboxFetchJob = { tenantId: tx.tenantId, connectionId: input.connectionId, messageId };
    await enqueue(boss, tx, QUEUES.mailboxFetch, job, { id: mailboxFetchJobId(input.connectionId, messageId) });
  }
  return { committed: true, queued: added.length };
}

/** A sync that couldn't finish: say why (generically) and when to try again. The cursor stays. */
export async function recordSyncProblem(tx: TenantTx, id: string, message: string, now: Date, retryAt: Date) {
  await tx.db
    .update(mailboxConnections)
    .set({ lastError: message, lastErrorAt: now, nextSyncAt: retryAt })
    .where(eq(mailboxConnections.id, id));
}

/** What a fetch job needs to know before downloading: is the mailbox still connected, is the message pending. */
export async function fetchState(tx: TenantTx, connectionId: string, messageId: string) {
  const [row] = await tx.db
    .select({ connectionStatus: mailboxConnections.status, messageStatus: mailboxMessages.status })
    .from(mailboxMessages)
    .innerJoin(mailboxConnections, eq(mailboxConnections.id, mailboxMessages.connectionId))
    .where(and(eq(mailboxMessages.connectionId, connectionId), eq(mailboxMessages.providerMessageId, messageId)));
  return row
    ? {
        connectionStatus: row.connectionStatus as MailboxStatus,
        messageStatus: row.messageStatus as MailboxMessageStatus,
      }
    : null;
}

export interface MessageOutcome {
  status: MailboxMessageStatus;
  reason?: MailboxMessageReason | null;
  documentId?: string | null;
  sizeBytes?: number | null;
  receivedAt?: Date | null;
}

/** Records what became of a message. A final status is never overwritten by a late retry. */
export async function markMailboxMessage(
  tx: TenantTx,
  connectionId: string,
  messageId: string,
  outcome: MessageOutcome,
): Promise<void> {
  await tx.db
    .update(mailboxMessages)
    .set({
      status: outcome.status,
      reason: outcome.reason ?? null,
      ...(outcome.documentId !== undefined ? { documentId: outcome.documentId } : {}),
      ...(outcome.sizeBytes !== undefined ? { sizeBytes: outcome.sizeBytes } : {}),
      ...(outcome.receivedAt !== undefined ? { receivedAt: outcome.receivedAt } : {}),
    })
    .where(
      and(
        eq(mailboxMessages.connectionId, connectionId),
        eq(mailboxMessages.providerMessageId, messageId),
        inArray(mailboxMessages.status, ["queued", "deferred"]),
      ),
    );
}

/**
 * How long the ledger keeps a finished message. Longer than any resync window (a resync looks back
 * at most MAILBOX_RESYNC_MAX_DAYS), so a purged message's tombstone outlives every chance to relist it.
 */
export const MAILBOX_LEDGER_DAYS = 30;

export async function pruneMailboxMessages(tx: TenantTx, now: Date): Promise<number> {
  const rows = await tx.db
    .delete(mailboxMessages)
    .where(
      and(
        lt(mailboxMessages.createdAt, new Date(now.getTime() - MAILBOX_LEDGER_DAYS * 86_400_000)),
        notInArray(mailboxMessages.status, ["queued", "deferred"]),
      ),
    )
    .returning({ id: mailboxMessages.id });
  return rows.length;
}

/** The mailbox a synced document came from (through the ledger), or null. */
export async function mailboxOfDocument(tx: TenantTx, documentId: string): Promise<{ email: string } | null> {
  const [row] = await tx.db
    .select({ email: mailboxConnections.email })
    .from(mailboxMessages)
    .innerJoin(mailboxConnections, eq(mailboxConnections.id, mailboxMessages.connectionId))
    .where(eq(mailboxMessages.documentId, documentId))
    .limit(1);
  return row ?? null;
}
