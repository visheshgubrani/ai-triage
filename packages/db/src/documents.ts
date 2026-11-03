import type { DocumentSource } from "@ai-triage/core";
import { and, asc, desc, eq, lt, ne } from "drizzle-orm";
import { enqueueStage, type PgBoss } from "./boss";
import { getActiveConfig } from "./configs";
import { loadClassification, loadParts, loadSchemaVersion } from "./pipeline";
import { listDecisions } from "./review";
import {
  actions,
  documentParts,
  documents,
  extractions,
  processingRuns,
  reviewTasks,
  tenantSettings,
  users,
} from "./schema";
import type { TenantTx } from "./tenant-tx";

export class IngestError extends Error {}

export interface NewDocument {
  source: DocumentSource;
  /** Dedup key per tenant and source: Message-ID for email, else the content's SHA-256. */
  externalId: string;
  /** Server-issued storage key of the source object. */
  sourceKey: string;
  title?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
}

/**
 * Creates the document, its first processing run and the `doc.parse` job in the caller's
 * transaction (docs/architecture.md §5), so all three exist or none do. A document that already
 * exists for (source, external_id) is a duplicate: nothing is written and its id is returned.
 */
export async function ingestDocument(
  tx: TenantTx,
  boss: PgBoss,
  input: NewDocument,
): Promise<{ documentId: string; duplicate: boolean }> {
  const [settings] = await tx.db.select({ configId: tenantSettings.activeConfigId }).from(tenantSettings);
  if (!settings?.configId) throw new IngestError("the tenant has no active pipeline config");

  const [doc] = await tx.db
    .insert(documents)
    .values({ tenantId: tx.tenantId, ...input })
    .onConflictDoNothing({ target: [documents.tenantId, documents.source, documents.externalId] })
    .returning({ id: documents.id });
  if (!doc) {
    const existing = await findDocument(tx, input.source, input.externalId);
    if (!existing) throw new IngestError("duplicate document is not visible");
    return { documentId: existing, duplicate: true };
  }

  const [run] = await tx.db
    .insert(processingRuns)
    .values({ tenantId: tx.tenantId, documentId: doc.id, configId: settings.configId, trigger: "ingest" })
    .returning({ id: processingRuns.id });
  if (!run) throw new Error("processing run insert returned no row");
  await tx.db.update(documents).set({ currentRunId: run.id }).where(eq(documents.id, doc.id));
  await enqueueStage(boss, tx, "parse", { tenantId: tx.tenantId, documentId: doc.id, runId: run.id });
  return { documentId: doc.id, duplicate: false };
}

export async function loadDocument(tx: TenantTx, documentId: string) {
  const [row] = await tx.db.select().from(documents).where(eq(documents.id, documentId));
  return row ?? null;
}

/** One part of a document, with its storage key (for presigning the part's file). */
export async function loadPart(tx: TenantTx, documentId: string, partIndex: number) {
  const [row] = await tx.db
    .select()
    .from(documentParts)
    .where(and(eq(documentParts.documentId, documentId), eq(documentParts.partIndex, partIndex)));
  return row ?? null;
}

/** The id of the tenant's document with this source and external id, if any. */
export async function findDocument(tx: TenantTx, source: DocumentSource, externalId: string): Promise<string | null> {
  const [row] = await tx.db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.source, source), eq(documents.externalId, externalId)));
  return row?.id ?? null;
}

/** Newest first, for the documents page. `before` pages by creation time. */
export async function listDocuments(tx: TenantTx, options: { limit?: number; before?: Date } = {}) {
  return tx.db
    .select({
      id: documents.id,
      title: documents.title,
      source: documents.source,
      mime: documents.mime,
      createdAt: documents.createdAt,
      processingStatus: documents.processingStatus,
      reviewStatus: documents.reviewStatus,
      deliveryStatus: documents.deliveryStatus,
      category: extractions.category,
      score: extractions.score,
      decision: extractions.decision,
      decisionReasons: extractions.decisionReasons,
      taskKind: reviewTasks.kind,
      taskReasons: reviewTasks.reasons,
    })
    .from(documents)
    .leftJoin(extractions, eq(extractions.id, documents.currentExtractionId))
    .leftJoin(reviewTasks, and(eq(reviewTasks.documentId, documents.id), ne(reviewTasks.status, "resolved")))
    .where(options.before ? lt(documents.createdAt, options.before) : undefined)
    .orderBy(desc(documents.createdAt))
    .limit(options.limit ?? 50);
}

/**
 * Everything the detail and review pages show about one document, or null if it isn't visible.
 * `modelGateResults` are those of the latest model revision: a reviewer's revision has no evidence of
 * its own, so the page highlights the model's quotes.
 */
export async function getDocumentDetail(tx: TenantTx, documentId: string) {
  const [document] = await tx.db.select().from(documents).where(eq(documents.id, documentId));
  if (!document) return null;
  const [run] = document.currentRunId
    ? await tx.db.select().from(processingRuns).where(eq(processingRuns.id, document.currentRunId))
    : [];
  const [extraction] = document.currentExtractionId
    ? await tx.db.select().from(extractions).where(eq(extractions.id, document.currentExtractionId))
    : [];
  const [task] = await tx.db
    .select({ task: reviewTasks, claimedByEmail: users.email })
    .from(reviewTasks)
    .leftJoin(users, eq(users.id, reviewTasks.claimedBy))
    .where(and(eq(reviewTasks.documentId, documentId), ne(reviewTasks.status, "resolved")));
  const revisions = await tx.db
    .select({
      id: extractions.id,
      revision: extractions.revision,
      author: extractions.author,
      authorEmail: users.email,
      runId: extractions.runId,
      category: extractions.category,
      decision: extractions.decision,
      gateResults: extractions.gateResults,
      createdAt: extractions.createdAt,
    })
    .from(extractions)
    .leftJoin(users, eq(users.id, extractions.createdBy))
    .where(eq(extractions.documentId, documentId))
    .orderBy(asc(extractions.revision));
  const documentActions = await tx.db
    .select()
    .from(actions)
    .where(eq(actions.documentId, documentId))
    .orderBy(asc(actions.createdAt));
  const config = await getActiveConfig(tx);
  return {
    document,
    run: run ?? null,
    parts: await loadParts(tx, documentId),
    classification: run ? await loadClassification(tx, run.id) : null,
    extraction: extraction ?? null,
    schema: extraction ? (await loadSchemaVersion(tx, extraction.schemaVersionId)).jsonSchema : null,
    modelGateResults: revisions.findLast((r) => r.author === "model")?.gateResults ?? null,
    revisions: revisions.map(({ gateResults: _gateResults, ...r }) => r),
    task: task ? { ...task.task, claimedByEmail: task.claimedByEmail } : null,
    decisions: await listDecisions(tx, documentId),
    actions: documentActions,
    categories: (config?.categories ?? []).map((c) => c.category).sort(),
  };
}
