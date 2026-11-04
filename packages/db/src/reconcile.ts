import { type PipelineStage, type ProcessingStatus, QUEUES, STAGE_INPUT_STATUS, STAGE_QUEUES } from "@ai-triage/core";
import { eq, sql } from "drizzle-orm";
import { stageJobId } from "./boss";
import { markDeliveryFailed } from "./delivery";
import { failEvalRun } from "./evals";
import type { Db } from "./index";
import { failRun } from "./pipeline";
import { actions, documents, evalRuns } from "./schema";
import type { TenantTx } from "./tenant-tx";

// Self-healing (docs/architecture.md §5): work left waiting on a job that no longer exists (a job
// whose dead letter also failed, a deleted job, a crash between two commits) is made visible
// instead of silently redone. pg-boss keeps a finished job's id for 7 days and ignores a re-send
// of it, so re-sending isn't an option: a stalled run fails into Processing failed (Retry gives
// it new job ids), a stalled action into Delivery failures (Redeliver), and a stalled eval run fails.

export type StaleKind = "document" | "action" | "eval_run";
export interface StaleWork {
  kind: StaleKind;
  tenantId: string;
  id: string;
}

/** Candidates older than `before`, across tenants (the stale_work() resolver, 0028_reconcile.sql). */
export async function staleWork(db: Db, before: Date, limit = 200): Promise<StaleWork[]> {
  const { rows } = await db.execute<{ kind: StaleKind; tenant_id: string; id: string }>(
    sql`select kind, tenant_id, id from stale_work(${before.toISOString()}::timestamptz, ${limit})`,
  );
  return rows.map((r) => ({ kind: r.kind, tenantId: r.tenant_id, id: r.id }));
}

const LIVE = sql`state in ('created', 'retry', 'active')`;

const STAGE_FOR_STATUS = Object.fromEntries(
  (Object.entries(STAGE_INPUT_STATUS) as [PipelineStage, ProcessingStatus][]).map(([stage, status]) => [status, stage]),
) as Partial<Record<ProcessingStatus, PipelineStage>>;

async function anyLive(tx: TenantTx, condition: ReturnType<typeof sql>): Promise<boolean> {
  const { rows } = await tx.db.execute(sql`select 1 from pgboss.job where ${LIVE} and (${condition}) limit 1`);
  return rows.length > 0;
}

/**
 * A document still waiting for a stage whose job is gone: neither the stage job (its deterministic
 * id) nor its dead-letter copy (which points back at it) will run. `failRun` is guarded on the
 * status, so a stage that commits at the same moment wins and this changes nothing.
 */
export async function reconcileDocument(tx: TenantTx, documentId: string): Promise<boolean> {
  const [doc] = await tx.db
    .select({ status: documents.processingStatus, runId: documents.currentRunId })
    .from(documents)
    .where(eq(documents.id, documentId));
  const stage = doc ? STAGE_FOR_STATUS[doc.status as ProcessingStatus] : undefined;
  if (!doc?.runId || !stage) return false;
  const jobId = stageJobId(doc.runId, stage);
  const live = await anyLive(
    tx,
    sql`(name = ${STAGE_QUEUES[stage]} and id = ${jobId}::uuid) or (name = ${QUEUES.failed} and source_id = ${jobId}::uuid)`,
  );
  if (live) return false;
  return failRun(tx, {
    runId: doc.runId,
    expectedStatus: doc.status as ProcessingStatus,
    reason: "stalled",
    message: `no ${stage} job is left to process it`,
  });
}

/** A pending action with no delivery job (or dead letter) left: it shows under Delivery failures. */
export async function reconcileAction(tx: TenantTx, actionId: string): Promise<boolean> {
  const [action] = await tx.db.select({ status: actions.status }).from(actions).where(eq(actions.id, actionId));
  if (action?.status !== "pending") return false;
  const live = await anyLive(
    tx,
    sql`name in (${QUEUES.deliver}, ${QUEUES.deliveryFailed}) and data->>'actionId' = ${actionId}`,
  );
  if (live) return false;
  return markDeliveryFailed(tx, {
    actionId,
    error: "delivery_stalled: no delivery job was left for this action. Redeliver sends it.",
    countAttempt: false,
  });
}

/** An eval run whose remaining items have no job left: it would never finish, so it fails. */
export async function reconcileEvalRun(tx: TenantTx, runId: string, now: Date): Promise<boolean> {
  const [run] = await tx.db.select({ status: evalRuns.status }).from(evalRuns).where(eq(evalRuns.id, runId));
  if (run?.status !== "queued" && run?.status !== "running") return false;
  const live = await anyLive(
    tx,
    sql`name in (${QUEUES.evalItem}, ${QUEUES.evalFailed}) and data->>'evalRunId' = ${runId}`,
  );
  if (live) return false;
  return failEvalRun(tx, runId, "stalled: some items have no job left to run them", now);
}

/** The processing status of the document whose current run is `runId` (null: the run isn't current). */
export async function currentRunStatus(tx: TenantTx, runId: string): Promise<ProcessingStatus | null> {
  const [doc] = await tx.db
    .select({ status: documents.processingStatus })
    .from(documents)
    .where(eq(documents.currentRunId, runId));
  return (doc?.status as ProcessingStatus | undefined) ?? null;
}
