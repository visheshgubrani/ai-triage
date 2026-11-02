import {
  DECISIONS,
  EVAL_ITEM_ORIGINS,
  EVAL_RUN_STATUSES,
  EVAL_SPLITS,
  LLM_CALL_MODES,
  LLM_STAGES,
} from "@ai-triage/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  numeric,
  type PgTableExtraConfigValue,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, emptyTextArray, oneOf, pk, tenantId, tenantKey } from "./_helpers";
import { users } from "./auth";
import { pipelineConfigs, processingRuns } from "./pipeline";
import { modelPrices } from "./prices";

// Eval datasets, runs and results, plus llm_calls. llm_calls lives here because its execution
// context is either a processing run or an eval run + item, and eval_results points back at it.
// Eval tables never reference `documents`: an eval can't create a document, so it can't create an
// action (invariant 7).

export const evalDatasets = pgTable(
  "eval_datasets",
  {
    id: pk(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [tenantKey("eval_datasets", t), unique("eval_datasets_name_key").on(t.tenantId, t.name)],
);

/** A labeled example. `source_key` points at an immutable snapshot of the source in storage. */
export const evalItems = pgTable(
  "eval_items",
  {
    id: pk(),
    tenantId: tenantId(),
    datasetId: uuid("dataset_id").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceMime: text("source_mime"),
    expectedCategory: text("expected_category").notNull(),
    expectedFields: jsonb("expected_fields").notNull().default({}),
    split: text("split", { enum: EVAL_SPLITS }).notNull(),
    origin: text("origin", { enum: EVAL_ITEM_ORIGINS }).notNull(),
    tags: text("tags").array().notNull().default(emptyTextArray()),
    createdAt: createdAt(),
  },
  (t) => [
    tenantKey("eval_items", t),
    oneOf("eval_items_split_check", t.split, EVAL_SPLITS),
    oneOf("eval_items_origin_check", t.origin, EVAL_ITEM_ORIGINS),
    foreignKey({
      name: "eval_items_dataset_fk",
      columns: [t.tenantId, t.datasetId],
      foreignColumns: [evalDatasets.tenantId, evalDatasets.id],
    }),
  ],
);

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: pk(),
    tenantId: tenantId(),
    datasetId: uuid("dataset_id").notNull(),
    configId: uuid("config_id").notNull(),
    split: text("split", { enum: EVAL_SPLITS }).notNull(),
    llmMode: text("llm_mode", { enum: LLM_CALL_MODES }).notNull(),
    status: text("status", { enum: EVAL_RUN_STATUSES }).notNull().default("queued"),
    aggregates: jsonb("aggregates"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    tenantKey("eval_runs", t),
    oneOf("eval_runs_split_check", t.split, EVAL_SPLITS),
    oneOf("eval_runs_llm_mode_check", t.llmMode, LLM_CALL_MODES),
    oneOf("eval_runs_status_check", t.status, EVAL_RUN_STATUSES),
    foreignKey({
      name: "eval_runs_dataset_fk",
      columns: [t.tenantId, t.datasetId],
      foreignColumns: [evalDatasets.tenantId, evalDatasets.id],
    }),
    foreignKey({
      name: "eval_runs_config_fk",
      columns: [t.tenantId, t.configId],
      foreignColumns: [pipelineConfigs.tenantId, pipelineConfigs.id],
    }),
  ],
);

/**
 * One row per Claude attempt, saved as soon as the response arrives and reused on retry
 * (invariant 4). Exactly one execution context: a processing run, or an eval run + item.
 * At most one canonical row per context and stage.
 */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: pk(),
    tenantId: tenantId(),
    processingRunId: uuid("processing_run_id"),
    evalRunId: uuid("eval_run_id"),
    evalItemId: uuid("eval_item_id"),
    stage: text("stage", { enum: LLM_STAGES }).notNull(),
    attempt: integer("attempt").notNull(),
    canonical: boolean("canonical").notNull().default(false),
    mode: text("mode", { enum: LLM_CALL_MODES }).notNull(),
    model: text("model").notNull(),
    effort: text("effort").notNull(),
    requestHash: text("request_hash").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    priceId: uuid("price_id").references(() => modelPrices.id),
    latencyMs: integer("latency_ms"),
    stopReason: text("stop_reason"),
    servedByFallback: boolean("served_by_fallback").notNull().default(false),
    requestId: text("request_id"),
    response: jsonb("response"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantKey("llm_calls", t),
    oneOf("llm_calls_stage_check", t.stage, LLM_STAGES),
    oneOf("llm_calls_mode_check", t.mode, LLM_CALL_MODES),
    check(
      "llm_calls_one_context_check",
      sql`num_nonnulls(${t.processingRunId}, ${t.evalRunId}) = 1 and (${t.evalRunId} is null) = (${t.evalItemId} is null)`,
    ),
    uniqueIndex("llm_calls_canonical_run_key")
      .on(t.processingRunId, t.stage)
      .where(sql`${t.canonical} and ${t.processingRunId} is not null`),
    uniqueIndex("llm_calls_canonical_eval_key")
      .on(t.evalRunId, t.evalItemId, t.stage)
      .where(sql`${t.canonical} and ${t.evalRunId} is not null`),
    unique("llm_calls_run_attempt_key").on(t.processingRunId, t.stage, t.attempt),
    unique("llm_calls_eval_attempt_key").on(t.evalRunId, t.evalItemId, t.stage, t.attempt),
    foreignKey({
      name: "llm_calls_processing_run_fk",
      columns: [t.tenantId, t.processingRunId],
      foreignColumns: [processingRuns.tenantId, processingRuns.id],
    }),
    foreignKey({
      name: "llm_calls_eval_run_fk",
      columns: [t.tenantId, t.evalRunId],
      foreignColumns: [evalRuns.tenantId, evalRuns.id],
    }),
    foreignKey({
      name: "llm_calls_eval_item_fk",
      columns: [t.tenantId, t.evalItemId],
      foreignColumns: [evalItems.tenantId, evalItems.id],
    }),
  ],
);

/** Per-item eval outcome. `proposed_action` is stored for inspection and never sent. */
export const evalResults = pgTable(
  "eval_results",
  {
    id: pk(),
    tenantId: tenantId(),
    evalRunId: uuid("eval_run_id").notNull(),
    evalItemId: uuid("eval_item_id").notNull(),
    predictedCategory: text("predicted_category"),
    predictedFields: jsonb("predicted_fields"),
    fieldScores: jsonb("field_scores"),
    decision: text("decision", { enum: DECISIONS }),
    proposedAction: jsonb("proposed_action"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    latencyMs: integer("latency_ms"),
    classifyCallId: uuid("classify_call_id"),
    extractCallId: uuid("extract_call_id"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantKey("eval_results", t),
    unique("eval_results_run_item_key").on(t.evalRunId, t.evalItemId),
    oneOf("eval_results_decision_check", t.decision, DECISIONS),
    foreignKey({
      name: "eval_results_run_fk",
      columns: [t.tenantId, t.evalRunId],
      foreignColumns: [evalRuns.tenantId, evalRuns.id],
    }),
    foreignKey({
      name: "eval_results_item_fk",
      columns: [t.tenantId, t.evalItemId],
      foreignColumns: [evalItems.tenantId, evalItems.id],
    }),
    foreignKey({
      name: "eval_results_classify_call_fk",
      columns: [t.tenantId, t.classifyCallId],
      foreignColumns: [llmCalls.tenantId, llmCalls.id],
    }),
    foreignKey({
      name: "eval_results_extract_call_fk",
      columns: [t.tenantId, t.extractCallId],
      foreignColumns: [llmCalls.tenantId, llmCalls.id],
    }),
  ],
);
