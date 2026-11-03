import type { ConfigSummary, EvalItem, EvalRun } from "@ai-triage/contracts";
import type { EvalErrorCode } from "@ai-triage/core";
import type { EvalItemRow, PipelineConfig, RunListEntry } from "@ai-triage/db";
import type { RunSummary } from "@ai-triage/evals";

/** 409: the state moved on (reload). 422: the request can never apply as sent. */
export const EVAL_ERROR_STATUS: Record<EvalErrorCode, 409 | 422> = {
  config_not_frozen: 422,
  config_frozen: 409,
  empty_split: 422,
  not_calib_run: 422,
  run_not_done: 409,
  runs_not_comparable: 422,
  invalid_config: 422,
};

const iso = (d: Date | null) => d?.toISOString() ?? null;

export const toConfigSummary = (c: PipelineConfig & { active?: boolean }, activeId?: string | null): ConfigSummary => ({
  id: c.id,
  version: c.version,
  name: c.name,
  parentId: c.parentId,
  frozenAt: iso(c.frozenAt),
  active: c.active ?? c.id === activeId,
  createdAt: c.createdAt.toISOString(),
  classify: { model: c.classifyModel, effort: c.classifyEffort, promptVersionId: c.classifyPromptVersionId },
  extract: { model: c.extractModel, effort: c.extractEffort, promptVersionId: c.extractPromptVersionId },
  categories: c.categories.map((k) => ({
    category: k.category,
    threshold: Number(k.threshold),
    automation: k.automation,
    auditRate: Number(k.auditRate),
  })),
});

export const toEvalRun = (e: RunListEntry): EvalRun => ({
  id: e.run.id,
  datasetId: e.run.datasetId,
  datasetName: e.datasetName,
  split: e.run.split,
  status: e.run.status,
  llmMode: e.run.llmMode,
  itemCount: e.run.itemCount,
  done: e.done,
  error: e.run.error,
  createdAt: e.run.createdAt.toISOString(),
  startedAt: iso(e.run.startedAt),
  finishedAt: iso(e.run.finishedAt),
  config: e.config,
  summary: (e.run.aggregates as RunSummary | null) ?? null,
});

export const toEvalItem = (i: EvalItemRow): EvalItem => ({
  id: i.id,
  split: i.split,
  expectedCategory: i.expectedCategory,
  expectedFields: i.expectedFields as Record<string, unknown>,
  origin: i.origin,
  originRef: i.originRef,
  tags: i.tags,
  sourceTitle: i.sourceTitle,
  sourceMime: i.sourceMime,
  createdAt: i.createdAt.toISOString(),
  retiredAt: iso(i.retiredAt),
});
