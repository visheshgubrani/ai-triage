import {
  JOIN_ROLES,
  MAILBOX_MESSAGE_REASONS,
  MAILBOX_MESSAGE_STATUSES,
  MAILBOX_PROVIDERS,
  MAILBOX_STATUSES,
  OAUTH_PURPOSES,
} from "@ai-triage/core";
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, oneOf, pk, tenantId, tenantKey, updatedAt } from "./_helpers";
import { users } from "./auth";
import { documents } from "./pipeline";

// Mailbox sync (docs/architecture.md §5, docs/google.md). A tenant connects a mailbox through an
// OAuth round trip (`oauth_states`), the connection keeps its encrypted tokens and sync cursor, and
// every message sync sees gets one ledger row (`mailbox_messages`) recording what became of it.

/**
 * One OAuth round trip started by an admin, for at most OAUTH_STATE_TTL_SECONDS: the `id` is the
 * `state` sent to the provider, so the callback finds it, and it is used once, by the same user.
 */
export const oauthStates = pgTable(
  "oauth_states",
  {
    id: pk(),
    tenantId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    /** PKCE verifier: it never leaves the server. */
    codeVerifier: text("code_verifier").notNull(),
    /** For a mailbox: import this many days of recent mail too. */
    backfillDays: integer("backfill_days"),
    /** For a Workspace domain: the role its people join as. */
    joinRole: text("join_role"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    tenantKey("oauth_states", t),
    oneOf("oauth_states_purpose_check", t.purpose, OAUTH_PURPOSES),
    oneOf("oauth_states_join_role_check", t.joinRole, JOIN_ROLES),
  ],
);

/**
 * A connected mailbox. Tokens are encrypted (crypto.ts, AAD `${tenant}:mailbox:${id}`) and belong
 * to the tenant, not to whoever connected it. `history_id` is the provider's sync cursor, advanced
 * only with a compare-and-set on `cursor_version`. Disconnecting deletes the tokens and keeps the row.
 */
export const mailboxConnections = pgTable(
  "mailbox_connections",
  {
    id: pk(),
    tenantId: tenantId(),
    provider: text("provider").notNull(),
    /** Lowercase. */
    email: text("email").notNull(),
    /** The provider's account id (Google `sub`). */
    providerAccountId: text("provider_account_id"),
    status: text("status").notNull().default("active"),
    /** Only mail in this label is ingested (Gmail label id; INBOX by default). */
    labelId: text("label_id").notNull().default("INBOX"),
    labelName: text("label_name").notNull().default("Inbox"),
    refreshTokenEnc: text("refresh_token_enc"),
    accessTokenEnc: text("access_token_enc"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    historyId: text("history_id"),
    cursorVersion: integer("cursor_version").notNull().default(0),
    /** Days of recent mail the next sync imports once (set at connect time), then null. */
    backfillDays: integer("backfill_days"),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** Generic, never a provider's raw response. */
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    connectedBy: uuid("connected_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantKey("mailbox_connections", t),
    unique("mailbox_connections_tenant_id_provider_email_key").on(t.tenantId, t.provider, t.email),
    index("mailbox_connections_due_idx").on(t.status, t.nextSyncAt),
    oneOf("mailbox_connections_provider_check", t.provider, MAILBOX_PROVIDERS),
    oneOf("mailbox_connections_status_check", t.status, MAILBOX_STATUSES),
    check("mailbox_connections_email_lowercase_check", sql`${t.email} = lower(${t.email})`),
  ],
);

/**
 * The ledger: one row per message a sync saw, so a message is fetched once, the mailbox page can
 * say what happened to each, and a purged document's message isn't ingested again (`purged`). Ids
 * only: no content, subject or sender.
 */
export const mailboxMessages = pgTable(
  "mailbox_messages",
  {
    id: pk(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    status: text("status").notNull().default("queued"),
    reason: text("reason"),
    documentId: uuid("document_id"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** When the provider received it. */
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantKey("mailbox_messages", t),
    unique("mailbox_messages_connection_id_provider_message_id_key").on(t.connectionId, t.providerMessageId),
    index("mailbox_messages_tenant_id_connection_id_created_at_idx").on(t.tenantId, t.connectionId, t.createdAt),
    index("mailbox_messages_tenant_id_document_id_idx").on(t.tenantId, t.documentId),
    oneOf("mailbox_messages_status_check", t.status, MAILBOX_MESSAGE_STATUSES),
    oneOf("mailbox_messages_reason_check", t.reason, MAILBOX_MESSAGE_REASONS),
    foreignKey({
      name: "mailbox_messages_connection_fk",
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [mailboxConnections.tenantId, mailboxConnections.id],
    }),
    foreignKey({
      name: "mailbox_messages_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
  ],
);
