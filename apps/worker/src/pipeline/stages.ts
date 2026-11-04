import {
  OTHER_CATEGORY,
  PIPELINE_STAGES,
  type PipelineStage,
  QUEUES,
  STAGE_INPUT_STATUS,
  STAGE_QUEUES,
  type StageJob,
} from "@ai-triage/core";
import {
  approvedPayload,
  buildClassifyRequest,
  buildExtractRequest,
  classifyCategories,
  evaluateExtraction,
  type ParsedPart,
  PipelineError,
  parseClassifyOutput,
  parseExtractOutput,
  senderPolicy,
} from "@ai-triage/core/pipeline";
import {
  advanceDocument,
  applyRouteDecision,
  createAction,
  currentRunStatus,
  enqueue,
  enqueueStage,
  failRun,
  finishRun,
  getConfig,
  insertClassification,
  insertModelExtraction,
  insertParts,
  isAtStage,
  loadCanonicalAttempt,
  loadClassification,
  loadExtraction,
  loadParts,
  loadPromptBody,
  loadRun,
  loadSchemaVersion,
  markCanonical,
  setCurrentExtraction,
  stagePolicy,
  type TenantTx,
  upsertOpenTask,
  withTenantTx,
} from "@ai-triage/db";
import { readAttemptOutput } from "@ai-triage/llm";
import { type JsonSchema, validateFields } from "@ai-triage/schemas";
import { log } from "../observe";
import type { PipelineDeps } from "./deps";
import { loadBlobs, loadCategoryOptions, loadSender, parseSource, stageModel } from "./source";

// Each stage follows docs/architecture.md §5: read in a short transaction (stop if the run isn't
// current or the stage is done), do the slow work with no transaction open, then commit in one
// transaction: guarded status advance (which locks the document row and detects stale or duplicate
// jobs), stage result, pointers, canonical attempt, next job.

/** Loads the run if its document is waiting for `stage`; null for a stale or duplicate job. */
async function currentRun(tx: TenantTx, job: StageJob, stage: PipelineStage) {
  const found = await loadRun(tx, job.runId);
  if (!found || !isAtStage(found.document, job.runId, STAGE_INPUT_STATUS[stage])) return null;
  const config = await getConfig(tx, found.run.configId);
  if (!config) throw new Error(`config ${found.run.configId} of run ${job.runId} not found`);
  return { ...found, config };
}

const toNewParts = (parts: ParsedPart[]) =>
  parts.map(({ partIndex, kind, mime, label, page, text, evidenceMode, storageKey }) => ({
    partIndex,
    kind,
    mime,
    label,
    page,
    text,
    evidenceMode,
    storageKey,
  }));

export async function parseStage(deps: PipelineDeps, job: StageJob): Promise<void> {
  const doc = await withTenantTx(deps.pool, job.tenantId, async (tx) => (await currentRun(tx, job, "parse"))?.document);
  if (!doc) return;

  const parts = await parseSource(deps.storage, doc, deps.limits);

  await withTenantTx(deps.pool, job.tenantId, async (tx) => {
    if (!(await advanceDocument(tx, { documentId: job.documentId, runId: job.runId, from: "received", to: "parsed" })))
      return;
    await insertParts(tx, job.documentId, toNewParts(parts));
    await enqueueStage(deps.boss, tx, "classify", job);
  });
}

export async function classifyStage(deps: PipelineDeps, job: StageJob, signal?: AbortSignal): Promise<void> {
  const input = await withTenantTx(deps.pool, job.tenantId, async (tx) => {
    const found = await currentRun(tx, job, "classify");
    if (!found) return null;
    return {
      config: found.config,
      categories: await loadCategoryOptions(tx, found.config),
      parts: await loadParts(tx, job.documentId),
      promptBody: await loadPromptBody(tx, found.config.classifyPromptVersionId),
    };
  });
  if (!input) return;

  const request = buildClassifyRequest({
    model: stageModel(input.config, "classify"),
    promptBody: input.promptBody,
    categories: input.categories,
    parts: input.parts,
    blobs: await loadBlobs(deps.storage, input.parts),
  });
  const ctx = { runId: job.runId };
  const { attemptId, output } = await deps.llm.call({ tenantId: job.tenantId, ctx, request, signal });
  const result = parseClassifyOutput(output, classifyCategories(input.categories));
  const other = result.category === OTHER_CATEGORY;

  await withTenantTx(deps.pool, job.tenantId, async (tx) => {
    const moved = await advanceDocument(tx, {
      documentId: job.documentId,
      runId: job.runId,
      from: "parsed",
      to: other ? "done" : "classified",
      ...(other ? { set: { reviewStatus: "pending" as const } } : {}),
    });
    if (!moved) return;
    await insertClassification(tx, {
      documentId: job.documentId,
      runId: job.runId,
      category: result.category,
      selfConfidence: result.selfConfidence,
      rationale: result.rationale,
    });
    await markCanonical(tx, { id: attemptId, ctx, stage: "classify" });
    if (other) {
      // Nothing to extract: a human reclassifies or rejects it.
      await upsertOpenTask(tx, { documentId: job.documentId, kind: "unclassified", reasons: ["category_other"] });
      await finishRun(tx, job.runId);
    } else {
      await enqueueStage(deps.boss, tx, "extract", job);
    }
  });
}

export async function extractStage(deps: PipelineDeps, job: StageJob, signal?: AbortSignal): Promise<void> {
  const input = await withTenantTx(deps.pool, job.tenantId, async (tx) => {
    const found = await currentRun(tx, job, "extract");
    if (!found) return null;
    // A reclassify run (phase 3) starts here with the reviewer's category instead of a classification.
    const category = found.run.forcedCategory ?? (await loadClassification(tx, job.runId))?.category;
    if (!category) throw new Error(`run ${job.runId} reached extract without a category`);
    const policy = found.config.categories.find((c) => c.category === category);
    if (!policy) throw new PipelineError("invalid_output", `category ${category} is not in config ${found.config.id}`);
    return {
      config: found.config,
      category,
      schemaVersion: await loadSchemaVersion(tx, policy.schemaVersionId),
      parts: await loadParts(tx, job.documentId),
      promptBody: await loadPromptBody(tx, found.config.extractPromptVersionId),
    };
  });
  if (!input) return;

  const schema = input.schemaVersion.jsonSchema as JsonSchema;
  const request = buildExtractRequest({
    model: stageModel(input.config, "extract"),
    promptBody: input.promptBody,
    category: input.category,
    schema,
    parts: input.parts,
    blobs: await loadBlobs(deps.storage, input.parts),
  });
  const ctx = { runId: job.runId };
  const { attemptId, output } = await deps.llm.call({ tenantId: job.tenantId, ctx, request, signal });
  const { values } = parseExtractOutput(output, schema);
  const validationErrors = validateFields(input.schemaVersion.id, schema, values);

  await withTenantTx(deps.pool, job.tenantId, async (tx) => {
    const moved = await advanceDocument(tx, {
      documentId: job.documentId,
      runId: job.runId,
      from: "classified",
      to: "extracted",
    });
    if (!moved) return;
    const extraction = await insertModelExtraction(tx, {
      documentId: job.documentId,
      runId: job.runId,
      category: input.category,
      schemaVersionId: input.schemaVersion.id,
      fields: values,
      validationErrors,
    });
    await setCurrentExtraction(tx, job.documentId, extraction.id);
    await markCanonical(tx, { id: attemptId, ctx, stage: "extract" });
    await enqueueStage(deps.boss, tx, "route", job);
  });
}

export async function routeStage(deps: PipelineDeps, job: StageJob): Promise<void> {
  const input = await withTenantTx(deps.pool, job.tenantId, async (tx) => {
    const found = await currentRun(tx, job, "route");
    if (!found) return null;
    const extraction = found.document.currentExtractionId
      ? await loadExtraction(tx, found.document.currentExtractionId)
      : null;
    if (!extraction || extraction.runId !== job.runId) throw new Error(`run ${job.runId} has no current extraction`);
    const policy = found.config.categories.find((c) => c.category === extraction.category);
    if (!policy) throw new PipelineError("invalid_output", `category ${extraction.category} is not in the config`);
    // The quotes and uncertain fields come from the response the extraction was made from.
    const attempt = await loadCanonicalAttempt(tx, { runId: job.runId }, "extract");
    if (!attempt) throw new Error(`run ${job.runId} has no canonical extract attempt`);
    return {
      run: found.run,
      document: found.document,
      config: found.config,
      policy,
      extraction,
      attempt,
      schemaVersion: await loadSchemaVersion(tx, extraction.schemaVersionId),
      parts: await loadParts(tx, job.documentId),
      classification: await loadClassification(tx, job.runId),
    };
  });
  if (!input) return;

  const schema = input.schemaVersion.jsonSchema as JsonSchema;
  const response = readAttemptOutput(
    input.attempt.model,
    input.attempt.response,
    stagePolicy(input.config.policy).extractMaxTokens,
  );
  const evaluation = evaluateExtraction({
    category: input.extraction.category,
    schemaVersion: { id: input.schemaVersion.id, version: input.schemaVersion.version, jsonSchema: schema },
    output: parseExtractOutput(response, schema),
    parts: input.parts,
    score: input.classification?.selfConfidence ?? null,
    policy: {
      threshold: input.policy.threshold,
      automation: input.policy.automation,
      auditRate: input.policy.auditRate,
    },
    trigger: input.run.trigger,
    auditDraw: deps.auditDraw(job.documentId, job.runId),
    ids: { documentId: job.documentId, extractionId: input.extraction.id },
    sender: await loadSender(deps.storage, {
      sourceKey: input.document.sourceKey,
      mime: input.document.mime,
      title: input.document.title,
    }),
    senderPolicy: senderPolicy(input.config.policy),
  });
  const { decision, audit, reasons, proposedAction } = evaluation.route;
  const autoApproved = decision === "auto" && !audit;

  await withTenantTx(deps.pool, job.tenantId, async (tx) => {
    const moved = await advanceDocument(tx, {
      documentId: job.documentId,
      runId: job.runId,
      from: "extracted",
      to: "done",
      set: autoApproved ? { reviewStatus: "not_required", deliveryStatus: "pending" } : { reviewStatus: "pending" },
    });
    if (!moved) return;
    await applyRouteDecision(tx, input.extraction.id, {
      gateResults: evaluation.gateResults,
      score: input.classification?.selfConfidence ?? null,
      decision,
      reasons,
    });
    if (autoApproved) {
      // The payload is frozen now; the action id is the webhook's Idempotency-Key (phase 3 delivers it).
      const payload = approvedPayload(proposedAction, "auto", deps.now());
      const actionId = await createAction(tx, {
        documentId: job.documentId,
        extractionId: input.extraction.id,
        payload,
      });
      await enqueue(deps.boss, tx, QUEUES.deliver, { tenantId: job.tenantId, actionId }, { id: actionId });
    } else {
      await upsertOpenTask(tx, {
        documentId: job.documentId,
        kind: audit ? "audit" : "review",
        extractionId: input.extraction.id,
        reasons,
      });
    }
    await finishRun(tx, job.runId);
  });
}

export const STAGE_HANDLERS: Record<
  PipelineStage,
  (deps: PipelineDeps, job: StageJob, signal?: AbortSignal) => Promise<void>
> = {
  parse: parseStage,
  classify: classifyStage,
  extract: extractStage,
  route: routeStage,
};

/**
 * Runs a stage. A PipelineError (bad file, refusal, missing cassette, budget...) can't be fixed by
 * retrying, so the run fails right away and a human gets a `processing_failed` task. Anything else
 * propagates: pg-boss retries the job, then dead-letters it to `doc.failed`.
 */
export async function runStage(
  deps: PipelineDeps,
  stage: PipelineStage,
  job: StageJob,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await STAGE_HANDLERS[stage](deps, job, signal);
  } catch (err) {
    if (!(err instanceof PipelineError)) throw err;
    log.warn("run failed", { stage, reason: err.reason, document: job.documentId, run: job.runId, err });
    await withTenantTx(deps.pool, job.tenantId, (tx) =>
      failRun(tx, {
        runId: job.runId,
        expectedStatus: STAGE_INPUT_STATUS[stage],
        reason: err.reason,
        message: err.message,
      }),
    );
  }
}

/**
 * `doc.failed`: a stage job ran out of retries. Fails the run only if the document is still waiting
 * for that stage; a job that expired after its stage had committed changes nothing.
 */
export async function failedStage(
  deps: PipelineDeps,
  job: StageJob,
  source: { queue: string | null; output: unknown },
): Promise<void> {
  const known = PIPELINE_STAGES.find((s) => STAGE_QUEUES[s] === source.queue);
  // Never leave a run waiting: without the source queue, fail it at the status it's in.
  const status = known
    ? STAGE_INPUT_STATUS[known]
    : await withTenantTx(deps.pool, job.tenantId, (tx) => currentRunStatus(tx, job.runId));
  if (!known) log.error("doc.failed: unknown source queue", { queue: source.queue, run: job.runId });
  if (!status) return;
  const output = source.output as { message?: unknown; name?: unknown } | null;
  const message = typeof output?.message === "string" ? output.message : JSON.stringify(source.output ?? null);
  // Retries that ran out because the provider stayed busy say so: Retry all, once it recovers.
  const busy = output?.name === "ProviderBusyError" || output?.name === "ProviderCoolingDownError";
  const reason = busy ? "provider_unavailable" : "retries_exhausted";
  await withTenantTx(deps.pool, job.tenantId, (tx) =>
    failRun(tx, { runId: job.runId, expectedStatus: status, reason, message }),
  );
}
