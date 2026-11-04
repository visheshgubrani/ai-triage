import { randomUUID } from "node:crypto";
import { type EvalItemJob, OTHER_CATEGORY } from "@ai-triage/core";
import {
  buildClassifyRequest,
  buildExtractRequest,
  classifyCategories,
  evaluateExtraction,
  PipelineError,
  parseClassifyOutput,
  parseExtractOutput,
  senderPolicy,
} from "@ai-triage/core/pipeline";
import {
  commitEvalResult,
  type EvalItemInput,
  failEvalRun,
  loadEvalItemInput,
  loadPromptBody,
  loadSchemaVersions,
  type NewEvalResult,
  withTenantTx,
} from "@ai-triage/db";
import { errorGrade, gradeItem } from "@ai-triage/evals";
import type { JsonSchema } from "@ai-triage/schemas";
import { loadBlobs, loadCategoryOptions, loadSender, parseSource, stageModel } from "../pipeline/source";
import type { EvalDeps } from "./deps";

// One eval item of one run (docs/architecture.md §8): the pipeline's own parse, requests, output
// parsing and evaluateExtraction() over the item's snapshot, then grading against its label. Like a
// stage handler: read in a short transaction, call the model with none open (attempts are saved and
// reused on retry), commit the result in one transaction. Unlike one, it never routes anywhere:
// the proposed action is stored on the result, and nothing here can create a document or an action.

type Outcome = Omit<NewEvalResult, "evalRunId" | "evalItemId">;

async function evaluate(
  deps: EvalDeps,
  job: EvalItemJob,
  input: EvalItemInput,
  resultId: string,
  signal?: AbortSignal,
): Promise<Outcome> {
  const { item, config } = input;
  const ctx = { evalRunId: job.evalRunId, evalItemId: job.evalItemId };
  const expectedFields = item.expectedFields as Record<string, unknown>;
  let classifyCallId: string | null = null;
  let predictedCategory: string | null = null;
  try {
    const prepared = await withTenantTx(deps.pool, job.tenantId, async (tx) => ({
      categories: await loadCategoryOptions(tx, config),
      classifyPrompt: await loadPromptBody(tx, config.classifyPromptVersionId),
      extractPrompt: await loadPromptBody(tx, config.extractPromptVersionId),
      schemaVersions: await loadSchemaVersions(
        tx,
        config.categories.map((c) => c.schemaVersionId),
      ),
    }));
    const parts = await parseSource(
      deps.storage,
      { sourceKey: item.sourceKey, mime: item.sourceMime, title: item.sourceTitle },
      deps.limits,
    );
    const blobs = await loadBlobs(deps.storage, parts);

    const classified = await deps.llm.call({
      tenantId: job.tenantId,
      ctx,
      signal,
      request: buildClassifyRequest({
        model: stageModel(config, "classify"),
        promptBody: prepared.classifyPrompt,
        categories: prepared.categories,
        parts,
        blobs,
      }),
    });
    classifyCallId = classified.attemptId;
    const classification = parseClassifyOutput(classified.output, classifyCategories(prepared.categories));
    predictedCategory = classification.category;
    const score = classification.selfConfidence;

    if (predictedCategory === OTHER_CATEGORY) {
      // Production stops here too: nothing to extract, a human reclassifies or rejects it.
      return {
        predictedCategory,
        predictedFields: null,
        score,
        decision: "review",
        reasons: ["category_other"],
        gateResults: null,
        grade: gradeItem({
          expectedCategory: item.expectedCategory,
          expectedFields,
          predictedCategory,
          predictedFields: null,
          schemaVersion: null,
        }),
        proposedAction: null,
        classifyCallId,
        extractCallId: null,
        error: null,
      };
    }

    const policy = config.categories.find((c) => c.category === predictedCategory);
    const schemaVersion = prepared.schemaVersions.find((v) => v.id === policy?.schemaVersionId);
    if (!policy || !schemaVersion) {
      throw new PipelineError("invalid_output", `category ${predictedCategory} is not in config ${config.id}`);
    }
    const schema = schemaVersion.jsonSchema as JsonSchema;
    const extracted = await deps.llm.call({
      tenantId: job.tenantId,
      ctx,
      signal,
      request: buildExtractRequest({
        model: stageModel(config, "extract"),
        promptBody: prepared.extractPrompt,
        category: predictedCategory,
        schema,
        parts,
        blobs,
      }),
    });
    const output = parseExtractOutput(extracted.output, schema);
    const evaluation = evaluateExtraction({
      category: predictedCategory,
      schemaVersion: { id: schemaVersion.id, version: schemaVersion.version, jsonSchema: schema },
      output,
      parts,
      score,
      policy: { threshold: policy.threshold, automation: policy.automation, auditRate: policy.auditRate },
      trigger: "ingest",
      // Never audit-sample: an audited item is still an auto decision, and evals measure the decision.
      auditDraw: 1,
      // No document or extraction exists; the ids only label the stored (never sent) proposed action.
      ids: { documentId: item.id, extractionId: resultId },
      sender: await loadSender(deps.storage, {
        sourceKey: item.sourceKey,
        mime: item.sourceMime,
        title: item.sourceTitle,
      }),
      senderPolicy: senderPolicy(config.policy),
    });
    return {
      predictedCategory,
      predictedFields: output.values,
      score,
      decision: evaluation.route.decision,
      reasons: evaluation.route.reasons,
      gateResults: evaluation.gateResults,
      grade: gradeItem({
        expectedCategory: item.expectedCategory,
        expectedFields,
        predictedCategory,
        predictedFields: output.values,
        schemaVersion: { version: schemaVersion.version, jsonSchema: schema },
      }),
      proposedAction: evaluation.route.proposedAction,
      classifyCallId,
      extractCallId: extracted.attemptId,
      error: null,
    };
  } catch (err) {
    // As in production, a PipelineError (bad file, refusal, missing cassette, budget…) fails the item
    // at once; anything else is retried by pg-boss, then dead-lettered to failedEvalItem.
    if (!(err instanceof PipelineError)) throw err;
    return errorOutcome(item.expectedCategory, predictedCategory, classifyCallId, {
      reason: err.reason,
      message: err.message,
    });
  }
}

const errorOutcome = (
  expectedCategory: string,
  predictedCategory: string | null,
  classifyCallId: string | null,
  error: NonNullable<NewEvalResult["error"]>,
): Outcome => ({
  predictedCategory,
  predictedFields: null,
  score: null,
  decision: null,
  reasons: [],
  gateResults: null,
  grade: errorGrade(expectedCategory, predictedCategory),
  proposedAction: null,
  classifyCallId,
  extractCallId: null,
  error,
});

export async function runEvalItem(deps: EvalDeps, job: EvalItemJob, signal?: AbortSignal): Promise<void> {
  const input = await withTenantTx(deps.pool, job.tenantId, (tx) => loadEvalItemInput(tx, job, deps.now()));
  if (!input) return;
  if (input.run.llmMode !== deps.llmMode) {
    // A run labeled replay must never spend money (and a live run must not be served from cassettes).
    await withTenantTx(deps.pool, job.tenantId, (tx) =>
      failEvalRun(
        tx,
        input.run.id,
        `mode_mismatch: the run expects ${input.run.llmMode} calls, but this worker makes ${deps.llmMode} calls`,
        deps.now(),
      ),
    );
    return;
  }
  const outcome = await evaluate(deps, job, input, randomUUID(), signal);
  await withTenantTx(deps.pool, job.tenantId, (tx) =>
    commitEvalResult(tx, { evalRunId: job.evalRunId, evalItemId: job.evalItemId, ...outcome }, deps.now()),
  );
}

/** Dead letter of eval.item: the item kept failing, so it gets an error result and the run can finish. */
export async function failedEvalItem(deps: EvalDeps, job: EvalItemJob, source: { output: unknown }): Promise<void> {
  const input = await withTenantTx(deps.pool, job.tenantId, (tx) => loadEvalItemInput(tx, job, deps.now()));
  if (!input) return;
  const output = source.output as { message?: unknown } | null;
  const message = typeof output?.message === "string" ? output.message : JSON.stringify(source.output ?? null);
  const outcome = errorOutcome(input.item.expectedCategory, null, null, { reason: "retries_exhausted", message });
  await withTenantTx(deps.pool, job.tenantId, (tx) =>
    commitEvalResult(tx, { evalRunId: job.evalRunId, evalItemId: job.evalItemId, ...outcome }, deps.now()),
  );
}
