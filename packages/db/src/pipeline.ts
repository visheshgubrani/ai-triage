import type {
  Decision,
  DeliveryStatus,
  EvidenceMode,
  FailureReason,
  ProcessingStatus,
  ReviewStatus,
  ReviewTaskKind,
} from "@ai-triage/core";
import { and, asc, eq, inArray, isNull, max, ne } from "drizzle-orm";
import {
  actions,
  categorySchemaVersions,
  classifications,
  documentParts,
  documents,
  extractions,
  processingRuns,
  promptVersions,
  reviewTasks,
} from "./schema";
import type { TenantTx } from "./tenant-tx";

// Stage reads and writes for the worker (docs/architecture.md §5). Every write that moves a document
// forward is guarded on `current_run_id` and the expected processing status: a stale or duplicate job
// matches nothing and must stop. A stage's commit order is: advanceDocument (takes the row lock),
// stage result, pointer updates, markCanonical, enqueue the next stage, all in one transaction.

export type ProcessingRunRow = typeof processingRuns.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentPartRow = typeof documentParts.$inferSelect;
export type ClassificationRow = typeof classifications.$inferSelect;
export type ExtractionRow = typeof extractions.$inferSelect;

export async function loadRun(tx: TenantTx, runId: string) {
  const [row] = await tx.db
    .select({ run: processingRuns, document: documents })
    .from(processingRuns)
    .innerJoin(documents, eq(documents.id, processingRuns.documentId))
    .where(eq(processingRuns.id, runId));
  return row ?? null;
}

/** True when `runId` is the document's current run and the document is waiting for this stage. */
export function isAtStage(document: DocumentRow, runId: string, status: ProcessingStatus): boolean {
  return document.currentRunId === runId && document.processingStatus === status;
}

export async function loadParts(tx: TenantTx, documentId: string): Promise<DocumentPartRow[]> {
  return tx.db
    .select()
    .from(documentParts)
    .where(eq(documentParts.documentId, documentId))
    .orderBy(asc(documentParts.partIndex));
}

export async function loadClassification(tx: TenantTx, runId: string): Promise<ClassificationRow | null> {
  const [row] = await tx.db.select().from(classifications).where(eq(classifications.runId, runId));
  return row ?? null;
}

export async function loadExtraction(tx: TenantTx, extractionId: string): Promise<ExtractionRow | null> {
  const [row] = await tx.db.select().from(extractions).where(eq(extractions.id, extractionId));
  return row ?? null;
}

export async function loadPromptBody(tx: TenantTx, promptVersionId: string): Promise<string> {
  const [row] = await tx.db
    .select({ body: promptVersions.body })
    .from(promptVersions)
    .where(eq(promptVersions.id, promptVersionId));
  if (!row) throw new Error(`prompt version ${promptVersionId} not found`);
  return row.body;
}

export async function loadSchemaVersion(tx: TenantTx, schemaVersionId: string) {
  const [row] = await tx.db.select().from(categorySchemaVersions).where(eq(categorySchemaVersions.id, schemaVersionId));
  if (!row) throw new Error(`category schema version ${schemaVersionId} not found`);
  return row;
}

export async function loadSchemaVersions(tx: TenantTx, ids: string[]) {
  if (ids.length === 0) return [];
  return tx.db.select().from(categorySchemaVersions).where(inArray(categorySchemaVersions.id, ids));
}

/**
 * Moves the document of `runId` from `from` to `to` (plus any extra columns), only if the run is
 * still current and the document is still at `from`. Returns false for a stale or duplicate job.
 */
export async function advanceDocument(
  tx: TenantTx,
  input: {
    documentId: string;
    runId: string;
    from: ProcessingStatus;
    to: ProcessingStatus;
    set?: { reviewStatus?: ReviewStatus; deliveryStatus?: DeliveryStatus };
  },
): Promise<boolean> {
  const rows = await tx.db
    .update(documents)
    .set({ processingStatus: input.to, ...input.set })
    .where(
      and(
        eq(documents.id, input.documentId),
        eq(documents.currentRunId, input.runId),
        eq(documents.processingStatus, input.from),
      ),
    )
    .returning({ id: documents.id });
  return rows.length === 1;
}

export interface NewPart {
  partIndex: number;
  page: number | null;
  text: string;
  evidenceMode: EvidenceMode;
  storageKey: string | null;
}

/** Parts belong to the document, not the run: a later run re-uses them (on conflict do nothing). */
export async function insertParts(tx: TenantTx, documentId: string, parts: NewPart[]): Promise<void> {
  if (parts.length === 0) return;
  await tx.db
    .insert(documentParts)
    .values(parts.map((p) => ({ tenantId: tx.tenantId, documentId, ...p })))
    .onConflictDoNothing({ target: [documentParts.documentId, documentParts.partIndex] });
}

export async function insertClassification(
  tx: TenantTx,
  input: { documentId: string; runId: string; category: string; selfConfidence: number; rationale: string },
): Promise<string> {
  const [row] = await tx.db
    .insert(classifications)
    .values({ tenantId: tx.tenantId, ...input })
    .returning({ id: classifications.id });
  if (!row) throw new Error("classification insert returned no row");
  return row.id;
}

/**
 * Inserts the model's extraction as the document's next revision. Call after advanceDocument, which
 * holds the document row lock, so concurrent revision writers can't pick the same number.
 */
export async function insertModelExtraction(
  tx: TenantTx,
  input: {
    documentId: string;
    runId: string;
    category: string;
    schemaVersionId: string;
    fields: unknown;
    validationErrors: unknown;
  },
): Promise<ExtractionRow> {
  const [latest] = await tx.db
    .select({ n: max(extractions.revision) })
    .from(extractions)
    .where(eq(extractions.documentId, input.documentId));
  const [row] = await tx.db
    .insert(extractions)
    .values({ tenantId: tx.tenantId, ...input, revision: (latest?.n ?? 0) + 1, author: "model" })
    .returning();
  if (!row) throw new Error("extraction insert returned no row");
  return row;
}

/** Points the document at an extraction. Separate from advanceDocument: the FK isn't deferrable. */
export async function setCurrentExtraction(tx: TenantTx, documentId: string, extractionId: string): Promise<void> {
  await tx.db.update(documents).set({ currentExtractionId: extractionId }).where(eq(documents.id, documentId));
}

/** Records route's outcome on the extraction it decided on. Only once: `decision` must still be null. */
export async function applyRouteDecision(
  tx: TenantTx,
  extractionId: string,
  input: { gateResults: unknown; score: number | null; decision: Decision; reasons: string[] },
): Promise<boolean> {
  const rows = await tx.db
    .update(extractions)
    .set({
      gateResults: input.gateResults,
      score: input.score,
      decision: input.decision,
      decisionReasons: input.reasons,
    })
    .where(and(eq(extractions.id, extractionId), isNull(extractions.decision)))
    .returning({ id: extractions.id });
  return rows.length === 1;
}

/**
 * Opens a task for the document, reusing its open task if it has one (at most one may be open):
 * the kind, extraction and reasons are replaced, and any claim is cleared so a stale claim token
 * can't act on the new state.
 */
export async function upsertOpenTask(
  tx: TenantTx,
  input: { documentId: string; kind: ReviewTaskKind; extractionId?: string | null; reasons: string[] },
): Promise<string> {
  const values = {
    kind: input.kind,
    extractionId: input.extractionId ?? null,
    reasons: input.reasons,
    status: "pending" as const,
    claimedBy: null,
    claimToken: null,
    leaseExpiresAt: null,
    resolvedAt: null,
  };
  const [updated] = await tx.db
    .update(reviewTasks)
    .set(values)
    .where(and(eq(reviewTasks.documentId, input.documentId), ne(reviewTasks.status, "resolved")))
    .returning({ id: reviewTasks.id });
  if (updated) return updated.id;
  const [inserted] = await tx.db
    .insert(reviewTasks)
    .values({ tenantId: tx.tenantId, documentId: input.documentId, ...values })
    .returning({ id: reviewTasks.id });
  if (!inserted) throw new Error("review task insert returned no row");
  return inserted.id;
}

/** Adds an approved action to the outbox. Its id is the webhook's Idempotency-Key. */
export async function createAction(
  tx: TenantTx,
  input: { documentId: string; extractionId: string; payload: unknown },
): Promise<string> {
  const [row] = await tx.db
    .insert(actions)
    .values({ tenantId: tx.tenantId, ...input })
    .returning({ id: actions.id });
  if (!row) throw new Error("action insert returned no row");
  return row.id;
}

export async function finishRun(tx: TenantTx, runId: string): Promise<void> {
  await tx.db
    .update(processingRuns)
    .set({ status: "done", finishedAt: new Date() })
    .where(eq(processingRuns.id, runId));
}

/**
 * Fails the run and hands the document to a human (`processing_failed` task: Retry or Reject).
 * Guarded on the status the failing stage expected, so a job that expired after its stage had
 * already committed can't fail a document that has moved on. Returns false when nothing matched.
 */
export async function failRun(
  tx: TenantTx,
  input: { runId: string; expectedStatus: ProcessingStatus; reason: FailureReason; message?: string },
): Promise<boolean> {
  const [doc] = await tx.db
    .update(documents)
    .set({ processingStatus: "failed", reviewStatus: "pending" })
    .where(and(eq(documents.currentRunId, input.runId), eq(documents.processingStatus, input.expectedStatus)))
    .returning({ id: documents.id });
  if (!doc) return false;
  const error = input.message ? `${input.reason}: ${input.message}` : input.reason;
  await tx.db
    .update(processingRuns)
    .set({ status: "failed", error: error.slice(0, 2000), finishedAt: new Date() })
    .where(eq(processingRuns.id, input.runId));
  await upsertOpenTask(tx, { documentId: doc.id, kind: "processing_failed", reasons: [input.reason] });
  return true;
}
