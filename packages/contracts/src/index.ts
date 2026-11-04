import {
  ACTION_STATUSES,
  API_ERROR_CODES,
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  AUTOMATION_MODES,
  DECISIONS,
  DELIVERY_STATUSES,
  DOCUMENT_SOURCES,
  EFFORTS,
  EVAL_ERROR_CODES,
  type EVAL_ITEM_ORIGINS,
  type EVAL_RUN_STATUSES,
  EVAL_SPLITS,
  EVIDENCE_MODES,
  EXTRACTION_AUTHORS,
  FAILURE_REASONS,
  INTAKE_FILTERS,
  INVITATION_ACCEPT_METHODS,
  type IntakeFilter,
  JOIN_ROLES,
  type LlmCallMode,
  MAILBOX_BACKFILL_MAX_DAYS,
  MAILBOX_MESSAGE_REASONS,
  MAILBOX_MESSAGE_STATUSES,
  MAILBOX_PROVIDERS,
  MAILBOX_STATUSES,
  MEMBER_ERROR_CODES,
  MEMBER_ROLES,
  PART_KINDS,
  PROCESSING_STATUSES,
  REVIEW_ACTIONS,
  REVIEW_ERROR_CODES,
  REVIEW_STATUSES,
  REVIEW_TASK_KINDS,
  REVIEW_TASK_STATUSES,
  RUN_STATUSES,
  RUN_TRIGGERS,
} from "@ai-triage/core";
import type {
  ProductionMetrics,
  ReliabilityBucket,
  ResultDetail,
  RunDiff,
  RunMetrics,
  RunSummary,
  ThresholdSweep,
} from "@ai-triage/evals";
import { z } from "zod";

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
  time: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** First-run setup (no workspace exists yet): whether it's open, and how an admin can accept. */
export const SetupStatusResponse = z.object({ needed: z.boolean(), googleSignIn: z.boolean() });
export type SetupStatusResponse = z.infer<typeof SetupStatusResponse>;

export const SetupRequest = z.object({
  token: z.string().min(20).max(100),
  workspaceName: z.string().trim().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, "3 to 40 lowercase letters, digits and dashes"),
  adminEmail: z.email().max(254),
  acceptWith: z.enum(INVITATION_ACCEPT_METHODS),
});
export type SetupRequest = z.infer<typeof SetupRequest>;

/** The first admin continues at this invite link (a password or Google), as any invited member. */
export const SetupResponse = z.object({ inviteUrl: z.string() });
export type SetupResponse = z.infer<typeof SetupResponse>;

export const OnboardingStep = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  detail: z.string(),
  href: z.string(),
});
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const OnboardingResponse = z.object({ dismissed: z.boolean(), steps: z.array(OnboardingStep) });
export type OnboardingResponse = z.infer<typeof OnboardingResponse>;

/** A signed `ping` to the tenant's webhook (Settings → Send test event). */
export const WebhookTestResponse = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  error: z.string().nullable(),
  ms: z.number(),
});
export type WebhookTestResponse = z.infer<typeof WebhookTestResponse>;

export const ReadyResponse = z.object({
  db: z.enum(["up", "down"]),
  migrations: z.enum(["current", "pending"]),
  storage: z.enum(["up", "down"]),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;

/** For the header (any member): what stops documents from being processed right now. */
export const SystemStatusResponse = z.object({
  workersRunning: z.number().int(),
  budgetExhausted: z.boolean(),
  /** Documents that failed on the budget and wait for a Retry (Retry all, after raising it). */
  budgetWaiting: z.number().int(),
});
export type SystemStatusResponse = z.infer<typeof SystemStatusResponse>;

/** Settings → System health (admins): this tenant's pipeline, and the deployment facts it shares. */
export const SystemHealthResponse = z.object({
  documents: z.array(z.object({ status: z.string(), count: z.number(), oldestUpdatedAt: z.string().nullable() })),
  openFailures: z.array(z.object({ reason: z.string(), count: z.number() })),
  last24h: z.object({ failedRuns: z.number(), stalledRuns: z.number() }),
  delivery: z.object({ pending: z.number(), failed: z.number(), oldestPendingAt: z.string().nullable() }),
  mailboxes: z.array(z.object({ status: z.string(), count: z.number() })),
  budget: z.object({ day: z.string(), capUsd: z.number(), spentUsd: z.number(), reservedUsd: z.number() }),
  workers: z.array(z.object({ version: z.string(), llmMode: z.string(), lastSeenAt: z.string() })),
  cooldowns: z.array(z.object({ provider: z.string(), model: z.string(), until: z.string(), reason: z.string() })),
});
export type SystemHealthResponse = z.infer<typeof SystemHealthResponse>;

export const MemberRole = z.enum(MEMBER_ROLES);
export type MemberRole = z.infer<typeof MemberRole>;

/** GET /me: the signed-in user and the tenant their session is acting in. */
export const MeResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  tenant: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  role: MemberRole,
  twoFactorEnabled: z.boolean(),
  /** An admin who must turn on 2FA before admin settings work (REQUIRE_ADMIN_2FA). */
  twoFactorRequired: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** GET /auth/providers (public): which sign-in methods besides email and password this instance offers. */
export const AuthProvidersResponse = z.object({ google: z.boolean() });
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponse>;

/** A field-level problem: a request that didn't parse, or edited values that don't match the schema. */
export const Issue = z.object({ field: z.string(), path: z.string(), message: z.string() });
export type Issue = z.infer<typeof Issue>;

/**
 * Every error body. Review and eval endpoints add a machine-readable `code` (409: the state moved
 * on, reload; 422: the request can't apply), and `issues` for invalid input.
 */
export const ErrorResponse = z.object({
  error: z.string(),
  code: z.enum([...REVIEW_ERROR_CODES, ...EVAL_ERROR_CODES, ...API_ERROR_CODES, ...MEMBER_ERROR_CODES]).optional(),
  issues: z.array(Issue).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  /** Set on 500s: quote it when reporting a problem; the server log carries the same id. */
  requestId: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// ── Documents ────────────────────────────────────────────────────────────────────────────────

const isoDate = z.string();

/** POST /uploads: step 1 of the two-step upload. */
export const UploadRequest = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().positive(),
  mime: z.string().min(1).max(200),
});
export type UploadRequest = z.infer<typeof UploadRequest>;

export const UploadResponse = z.object({
  uploadId: z.string(),
  /** Presigned URL: PUT the bytes here with exactly `headers`. */
  url: z.string(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expiresAt: isoDate,
});
export type UploadResponse = z.infer<typeof UploadResponse>;

/** Result of every ingestion path. `duplicate`: the document already existed and nothing changed. */
export const IngestResponse = z.object({ documentId: z.string(), duplicate: z.boolean() });
export type IngestResponse = z.infer<typeof IngestResponse>;

export const DocumentSummary = z.object({
  id: z.string(),
  title: z.string().nullable(),
  source: z.enum(DOCUMENT_SOURCES),
  mime: z.string().nullable(),
  createdAt: isoDate,
  processingStatus: z.enum(PROCESSING_STATUSES),
  reviewStatus: z.enum(REVIEW_STATUSES),
  deliveryStatus: z.enum(DELIVERY_STATUSES),
  category: z.string().nullable(),
  score: z.number().nullable(),
  decision: z.enum(DECISIONS).nullable(),
  /** Why the document is (or would be) in review: gate and routing reasons, or the open task's. */
  reasons: z.array(z.string()),
  taskKind: z.enum(REVIEW_TASK_KINDS).nullable(),
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

export const DocumentListQuery = z.object({
  status: z.enum(PROCESSING_STATUSES).optional(),
  source: z.enum(DOCUMENT_SOURCES).optional(),
  category: z.string().min(1).max(100).optional(),
  /** Matches the title (subject or file name). */
  q: z.string().min(1).max(200).optional(),
  /** The previous page's `nextBefore`. */
  before: z.iso.datetime().optional(),
});
export type DocumentListQuery = z.infer<typeof DocumentListQuery>;

export const DocumentList = z.object({
  documents: z.array(DocumentSummary),
  /** Pass as `before` for the next page; null on the last one. */
  nextBefore: z.string().nullable(),
});
export type DocumentList = z.infer<typeof DocumentList>;

/** A live claim on a review task. A claim whose lease ran out is reported as none. */
export const ClaimInfo = z.object({ userId: z.string(), email: z.string().nullable(), leaseExpiresAt: isoDate });
export type ClaimInfo = z.infer<typeof ClaimInfo>;

export const IntakeSettings = z.object(
  Object.fromEntries(INTAKE_FILTERS.map((f) => [f, z.boolean()])) as Record<IntakeFilter, z.ZodBoolean>,
);
export type IntakeSettings = z.infer<typeof IntakeSettings>;

export const ProcessResponse = z.object({ runId: z.string() });
export type ProcessResponse = z.infer<typeof ProcessResponse>;

export const DocumentDetail = z.object({
  document: DocumentSummary.extend({ sizeBytes: z.number().nullable() }),
  run: z
    .object({
      id: z.string(),
      trigger: z.enum(RUN_TRIGGERS),
      forcedCategory: z.string().nullable(),
      status: z.enum(RUN_STATUSES),
      error: z.string().nullable(),
      /** The intake filter that skipped it (the document is `skipped`). */
      skipReason: z.enum(INTAKE_FILTERS).nullable(),
      createdAt: isoDate,
      finishedAt: isoDate.nullable(),
    })
    .nullable(),
  parts: z.array(
    z.object({
      partIndex: z.number(),
      kind: z.enum(PART_KINDS),
      mime: z.string(),
      label: z.string().nullable(),
      page: z.number().nullable(),
      text: z.string(),
      evidenceMode: z.enum(EVIDENCE_MODES),
      /** Parts cut from the same stored file (the pages of one PDF) share this: the first one's index. */
      fileIndex: z.number().nullable(),
    }),
  ),
  classification: z
    .object({ category: z.string(), selfConfidence: z.number(), rationale: z.string().nullable() })
    .nullable(),
  extraction: z
    .object({
      id: z.string(),
      revision: z.number(),
      author: z.enum(EXTRACTION_AUTHORS),
      parentId: z.string().nullable(),
      category: z.string(),
      schemaVersionId: z.string(),
      fields: z.unknown(),
      validationErrors: z.unknown(),
      gateResults: z.unknown(),
      score: z.number().nullable(),
      decision: z.enum(DECISIONS).nullable(),
      decisionReasons: z.array(z.string()),
      createdAt: isoDate,
    })
    .nullable(),
  /** The JSON Schema of the extraction's category version: the review form is rendered from it. */
  schema: z.unknown().nullable(),
  /** Gate results of the latest model revision, whose evidence the page highlights. */
  modelGateResults: z.unknown().nullable(),
  revisions: z.array(
    z.object({
      id: z.string(),
      revision: z.number(),
      author: z.enum(EXTRACTION_AUTHORS),
      authorEmail: z.string().nullable(),
      category: z.string(),
      decision: z.enum(DECISIONS).nullable(),
      createdAt: isoDate,
    }),
  ),
  task: z
    .object({
      id: z.string(),
      kind: z.enum(REVIEW_TASK_KINDS),
      status: z.enum(REVIEW_TASK_STATUSES),
      reasons: z.array(z.string()),
      extractionId: z.string().nullable(),
      createdAt: isoDate,
      claim: ClaimInfo.nullable(),
    })
    .nullable(),
  decisions: z.array(
    z.object({
      id: z.string(),
      outcome: z.enum(REVIEW_ACTIONS),
      taskKind: z.enum(REVIEW_TASK_KINDS),
      extractionId: z.string().nullable(),
      reviewerEmail: z.string().nullable(),
      diff: z.unknown(),
      note: z.string().nullable(),
      createdAt: isoDate,
    }),
  ),
  actions: z.array(
    z.object({
      id: z.string(),
      extractionId: z.string(),
      status: z.enum(ACTION_STATUSES),
      payload: z.unknown(),
      attempts: z.number(),
      lastError: z.string().nullable(),
      deliveredAt: isoDate.nullable(),
      createdAt: isoDate,
    }),
  ),
  /** Categories of the active config: where a reviewer may reclassify to. */
  categories: z.array(z.string()),
  /**
   * For mail synced from a connected mailbox: which one, and a link that finds the message in Gmail
   * (by its Message-ID; null when it had none).
   */
  mailbox: z.object({ email: z.string(), gmailUrl: z.string().nullable() }).nullable(),
});
export type DocumentDetail = z.infer<typeof DocumentDetail>;

export const SourceUrlResponse = z.object({ url: z.string() });
export type SourceUrlResponse = z.infer<typeof SourceUrlResponse>;

/** GET /documents/:id/parts/:index/file: a short-lived URL of the part's stored file (PDF, image). */
export const FileUrlResponse = z.object({ url: z.string(), mime: z.string(), label: z.string().nullable() });
export type FileUrlResponse = z.infer<typeof FileUrlResponse>;

/** GET /documents/:id/email. `html` is sanitized (no scripts, styles or remote content), or null. */
export const EmailView = z.object({
  subject: z.string().nullable(),
  from: z.string().nullable(),
  date: z.string().nullable(),
  text: z.string(),
  html: z.string().nullable(),
  attachments: z.array(z.object({ index: z.number(), filename: z.string(), mime: z.string(), size: z.number() })),
});
export type EmailView = z.infer<typeof EmailView>;

/** POST /webhooks/postmark when the recipient isn't a tenant's inbound address. */
export const IgnoredResponse = z.object({ ignored: z.literal("unknown_recipient") });
export type IgnoredResponse = z.infer<typeof IgnoredResponse>;

// ── Review ───────────────────────────────────────────────────────────────────────────────────

export const InboxTask = z.object({
  id: z.string(),
  kind: z.enum(REVIEW_TASK_KINDS),
  status: z.enum(REVIEW_TASK_STATUSES),
  reasons: z.array(z.string()),
  createdAt: isoDate,
  documentId: z.string(),
  title: z.string().nullable(),
  source: z.enum(DOCUMENT_SOURCES),
  mime: z.string().nullable(),
  category: z.string().nullable(),
  score: z.number().nullable(),
  extractionId: z.string().nullable(),
  /** Why the run failed, for `processing_failed` tasks. */
  runError: z.string().nullable(),
  claim: ClaimInfo.nullable(),
});
export type InboxTask = z.infer<typeof InboxTask>;

const counts = z.record(z.string(), z.number());
export const InboxCounts = z.object({ total: z.number(), kind: counts, category: counts, reason: counts });
export type InboxCounts = z.infer<typeof InboxCounts>;

export const InboxResponse = z.object({ tasks: z.array(InboxTask), counts: InboxCounts });
export type InboxResponse = z.infer<typeof InboxResponse>;

export const INBOX_AGES = ["1h", "24h", "7d"] as const;
export type InboxAge = (typeof INBOX_AGES)[number];

/** GET /review/tasks filters. `reason` is a reason code (`required_missing` matches `required_missing:total`). */
export const InboxQuery = z.object({
  kind: z.enum(REVIEW_TASK_KINDS).optional(),
  category: z.string().min(1).max(100).optional(),
  reason: z.string().min(1).max(100).optional(),
  olderThan: z.enum(INBOX_AGES).optional(),
  mine: z.literal("1").optional(),
});
export type InboxQuery = z.infer<typeof InboxQuery>;

/** Retry all (admins): every open, unclaimed processing_failed task, optionally of one reason. */
export const RetryFailedRequest = z.object({
  reason: z.enum(FAILURE_REASONS).optional(),
  /** Only failures from before this time (the start of an outage, say). */
  before: z.iso.datetime().optional(),
});
export type RetryFailedRequest = z.infer<typeof RetryFailedRequest>;

export const RetryFailedResponse = z.object({
  retried: z.number().int(),
  /** Tasks that moved on before their turn (claimed, already retried). */
  skipped: z.number().int(),
});
export type RetryFailedResponse = z.infer<typeof RetryFailedResponse>;

export const ClaimNextRequest = z.object({
  kind: z.enum(REVIEW_TASK_KINDS).optional(),
  category: z.string().min(1).max(100).optional(),
});
export type ClaimNextRequest = z.infer<typeof ClaimNextRequest>;

export const ClaimResponse = z.object({
  taskId: z.string(),
  documentId: z.string(),
  claimToken: z.string(),
  leaseExpiresAt: isoDate,
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const ClaimNextResponse = z.object({ claim: ClaimResponse.nullable() });
export type ClaimNextResponse = z.infer<typeof ClaimNextResponse>;

export const ClaimTokenRequest = z.object({ claimToken: z.uuid() });
export type ClaimTokenRequest = z.infer<typeof ClaimTokenRequest>;

export const HeartbeatResponse = z.object({ leaseExpiresAt: isoDate });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const ReleaseResponse = z.object({ released: z.boolean() });
export type ReleaseResponse = z.infer<typeof ReleaseResponse>;

const decisionBase = { claimToken: z.uuid(), note: z.string().max(2000).optional() };

/**
 * "Add to eval set" on an approval: the approved category and fields become the label of a new item
 * in the tenant's Main dataset, with a copy of the document's source.
 */
const addToEvalSet = z.object({ split: z.enum(EVAL_SPLITS) }).optional();

/**
 * POST /review/tasks/:id/decisions. Approvals name the exact revision they approve; the server
 * refuses with 409 if it isn't the document's current one. Which actions a task allows depends on
 * its kind (ACTIONS_BY_TASK_KIND).
 */
export const DecisionRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), extractionId: z.uuid(), addToEvalSet, ...decisionBase }),
  z.object({
    action: z.literal("edit_approve"),
    extractionId: z.uuid(),
    fields: z.record(z.string(), z.unknown()),
    addToEvalSet,
    ...decisionBase,
  }),
  z.object({ action: z.literal("reclassify"), category: z.string().min(1).max(100), ...decisionBase }),
  z.object({ action: z.literal("reject"), ...decisionBase }),
  z.object({ action: z.literal("retry"), ...decisionBase }),
]);
export type DecisionRequest = z.infer<typeof DecisionRequest>;

export const DecisionResponse = z.object({
  decisionId: z.string(),
  outcome: z.enum(REVIEW_ACTIONS),
  documentId: z.string(),
  /** The approved revision (a new one for an edit). */
  extractionId: z.string().nullable(),
  /** The outbox action an approval created; its id is the webhook's Idempotency-Key. */
  actionId: z.string().nullable(),
  /** The run a retry or reclassify started. */
  runId: z.string().nullable(),
  /** The eval item "Add to eval set" created (or found: the same content was already in the set). */
  evalItem: z.object({ id: z.string(), split: z.enum(EVAL_SPLITS), duplicate: z.boolean() }).nullable(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;

// ── Delivery and settings ────────────────────────────────────────────────────────────────────

export const DeliveryFailure = z.object({
  actionId: z.string(),
  documentId: z.string(),
  title: z.string().nullable(),
  category: z.string(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type DeliveryFailure = z.infer<typeof DeliveryFailure>;

export const DeliveryFailureList = z.object({ failures: z.array(DeliveryFailure) });
export type DeliveryFailureList = z.infer<typeof DeliveryFailureList>;

export const RedeliverResponse = z.object({ actionId: z.string(), status: z.literal("pending") });
export type RedeliverResponse = z.infer<typeof RedeliverResponse>;

export const WebhookSettings = z.object({
  url: z.string().nullable(),
  secretSet: z.boolean(),
  /** The secret's first characters, to recognise it. The full secret is shown only when created. */
  secretHint: z.string().nullable(),
  /** After a rotation: until when deliveries are also signed with the previous secret. */
  previousSecretValidUntil: isoDate.nullable(),
});
export type WebhookSettings = z.infer<typeof WebhookSettings>;

export const WebhookSettingsRequest = z.object({
  url: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullable(),
});
export type WebhookSettingsRequest = z.infer<typeof WebhookSettingsRequest>;

/** PUT /settings/webhook and POST /settings/webhook/rotate. `secret` is set only when one was created. */
export const WebhookSettingsResponse = z.object({ settings: WebhookSettings, secret: z.string().nullable() });
export type WebhookSettingsResponse = z.infer<typeof WebhookSettingsResponse>;

// ── Inbound email ───────────────────────────────────────────────────────────────────────────

/** GET /settings/inbound and POST /settings/inbound/rotate: where to forward mail for this tenant. */
export const InboundSettings = z.object({ addresses: z.array(z.string()) });
export type InboundSettings = z.infer<typeof InboundSettings>;

// ── API keys ───────────────────────────────────────────────────────────────────────────────

export const ApiKeySummary = z.object({
  id: z.uuid(),
  name: z.string(),
  /** `tri_xxxxxxxx`: enough to recognise a key, never enough to use it. */
  prefix: z.string(),
  createdAt: isoDate,
  lastUsedAt: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
});
export type ApiKeySummary = z.infer<typeof ApiKeySummary>;

export const ApiKeyList = z.object({ keys: z.array(ApiKeySummary) });
export type ApiKeyList = z.infer<typeof ApiKeyList>;

export const ApiKeyRequest = z.object({
  name: z.string().trim().min(1).max(100),
  /** Omitted: the key never expires. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type ApiKeyRequest = z.infer<typeof ApiKeyRequest>;

/** POST /settings/api-keys: the key itself, shown this once. */
export const ApiKeyCreated = z.object({ key: z.string(), apiKey: ApiKeySummary });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;

// ── Retention ──────────────────────────────────────────────────────────────────────────────

/** GET/PUT /settings/retention: finished documents older than this are purged daily (null: kept). */
export const RetentionSettings = z.object({ retentionDays: z.number().int().min(1).max(3650).nullable() });
export type RetentionSettings = z.infer<typeof RetentionSettings>;

// ── LLM budget ──────────────────────────────────────────────────────────────────────────────

/** GET/PUT /settings/budget: the daily cap (USD) and today's (UTC) live spend. */
export const BudgetSettings = z.object({
  day: z.string(),
  capUsd: z.number(),
  spentUsd: z.number(),
  reservedUsd: z.number(),
});
export type BudgetSettings = z.infer<typeof BudgetSettings>;

export const BudgetRequest = z.object({ capUsd: z.number().min(0).max(100_000) });
export type BudgetRequest = z.infer<typeof BudgetRequest>;

// ── Audit log ───────────────────────────────────────────────────────────────────────────────

export const AuditEvent = z.object({
  id: z.uuid(),
  actorType: z.enum(AUDIT_ACTOR_TYPES),
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  action: z.enum(AUDIT_ACTIONS),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: isoDate,
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditQuery = z.object({ cursor: z.string().max(200).optional() });

export const AuditEventList = z.object({ events: z.array(AuditEvent), nextCursor: z.string().nullable() });
export type AuditEventList = z.infer<typeof AuditEventList>;

// ── Evals ────────────────────────────────────────────────────────────────────────────────────
// Request bodies are Zod (validated); responses are typed with the metric shapes from @ai-triage/evals.

export type EvalSplit = (typeof EVAL_SPLITS)[number];

export interface EvalDataset {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  /** Active items per split. */
  counts: Record<EvalSplit, number>;
}
export interface EvalDatasetList {
  datasets: EvalDataset[];
}

export const EvalItemsQuery = z.object({
  split: z.enum(EVAL_SPLITS).optional(),
  retired: z.literal("1").optional(),
});
export type EvalItemsQuery = z.infer<typeof EvalItemsQuery>;

export interface EvalItem {
  id: string;
  split: EvalSplit;
  expectedCategory: string;
  expectedFields: Record<string, unknown>;
  origin: (typeof EVAL_ITEM_ORIGINS)[number];
  originRef: string | null;
  tags: string[];
  sourceTitle: string | null;
  sourceMime: string;
  createdAt: string;
  retiredAt: string | null;
}
export interface EvalItemList {
  items: EvalItem[];
}

/** A config version as the evals page shows it. */
export interface ConfigSummary {
  id: string;
  version: number;
  name: string;
  parentId: string | null;
  frozenAt: string | null;
  active: boolean;
  createdAt: string;
  classify: { model: string; effort: string; promptVersionId: string };
  extract: { model: string; effort: string; promptVersionId: string };
  categories: {
    category: string;
    threshold: number;
    automation: (typeof AUTOMATION_MODES)[number];
    auditRate: number;
  }[];
}
export interface ConfigList {
  configs: ConfigSummary[];
  promptVersions: { id: string; stage: string; version: number }[];
}

const CategoryChange = z.object({
  category: z.string().min(1).max(100),
  threshold: z.number().min(0).max(1),
  automation: z.enum(AUTOMATION_MODES),
  auditRate: z.number().min(0).max(1),
});
const StageChange = z
  .object({ model: z.string().min(1).max(200), effort: z.enum(EFFORTS), promptVersionId: z.uuid() })
  .partial();

/** POST /configs: a new (unfrozen, inactive) version derived from `parentId`. */
export const CandidateConfigRequest = z.object({
  parentId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  classify: StageChange.optional(),
  extract: StageChange.optional(),
  categories: z.array(CategoryChange).max(50).optional(),
  /**
   * Require authenticated email (DMARC, or DKIM) to auto-approve, trusting Authentication-Results
   * only from these receiving servers (e.g. `mx.google.com`). Omitted: the parent's policy.
   */
  sender: z
    .object({
      require: z.boolean(),
      trustedAuthServIds: z.array(z.string().trim().min(1).max(253)).max(20),
      /** Mail synced from a connected mailbox must be authenticated (default true). */
      mailbox: z.object({ require: z.boolean() }).optional(),
    })
    .optional(),
});
export type CandidateConfigRequest = z.infer<typeof CandidateConfigRequest>;

export interface ConfigResponse {
  config: ConfigSummary;
}

/** A catalog model and whether a running worker can call it now (worker heartbeats). */
export interface ModelOption {
  ref: string;
  provider: string;
  efforts: string[];
  /** Replay serves this model only at its recorded effort. */
  recordedEffort: string | null;
  available: boolean;
  /** Why not, when it isn't: no key on the worker, no recording in replay, no worker running. */
  reason: string | null;
}
export interface ModelList {
  models: ModelOption[];
}

/** Settings → Pipeline: the active version, with what the sender policy says. */
export interface PipelineSettings {
  config: ConfigSummary;
  /** Forwarded mail (Postmark) must be authenticated to auto-approve. Synced mail always is. */
  senderRequire: boolean;
}

/**
 * Settings → Pipeline → Save: a new version of the active one with these models, every category
 * reviewed by a person (a model change makes the old thresholds meaningless), activated at once.
 */
export const PipelineChangeRequest = z.object({
  classify: z.object({ model: z.string().min(1).max(200), effort: z.enum(EFFORTS) }),
  extract: z.object({ model: z.string().min(1).max(200), effort: z.enum(EFFORTS) }),
  senderRequire: z.boolean(),
});
export type PipelineChangeRequest = z.infer<typeof PipelineChangeRequest>;

export const EvalRunsQuery = z.object({ datasetId: z.uuid().optional() });
export type EvalRunsQuery = z.infer<typeof EvalRunsQuery>;

export interface EvalRun {
  id: string;
  datasetId: string;
  datasetName: string;
  split: EvalSplit;
  status: (typeof EVAL_RUN_STATUSES)[number];
  /**
   * `replay`: served from cassettes, so costs are recorded figures and latencies recorded live
   * latencies. `simulated`: the simulator answered (`sim:` models), so nothing measures a real model.
   */
  llmMode: LlmCallMode;
  itemCount: number;
  /** Results stored so far. */
  done: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  config: { id: string; version: number; name: string; frozen: boolean; classifyModel: string; extractModel: string };
  /** Set once the run is done. */
  summary: RunSummary | null;
}
export interface EvalRunList {
  runs: EvalRun[];
  /** How a run started now would call models (the deployment's LLM_MODE). */
  newRunMode: LlmCallMode;
}

/** POST /evals/runs. Test-split runs need a frozen config (422 config_not_frozen). */
export const EvalRunRequest = z.object({ datasetId: z.uuid(), split: z.enum(EVAL_SPLITS), configId: z.uuid() });
export type EvalRunRequest = z.infer<typeof EvalRunRequest>;

export interface EvalRunCreated {
  runId: string;
  itemCount: number;
}

export interface EvalRunDetail {
  run: EvalRun;
  config: ConfigSummary;
  /** Null until the run is done. */
  metrics: RunMetrics | null;
  /** Per category the config routes, from the results so far. */
  sweeps: ThresholdSweep[];
  reliability: ReliabilityBucket[];
  results: ResultDetail[];
}

/** POST /evals/runs/:id/freeze: a frozen child of the run's config with these category settings. */
export const FreezeRequest = z.object({
  name: z.string().trim().min(1).max(200),
  categories: z.array(CategoryChange).max(50),
});
export type FreezeRequest = z.infer<typeof FreezeRequest>;

export const EvalDiffQuery = z.object({ a: z.uuid(), b: z.uuid() });
export type EvalDiffQuery = z.infer<typeof EvalDiffQuery>;

export interface EvalDiffResponse {
  a: EvalRun;
  b: EvalRun;
  diff: RunDiff;
  /** Item titles, for the regression list. */
  titles: Record<string, string | null>;
}

export const ProductionQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
export type ProductionQuery = z.infer<typeof ProductionQuery>;

export interface ProductionResponse extends ProductionMetrics {
  since: string;
  until: string;
  days: number;
}

// ── Members and invitations ──────────────────────────────────────────────────────────────────

export const InvitationAcceptMethod = z.enum(INVITATION_ACCEPT_METHODS);
export type InvitationAcceptMethod = z.infer<typeof InvitationAcceptMethod>;

export const Member = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: MemberRole,
  joinedAt: isoDate,
  twoFactorEnabled: z.boolean(),
  /** The Google Workspace domain the user signed up with, if any. */
  hostedDomain: z.string().nullable(),
  /** `credential` (a password) and/or `google`. */
  signInMethods: z.array(z.string()),
});
export type Member = z.infer<typeof Member>;

export const Invitation = z.object({
  id: z.string(),
  email: z.string(),
  role: MemberRole,
  acceptWith: InvitationAcceptMethod,
  expiresAt: isoDate,
  createdAt: isoDate,
});
export type Invitation = z.infer<typeof Invitation>;

/** GET /members (admin): members, pending invitations, and the Workspace domain auto-join setting. */
export const MemberList = z.object({
  members: z.array(Member),
  invitations: z.array(Invitation),
  workspaceDomain: z.object({ domain: z.string(), joinRole: z.enum(JOIN_ROLES) }).nullable(),
  /** Whether this instance has a Google client (Google invitations and auto-join need one). */
  google: z.boolean(),
});
export type MemberList = z.infer<typeof MemberList>;

export const JoinRole = z.enum(JOIN_ROLES);
export type JoinRole = z.infer<typeof JoinRole>;

/** POST /members/workspace-domain/verify, PATCH /members/workspace-domain. */
export const WorkspaceDomainRequest = z.object({ joinRole: JoinRole });
export type WorkspaceDomainRequest = z.infer<typeof WorkspaceDomainRequest>;

export const UpdateMemberRequest = z.object({ role: MemberRole });
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

export const CreateInvitationRequest = z.object({
  email: z.email().max(320),
  role: MemberRole,
  acceptWith: InvitationAcceptMethod.default("google"),
});
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequest>;

/** The link is shown once: only the token's hash is stored. */
export const InvitationCreated = z.object({ invitation: Invitation, link: z.string() });
export type InvitationCreated = z.infer<typeof InvitationCreated>;

/** Invitation tokens are 32 random bytes, base64url (43 characters). */
export const InvitationTokenRequest = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export type InvitationTokenRequest = z.infer<typeof InvitationTokenRequest>;

/** POST /invitations/lookup (public): what the invite page shows before anyone signs in. */
export const InvitationPreview = z.object({
  tenantName: z.string(),
  email: z.string(),
  role: MemberRole,
  acceptWith: InvitationAcceptMethod,
  expiresAt: isoDate,
  google: z.boolean(),
});
export type InvitationPreview = z.infer<typeof InvitationPreview>;

export const AcceptWithPasswordRequest = InvitationTokenRequest.extend({
  name: z.string().trim().min(1).max(200),
  password: z.string().min(12).max(128),
});
export type AcceptWithPasswordRequest = z.infer<typeof AcceptWithPasswordRequest>;

export const InvitationAccepted = z.object({ tenantId: z.string(), email: z.string() });
export type InvitationAccepted = z.infer<typeof InvitationAccepted>;

// ── Mailboxes ────────────────────────────────────────────────────────────────────────────────

export const MailboxSummary = z.object({
  id: z.string(),
  provider: z.enum(MAILBOX_PROVIDERS),
  email: z.string(),
  status: z.enum(MAILBOX_STATUSES),
  labelId: z.string(),
  labelName: z.string(),
  lastSyncedAt: isoDate.nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type MailboxSummary = z.infer<typeof MailboxSummary>;

/** GET /mailboxes (admin). `google`: whether this instance can connect Google mailboxes. */
export const MailboxList = z.object({ mailboxes: z.array(MailboxSummary), google: z.boolean() });
export type MailboxList = z.infer<typeof MailboxList>;

export const MailboxMessage = z.object({
  id: z.string(),
  status: z.enum(MAILBOX_MESSAGE_STATUSES),
  reason: z.enum(MAILBOX_MESSAGE_REASONS).nullable(),
  documentId: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  receivedAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type MailboxMessage = z.infer<typeof MailboxMessage>;

/** GET /mailboxes/:id: the mailbox and what became of its most recent messages. */
export const MailboxDetail = z.object({ mailbox: MailboxSummary, messages: z.array(MailboxMessage) });
export type MailboxDetail = z.infer<typeof MailboxDetail>;

/** POST /mailboxes/google/authorize: start connecting; the browser goes to `url`. */
export const AuthorizeMailboxRequest = z.object({
  /** Also import this many days of recent mail. */
  backfillDays: z.number().int().min(0).max(MAILBOX_BACKFILL_MAX_DAYS).default(0),
  /** Reconnecting a known mailbox: pre-fill Google's account picker. */
  loginHint: z.email().optional(),
});
export type AuthorizeMailboxRequest = z.infer<typeof AuthorizeMailboxRequest>;

export const AuthorizeResponse = z.object({ url: z.string() });
export type AuthorizeResponse = z.infer<typeof AuthorizeResponse>;

export const MailboxLabels = z.object({
  labels: z.array(z.object({ id: z.string(), name: z.string(), type: z.string().optional() })),
});
export type MailboxLabels = z.infer<typeof MailboxLabels>;

export const UpdateMailboxRequest = z
  .object({ labelId: z.string().trim().min(1).max(200).optional(), paused: z.boolean().optional() })
  .refine((v) => v.labelId !== undefined || v.paused !== undefined, { message: "Nothing to change" });
export type UpdateMailboxRequest = z.infer<typeof UpdateMailboxRequest>;
