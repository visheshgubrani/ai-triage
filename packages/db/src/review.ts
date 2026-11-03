import {
  LEASE_SECONDS,
  type ReviewAction,
  type ReviewErrorCode,
  type ReviewStatus,
  type ReviewTaskKind,
} from "@ai-triage/core";
import { and, asc, desc, eq, lt, max, ne, type SQL, sql } from "drizzle-orm";
import type { ExtractionRow } from "./pipeline";
import { classifications, documents, extractions, processingRuns, reviewDecisions, reviewTasks, users } from "./schema";
import type { TenantTx } from "./tenant-tx";

// The review queue (docs/architecture.md §5, §7). A claim is (claimed_by, claim_token, lease); a
// claim whose lease has run out counts as no claim everywhere, so there is no reaper. Decisions lock
// the document row, then the task row: the same order as the worker's stage commits.

export type ReviewTaskRow = typeof reviewTasks.$inferSelect;

/** A review request the current state can't satisfy. The API maps `code` to 409 or 422. */
export class ReviewError extends Error {
  constructor(
    readonly code: ReviewErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface Claim {
  taskId: string;
  documentId: string;
  claimToken: string;
  leaseExpiresAt: Date;
}

const leaseUntil = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

/** The category shown for a task: its extraction's, else the current run's classification (`other`). */
const taskCategory = sql<string | null>`coalesce(${extractions.category}, ${classifications.category})`;

/** True while someone holds a live claim on the task. */
const liveClaim = (now: Date) =>
  sql<boolean>`(${reviewTasks.status} = 'claimed' and ${reviewTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz)`;

/** Pending, or claimed with a lapsed lease: a task anyone with the reviewer role may take. */
const claimable = (now: Date) =>
  sql`(${reviewTasks.status} = 'pending' or (${reviewTasks.status} = 'claimed' and ${reviewTasks.leaseExpiresAt} <= ${now.toISOString()}::timestamptz))`;

const hasReasonCode = (code: string) =>
  sql`exists (select 1 from unnest(${reviewTasks.reasons}) r where split_part(r, ':', 1) = ${code})`;

export interface InboxFilter {
  kind?: ReviewTaskKind;
  category?: string;
  /** A reason code: the part before `:` (`required_missing` matches `required_missing:total`). */
  reasonCode?: string;
  /** Only tasks created before this time (the age filter). */
  olderThan?: Date;
  /** Only tasks claimed by this user. */
  mineUserId?: string;
  /** Just this task, open or resolved (the review page's lookup). */
  taskId?: string;
}

function inboxConditions(filter: InboxFilter, now: Date): SQL[] {
  const conditions: SQL[] = filter.taskId ? [eq(reviewTasks.id, filter.taskId)] : [ne(reviewTasks.status, "resolved")];
  if (filter.kind) conditions.push(eq(reviewTasks.kind, filter.kind));
  if (filter.category) conditions.push(sql`${taskCategory} = ${filter.category}`);
  if (filter.reasonCode) conditions.push(hasReasonCode(filter.reasonCode));
  if (filter.olderThan) conditions.push(lt(reviewTasks.createdAt, filter.olderThan));
  if (filter.mineUserId) conditions.push(liveClaim(now), eq(reviewTasks.claimedBy, filter.mineUserId));
  return conditions;
}

/** Open tasks, oldest first, with what the inbox shows. A lapsed claim is reported as no claim. */
export async function listInbox(
  tx: TenantTx,
  input: { now: Date; filter?: InboxFilter; after?: Date; limit?: number },
) {
  const conditions = inboxConditions(input.filter ?? {}, input.now);
  if (input.after) conditions.push(sql`${reviewTasks.createdAt} > ${input.after.toISOString()}::timestamptz`);
  const rows = await tx.db
    .select({
      id: reviewTasks.id,
      kind: reviewTasks.kind,
      status: reviewTasks.status,
      reasons: reviewTasks.reasons,
      createdAt: reviewTasks.createdAt,
      extractionId: reviewTasks.extractionId,
      documentId: documents.id,
      title: documents.title,
      source: documents.source,
      mime: documents.mime,
      category: taskCategory,
      score: extractions.score,
      runError: processingRuns.error,
      claimed: liveClaim(input.now),
      claimedBy: reviewTasks.claimedBy,
      claimedByEmail: users.email,
      leaseExpiresAt: reviewTasks.leaseExpiresAt,
    })
    .from(reviewTasks)
    .innerJoin(documents, eq(documents.id, reviewTasks.documentId))
    .leftJoin(extractions, eq(extractions.id, reviewTasks.extractionId))
    .leftJoin(processingRuns, eq(processingRuns.id, documents.currentRunId))
    .leftJoin(classifications, eq(classifications.runId, documents.currentRunId))
    .leftJoin(users, eq(users.id, reviewTasks.claimedBy))
    .where(and(...conditions))
    .orderBy(asc(reviewTasks.createdAt), asc(reviewTasks.id))
    .limit(input.limit ?? 100);
  return rows.map(({ claimed, claimedBy, claimedByEmail, leaseExpiresAt, ...row }) => ({
    ...row,
    status: claimed || row.status !== "claimed" ? row.status : ("pending" as const),
    claim: claimed && claimedBy ? { userId: claimedBy, email: claimedByEmail, leaseExpiresAt } : null,
  }));
}

/** Open-task counts per kind, category and reason code, for the inbox filters. */
export async function inboxCounts(tx: TenantTx) {
  const open = ne(reviewTasks.status, "resolved");
  const total = sql<number>`count(*)::int`;
  // A transaction is one client, so these run one after another.
  const byKind = await tx.db
    .select({ key: reviewTasks.kind, n: total })
    .from(reviewTasks)
    .where(open)
    .groupBy(reviewTasks.kind);
  const byCategory = await tx.db
    .select({ key: taskCategory, n: total })
    .from(reviewTasks)
    .innerJoin(documents, eq(documents.id, reviewTasks.documentId))
    .leftJoin(extractions, eq(extractions.id, reviewTasks.extractionId))
    .leftJoin(classifications, eq(classifications.runId, documents.currentRunId))
    .where(open)
    .groupBy(taskCategory);
  const byReason = await tx.db.execute<{ key: string; n: number }>(sql`
    select split_part(r, ':', 1) as key, count(distinct t.id)::int as n
    from ${reviewTasks} t, unnest(t.reasons) r
    where t.status <> 'resolved'
    group by 1`);
  const record = (rows: { key: string | null; n: number }[]) =>
    Object.fromEntries(rows.filter((r) => r.key !== null).map((r) => [r.key, r.n])) as Record<string, number>;
  return {
    total: byKind.reduce((sum, r) => sum + r.n, 0),
    kind: record(byKind),
    category: record(byCategory),
    reason: record(byReason.rows),
  };
}

/**
 * Claims the oldest claimable task matching the filter. `FOR UPDATE SKIP LOCKED` lets concurrent
 * reviewers each get a different task without waiting on each other. Returns null when none is left.
 */
export async function claimNext(
  tx: TenantTx,
  input: { userId: string; now: Date; filter?: Pick<InboxFilter, "kind" | "category">; leaseSeconds?: number },
): Promise<Claim | null> {
  const conditions = [claimable(input.now)];
  if (input.filter?.kind) conditions.push(sql`${reviewTasks.kind} = ${input.filter.kind}`);
  if (input.filter?.category) conditions.push(sql`${taskCategory} = ${input.filter.category}`);
  const lease = leaseUntil(input.now, input.leaseSeconds ?? LEASE_SECONDS);
  const { rows } = await tx.db.execute<{ id: string; document_id: string; claim_token: string }>(sql`
    update ${reviewTasks} set status = 'claimed', claimed_by = ${input.userId},
      claim_token = gen_random_uuid(), lease_expires_at = ${lease.toISOString()}::timestamptz
    where id = (
      select ${reviewTasks.id} from ${reviewTasks}
      join ${documents} on ${documents.id} = ${reviewTasks.documentId}
      left join ${extractions} on ${extractions.id} = ${reviewTasks.extractionId}
      left join ${classifications} on ${classifications.runId} = ${documents.currentRunId}
      where ${and(...conditions)}
      order by ${reviewTasks.createdAt}, ${reviewTasks.id}
      limit 1
      for update of ${reviewTasks} skip locked)
    returning id, document_id, claim_token`);
  const row = rows[0];
  return row
    ? { taskId: row.id, documentId: row.document_id, claimToken: row.claim_token, leaseExpiresAt: lease }
    : null;
}

async function lockTask(tx: TenantTx, taskId: string): Promise<ReviewTaskRow | null> {
  const [task] = await tx.db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).for("update");
  return task ?? null;
}

function assertOpen(task: ReviewTaskRow): void {
  if (task.status === "resolved") throw new ReviewError("task_resolved", "This task has already been decided.");
  if (task.status === "awaiting_extraction") {
    throw new ReviewError("reprocessing", "This document is being reprocessed after a reclassify.");
  }
}

async function claimedByOther(tx: TenantTx, task: ReviewTaskRow): Promise<ReviewError> {
  const [user] = task.claimedBy
    ? await tx.db.select({ email: users.email }).from(users).where(eq(users.id, task.claimedBy))
    : [];
  return new ReviewError("claimed_by_other", `Claimed by ${user?.email ?? "another reviewer"}.`, {
    claimedBy: user?.email ?? null,
    leaseExpiresAt: task.leaseExpiresAt?.toISOString() ?? null,
  });
}

/**
 * Claims one task (opening it from the inbox). A free or lapsed task gets a new token; the caller's
 * own live claim is extended and keeps its token. Null when the task isn't visible.
 */
export async function claimTask(
  tx: TenantTx,
  input: { taskId: string; userId: string; now: Date; leaseSeconds?: number },
): Promise<Claim | null> {
  const task = await lockTask(tx, input.taskId);
  if (!task) return null;
  assertOpen(task);
  const live = task.status === "claimed" && task.leaseExpiresAt !== null && task.leaseExpiresAt > input.now;
  if (live && task.claimedBy !== input.userId) throw await claimedByOther(tx, task);
  const lease = leaseUntil(input.now, input.leaseSeconds ?? LEASE_SECONDS);
  const [row] = await tx.db
    .update(reviewTasks)
    .set({
      status: "claimed",
      claimedBy: input.userId,
      claimToken: live && task.claimToken ? task.claimToken : sql`gen_random_uuid()`,
      leaseExpiresAt: lease,
    })
    .where(eq(reviewTasks.id, task.id))
    .returning({ claimToken: reviewTasks.claimToken });
  if (!row?.claimToken) throw new Error("claim update returned no row");
  return { taskId: task.id, documentId: task.documentId, claimToken: row.claimToken, leaseExpiresAt: lease };
}

const holdsClaim = (input: { taskId: string; userId: string; claimToken: string; now: Date }) =>
  and(
    eq(reviewTasks.id, input.taskId),
    eq(reviewTasks.status, "claimed"),
    eq(reviewTasks.claimedBy, input.userId),
    eq(reviewTasks.claimToken, input.claimToken),
    sql`${reviewTasks.leaseExpiresAt} > ${input.now.toISOString()}::timestamptz`,
  );

/** Extends a live claim. A lapsed lease can't be extended: the page must claim again and reload. */
export async function heartbeat(
  tx: TenantTx,
  input: { taskId: string; userId: string; claimToken: string; now: Date; leaseSeconds?: number },
): Promise<Date> {
  const lease = leaseUntil(input.now, input.leaseSeconds ?? LEASE_SECONDS);
  const rows = await tx.db
    .update(reviewTasks)
    .set({ leaseExpiresAt: lease })
    .where(holdsClaim(input))
    .returning({ id: reviewTasks.id });
  if (rows.length === 0) throw new ReviewError("claim_lost", "Your claim on this task has ended.");
  return lease;
}

/** Gives a claimed task back to the queue. Returns false when the claim was already gone. */
export async function releaseClaim(
  tx: TenantTx,
  input: { taskId: string; userId: string; claimToken: string; now: Date },
): Promise<boolean> {
  const rows = await tx.db
    .update(reviewTasks)
    .set({ status: "pending", claimedBy: null, claimToken: null, leaseExpiresAt: null })
    .where(holdsClaim(input))
    .returning({ id: reviewTasks.id });
  return rows.length === 1;
}

/**
 * Locks the task's document, then the task, and checks the caller still holds a live claim with this
 * token. Every decision starts here. Null when the task isn't visible.
 */
export async function lockTaskForDecision(
  tx: TenantTx,
  input: { taskId: string; userId: string; claimToken: string; now: Date },
) {
  const [ref] = await tx.db
    .select({ documentId: reviewTasks.documentId })
    .from(reviewTasks)
    .where(eq(reviewTasks.id, input.taskId));
  if (!ref) return null;
  const [document] = await tx.db.select().from(documents).where(eq(documents.id, ref.documentId)).for("update");
  const task = await lockTask(tx, input.taskId);
  if (!document || !task) return null;
  assertOpen(task);
  const held =
    task.status === "claimed" &&
    task.claimedBy === input.userId &&
    task.claimToken === input.claimToken &&
    task.leaseExpiresAt !== null &&
    task.leaseExpiresAt > input.now;
  if (!held) throw new ReviewError("claim_lost", "Your claim on this task has ended. Reload to continue.");
  return { document, task };
}

/** A reviewer's edit as the document's next revision. The caller holds the document row lock. */
export async function insertUserExtraction(
  tx: TenantTx,
  input: { base: ExtractionRow; userId: string; fields: unknown; validationErrors: unknown; gateResults: unknown },
): Promise<ExtractionRow> {
  const [latest] = await tx.db
    .select({ n: max(extractions.revision) })
    .from(extractions)
    .where(eq(extractions.documentId, input.base.documentId));
  const [row] = await tx.db
    .insert(extractions)
    .values({
      tenantId: tx.tenantId,
      documentId: input.base.documentId,
      runId: null,
      revision: (latest?.n ?? 0) + 1,
      author: "user",
      parentId: input.base.id,
      category: input.base.category,
      schemaVersionId: input.base.schemaVersionId,
      fields: input.fields,
      validationErrors: input.validationErrors,
      gateResults: input.gateResults,
      createdBy: input.userId,
    })
    .returning();
  if (!row) throw new Error("extraction insert returned no row");
  return row;
}

export async function resolveTask(tx: TenantTx, taskId: string, now: Date): Promise<void> {
  await tx.db
    .update(reviewTasks)
    .set({ status: "resolved", claimedBy: null, claimToken: null, leaseExpiresAt: null, resolvedAt: now })
    .where(eq(reviewTasks.id, taskId));
}

/** After a reclassify: nobody can act on the task until the new run's extraction reopens it. */
export async function setAwaitingExtraction(tx: TenantTx, taskId: string): Promise<void> {
  await tx.db
    .update(reviewTasks)
    .set({ status: "awaiting_extraction", claimedBy: null, claimToken: null, leaseExpiresAt: null })
    .where(eq(reviewTasks.id, taskId));
}

export async function setReviewOutcome(
  tx: TenantTx,
  documentId: string,
  set: { reviewStatus: ReviewStatus; deliveryStatus?: "pending" },
): Promise<void> {
  await tx.db.update(documents).set(set).where(eq(documents.id, documentId));
}

export async function insertDecision(
  tx: TenantTx,
  input: {
    task: ReviewTaskRow;
    reviewerId: string;
    outcome: ReviewAction;
    extractionId?: string | null;
    before?: unknown;
    after?: unknown;
    diff?: unknown;
    note?: string | null;
  },
): Promise<string> {
  const [row] = await tx.db
    .insert(reviewDecisions)
    .values({
      tenantId: tx.tenantId,
      reviewTaskId: input.task.id,
      documentId: input.task.documentId,
      taskKind: input.task.kind,
      extractionId: input.extractionId ?? null,
      reviewerId: input.reviewerId,
      outcome: input.outcome,
      before: input.before ?? null,
      after: input.after ?? null,
      diff: input.diff ?? null,
      note: input.note ?? null,
    })
    .returning({ id: reviewDecisions.id });
  if (!row) throw new Error("review decision insert returned no row");
  return row.id;
}

/** A document's decisions, newest first, with reviewer emails. */
export async function listDecisions(tx: TenantTx, documentId: string) {
  return tx.db
    .select({
      id: reviewDecisions.id,
      outcome: reviewDecisions.outcome,
      taskKind: reviewDecisions.taskKind,
      extractionId: reviewDecisions.extractionId,
      reviewerEmail: users.email,
      diff: reviewDecisions.diff,
      note: reviewDecisions.note,
      createdAt: reviewDecisions.createdAt,
    })
    .from(reviewDecisions)
    .leftJoin(users, eq(users.id, reviewDecisions.reviewerId))
    .where(eq(reviewDecisions.documentId, documentId))
    .orderBy(desc(reviewDecisions.createdAt));
}
