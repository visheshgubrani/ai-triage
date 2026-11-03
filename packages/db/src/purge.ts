import { createHash } from "node:crypto";
import { EMAIL_SOURCE_MIME, QUEUES, type StorageDeleteJob } from "@ai-triage/core";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { enqueue, type PgBoss } from "./boss";
import { documents, tenantSettings, uploads } from "./schema";
import type { TenantTx } from "./tenant-tx";

// Deletion and retention (docs/security.md, M7). A document is deleted by purge_document()
// (migrations/0016_purge.sql), the one way past the immutability guards; its objects are deleted
// by a `storage.delete` job enqueued in the same transaction, so they go only once the rows are gone,
// and a storage hiccup is retried instead of leaving the database and the bucket out of step.

/** What storage holds for a purged document: an email is a folder of objects, a file is one. */
export function storageToDelete(
  tenantId: string,
  purged: { source_key: string; source_mime: string | null; part_keys: string[] },
): StorageDeleteJob {
  if (purged.source_mime === EMAIL_SOURCE_MIME) {
    const folder = purged.source_key.slice(0, purged.source_key.lastIndexOf("/") + 1);
    return { tenantId, keys: [], prefixes: [folder] };
  }
  return { tenantId, keys: [...new Set([purged.source_key, ...purged.part_keys])], prefixes: [] };
}

/**
 * Deletes a document, its runs, model calls, extractions, review tasks and decisions, and actions,
 * and enqueues the deletion of its objects. Returns null when the document isn't visible here, else
 * what an audit event may record about it (never its content).
 */
export async function purgeDocument(
  tx: TenantTx,
  boss: PgBoss,
  documentId: string,
): Promise<{ externalIdSha256: string; source: string } | null> {
  const [doc] = await tx.db
    .select({ externalId: documents.externalId, source: documents.source })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc) return null;
  const { rows } = await tx.db.execute<{ source_key: string; source_mime: string | null; part_keys: string[] }>(
    sql`select * from public.purge_document(${documentId})`,
  );
  const purged = rows[0];
  if (!purged) return null;
  await enqueue(boss, tx, QUEUES.storageDelete, storageToDelete(tx.tenantId, purged));
  return { externalIdSha256: createHash("sha256").update(doc.externalId).digest("hex"), source: doc.source };
}

/**
 * Finished documents created before `before`: nothing is left to happen to them (processed, decided
 * or not needing review, and not waiting for a delivery). Oldest first.
 */
export async function listExpiredDocuments(tx: TenantTx, before: Date, limit: number): Promise<string[]> {
  const rows = await tx.db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        lt(documents.createdAt, before),
        inArray(documents.processingStatus, ["done", "failed"]),
        inArray(documents.reviewStatus, ["not_required", "approved", "rejected"]),
        inArray(documents.deliveryStatus, ["none", "delivered", "failed"]),
      ),
    )
    .orderBy(documents.createdAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function getRetentionDays(tx: TenantTx): Promise<number | null> {
  const [row] = await tx.db.select({ days: tenantSettings.retentionDays }).from(tenantSettings);
  return row?.days ?? null;
}

export async function setRetentionDays(tx: TenantTx, days: number | null): Promise<void> {
  await tx.db.update(tenantSettings).set({ retentionDays: days }).where(eq(tenantSettings.tenantId, tx.tenantId));
}

/** Uploads that expired without being completed: their rows, and any object a client PUT anyway. */
export async function takeAbandonedUploads(tx: TenantTx, before: Date): Promise<string[]> {
  const rows = await tx.db
    .delete(uploads)
    .where(and(isNull(uploads.completedAt), lt(uploads.expiresAt, before)))
    .returning({ storageKey: uploads.storageKey });
  return rows.map((r) => r.storageKey);
}
