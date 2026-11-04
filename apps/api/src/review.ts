import type { DecisionRequest, DecisionResponse } from "@ai-triage/contracts";
import {
  ACTIONS_BY_TASK_KIND,
  type EvalSplit,
  type FailureReason,
  OTHER_CATEGORY,
  QUEUES,
  type ReviewErrorCode,
} from "@ai-triage/core";
import { approvedPayload, checkUserRevision, proposeAction } from "@ai-triage/core/pipeline";
import { fieldDiff } from "@ai-triage/core/review";
import {
  type AuditActor,
  createAction,
  type ExtractionRow,
  enqueue,
  getActiveConfig,
  getOrCreateDataset,
  insertDecision,
  insertEvalItem,
  insertUserExtraction,
  listRetryableFailures,
  loadClassification,
  loadExtraction,
  loadRun,
  loadSchemaVersion,
  loadTaskDocument,
  lockTaskForDecision,
  lockUnclaimedTask,
  ReviewError,
  recordAudit,
  resolveTask,
  setAwaitingExtraction,
  setCurrentExtraction,
  setReviewOutcome,
  startRun,
  type TenantTx,
  withTenantTx,
} from "@ai-triage/db";
import { type EvalSource, snapshotDocumentSource } from "@ai-triage/ingest";
import type { AppDeps } from "./deps";
import type { TenantContext } from "./tenant";

/** 409: the task or document moved on, so reload. 422: the request can never apply to this task. */
export const REVIEW_ERROR_STATUS: Record<ReviewErrorCode, 409 | 422> = {
  task_resolved: 409,
  reprocessing: 409,
  claim_lost: 409,
  claimed_by_other: 409,
  stale_revision: 409,
  not_redeliverable: 409,
  action_not_allowed: 422,
  invalid_fields: 422,
  invalid_category: 422,
};

type Fields = Record<string, unknown>;
type JsonSchema = Parameters<typeof checkUserRevision>[0]["schemaVersion"]["jsonSchema"];
const asFields = (value: unknown): Fields => (value && typeof value === "object" ? (value as Fields) : {});

/**
 * Applies a reviewer's decision to a task, all in one transaction (docs/architecture.md §5): the
 * document row and then the task row are locked, the claim is checked, and the action must be one
 * the task's kind allows. Returns null when the task isn't visible to the tenant.
 *
 * "Add to eval set" on an approval copies the document's source first (storage isn't
 * transactional; a refused decision leaves an unreferenced copy, like an expired upload), then
 * adds the item, labeled with the approved revision, in the decision's transaction.
 */
export async function decide(
  deps: AppDeps,
  actor: TenantContext,
  taskId: string,
  body: DecisionRequest,
): Promise<DecisionResponse | null> {
  const evalSplit = "addToEvalSet" in body ? body.addToEvalSet?.split : undefined;
  let snapshot: EvalSource | null = null;
  if (evalSplit) {
    const document = await withTenantTx(deps.pool, actor.tenantId, (tx) => loadTaskDocument(tx, taskId));
    if (!document) return null;
    snapshot = await snapshotDocumentSource(deps.storage, actor.tenantId, document);
  }
  return withTenantTx(deps.pool, actor.tenantId, async (tx) => {
    const now = deps.now();
    const locked = await lockTaskForDecision(tx, {
      taskId,
      userId: actor.user.id,
      claimToken: body.claimToken,
      now,
    });
    if (!locked) return null;
    const { task, document } = locked;
    if (!ACTIONS_BY_TASK_KIND[task.kind].includes(body.action)) {
      throw new ReviewError("action_not_allowed", `A ${task.kind} task can't be resolved with ${body.action}.`);
    }
    const note = body.note?.trim() || null;
    const result = { documentId: document.id, extractionId: null, actionId: null, runId: null, evalItem: null };

    switch (body.action) {
      case "approve":
      case "edit_approve": {
        if (body.extractionId !== task.extractionId || body.extractionId !== document.currentExtractionId) {
          throw new ReviewError("stale_revision", "The extraction changed since you opened it. Reload to continue.");
        }
        const base = await loadExtraction(tx, body.extractionId);
        if (!base) throw new Error(`extraction ${body.extractionId} not found`);
        const edit = body.action === "edit_approve" ? await editRevision(tx, actor, base, body.fields) : null;
        const approved = edit?.revision ?? base;
        const payload = approvedPayload(
          proposeAction({
            documentId: document.id,
            extractionId: approved.id,
            category: approved.category,
            values: asFields(approved.fields),
          }),
          { type: "user", id: actor.user.id, email: actor.user.email },
          now,
        );
        const actionId = await createAction(tx, { documentId: document.id, extractionId: approved.id, payload });
        await enqueue(deps.boss, tx, QUEUES.deliver, { tenantId: actor.tenantId, actionId }, { id: actionId });
        await setReviewOutcome(tx, document.id, { reviewStatus: "approved", deliveryStatus: "pending" });
        await resolveTask(tx, task.id, now);
        const decisionId = await insertDecision(tx, {
          task,
          reviewerId: actor.user.id,
          // An edit that changed nothing approves the revision as it was.
          outcome: edit ? "edit_approve" : "approve",
          extractionId: approved.id,
          before: edit ? base.fields : null,
          after: edit ? approved.fields : null,
          diff: edit?.diff ?? null,
          note,
        });
        const evalItem =
          evalSplit && snapshot
            ? await addToEvalSet(tx, actor, { approved, edited: edit !== null, decisionId, split: evalSplit, snapshot })
            : null;
        return {
          ...result,
          decisionId,
          outcome: edit ? "edit_approve" : "approve",
          extractionId: approved.id,
          actionId,
          evalItem,
        };
      }

      case "reclassify": {
        const config = await getActiveConfig(tx);
        const current = task.extractionId
          ? (await loadExtraction(tx, task.extractionId))?.category
          : document.currentRunId
            ? (await loadClassification(tx, document.currentRunId))?.category
            : undefined;
        const allowed = config?.categories.some((c) => c.category === body.category) ?? false;
        if (!config || !allowed || body.category === OTHER_CATEGORY || body.category === current) {
          throw new ReviewError("invalid_category", `Can't reclassify to "${body.category}".`, {
            categories: (config?.categories ?? []).map((c) => c.category),
          });
        }
        const runId = await startRun(tx, deps.boss, {
          documentId: document.id,
          configId: config.id,
          trigger: "reclassify",
          forcedCategory: body.category,
        });
        await setAwaitingExtraction(tx, task.id);
        const decisionId = await insertDecision(tx, {
          task,
          reviewerId: actor.user.id,
          outcome: "reclassify",
          extractionId: task.extractionId,
          before: { category: current ?? null },
          after: { category: body.category },
          note,
        });
        return { ...result, decisionId, outcome: "reclassify", runId };
      }

      case "reject": {
        await setReviewOutcome(tx, document.id, { reviewStatus: "rejected" });
        await resolveTask(tx, task.id, now);
        const decisionId = await insertDecision(tx, {
          task,
          reviewerId: actor.user.id,
          outcome: "reject",
          extractionId: task.extractionId,
          note,
        });
        return { ...result, decisionId, outcome: "reject" };
      }

      case "retry": {
        const runId = await retryRun(tx, deps, document, task, now);
        const decisionId = await insertDecision(tx, { task, reviewerId: actor.user.id, outcome: "retry", note });
        return { ...result, decisionId, outcome: "retry", runId };
      }
    }
  });
}

/**
 * Retry (one transaction, the document and task locked): a new run from parse with the active
 * config. A failed reclassify run is retried as one, so the reviewer's category still stands, unless
 * that category is no longer in the config (then a plain retry; reclassifying into it would fail).
 * The new run opens its own task if it needs a human; it may also auto-approve.
 */
async function retryRun(
  tx: TenantTx,
  deps: AppDeps,
  document: { id: string; currentRunId: string | null },
  task: { id: string },
  now: Date,
): Promise<string> {
  const config = await getActiveConfig(tx);
  if (!config) throw new Error("the tenant has no active pipeline config");
  const failed = document.currentRunId ? (await loadRun(tx, document.currentRunId))?.run : null;
  const forced =
    failed?.trigger === "reclassify" && failed.forcedCategory
      ? config.categories.some((c) => c.category === failed.forcedCategory)
        ? failed.forcedCategory
        : null
      : null;
  const runId = await startRun(
    tx,
    deps.boss,
    forced
      ? { documentId: document.id, configId: config.id, trigger: "reclassify", forcedCategory: forced }
      : { documentId: document.id, configId: config.id, trigger: "retry" },
  );
  await resolveTask(tx, task.id, now);
  await setReviewOutcome(tx, document.id, { reviewStatus: "not_required" });
  return runId;
}

/** How many failed documents one Retry all takes; the button can be pressed again for the rest. */
export const RETRY_ALL_LIMIT = 500;

/**
 * Retry all (admins): Retry on every open, unclaimed `processing_failed` task, optionally of one
 * reason (after a provider outage, `provider_unavailable`; after a budget top-up, `budget_exhausted`).
 * Each document gets its own transaction, exactly as a reviewer's Retry, so one that moved on (a
 * reviewer claimed it, it was already retried) is skipped. One audit event records the batch.
 */
export async function retryFailed(
  deps: AppDeps,
  actor: TenantContext,
  audit: AuditActor,
  input: { reason?: FailureReason; before?: Date },
): Promise<{ retried: number; skipped: number }> {
  const now = deps.now();
  const taskIds = await withTenantTx(deps.pool, actor.tenantId, (tx) =>
    listRetryableFailures(tx, { ...input, limit: RETRY_ALL_LIMIT, now }),
  );
  let retried = 0;
  for (const taskId of taskIds) {
    const done = await withTenantTx(deps.pool, actor.tenantId, async (tx) => {
      const locked = await lockUnclaimedTask(tx, taskId, now);
      if (locked?.task.kind !== "processing_failed") return false;
      await retryRun(tx, deps, locked.document, locked.task, now);
      await insertDecision(tx, { task: locked.task, reviewerId: actor.user.id, outcome: "retry", note: "Retry all" });
      return true;
    });
    if (done) retried++;
  }
  if (retried > 0) {
    await withTenantTx(deps.pool, actor.tenantId, (tx) =>
      recordAudit(tx, audit, {
        action: "runs.bulk_retried",
        details: { retried, reason: input.reason ?? null, before: input.before?.toISOString() ?? null },
      }),
    );
  }
  return { retried, skipped: taskIds.length - retried };
}

/**
 * The approved revision as an eval label in the tenant's Main dataset. A label must match the full
 * schema (a plain approval can bind a revision that didn't), else the whole decision is refused.
 * The tag says whether a person edited the values or approved the model's as they were.
 */
async function addToEvalSet(
  tx: TenantTx,
  actor: TenantContext,
  input: { approved: ExtractionRow; edited: boolean; decisionId: string; split: EvalSplit; snapshot: EvalSource },
) {
  const { approved } = input;
  const schemaVersion = await loadSchemaVersion(tx, approved.schemaVersionId);
  // Nulls are kept: to the comparators a null and a missing key both mean "not stated".
  const fields = asFields(approved.fields);
  const check = checkUserRevision({
    category: approved.category,
    schemaVersion: {
      id: schemaVersion.id,
      version: schemaVersion.version,
      jsonSchema: schemaVersion.jsonSchema as JsonSchema,
    },
    values: fields,
  });
  if (check.validationIssues.length > 0) {
    throw new ReviewError("invalid_fields", "These values can't be an eval label: some don't match the schema.", {
      issues: check.validationIssues.map(({ field, path, message }) => ({ field, path, message })),
    });
  }
  const dataset = await getOrCreateDataset(tx);
  return insertEvalItem(tx, {
    datasetId: dataset.id,
    source: input.snapshot,
    expectedCategory: approved.category,
    expectedFields: fields,
    split: input.split,
    origin: "review",
    originRef: `decision:${input.decisionId}`,
    tags: [input.edited ? "review:edited" : "review:approved"],
    createdBy: actor.user.id,
  });
}

/**
 * Turns edited values into a new revision (author `user`, parent = the revision shown), after checking
 * them against the full schema. Returns null when nothing changed.
 */
async function editRevision(tx: TenantTx, actor: TenantContext, base: ExtractionRow, fields: Fields) {
  const diff = fieldDiff(asFields(base.fields), fields);
  if (diff.length === 0) return null;
  const schemaVersion = await loadSchemaVersion(tx, base.schemaVersionId);
  const check = checkUserRevision({
    category: base.category,
    schemaVersion: {
      id: schemaVersion.id,
      version: schemaVersion.version,
      jsonSchema: schemaVersion.jsonSchema as JsonSchema,
    },
    values: fields,
  });
  if (check.validationIssues.length > 0) {
    throw new ReviewError("invalid_fields", "Some fields don't match the schema.", {
      issues: check.validationIssues.map(({ field, path, message }) => ({ field, path, message })),
    });
  }
  const revision = await insertUserExtraction(tx, {
    base,
    userId: actor.user.id,
    fields,
    validationErrors: [],
    gateResults: check.gateResults,
  });
  await setCurrentExtraction(tx, base.documentId, revision.id);
  return { revision, diff };
}
