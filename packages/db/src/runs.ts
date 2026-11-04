import { eq, sql } from "drizzle-orm";
import { enqueueStage, type PgBoss } from "./boss";
import { getActiveConfig } from "./configs";
import { documents, processingRuns } from "./schema";
import type { TenantTx } from "./tenant-tx";

export type NewRun =
  | { documentId: string; configId: string; trigger: "retry" }
  | { documentId: string; configId: string; trigger: "reclassify"; forcedCategory: string };

/**
 * Starts a new processing run for a document a reviewer sent back (docs/architecture.md §5): the run
 * becomes current, the previous one is linked through `superseded_by` (a finished run is marked
 * `superseded`, a failed one stays `failed`), and the first stage is enqueued in the same transaction.
 * A retry starts from parse; a reclassify run starts at extract with the reviewer's category.
 * The caller must hold the document row lock.
 */
export async function startRun(tx: TenantTx, boss: PgBoss, input: NewRun): Promise<string> {
  const [document] = await tx.db
    .select({ currentRunId: documents.currentRunId })
    .from(documents)
    .where(eq(documents.id, input.documentId));
  if (!document) throw new Error(`document ${input.documentId} not found`);

  const forcedCategory = input.trigger === "reclassify" ? input.forcedCategory : null;
  const [run] = await tx.db
    .insert(processingRuns)
    .values({
      tenantId: tx.tenantId,
      documentId: input.documentId,
      configId: input.configId,
      trigger: input.trigger,
      forcedCategory,
    })
    .returning({ id: processingRuns.id });
  if (!run) throw new Error("processing run insert returned no row");

  if (document.currentRunId) {
    await tx.db
      .update(processingRuns)
      .set({
        supersededBy: run.id,
        status: sql`case when ${processingRuns.status} = 'failed' then 'failed' else 'superseded' end`,
        finishedAt: sql`coalesce(${processingRuns.finishedAt}, now())`,
      })
      .where(eq(processingRuns.id, document.currentRunId));
  }
  const stage = input.trigger === "reclassify" ? "extract" : "parse";
  await tx.db
    .update(documents)
    .set({ currentRunId: run.id, processingStatus: stage === "extract" ? "classified" : "received" })
    .where(eq(documents.id, input.documentId));
  await enqueueStage(boss, tx, stage, { tenantId: tx.tenantId, documentId: input.documentId, runId: run.id });
  return run.id;
}

/**
 * Process anyway: a document an intake filter skipped runs the pipeline after all, as a retry
 * (which the filters never apply to). Locks the document, so a second click finds it no longer
 * skipped and starts nothing. Null: the document isn't skipped (or doesn't exist).
 */
export async function processSkipped(tx: TenantTx, boss: PgBoss, documentId: string): Promise<string | null> {
  const [document] = await tx.db
    .select({ status: documents.processingStatus })
    .from(documents)
    .where(eq(documents.id, documentId))
    .for("update");
  if (document?.status !== "skipped") return null;
  const config = await getActiveConfig(tx);
  if (!config) throw new Error("the tenant has no active pipeline config");
  return startRun(tx, boss, { documentId, configId: config.id, trigger: "retry" });
}
