import {
  ACTION_STATUSES,
  DECISIONS,
  DELIVERY_STATUSES,
  DOCUMENT_SOURCES,
  EVIDENCE_MODES,
  EXTRACTION_AUTHORS,
  MEMBER_ROLES,
  PART_KINDS,
  PROCESSING_STATUSES,
  REVIEW_STATUSES,
  REVIEW_TASK_KINDS,
  REVIEW_TASK_STATUSES,
  RUN_STATUSES,
  RUN_TRIGGERS,
} from "@ai-triage/core";
import { z } from "zod";

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const MemberRole = z.enum(MEMBER_ROLES);
export type MemberRole = z.infer<typeof MemberRole>;

/** GET /me: the signed-in user and the tenant their session is acting in. */
export const MeResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  tenant: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  role: MemberRole,
});
export type MeResponse = z.infer<typeof MeResponse>;

export const ErrorResponse = z.object({ error: z.string() });
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

export const DocumentList = z.object({ documents: z.array(DocumentSummary) });
export type DocumentList = z.infer<typeof DocumentList>;

export const DocumentDetail = z.object({
  document: DocumentSummary.extend({ sizeBytes: z.number().nullable() }),
  run: z
    .object({
      id: z.string(),
      trigger: z.enum(RUN_TRIGGERS),
      status: z.enum(RUN_STATUSES),
      error: z.string().nullable(),
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
      category: z.string(),
      fields: z.unknown(),
      validationErrors: z.unknown(),
      gateResults: z.unknown(),
      score: z.number().nullable(),
      decision: z.enum(DECISIONS).nullable(),
      decisionReasons: z.array(z.string()),
    })
    .nullable(),
  task: z
    .object({
      id: z.string(),
      kind: z.enum(REVIEW_TASK_KINDS),
      status: z.enum(REVIEW_TASK_STATUSES),
      reasons: z.array(z.string()),
    })
    .nullable(),
  actions: z.array(
    z.object({ id: z.string(), status: z.enum(ACTION_STATUSES), payload: z.unknown(), createdAt: isoDate }),
  ),
});
export type DocumentDetail = z.infer<typeof DocumentDetail>;

export const SourceUrlResponse = z.object({ url: z.string() });
export type SourceUrlResponse = z.infer<typeof SourceUrlResponse>;

/** POST /webhooks/postmark when the recipient isn't a tenant's inbound address. */
export const IgnoredResponse = z.object({ ignored: z.literal("unknown_recipient") });
export type IgnoredResponse = z.infer<typeof IgnoredResponse>;
