import {
  AUTOMATION_MODES,
  DECISIONS,
  DELIVERY_STATUSES,
  DOCUMENT_SOURCES,
  EVIDENCE_MODES,
  EXTRACTION_AUTHORS,
  INTAKE_FILTERS,
  LLM_STAGES,
  PART_KINDS,
  PROCESSING_STATUSES,
  REVIEW_STATUSES,
  RUN_STATUSES,
  RUN_TRIGGERS,
} from "@ai-triage/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  type PgTableExtraConfigValue,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { between01, createdAt, emptyTextArray, oneOf, pk, tenantId, tenantKey, updatedAt } from "./_helpers";
import { users } from "./auth";

// ── Immutable versions: category schemas, prompts, pipeline configs ──────────────────────────
// Rows here are never updated or deleted (triggers in 0002_rls.sql). A change is a new version.

export const categorySchemaVersions = pgTable(
  "category_schema_versions",
  {
    id: pk(),
    tenantId: tenantId(),
    category: text("category").notNull(),
    version: integer("version").notNull(),
    jsonSchema: jsonb("json_schema").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantKey("category_schema_versions", t),
    unique("category_schema_versions_category_version_key").on(t.tenantId, t.category, t.version),
    // Lets pipeline_config_categories prove its category matches the schema version's category.
    unique("category_schema_versions_tenant_id_id_category_key").on(t.tenantId, t.id, t.category),
  ],
);

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: pk(),
    tenantId: tenantId(),
    stage: text("stage", { enum: LLM_STAGES }).notNull(),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantKey("prompt_versions", t),
    unique("prompt_versions_stage_version_key").on(t.tenantId, t.stage, t.version),
    oneOf("prompt_versions_stage_check", t.stage, LLM_STAGES),
  ],
);

/**
 * An immutable pipeline configuration version. The only permitted update is setting `frozen_at`
 * once (after calibration); test-split eval runs require a frozen config (docs/architecture.md §8).
 * Model ids and efforts are plain text, validated against @ai-triage/core in src/configs.ts.
 */
export const pipelineConfigs = pgTable(
  "pipeline_configs",
  {
    id: pk(),
    tenantId: tenantId(),
    version: integer("version").notNull(),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    classifyModel: text("classify_model").notNull(),
    classifyEffort: text("classify_effort").notNull(),
    classifyPromptVersionId: uuid("classify_prompt_version_id").notNull(),
    extractModel: text("extract_model").notNull(),
    extractEffort: text("extract_effort").notNull(),
    extractPromptVersionId: uuid("extract_prompt_version_id").notNull(),
    policy: jsonb("policy").notNull().default({}),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantKey("pipeline_configs", t),
    unique("pipeline_configs_version_key").on(t.tenantId, t.version),
    foreignKey({
      name: "pipeline_configs_parent_fk",
      columns: [t.tenantId, t.parentId],
      foreignColumns: [pipelineConfigs.tenantId, pipelineConfigs.id],
    }),
    foreignKey({
      name: "pipeline_configs_classify_prompt_fk",
      columns: [t.tenantId, t.classifyPromptVersionId],
      foreignColumns: [promptVersions.tenantId, promptVersions.id],
    }),
    foreignKey({
      name: "pipeline_configs_extract_prompt_fk",
      columns: [t.tenantId, t.extractPromptVersionId],
      foreignColumns: [promptVersions.tenantId, promptVersions.id],
    }),
  ],
);

/** Per-category routing policy of a config version. Insert-only, and only while the config is unfrozen. */
export const pipelineConfigCategories = pgTable(
  "pipeline_config_categories",
  {
    tenantId: tenantId(),
    configId: uuid("config_id").notNull(),
    category: text("category").notNull(),
    schemaVersionId: uuid("schema_version_id").notNull(),
    threshold: numeric("threshold", { precision: 4, scale: 3, mode: "number" }).notNull(),
    automation: text("automation", { enum: AUTOMATION_MODES }).notNull().default("review_all"),
    auditRate: numeric("audit_rate", { precision: 4, scale: 3, mode: "number" }).notNull().default(0.1),
  },
  (t) => [
    primaryKey({ name: "pipeline_config_categories_pkey", columns: [t.configId, t.category] }),
    foreignKey({
      name: "pipeline_config_categories_config_fk",
      columns: [t.tenantId, t.configId],
      foreignColumns: [pipelineConfigs.tenantId, pipelineConfigs.id],
    }),
    foreignKey({
      name: "pipeline_config_categories_schema_fk",
      columns: [t.tenantId, t.schemaVersionId, t.category],
      foreignColumns: [categorySchemaVersions.tenantId, categorySchemaVersions.id, categorySchemaVersions.category],
    }),
    oneOf("pipeline_config_categories_automation_check", t.automation, AUTOMATION_MODES),
    between01("pipeline_config_categories_threshold_check", t.threshold),
    between01("pipeline_config_categories_audit_rate_check", t.auditRate),
  ],
);

// ── Documents and processing ─────────────────────────────────────────────────────────────────

/**
 * An ingested email or file. `current_run_id` and `current_extraction_id` point at rows of the same
 * document (three-column composite FKs), so a document can never adopt another document's run or
 * extraction, even within one tenant.
 */
export const documents = pgTable(
  "documents",
  {
    id: pk(),
    tenantId: tenantId(),
    source: text("source", { enum: DOCUMENT_SOURCES }).notNull(),
    externalId: text("external_id").notNull(),
    sourceKey: text("source_key").notNull(),
    title: text("title"),
    mime: text("mime"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    processingStatus: text("processing_status", { enum: PROCESSING_STATUSES }).notNull().default("received"),
    reviewStatus: text("review_status", { enum: REVIEW_STATUSES }).notNull().default("not_required"),
    deliveryStatus: text("delivery_status", { enum: DELIVERY_STATUSES }).notNull().default("none"),
    currentRunId: uuid("current_run_id"),
    currentExtractionId: uuid("current_extraction_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantKey("documents", t),
    unique("documents_source_external_id_key").on(t.tenantId, t.source, t.externalId),
    index("documents_tenant_id_created_at_idx").on(t.tenantId, t.createdAt),
    // The reconciler's scan (stale_work(), 0028): only documents still on their way through the pipeline.
    index("documents_in_flight_idx")
      .on(t.updatedAt)
      .where(sql`processing_status in ('received', 'parsed', 'classified', 'extracted')`),
    oneOf("documents_source_check", t.source, DOCUMENT_SOURCES),
    oneOf("documents_processing_status_check", t.processingStatus, PROCESSING_STATUSES),
    oneOf("documents_review_status_check", t.reviewStatus, REVIEW_STATUSES),
    oneOf("documents_delivery_status_check", t.deliveryStatus, DELIVERY_STATUSES),
    foreignKey({
      name: "documents_current_run_fk",
      columns: [t.tenantId, t.id, t.currentRunId],
      foreignColumns: [processingRuns.tenantId, processingRuns.documentId, processingRuns.id],
    }),
    foreignKey({
      name: "documents_current_extraction_fk",
      columns: [t.tenantId, t.id, t.currentExtractionId],
      foreignColumns: [extractions.tenantId, extractions.documentId, extractions.id],
    }),
  ],
);

/**
 * Parsed text of a document: the email body, an attachment, or one PDF page. `storage_key` points
 * at the part's binary (a PDF or image is sent to Claude as a document or image block); `label` is
 * the attachment or file name.
 */
export const documentParts = pgTable(
  "document_parts",
  {
    id: pk(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    partIndex: integer("part_index").notNull(),
    kind: text("kind", { enum: PART_KINDS }).notNull(),
    mime: text("mime").notNull(),
    label: text("label"),
    page: integer("page"),
    text: text("text").notNull(),
    evidenceMode: text("evidence_mode", { enum: EVIDENCE_MODES }).notNull(),
    storageKey: text("storage_key"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantKey("document_parts", t),
    unique("document_parts_document_id_part_index_key").on(t.documentId, t.partIndex),
    oneOf("document_parts_kind_check", t.kind, PART_KINDS),
    oneOf("document_parts_evidence_mode_check", t.evidenceMode, EVIDENCE_MODES),
    foreignKey({
      name: "document_parts_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
  ],
);

export const processingRuns = pgTable(
  "processing_runs",
  {
    id: pk(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    configId: uuid("config_id").notNull(),
    trigger: text("trigger", { enum: RUN_TRIGGERS }).notNull(),
    forcedCategory: text("forced_category"),
    status: text("status", { enum: RUN_STATUSES }).notNull().default("running"),
    supersededBy: uuid("superseded_by"),
    error: text("error"),
    /** The intake filter that ended the run before any model call (the document is `skipped`). */
    skipReason: text("skip_reason", { enum: INTAKE_FILTERS }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantKey("processing_runs", t),
    oneOf("processing_runs_skip_reason_check", t.skipReason, INTAKE_FILTERS),
    unique("processing_runs_tenant_id_document_id_id_key").on(t.tenantId, t.documentId, t.id),
    oneOf("processing_runs_trigger_check", t.trigger, RUN_TRIGGERS),
    oneOf("processing_runs_status_check", t.status, RUN_STATUSES),
    check(
      "processing_runs_forced_category_check",
      sql`(${t.trigger} = 'reclassify') = (${t.forcedCategory} is not null)`,
    ),
    foreignKey({
      name: "processing_runs_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    foreignKey({
      name: "processing_runs_config_fk",
      columns: [t.tenantId, t.configId],
      foreignColumns: [pipelineConfigs.tenantId, pipelineConfigs.id],
    }),
    foreignKey({
      name: "processing_runs_superseded_by_fk",
      columns: [t.tenantId, t.documentId, t.supersededBy],
      foreignColumns: [processingRuns.tenantId, processingRuns.documentId, processingRuns.id],
    }),
  ],
);

/** Classify-stage result. One per run, so a repeated model call can't produce a second one. */
export const classifications = pgTable(
  "classifications",
  {
    id: pk(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    runId: uuid("run_id").notNull(),
    category: text("category").notNull(),
    selfConfidence: numeric("self_confidence", { precision: 4, scale: 3, mode: "number" }).notNull(),
    rationale: text("rationale"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantKey("classifications", t),
    unique("classifications_run_id_key").on(t.runId),
    between01("classifications_self_confidence_check", t.selfConfidence),
    foreignKey({
      name: "classifications_run_fk",
      columns: [t.tenantId, t.documentId, t.runId],
      foreignColumns: [processingRuns.tenantId, processingRuns.documentId, processingRuns.id],
    }),
  ],
);

/**
 * Extraction revisions. Revision 1 comes from the model (one per run); edits add revisions with
 * `author = 'user'` and no run. Approvals bind to an exact revision id.
 */
export const extractions = pgTable(
  "extractions",
  {
    id: pk(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    runId: uuid("run_id"),
    revision: integer("revision").notNull(),
    author: text("author", { enum: EXTRACTION_AUTHORS }).notNull(),
    parentId: uuid("parent_id"),
    category: text("category").notNull(),
    schemaVersionId: uuid("schema_version_id").notNull(),
    fields: jsonb("fields").notNull(),
    validationErrors: jsonb("validation_errors").notNull().default([]),
    gateResults: jsonb("gate_results").notNull().default([]),
    score: numeric("score", { precision: 4, scale: 3, mode: "number" }),
    decision: text("decision", { enum: DECISIONS }),
    decisionReasons: text("decision_reasons").array().notNull().default(emptyTextArray()),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantKey("extractions", t),
    unique("extractions_tenant_id_document_id_id_key").on(t.tenantId, t.documentId, t.id),
    unique("extractions_document_id_revision_key").on(t.documentId, t.revision),
    uniqueIndex("extractions_run_id_key").on(t.runId).where(sql`${t.runId} is not null`),
    oneOf("extractions_author_check", t.author, EXTRACTION_AUTHORS),
    oneOf("extractions_decision_check", t.decision, DECISIONS),
    check("extractions_author_run_check", sql`(${t.author} = 'model') = (${t.runId} is not null)`),
    check("extractions_user_author_check", sql`${t.author} <> 'user' or ${t.createdBy} is not null`),
    foreignKey({
      name: "extractions_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    foreignKey({
      name: "extractions_run_fk",
      columns: [t.tenantId, t.documentId, t.runId],
      foreignColumns: [processingRuns.tenantId, processingRuns.documentId, processingRuns.id],
    }),
    foreignKey({
      name: "extractions_parent_fk",
      columns: [t.tenantId, t.documentId, t.parentId],
      foreignColumns: [extractions.tenantId, extractions.documentId, extractions.id],
    }),
    foreignKey({
      name: "extractions_schema_version_fk",
      columns: [t.tenantId, t.schemaVersionId],
      foreignColumns: [categorySchemaVersions.tenantId, categorySchemaVersions.id],
    }),
  ],
);
