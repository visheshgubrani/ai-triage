// Pipeline stages, statuses and other closed sets. See docs/architecture.md §5 for transitions.
// Everything in this package stays pure: I/O happens through ports passed in
// by the api/worker (production) or the eval runner (which gets no action port).
// The `as const` arrays are the single source of truth: packages/db builds its
// CHECK constraints from them.

export const PIPELINE_STAGES = ["parse", "classify", "extract", "route"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Stages that call Claude, and so appear in llm_calls and pipeline_configs. */
export const LLM_STAGES = ["classify", "extract"] as const;
export type LlmStage = (typeof LLM_STAGES)[number];

export const PROCESSING_STATUSES = ["received", "parsed", "classified", "extracted", "done", "failed"] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const REVIEW_STATUSES = ["not_required", "pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const DELIVERY_STATUSES = ["none", "pending", "delivered", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DOCUMENT_SOURCES = ["email", "upload", "api"] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

export const EVIDENCE_MODES = ["text", "pdf_text", "unverifiable"] as const;
export type EvidenceMode = (typeof EVIDENCE_MODES)[number];

/** What a document part is: an email's rendered body, one of its attachments, or an uploaded file. */
export const PART_KINDS = ["email_body", "attachment", "file"] as const;
export type PartKind = (typeof PART_KINDS)[number];

export const RUN_TRIGGERS = ["ingest", "retry", "reclassify"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_STATUSES = ["running", "done", "failed", "superseded"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const EXTRACTION_AUTHORS = ["model", "user"] as const;
export type ExtractionAuthor = (typeof EXTRACTION_AUTHORS)[number];

export const DECISIONS = ["auto", "review"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Automation is opt-in per category; the default sends everything to a human. */
export const AUTOMATION_MODES = ["review_all", "auto_when_confident"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const REVIEW_TASK_KINDS = ["review", "audit", "processing_failed", "unclassified"] as const;
export type ReviewTaskKind = (typeof REVIEW_TASK_KINDS)[number];

export const REVIEW_TASK_STATUSES = ["pending", "claimed", "awaiting_extraction", "resolved"] as const;
export type ReviewTaskStatus = (typeof REVIEW_TASK_STATUSES)[number];

export const REVIEW_ACTIONS = ["approve", "edit_approve", "reclassify", "reject", "retry"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const ACTIONS_BY_TASK_KIND: Record<ReviewTaskKind, readonly ReviewAction[]> = {
  processing_failed: ["retry", "reject"],
  unclassified: ["reclassify", "reject"],
  review: ["approve", "edit_approve", "reclassify", "reject"],
  audit: ["approve", "edit_approve", "reclassify", "reject"],
};

export const ACTION_STATUSES = ["pending", "delivered", "failed"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const MEMBER_ROLES = ["admin", "reviewer", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const EVAL_SPLITS = ["dev", "calib", "test"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

export const EVAL_ITEM_ORIGINS = ["seed", "import", "review", "label"] as const;
export type EvalItemOrigin = (typeof EVAL_ITEM_ORIGINS)[number];

export const EVAL_RUN_STATUSES = ["queued", "running", "done", "failed"] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

/** How an llm_calls row was produced. `record` mode calls the live API, so it stores `live`. */
export const LLM_CALL_MODES = ["live", "replay"] as const;
export type LlmCallMode = (typeof LLM_CALL_MODES)[number];

/** Exact model ids, no date suffixes (AGENTS.md). Plain text in the DB, validated here. */
export const MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

/** `output_config.effort` levels accepted by every model in MODEL_IDS. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Every pg-boss queue. `db:migrate` creates them, because `send()` refuses unknown queues. */
export const QUEUES = {
  ping: "system.ping",
  parse: "doc.parse",
  classify: "doc.classify",
  extract: "doc.extract",
  route: "doc.route",
  /** Dead-letter queue of the four stage queues: marks the run failed once retries are exhausted. */
  failed: "doc.failed",
  deliver: "action.deliver",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** The queue of each pipeline stage, and the processing status a document must be in to enter it. */
export const STAGE_QUEUES = {
  parse: QUEUES.parse,
  classify: QUEUES.classify,
  extract: QUEUES.extract,
  route: QUEUES.route,
} as const satisfies Record<PipelineStage, QueueName>;

export const STAGE_INPUT_STATUS = {
  parse: "received",
  classify: "parsed",
  extract: "classified",
  route: "extracted",
} as const satisfies Record<PipelineStage, ProcessingStatus>;

export interface QueueSettings {
  retryLimit: number;
  /** Seconds; doubled per retry when `retryBackoff` is set. */
  retryDelay: number;
  retryBackoff: boolean;
  /** How long a job may stay active before pg-boss retries it. LLM stages get room for slow calls. */
  expireInSeconds: number;
  deadLetter?: QueueName;
}

const stage = (retryLimit: number, expireInSeconds: number): QueueSettings => ({
  retryLimit,
  retryDelay: 5,
  retryBackoff: true,
  expireInSeconds,
  deadLetter: QUEUES.failed,
});

/** Retry policy per queue, applied by `db:migrate` (create, or update an existing queue). */
export const QUEUE_OPTIONS: Record<QueueName, QueueSettings> = {
  [QUEUES.ping]: { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 60 },
  [QUEUES.parse]: stage(3, 300),
  [QUEUES.classify]: stage(4, 900),
  [QUEUES.extract]: stage(4, 900),
  [QUEUES.route]: stage(3, 120),
  [QUEUES.failed]: { retryLimit: 5, retryDelay: 5, retryBackoff: true, expireInSeconds: 120 },
  [QUEUES.deliver]: { retryLimit: 8, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 },
};

/** Payload of every pipeline stage job (and of its dead-letter copy). */
export interface StageJob {
  tenantId: string;
  documentId: string;
  runId: string;
}

// ── Documents and categories ─────────────────────────────────────────────────────────────────

/** Mime types accepted by uploads and the REST API. The parse stage re-checks magic bytes. */
export const DOCUMENT_MIMES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  eml: "message/rfc822",
  png: "image/png",
  jpeg: "image/jpeg",
  text: "text/plain",
} as const;
export type DocumentMime = (typeof DOCUMENT_MIMES)[keyof typeof DOCUMENT_MIMES];
export const ACCEPTED_MIMES: readonly DocumentMime[] = Object.values(DOCUMENT_MIMES);

/**
 * Mime of an email document's source object: the normalized email JSON written at ingestion (from a
 * Postmark payload or an .eml), with attachments stored as separate objects.
 */
export const EMAIL_SOURCE_MIME = "application/vnd.ai-triage.email+json";

/** Categories shipped with a schema template (packages/schemas). `other` is always available too. */
export const BUILTIN_CATEGORIES = ["invoice", "support_request", "contract"] as const;
export type BuiltinCategory = (typeof BUILTIN_CATEGORIES)[number];
export const OTHER_CATEGORY = "other";

/**
 * Gate reason codes. A failed gate is recorded as `code` or `code:field` (for example
 * `required_missing:total`), and any failure sends the item to review (docs/architecture.md §6).
 */
export const GATE_CODES = [
  "schema_invalid",
  "required_missing",
  "uncertain",
  "evidence_missing",
  "evidence_not_found",
  "evidence_unverifiable",
  "rule_failed",
  "category_other",
] as const;
export type GateCode = (typeof GATE_CODES)[number];

/** Why a document that passed every gate still goes to a human. */
export const ROUTE_REASONS = [
  "below_threshold",
  "no_score",
  "automation_off",
  "reclassify_run",
  "audit_sample",
] as const;
export type RouteReason = (typeof ROUTE_REASONS)[number];

/** Why a processing run failed. Stored on the run and as the `processing_failed` task's reason. */
export const FAILURE_REASONS = [
  "unsupported_file",
  "file_too_large",
  "too_many_pages",
  "parse_error",
  "request_too_large",
  "llm_refusal",
  "llm_truncated",
  "llm_bad_request",
  "invalid_output",
  "cassette_missing",
  "budget_exhausted",
  "retries_exhausted",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
