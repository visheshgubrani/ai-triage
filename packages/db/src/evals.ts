import {
  type Decision,
  type EvalErrorCode,
  type EvalItemJob,
  type EvalItemOrigin,
  type EvalSplit,
  type FailureReason,
  type LlmCallMode,
  QUEUES,
} from "@ai-triage/core";
import { type CallRow, type FieldScores, type ResultDetail, type RunSummary, runMetrics } from "@ai-triage/evals";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  type CategoryChange,
  createCandidateConfig,
  freezeConfig,
  getConfig,
  type PipelineConfig,
  setActiveConfig,
} from "./configs";
import { markCanonical } from "./llm-calls";
import { evalDatasets, evalItems, evalResults, evalRuns, llmCalls, pipelineConfigs } from "./schema";
import type { TenantTx } from "./tenant-tx";

// Eval datasets, runs and results (docs/architecture.md §8). An eval run executes the pipeline's own
// code over labeled items but never touches documents, tasks or actions (invariant 7): results go to
// eval_results only. A run is one eval.item job per item, enqueued with the run in one transaction;
// each item commits its result alone, and the commit that completes the set finishes the run.

/** An eval request the current state can't satisfy. The API maps `code` to 409 or 422. */
export class EvalRequestError extends Error {
  constructor(
    readonly code: EvalErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The dataset "Add to eval set" promotes into, created on first use. */
export const DEFAULT_EVAL_DATASET = "Main";

export type EvalItemRow = typeof evalItems.$inferSelect;
export type EvalRunRow = typeof evalRuns.$inferSelect;

// ── Datasets and items ───────────────────────────────────────────────────────────────────────

export async function getOrCreateDataset(
  tx: TenantTx,
  name = DEFAULT_EVAL_DATASET,
): Promise<{ id: string; name: string }> {
  const [created] = await tx.db
    .insert(evalDatasets)
    .values({ tenantId: tx.tenantId, name })
    .onConflictDoNothing()
    .returning({ id: evalDatasets.id, name: evalDatasets.name });
  if (created) return created;
  const [found] = await tx.db
    .select({ id: evalDatasets.id, name: evalDatasets.name })
    .from(evalDatasets)
    .where(eq(evalDatasets.name, name));
  if (!found) throw new Error(`dataset ${name} vanished`);
  return found;
}

export interface DatasetSummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  /** Active (not retired) items per split. */
  counts: Record<EvalSplit, number>;
}

export async function listDatasets(tx: TenantTx): Promise<DatasetSummary[]> {
  const datasets = await tx.db.select().from(evalDatasets).orderBy(asc(evalDatasets.createdAt));
  const counts = await tx.db
    .select({ datasetId: evalItems.datasetId, split: evalItems.split, n: count() })
    .from(evalItems)
    .where(isNull(evalItems.retiredAt))
    .groupBy(evalItems.datasetId, evalItems.split);
  return datasets.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    createdAt: d.createdAt,
    counts: {
      dev: counts.find((c) => c.datasetId === d.id && c.split === "dev")?.n ?? 0,
      calib: counts.find((c) => c.datasetId === d.id && c.split === "calib")?.n ?? 0,
      test: counts.find((c) => c.datasetId === d.id && c.split === "test")?.n ?? 0,
    },
  }));
}

export interface NewEvalItem {
  datasetId: string;
  /** The stored snapshot (`importEvalSource` / `snapshotDocumentSource` in @ai-triage/ingest). */
  source: { sourceKey: string; sourceMime: string; sourceTitle: string | null; contentKey: string };
  expectedCategory: string;
  expectedFields: Record<string, unknown>;
  split: EvalSplit;
  origin: EvalItemOrigin;
  originRef?: string;
  tags?: string[];
  createdBy?: string;
}

/**
 * Adds an item, unless the same content is already active in the dataset: then it returns that
 * item with `duplicate: true` (its snapshot objects were written for nothing, like an ingestion race).
 */
export async function insertEvalItem(
  tx: TenantTx,
  item: NewEvalItem,
): Promise<{ id: string; split: EvalSplit; duplicate: boolean }> {
  const [row] = await tx.db
    .insert(evalItems)
    .values({
      tenantId: tx.tenantId,
      datasetId: item.datasetId,
      ...item.source,
      expectedCategory: item.expectedCategory,
      expectedFields: item.expectedFields,
      split: item.split,
      origin: item.origin,
      originRef: item.originRef,
      tags: item.tags ?? [],
      createdBy: item.createdBy,
    })
    .onConflictDoNothing()
    .returning({ id: evalItems.id, split: evalItems.split });
  if (row) return { ...row, duplicate: false };
  const [existing] = await tx.db
    .select({ id: evalItems.id, split: evalItems.split })
    .from(evalItems)
    .where(
      and(
        eq(evalItems.datasetId, item.datasetId),
        eq(evalItems.contentKey, item.source.contentKey),
        isNull(evalItems.retiredAt),
      ),
    );
  if (!existing) throw new Error("eval item insert conflicted, but no active item has its content key");
  return { ...existing, duplicate: true };
}

export async function listItems(
  tx: TenantTx,
  datasetId: string,
  filter: { split?: EvalSplit; includeRetired?: boolean } = {},
): Promise<EvalItemRow[]> {
  return tx.db
    .select()
    .from(evalItems)
    .where(
      and(
        eq(evalItems.datasetId, datasetId),
        filter.split ? eq(evalItems.split, filter.split) : undefined,
        filter.includeRetired ? undefined : isNull(evalItems.retiredAt),
      ),
    )
    .orderBy(asc(evalItems.createdAt), asc(evalItems.id));
}

export async function getEvalItem(tx: TenantTx, itemId: string): Promise<EvalItemRow | null> {
  const [row] = await tx.db.select().from(evalItems).where(eq(evalItems.id, itemId));
  return row ?? null;
}

/** Retires an item (a wrong label); false if it was already retired or doesn't exist. */
export async function retireEvalItem(tx: TenantTx, itemId: string, now = new Date()): Promise<boolean> {
  const rows = await tx.db
    .update(evalItems)
    .set({ retiredAt: now })
    .where(and(eq(evalItems.id, itemId), isNull(evalItems.retiredAt)))
    .returning({ id: evalItems.id });
  return rows.length === 1;
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────

export interface NewEvalRun {
  datasetId: string;
  split: EvalSplit;
  configId: string;
  /** The mode the worker must be in to run it (record counts as live). */
  llmMode: LlmCallMode;
  createdBy?: string;
}

/**
 * Creates a run over the split's active items and enqueues one eval.item job per item, in the
 * caller's transaction (both exist only if it commits). Test-split runs need a frozen config:
 * thresholds are chosen on calib and frozen first (invariant 9; a trigger backs this up).
 */
export async function createEvalRun(
  tx: TenantTx,
  boss: PgBoss,
  input: NewEvalRun,
): Promise<{ runId: string; itemCount: number }> {
  const config = await getConfig(tx, input.configId);
  if (!config) throw new EvalRequestError("invalid_config", `config ${input.configId} not found`);
  if (input.split === "test" && !config.frozenAt) {
    throw new EvalRequestError("config_not_frozen", "test-split runs need a frozen config: run calib, then Freeze", {
      configId: config.id,
    });
  }
  const items = await tx.db
    .select({ id: evalItems.id })
    .from(evalItems)
    .where(and(eq(evalItems.datasetId, input.datasetId), eq(evalItems.split, input.split), isNull(evalItems.retiredAt)))
    .orderBy(asc(evalItems.createdAt), asc(evalItems.id));
  if (items.length === 0) throw new EvalRequestError("empty_split", `the ${input.split} split has no items`);

  const [run] = await tx.db
    .insert(evalRuns)
    .values({ tenantId: tx.tenantId, ...input, itemCount: items.length })
    .returning({ id: evalRuns.id });
  if (!run) throw new Error("eval run insert returned no row");
  const jobs = items.map((item) => ({
    data: { tenantId: tx.tenantId, evalRunId: run.id, evalItemId: item.id } satisfies EvalItemJob,
  }));
  await boss.insert(QUEUES.evalItem, jobs, { db: tx.queueDb });
  return { runId: run.id, itemCount: items.length };
}

export interface RunListEntry {
  run: EvalRunRow;
  config: { id: string; version: number; name: string; frozen: boolean; classifyModel: string; extractModel: string };
  datasetName: string;
  /** Results stored so far. */
  done: number;
}

export async function listRuns(
  tx: TenantTx,
  filter: { datasetId?: string; runId?: string; limit?: number } = {},
): Promise<RunListEntry[]> {
  const rows = await tx.db
    .select({
      run: evalRuns,
      configVersion: pipelineConfigs.version,
      configName: pipelineConfigs.name,
      frozenAt: pipelineConfigs.frozenAt,
      classifyModel: pipelineConfigs.classifyModel,
      extractModel: pipelineConfigs.extractModel,
      datasetName: evalDatasets.name,
      done: sql<number>`(select count(*)::int from eval_results r where r.eval_run_id = ${evalRuns.id})`,
    })
    .from(evalRuns)
    .innerJoin(pipelineConfigs, eq(pipelineConfigs.id, evalRuns.configId))
    .innerJoin(evalDatasets, eq(evalDatasets.id, evalRuns.datasetId))
    .where(
      and(
        filter.datasetId ? eq(evalRuns.datasetId, filter.datasetId) : undefined,
        filter.runId ? eq(evalRuns.id, filter.runId) : undefined,
      ),
    )
    .orderBy(desc(evalRuns.createdAt))
    .limit(filter.limit ?? 100);
  return rows.map((r) => ({
    run: r.run,
    config: {
      id: r.run.configId,
      version: r.configVersion,
      name: r.configName,
      frozen: r.frozenAt !== null,
      classifyModel: r.classifyModel,
      extractModel: r.extractModel,
    },
    datasetName: r.datasetName,
    done: r.done,
  }));
}

export async function getEvalRun(tx: TenantTx, runId: string): Promise<RunListEntry | null> {
  const [entry] = await listRuns(tx, { runId });
  return entry ?? null;
}

/** Fails a run that can't proceed (for example, the worker's LLM mode differs from the run's). */
export async function failEvalRun(tx: TenantTx, runId: string, error: string, now = new Date()): Promise<boolean> {
  const rows = await tx.db
    .update(evalRuns)
    .set({ status: "failed", error, finishedAt: now })
    .where(and(eq(evalRuns.id, runId), inArray(evalRuns.status, ["queued", "running"])))
    .returning({ id: evalRuns.id });
  return rows.length === 1;
}

// ── Calibration and activation ───────────────────────────────────────────────────────────────

/**
 * Freeze (docs/architecture.md §8): from a finished calib run, a new version of the run's config with
 * the thresholds (and automation, audit rate) chosen from its sweep, frozen in the same transaction.
 * Only frozen versions can run on test or be activated.
 */
export async function freezeCalibratedConfig(
  tx: TenantTx,
  input: { runId: string; name: string; categories: CategoryChange[]; createdBy?: string },
): Promise<PipelineConfig> {
  const [run] = await tx.db.select().from(evalRuns).where(eq(evalRuns.id, input.runId));
  if (!run) throw new EvalRequestError("run_not_done", `eval run ${input.runId} not found`);
  if (run.split !== "calib") throw new EvalRequestError("not_calib_run", "thresholds are chosen on a calib run");
  if (run.status !== "done") throw new EvalRequestError("run_not_done", "the calib run hasn't finished");
  const config = await createCandidateConfig(tx, {
    parentId: run.configId,
    name: input.name,
    categories: input.categories,
    createdBy: input.createdBy,
  });
  const frozenAt = await freezeConfig(tx, config.id);
  return { ...config, frozenAt };
}

/** Makes a frozen version the one new documents run with. */
export async function activateConfig(tx: TenantTx, configId: string): Promise<void> {
  const config = await getConfig(tx, configId);
  if (!config) throw new EvalRequestError("invalid_config", `config ${configId} not found`);
  if (!config.frozenAt) throw new EvalRequestError("config_not_frozen", "only a frozen config can be activated");
  await setActiveConfig(tx, configId);
}

// ── Running an item ──────────────────────────────────────────────────────────────────────────

export interface EvalItemInput {
  run: EvalRunRow;
  item: EvalItemRow;
  config: PipelineConfig;
}

/**
 * The read step of an eval.item job: null when there's nothing to do (the run is finished or failed,
 * or this item already has a result). Marks a queued run running.
 */
export async function loadEvalItemInput(
  tx: TenantTx,
  job: EvalItemJob,
  now = new Date(),
): Promise<EvalItemInput | null> {
  const [run] = await tx.db.select().from(evalRuns).where(eq(evalRuns.id, job.evalRunId));
  if (!run || (run.status !== "queued" && run.status !== "running")) return null;
  const [result] = await tx.db
    .select({ id: evalResults.id })
    .from(evalResults)
    .where(and(eq(evalResults.evalRunId, job.evalRunId), eq(evalResults.evalItemId, job.evalItemId)));
  if (result) return null;
  const item = await getEvalItem(tx, job.evalItemId);
  if (!item) throw new Error(`eval item ${job.evalItemId} not found`);
  const config = await getConfig(tx, run.configId);
  if (!config) throw new Error(`config ${run.configId} of eval run ${run.id} not found`);
  if (run.status === "queued") {
    await tx.db
      .update(evalRuns)
      .set({ status: "running", startedAt: now })
      .where(and(eq(evalRuns.id, run.id), eq(evalRuns.status, "queued")));
  }
  return { run, item, config };
}

export interface NewEvalResult {
  evalRunId: string;
  evalItemId: string;
  predictedCategory: string | null;
  predictedFields: Record<string, unknown> | null;
  score: number | null;
  decision: Decision | null;
  reasons: string[];
  gateResults: unknown;
  grade: { categoryCorrect: boolean; requiredCorrect: boolean; fullyCorrect: boolean; fieldScores: FieldScores | null };
  proposedAction: unknown;
  classifyCallId: string | null;
  extractCallId: string | null;
  error: { reason: FailureReason; message: string } | null;
}

/**
 * The commit step of an eval.item job, in one transaction: lock the run (NO KEY UPDATE, so attempt
 * inserts' foreign-key checks don't wait on it), store the result unless one exists (a duplicate
 * job), mark its attempts canonical only if it was stored, and finish the run when this was the last
 * item. Returns whether the result was stored and whether the run finished.
 */
export async function commitEvalResult(
  tx: TenantTx,
  result: NewEvalResult,
  now = new Date(),
): Promise<{ inserted: boolean; finished: boolean }> {
  const [run] = await tx.db
    .select({ status: evalRuns.status, itemCount: evalRuns.itemCount })
    .from(evalRuns)
    .where(eq(evalRuns.id, result.evalRunId))
    .for("no key update");
  if (!run || (run.status !== "queued" && run.status !== "running")) return { inserted: false, finished: false };

  const ctx = { evalRunId: result.evalRunId, evalItemId: result.evalItemId };
  const [{ cost } = { cost: null }] = await tx.db
    .select({ cost: sql<string | null>`sum(${llmCalls.costUsd})` })
    .from(llmCalls)
    .where(and(eq(llmCalls.evalRunId, result.evalRunId), eq(llmCalls.evalItemId, result.evalItemId)));
  const callIds = [result.classifyCallId, result.extractCallId].filter((id): id is string => id !== null);
  const [{ latency } = { latency: null }] =
    callIds.length === 0
      ? []
      : await tx.db
          .select({ latency: sql<number | null>`sum(${llmCalls.latencyMs})::int` })
          .from(llmCalls)
          .where(inArray(llmCalls.id, callIds));

  const [stored] = await tx.db
    .insert(evalResults)
    .values({
      tenantId: tx.tenantId,
      evalRunId: result.evalRunId,
      evalItemId: result.evalItemId,
      predictedCategory: result.predictedCategory,
      predictedFields: result.predictedFields,
      fieldScores: result.grade.fieldScores,
      score: result.score,
      decision: result.decision,
      reasons: result.reasons,
      gateResults: result.gateResults,
      categoryCorrect: result.grade.categoryCorrect,
      requiredCorrect: result.grade.requiredCorrect,
      fullyCorrect: result.grade.fullyCorrect,
      proposedAction: result.proposedAction,
      costUsd: cost ?? "0",
      latencyMs: latency,
      classifyCallId: result.classifyCallId,
      extractCallId: result.extractCallId,
      errorReason: result.error?.reason ?? null,
      error: result.error?.message ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: evalResults.id });
  if (!stored) return { inserted: false, finished: false };
  if (result.classifyCallId) await markCanonical(tx, { id: result.classifyCallId, ctx, stage: "classify" });
  if (result.extractCallId) await markCanonical(tx, { id: result.extractCallId, ctx, stage: "extract" });

  const [{ n } = { n: 0 }] = await tx.db
    .select({ n: count() })
    .from(evalResults)
    .where(eq(evalResults.evalRunId, result.evalRunId));
  if (n < run.itemCount) return { inserted: true, finished: false };
  const summary: RunSummary = runMetrics(
    await loadRunResults(tx, result.evalRunId),
    await loadRunCalls(tx, result.evalRunId),
  ).summary;
  await tx.db
    .update(evalRuns)
    .set({ status: "done", aggregates: summary, finishedAt: now })
    .where(eq(evalRuns.id, result.evalRunId));
  return { inserted: true, finished: true };
}

// ── Reading results ──────────────────────────────────────────────────────────────────────────

export async function loadRunResults(tx: TenantTx, runId: string): Promise<ResultDetail[]> {
  const rows = await tx.db
    .select({ result: evalResults, item: evalItems })
    .from(evalResults)
    .innerJoin(evalItems, eq(evalItems.id, evalResults.evalItemId))
    .where(eq(evalResults.evalRunId, runId))
    .orderBy(asc(evalItems.createdAt), asc(evalItems.id));
  return rows.map(({ result: r, item }) => ({
    resultId: r.id,
    itemId: item.id,
    sourceTitle: item.sourceTitle,
    split: item.split,
    tags: item.tags,
    expectedCategory: item.expectedCategory,
    expectedFields: item.expectedFields as Record<string, unknown>,
    predictedCategory: r.predictedCategory,
    predictedFields: r.predictedFields as Record<string, unknown> | null,
    score: r.score,
    decision: r.decision,
    reasons: r.reasons,
    categoryCorrect: r.categoryCorrect,
    requiredCorrect: r.requiredCorrect,
    fullyCorrect: r.fullyCorrect,
    fieldScores: r.fieldScores as FieldScores | null,
    errorReason: r.errorReason,
    error: r.error,
    proposedAction: r.proposedAction,
    costUsd: Number(r.costUsd ?? 0),
    latencyMs: r.latencyMs,
  }));
}

/** Every attempt of a run (retries included), for cost and latency. */
export async function loadRunCalls(tx: TenantTx, runId: string): Promise<CallRow[]> {
  const rows = await tx.db
    .select({
      itemId: llmCalls.evalItemId,
      stage: llmCalls.stage,
      canonical: llmCalls.canonical,
      mode: llmCalls.mode,
      costUsd: llmCalls.costUsd,
      latencyMs: llmCalls.latencyMs,
      inputTokens: llmCalls.inputTokens,
      outputTokens: llmCalls.outputTokens,
      cacheReadInputTokens: llmCalls.cacheReadInputTokens,
      cacheCreationInputTokens: llmCalls.cacheCreationInputTokens,
    })
    .from(llmCalls)
    .where(eq(llmCalls.evalRunId, runId));
  return rows.map((r) => ({ ...r, itemId: r.itemId ?? "", costUsd: r.costUsd === null ? null : Number(r.costUsd) }));
}
