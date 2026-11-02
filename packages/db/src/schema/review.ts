import { ACTION_STATUSES, REVIEW_ACTIONS, REVIEW_TASK_KINDS, REVIEW_TASK_STATUSES } from "@ai-triage/core";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, emptyTextArray, oneOf, pk, tenantId, tenantKey, updatedAt } from "./_helpers";
import { users } from "./auth";
import { documents, extractions } from "./pipeline";

/**
 * Human work items. `review` and `audit` tasks bind to an exact extraction revision; a claim is a
 * (claimed_by, claim_token, lease) triple that approval must present (docs/architecture.md §5).
 */
export const reviewTasks = pgTable(
  "review_tasks",
  {
    id: pk(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    kind: text("kind", { enum: REVIEW_TASK_KINDS }).notNull(),
    extractionId: uuid("extraction_id"),
    reasons: text("reasons").array().notNull().default(emptyTextArray()),
    status: text("status", { enum: REVIEW_TASK_STATUSES }).notNull().default("pending"),
    claimedBy: uuid("claimed_by").references(() => users.id),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    tenantKey("review_tasks", t),
    oneOf("review_tasks_kind_check", t.kind, REVIEW_TASK_KINDS),
    oneOf("review_tasks_status_check", t.status, REVIEW_TASK_STATUSES),
    check(
      "review_tasks_extraction_required_check",
      sql`${t.kind} not in ('review', 'audit') or ${t.extractionId} is not null`,
    ),
    // A claim is all-or-nothing, and only a claimed task holds one.
    check(
      "review_tasks_claim_check",
      sql`(${t.status} = 'claimed') = (${t.claimToken} is not null and ${t.claimedBy} is not null and ${t.leaseExpiresAt} is not null)`,
    ),
    uniqueIndex("review_tasks_one_open_per_document_key").on(t.documentId).where(sql`${t.status} <> 'resolved'`),
    index("review_tasks_queue_idx").on(t.tenantId, t.status, t.createdAt),
    foreignKey({
      name: "review_tasks_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    foreignKey({
      name: "review_tasks_extraction_fk",
      columns: [t.tenantId, t.documentId, t.extractionId],
      foreignColumns: [extractions.tenantId, extractions.documentId, extractions.id],
    }),
  ],
);

export const reviewDecisions = pgTable(
  "review_decisions",
  {
    id: pk(),
    tenantId: tenantId(),
    reviewTaskId: uuid("review_task_id").notNull(),
    documentId: uuid("document_id").notNull(),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => users.id),
    outcome: text("outcome", { enum: REVIEW_ACTIONS }).notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    diff: jsonb("diff"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantKey("review_decisions", t),
    oneOf("review_decisions_outcome_check", t.outcome, REVIEW_ACTIONS),
    foreignKey({
      name: "review_decisions_task_fk",
      columns: [t.tenantId, t.reviewTaskId],
      foreignColumns: [reviewTasks.tenantId, reviewTasks.id],
    }),
    foreignKey({
      name: "review_decisions_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
  ],
);

/**
 * Outbox of approved actions. `payload` is frozen at approval; `id` doubles as the webhook
 * `Idempotency-Key`. One action per approved revision. `document_id` is required, and eval items
 * never create documents, so an eval run can't produce an action (invariant 7).
 */
export const actions = pgTable(
  "actions",
  {
    id: pk(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    extractionId: uuid("extraction_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: ACTION_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantKey("actions", t),
    unique("actions_extraction_id_key").on(t.extractionId),
    oneOf("actions_status_check", t.status, ACTION_STATUSES),
    foreignKey({
      name: "actions_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    foreignKey({
      name: "actions_extraction_fk",
      columns: [t.tenantId, t.documentId, t.extractionId],
      foreignColumns: [extractions.tenantId, extractions.documentId, extractions.id],
    }),
  ],
);
