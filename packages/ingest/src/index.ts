import { createHash } from "node:crypto";
import { ACCEPTED_MIMES, DOCUMENT_MIMES, type DocumentSource, EMAIL_SOURCE_MIME, isOneOf } from "@ai-triage/core";
import {
  type NormalizedEmail,
  normalizeEml,
  normalizePostmark,
  type PostmarkInbound,
  type StoredEmail,
} from "@ai-triage/core/pipeline";
import {
  createDb,
  findDocument,
  getUpload,
  ingestDocument,
  insertUpload,
  markUploadCompleted,
  type PgBoss,
  type Pool,
  resolveInboundAddress,
  withTenantTx,
} from "@ai-triage/db";
import { type Storage, storageKeys } from "@ai-triage/storage";

// Every way a document enters the system ends here: store the source under a server-issued key,
// then create the document, its first run and the parse job in one transaction (ingestDocument).
// A duplicate (same source and external id) returns the existing document and writes nothing new.
// Objects are written before the transaction, so a duplicate that races past the pre-check leaves
// orphan objects behind (cleaned up by the retention purge, later).

export interface IngestDeps {
  pool: Pool;
  boss: PgBoss;
  storage: Storage;
}

export interface IngestLimits {
  maxFileBytes: number;
}

export interface IngestResult {
  documentId: string;
  duplicate: boolean;
}

/** A request the API should refuse; `status` is the HTTP status to answer with. */
export class IngestRejected extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410 | 413 | 415 | 422,
    message: string,
  ) {
    super(message);
    this.name = "IngestRejected";
  }
}

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const EML_MIMES = new Set([DOCUMENT_MIMES.eml, "application/eml"]);
export const isEml = (filename: string | null, mime: string | null) =>
  (mime !== null && EML_MIMES.has(mime)) || (filename?.toLowerCase().endsWith(".eml") ?? false);

async function existing(deps: IngestDeps, tenantId: string, source: DocumentSource, externalId: string) {
  const id = await withTenantTx(deps.pool, tenantId, (tx) => findDocument(tx, source, externalId));
  return id ? { documentId: id, duplicate: true } : null;
}

/** The tenant an inbound email is for: the first recipient that is a tenant's inbound address. */
export async function resolveEmailTenant(pool: Pool, recipients: readonly string[]): Promise<string | null> {
  const db = createDb(pool);
  for (const address of recipients) {
    const tenantId = await resolveInboundAddress(db, address);
    if (tenantId) return tenantId;
  }
  return null;
}

/** External id of an email: its Message-ID, else a hash of the original (Postmark payload or .eml). */
export function emailExternalId(email: NormalizedEmail, input: { postmark?: PostmarkInbound; eml?: Uint8Array }) {
  return email.messageId ?? `sha256:${sha256(input.eml ?? JSON.stringify(input.postmark ?? null))}`;
}

/** External id of a file (and of an .eml-less upload): the SHA-256 of its bytes. */
export const fileExternalId = (bytes: Uint8Array) => `sha256:${sha256(bytes)}`;

export const emailTitle = (email: NormalizedEmail) => email.subject ?? "(no subject)";

/**
 * Writes a normalized email the way the parse stage reads it: each attachment as its own object,
 * then the StoredEmail (`email.json`) pointing at them.
 */
export async function writeStoredEmail(
  storage: Storage,
  keys: { email: string; attachment: (index: number) => string },
  email: NormalizedEmail,
): Promise<{ attachments: StoredEmail["attachments"]; json: Uint8Array }> {
  const attachments = await Promise.all(
    email.attachments.map(async (att, index) => {
      const storageKey = keys.attachment(index);
      await storage.put(storageKey, att.content, att.mime);
      return { index, filename: att.filename, mime: att.mime, size: att.size, contentId: att.contentId, storageKey };
    }),
  );
  const stored: StoredEmail = {
    version: 1,
    messageId: email.messageId,
    subject: email.subject,
    from: email.from,
    date: email.date,
    text: email.text,
    attachments,
  };
  const json = new TextEncoder().encode(JSON.stringify(stored));
  await storage.put(keys.email, json, EMAIL_SOURCE_MIME);
  return { attachments, json };
}

/**
 * Ingests an email for a tenant: each attachment becomes its own object, the normalized email is
 * stored as the document's source (`email.json`), and the original (Postmark payload or .eml) is
 * kept beside it as the source of record. External id: Message-ID, else a hash of the original.
 */
export async function ingestEmail(
  deps: IngestDeps,
  tenantId: string,
  email: NormalizedEmail,
  input: { source: DocumentSource; postmark?: PostmarkInbound; eml?: Uint8Array },
): Promise<IngestResult> {
  const externalId = emailExternalId(email, input);
  const dup = await existing(deps, tenantId, input.source, externalId);
  if (dup) return dup;

  const keys = storageKeys.email(tenantId);
  const { attachments, json } = await writeStoredEmail(deps.storage, keys, email);
  if (input.postmark) {
    const record = {
      ...input.postmark,
      Attachments: (input.postmark.Attachments ?? []).map(({ Content: _content, ...rest }, i) => ({
        ...rest,
        StorageKey: keys.attachment(i),
      })),
    };
    await deps.storage.put(keys.postmark, new TextEncoder().encode(JSON.stringify(record)), "application/json");
  }
  if (input.eml) await deps.storage.put(keys.eml, input.eml, DOCUMENT_MIMES.eml);

  const sizeBytes = json.byteLength + attachments.reduce((sum, a) => sum + a.size, 0);
  return withTenantTx(deps.pool, tenantId, (tx) =>
    ingestDocument(tx, deps.boss, {
      source: input.source,
      externalId,
      sourceKey: keys.email,
      title: emailTitle(email),
      mime: EMAIL_SOURCE_MIME,
      sizeBytes,
    }),
  );
}

/** Postmark inbound webhook: routes by recipient address. Unknown recipients are ignored. */
export async function ingestPostmark(
  deps: IngestDeps,
  payload: PostmarkInbound,
): Promise<IngestResult | { ignored: "unknown_recipient" }> {
  const email = normalizePostmark(payload);
  const tenantId = await resolveEmailTenant(deps.pool, email.recipients);
  if (!tenantId) return { ignored: "unknown_recipient" };
  return ingestEmail(deps, tenantId, email, { source: "email", postmark: payload });
}

/**
 * Ingests a file (REST API, or a completed upload). An .eml is ingested as an email. Other files
 * are stored as-is under a server key; the external id is the content's SHA-256.
 */
export async function ingestFile(
  deps: IngestDeps,
  tenantId: string,
  file: { bytes: Uint8Array; filename: string | null; mime: string | null; source: DocumentSource; sourceKey?: string },
  limits: IngestLimits,
): Promise<IngestResult> {
  if (file.bytes.byteLength > limits.maxFileBytes) {
    throw new IngestRejected(413, `file exceeds ${Math.round(limits.maxFileBytes / 2 ** 20)} MB`);
  }
  if (file.bytes.byteLength === 0) throw new IngestRejected(400, "file is empty");
  if (isEml(file.filename, file.mime)) {
    const email = await normalizeEml(file.bytes);
    return ingestEmail(deps, tenantId, email, { source: file.source, eml: file.bytes });
  }
  const mime = file.mime?.split(";")[0]?.trim().toLowerCase() ?? null;
  if (!isOneOf(ACCEPTED_MIMES, mime)) throw new IngestRejected(415, `unsupported type ${file.mime ?? "(none)"}`);

  const externalId = fileExternalId(file.bytes);
  const dup = await existing(deps, tenantId, file.source, externalId);
  if (dup) return dup;
  const sourceKey = file.sourceKey ?? storageKeys.file(tenantId);
  if (!file.sourceKey) await deps.storage.put(sourceKey, file.bytes, mime);
  return withTenantTx(deps.pool, tenantId, (tx) =>
    ingestDocument(tx, deps.boss, {
      source: file.source,
      externalId,
      sourceKey,
      title: file.filename,
      mime,
      sizeBytes: file.bytes.byteLength,
    }),
  );
}

/** Upload URLs are valid this long; the upload row expires with them. */
export const UPLOAD_TTL_SECONDS = 15 * 60;

/** Step 1 of an upload: a server-issued key, an `uploads` row, and a presigned PUT. */
export async function createUpload(
  deps: IngestDeps,
  tenantId: string,
  input: { filename: string; size: number; mime: string; createdBy: string },
  limits: IngestLimits,
) {
  if (input.size <= 0) throw new IngestRejected(400, "file is empty");
  if (input.size > limits.maxFileBytes)
    throw new IngestRejected(413, `file exceeds ${Math.round(limits.maxFileBytes / 2 ** 20)} MB`);
  const mime = input.mime.toLowerCase();
  if (!isOneOf(ACCEPTED_MIMES, mime) && !isEml(input.filename, mime)) {
    throw new IngestRejected(415, `unsupported type ${input.mime}`);
  }
  const storageKey = storageKeys.upload(tenantId);
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000);
  const uploadId = await withTenantTx(deps.pool, tenantId, (tx) =>
    insertUpload(tx, {
      storageKey,
      filename: input.filename,
      expectedSize: input.size,
      expectedMime: mime,
      expiresAt,
      createdBy: input.createdBy,
    }),
  );
  const url = await deps.storage.presignPut(storageKey, mime, UPLOAD_TTL_SECONDS);
  return { uploadId, url, method: "PUT" as const, headers: { "content-type": mime }, expiresAt };
}

/**
 * Step 2: the upload must belong to the tenant (RLS: another tenant's id is simply not found), be
 * unexpired, and the stored object must match the declared size and type. Then the document is
 * created and the upload marked complete. Completing twice returns the same document.
 */
export async function completeUpload(
  deps: IngestDeps,
  tenantId: string,
  uploadId: string,
  limits: IngestLimits,
): Promise<IngestResult> {
  const upload = await withTenantTx(deps.pool, tenantId, (tx) => getUpload(tx, uploadId));
  if (!upload) throw new IngestRejected(404, "upload not found");
  if (!upload.completedAt && upload.expiresAt < new Date()) throw new IngestRejected(410, "upload expired");

  const head = await deps.storage.head(upload.storageKey);
  if (!head) throw new IngestRejected(409, "nothing has been uploaded yet");
  if (head.size !== upload.expectedSize) {
    throw new IngestRejected(422, `uploaded ${head.size} bytes, expected ${upload.expectedSize}`);
  }
  if (head.contentType?.toLowerCase() !== upload.expectedMime) {
    throw new IngestRejected(422, `uploaded type ${head.contentType}, expected ${upload.expectedMime}`);
  }

  const bytes = await deps.storage.get(upload.storageKey);
  const result = await ingestFile(
    deps,
    tenantId,
    { bytes, filename: upload.filename, mime: upload.expectedMime, source: "upload", sourceKey: upload.storageKey },
    limits,
  );
  await withTenantTx(deps.pool, tenantId, (tx) => markUploadCompleted(tx, uploadId));
  return result;
}

export { type EmailViewData, readEmailView, sanitizeEmailHtml } from "./email-view";
export * from "./eval-source";
