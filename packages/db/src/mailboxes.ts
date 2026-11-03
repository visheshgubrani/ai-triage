import { randomUUID } from "node:crypto";
import { type MailboxProvider, type MailboxStatus, OAUTH_STATE_TTL_SECONDS, type OAuthPurpose } from "@ai-triage/core";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type pg from "pg";
import { decryptSecret, encryptSecret, type KeyRing } from "./crypto";
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
