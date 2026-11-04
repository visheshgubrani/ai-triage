// Pipeline stages, statuses and other closed sets. See docs/architecture.md §5 for transitions.
// Everything in this package stays pure: I/O happens through ports passed in
// by the api/worker (production) or the eval runner (which gets no action port).
// The `as const` arrays are the single source of truth: packages/db builds its
// CHECK constraints from them.

/** This release (Keep a Changelog, CHANGELOG.md). A test keeps it equal to the root package.json. */
export const APP_VERSION = "0.7.0";

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

/** The channel a document arrived through (not its content type: an .eml upload is `upload`). */
export const DOCUMENT_SOURCES = ["email", "upload", "api", "gmail"] as const;
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

/** Roles a Workspace domain auto-join may grant. Never admin: admins are invited. */
export const JOIN_ROLES = ["reviewer", "viewer"] as const;
export type JoinRole = (typeof JOIN_ROLES)[number];

/**
 * How an invitation may be accepted: with a Google account whose verified email matches it, or
 * also by setting a password (the link is then the only proof, so Google is the default).
 */
export const INVITATION_ACCEPT_METHODS = ["google", "google_or_password"] as const;
export type InvitationAcceptMethod = (typeof INVITATION_ACCEPT_METHODS)[number];

/** Better Auth's invitation statuses that this app uses. Expiry is read from `expires_at`. */
export const INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** How long an invitation link stays valid. */
export const INVITATION_TTL_DAYS = 7;

export const EVAL_SPLITS = ["dev", "calib", "test"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

export const EVAL_ITEM_ORIGINS = ["seed", "import", "review", "label"] as const;
export type EvalItemOrigin = (typeof EVAL_ITEM_ORIGINS)[number];

export const EVAL_RUN_STATUSES = ["queued", "running", "done", "failed"] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

/** Execution context of an llm_calls row: a processing run, or an eval run + item (never both). */
export type LlmCallContext = { runId: string } | { evalRunId: string; evalItemId: string };

/**
 * How an llm_calls row was produced. `record` mode calls the live API, so it stores `live`.
 * `simulated`: the simulator answered (a `sim:` model), never money and never a real model.
 */
export const LLM_CALL_MODES = ["live", "replay", "simulated"] as const;
export type LlmCallMode = (typeof LLM_CALL_MODES)[number];

/** How the deployment calls models: `replay` (cassettes, the default), `record` (live, saved) or `live`. */
export const LLM_MODES = ["replay", "record", "live"] as const;
export type LlmMode = (typeof LLM_MODES)[number];

/** Replay is the default so a fresh clone never spends money. Live must be explicit. */
export function getLlmMode(value = process.env.LLM_MODE): LlmMode {
  if (value === undefined || value === "") return "replay";
  if ((LLM_MODES as readonly string[]).includes(value)) return value as LlmMode;
  throw new Error(`Invalid LLM_MODE "${value}". Expected one of: ${LLM_MODES.join(", ")}`);
}

/** How a mode's calls are stored in llm_calls: record calls the live API, so its calls are `live`. */
export const callModeOf = (mode: LlmMode): LlmCallMode => (mode === "replay" ? "replay" : "live");

/**
 * Effort levels across providers (Claude's `output_config.effort`, OpenAI-style `reasoning_effort`).
 * `none` means no reasoning, or no effort control at all. Each model lists the ones it accepts
 * (`MODEL_CATALOG` in ./models); configs are validated against that list.
 */
export const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
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
  /** Dead-letter queue of `action.deliver`: marks the action failed once retries are exhausted. */
  deliveryFailed: "action.failed",
  /** One eval item of one eval run: parse, classify, extract, evaluate and grade, then store the result. */
  evalItem: "eval.item",
  /** Dead-letter queue of `eval.item`: stores an error result once retries are exhausted. */
  evalFailed: "eval.failed",
  /** Daily housekeeping (cron): retention purges, expired uploads, old rate-limit windows. */
  maintenance: "system.maintenance",
  /** Deletes a purged document's objects, after the purge committed (the outbox for storage). */
  storageDelete: "storage.delete",
  /** Every minute (cron): enqueues a sync for each connected mailbox that is due. */
  mailboxPoll: "mailbox.poll",
  /** One mailbox: lists new messages since its cursor and enqueues a fetch for each. One per mailbox at a time. */
  mailboxSync: "mailbox.sync",
  /** One message of one mailbox: downloads it and ingests it as a document. */
  mailboxFetch: "mailbox.fetch",
  /** Dead-letter queue of `mailbox.fetch`: marks the message failed once retries are exhausted. */
  mailboxFailed: "mailbox.failed",
  /** Every five minutes (cron): fails runs, actions and eval runs left waiting on a job that is gone. */
  reconcile: "system.reconcile",
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
  /** Seconds: the longest a retry waits, however far backoff has doubled. */
  retryDelayMax?: number;
  /**
   * Seconds. A handler's worker refreshes the job this often (pg-boss does it); a job whose worker
   * died stops being refreshed and is retried after this long, instead of after `expireInSeconds`.
   */
  heartbeatSeconds?: number;
  /**
   * pg-boss queue policy (default `standard`). `exclusive` allows one queued or active job per
   * `singletonKey`, so a mailbox never syncs twice at once. A queue's policy is fixed when it's created.
   */
  policy?: "standard" | "exclusive";
}

const stage = (retryLimit: number, expireInSeconds: number): QueueSettings => ({
  retryLimit,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds,
  heartbeatSeconds: 30,
  deadLetter: QUEUES.failed,
});

/**
 * How long one model call may take before the SDK aborts it. Classify answers briefly; extract may
 * write up to its max_tokens, at about 40 tokens a second at worst. pg-boss owns retries (the SDK
 * makes none), so a stage's job expiry only has to outlast one call (a test checks the margin).
 */
export function llmTimeoutMs(stage: LlmStage, maxTokens: number): number {
  if (stage === "classify") return 120_000;
  return Math.min(600_000, 60_000 + Math.ceil(maxTokens / 40) * 1000);
}

/** Retry policy per queue, applied by `db:migrate` (create, or update an existing queue). */
export const QUEUE_OPTIONS: Record<QueueName, QueueSettings> = {
  [QUEUES.ping]: { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 60 },
  // Parsing runs in a sandbox bounded by PARSE_TIMEOUT_MS (60 s by default).
  [QUEUES.parse]: stage(3, 300),
  // One model call each: classify's 120 s timeout, extract's at most 600 s, plus a margin. Ten
  // retries with backoff capped at 5 minutes ride out about an hour of a busy provider.
  [QUEUES.classify]: stage(10, 300),
  [QUEUES.extract]: stage(10, 660),
  [QUEUES.route]: stage(3, 120),
  [QUEUES.failed]: { retryLimit: 5, retryDelay: 5, retryBackoff: true, retryDelayMax: 300, expireInSeconds: 120 },
  [QUEUES.deliver]: {
    retryLimit: 8,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 1800,
    expireInSeconds: 60,
    deadLetter: QUEUES.deliveryFailed,
  },
  [QUEUES.deliveryFailed]: {
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 60,
  },
  // An item parses and makes up to two model calls in one job, so its expiry covers all three.
  [QUEUES.evalItem]: {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 900,
    heartbeatSeconds: 30,
    deadLetter: QUEUES.evalFailed,
  },
  [QUEUES.evalFailed]: { retryLimit: 5, retryDelay: 5, retryBackoff: true, retryDelayMax: 300, expireInSeconds: 120 },
  [QUEUES.maintenance]: { retryLimit: 3, retryDelay: 60, retryBackoff: true, retryDelayMax: 900, expireInSeconds: 900 },
  [QUEUES.storageDelete]: {
    retryLimit: 10,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 1800,
    expireInSeconds: 300,
  },
  // A missed minute is caught by the next one, so the poll never retries.
  [QUEUES.mailboxPoll]: { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 60 },
  [QUEUES.mailboxSync]: {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 300,
    policy: "exclusive",
  },
  [QUEUES.mailboxFetch]: {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 300,
    deadLetter: QUEUES.mailboxFailed,
  },
  [QUEUES.mailboxFailed]: { retryLimit: 5, retryDelay: 5, retryBackoff: true, retryDelayMax: 300, expireInSeconds: 60 },
  // A missed pass is caught by the next one.
  [QUEUES.reconcile]: { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 240 },
};

/** When the maintenance job runs (cron, UTC). */
export const MAINTENANCE_CRON = "15 3 * * *";

/** When the mailbox poll runs: every minute, pg-boss's finest cron granularity. */
export const MAILBOX_POLL_CRON = "* * * * *";

/** When the reconciler runs: every five minutes. */
export const RECONCILE_CRON = "*/5 * * * *";

/** Payload of `storage.delete`: objects and key prefixes, all inside `t/{tenantId}/`. */
export interface StorageDeleteJob {
  tenantId: string;
  keys: string[];
  prefixes: string[];
}

/** Payload of every pipeline stage job (and of its dead-letter copy). */
export interface StageJob {
  tenantId: string;
  documentId: string;
  runId: string;
}

/** Payload of an `action.deliver` job (and of its dead-letter copy). The action id is the Idempotency-Key. */
export interface DeliverJob {
  tenantId: string;
  actionId: string;
}

/** Payload of an `eval.item` job (and of its dead-letter copy). */
export interface EvalItemJob {
  tenantId: string;
  evalRunId: string;
  evalItemId: string;
}

/** Payload of a `mailbox.sync` job (its singletonKey is the connection id). */
export interface MailboxSyncJob {
  tenantId: string;
  connectionId: string;
}

/** Payload of a `mailbox.fetch` job (and of its dead-letter copy). `messageId` is the provider's id. */
export interface MailboxFetchJob {
  tenantId: string;
  connectionId: string;
  messageId: string;
}

// ── Mailboxes ────────────────────────────────────────────────────────────────────────────────

/** Mail providers a tenant can connect a mailbox from. Microsoft comes later. */
export const MAILBOX_PROVIDERS = ["google"] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

/**
 * The authserv-id each provider's receiving servers write into Authentication-Results. Mail synced
 * from a provider's mailbox is checked against these results only (pipeline/untrusted.ts).
 */
export const MAILBOX_AUTHSERV_IDS: Record<MailboxProvider, string> = { google: "mx.google.com" };

/**
 * A connection's state. `reauth_required`: the provider refused its refresh token (revoked, or a
 * Testing-mode token expired), so polling stops until an admin reconnects.
 */
export const MAILBOX_STATUSES = ["active", "paused", "reauth_required", "disconnected"] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

/** A synced message's state in the `mailbox_messages` ledger. `purged`: its document was deleted. */
export const MAILBOX_MESSAGE_STATUSES = [
  "queued",
  "ingested",
  "duplicate",
  "skipped",
  "deferred",
  "failed",
  "purged",
] as const;
export type MailboxMessageStatus = (typeof MAILBOX_MESSAGE_STATUSES)[number];

/** Why a synced message wasn't ingested (`skipped`), or why it failed (`failed`). */
export const MAILBOX_MESSAGE_REASONS = [
  /** A draft, sent, spam, trash or chat message, or one no longer in the intake label. */
  "not_inbound",
  /** Deleted from the mailbox before it was downloaded. */
  "deleted",
  "too_large",
  "too_many_attachments",
  "unreadable",
  /** The mailbox was disconnected before the message was downloaded. */
  "disconnected",
  /** `failed`: downloading or ingesting kept failing. */
  "retries_exhausted",
] as const;
export type MailboxMessageReason = (typeof MAILBOX_MESSAGE_REASONS)[number];

/** What an OAuth round trip started by this app is for (`oauth_states.purpose`). */
export const OAUTH_PURPOSES = ["mailbox", "workspace_domain"] as const;
export type OAuthPurpose = (typeof OAUTH_PURPOSES)[number];

/** How long an OAuth round trip may take before its state expires. */
export const OAUTH_STATE_TTL_SECONDS = 600;
/**
 * When a mailbox's history cursor expired (unsynced for about a week), the next sync lists recent
 * mail instead, looking back at most this far.
 */
export const MAILBOX_RESYNC_MAX_DAYS = 7;
/** A connect may import recent mail too: at most this many days, and this many messages. */
export const MAILBOX_BACKFILL_MAX_DAYS = 7;
export const MAILBOX_BACKFILL_MAX_MESSAGES = 200;

// ── Review and delivery ──────────────────────────────────────────────────────────────────────

/**
 * A claim lasts this long unless the reviewer's page extends it. An expired claim counts as no
 * claim everywhere (claim, inbox, decisions), so there is no reaper (docs/architecture.md §7).
 */
export const LEASE_SECONDS = 600;
/** How often an open review page extends its lease while the tab is visible. */
export const HEARTBEAT_SECONDS = 60;

/** Machine-readable reasons a review request was refused (409 or 422), shown as `code` in ErrorResponse. */
export const REVIEW_ERROR_CODES = [
  "task_resolved",
  "reprocessing",
  "claim_lost",
  "claimed_by_other",
  "stale_revision",
  "action_not_allowed",
  "invalid_fields",
  "invalid_category",
  "not_redeliverable",
] as const;
export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];

/** Machine-readable reasons an eval request was refused (409 or 422), shown as `code` in ErrorResponse. */
export const EVAL_ERROR_CODES = [
  "config_not_frozen",
  "config_frozen",
  "empty_split",
  "not_calib_run",
  "run_not_done",
  "runs_not_comparable",
  "invalid_config",
] as const;
export type EvalErrorCode = (typeof EVAL_ERROR_CODES)[number];

/** Request-level refusals shared by every route (docs/security.md), shown as `code` in ErrorResponse. */
export const API_ERROR_CODES = [
  "bad_origin",
  "unreadable_file",
  "rate_limited",
  "two_factor_required",
  /** A sensitive account change by a user without a password needs a sign-in from the last few minutes. */
  "recent_sign_in_required",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Why a members or invitations request was refused, shown as `code` in ErrorResponse. */
export const MEMBER_ERROR_CODES = [
  /** The change would leave the workspace without an admin. */
  "last_admin",
  "not_member",
  "already_member",
  /** The invitation link doesn't exist, was used or revoked, or has expired. */
  "invitation_invalid",
  /** The signed-in user isn't the invited email. */
  "email_mismatch",
  /** A Google-only invitation needs a verified email (sign in with Google). */
  "email_not_verified",
  "password_not_allowed",
  /** Accepting with a password, for an email that already has an account. */
  "user_exists",
  /** Another tenant already claimed that Workspace domain. */
  "domain_taken",
  /** The Google account used to claim a domain isn't a Workspace account (no `hd`). */
  "not_workspace_account",
] as const;
export type MemberErrorCode = (typeof MEMBER_ERROR_CODES)[number];

/** Who did something recorded in the audit log: a member, a tenant API key, or the system (CLI, cron). */
export const AUDIT_ACTOR_TYPES = ["user", "api_key", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Security-relevant changes recorded in `audit_events` (docs/security.md). Review decisions have
 * their own trail (`review_decisions`) and aren't repeated here.
 */
export const AUDIT_ACTIONS = [
  "settings.webhook_updated",
  "settings.webhook_secret_rotated",
  "settings.budget_updated",
  "settings.retention_updated",
  "settings.inbound_rotated",
  "api_key.created",
  "api_key.revoked",
  "action.redelivered",
  "config.created",
  "config.frozen",
  "config.activated",
  "eval_run.created",
  "eval_item.retired",
  "document.purged",
  "retention.swept",
  "auth.two_factor_enabled",
  "auth.two_factor_disabled",
  "auth.google_linked",
  "auth.google_unlinked",
  "member.invited",
  "member.invitation_revoked",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "tenant.workspace_domain_set",
  "tenant.workspace_domain_cleared",
  "mailbox.connected",
  "mailbox.updated",
  "mailbox.disconnected",
  "mailbox.reauth_required",
  "setup.completed",
  "category.version_created",
  "runs.bulk_retried",
  "intake_filters.updated",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Headers of a webhook delivery. Receivers dedupe on the Idempotency-Key, which is the action id. */
export const WEBHOOK_HEADERS = {
  idempotencyKey: "Idempotency-Key",
  event: "X-Triage-Event",
  /** `t=<unix seconds>,v2=<hex HMAC-SHA256(secret, "<t>.<idempotency key>.<body>")>[,v2=…]` */
  signature: "X-Triage-Signature",
} as const;
export const WEBHOOK_EVENT = "document.approved";
/** How far a receiver should let the signed timestamp drift before rejecting a delivery. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

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
  /** The text addresses the triage system (deterministic patterns, pipeline/untrusted.ts). */
  "injection_suspected",
  /** Email that the config requires to be authenticated (SPF/DKIM/DMARC) and isn't. */
  "sender_unauthenticated",
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
  /** Parsing a file ran past PARSE_TIMEOUT_MS (or its memory limit) in the parse sandbox. */
  "parse_timeout",
  /** The model provider kept answering 429/529/503 until the stage's retries ran out. */
  "provider_unavailable",
  /** The reconciler found the run waiting on a job that no longer exists (docs/architecture.md §5). */
  "stalled",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export * from "./env";
export * from "./models";
