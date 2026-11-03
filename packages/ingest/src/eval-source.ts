import { ACCEPTED_MIMES, EMAIL_SOURCE_MIME, isOneOf } from "@ai-triage/core";
import { type NormalizedEmail, normalizeEml, type PostmarkInbound, type StoredEmail } from "@ai-triage/core/pipeline";
import { type Storage, storageKeys } from "@ai-triage/storage";
import { emailExternalId, emailTitle, fileExternalId, IngestRejected, isEml, writeStoredEmail } from "./index";

// Eval item sources (docs/architecture.md §8). An eval item never creates a document (invariant 7),
// but its source is stored exactly as ingestion stores a document's: a normalized email with one
// object per attachment, or the file under its declared mime and file name. The eval runner then
// parses it with the parse stage's own code, so it sends the model the same request as production.

/** Where an eval item's snapshot lives, and the key that keeps the same content out of a dataset twice. */
export interface EvalSource {
  sourceKey: string;
  sourceMime: string;
  sourceTitle: string | null;
  /** Derived like `documents.external_id`: Message-ID, else a content hash. */
  contentKey: string;
}

export type EvalSourceInput =
  | { kind: "email"; email: NormalizedEmail; original: { postmark?: PostmarkInbound; eml?: Uint8Array } }
  | { kind: "file"; bytes: Uint8Array; filename: string | null; mime: string | null };

/** Stores a labeled example (a fixture, an imported file) as an eval item's source. */
export async function importEvalSource(
  storage: Storage,
  tenantId: string,
  input: EvalSourceInput,
): Promise<EvalSource> {
  const keys = storageKeys.evalSource(tenantId);
  if (input.kind === "file" && isEml(input.filename, input.mime)) {
    const email = await normalizeEml(input.bytes);
    return importEvalSource(storage, tenantId, { kind: "email", email, original: { eml: input.bytes } });
  }
  if (input.kind === "email") {
    await writeStoredEmail(storage, keys, input.email);
    return {
      sourceKey: keys.email,
      sourceMime: EMAIL_SOURCE_MIME,
      sourceTitle: emailTitle(input.email),
      contentKey: emailExternalId(input.email, input.original),
    };
  }
  const mime = input.mime?.split(";")[0]?.trim().toLowerCase() ?? null;
  if (!isOneOf(ACCEPTED_MIMES, mime)) throw new IngestRejected(415, `unsupported type ${input.mime ?? "(none)"}`);
  if (input.bytes.byteLength === 0) throw new IngestRejected(400, "file is empty");
  await storage.put(keys.file, input.bytes, mime);
  return {
    sourceKey: keys.file,
    sourceMime: mime,
    sourceTitle: input.filename,
    contentKey: fileExternalId(input.bytes),
  };
}

/** A document's stored source, as `documents` holds it. */
export interface DocumentSourceRef {
  sourceKey: string;
  mime: string | null;
  title: string | null;
  externalId: string;
}

/**
 * Copies a document's source into a new eval item snapshot ("Add to eval set"): the email and every
 * attachment under the snapshot's own keys, or the file. The copy is independent of the document.
 */
export async function snapshotDocumentSource(
  storage: Storage,
  tenantId: string,
  doc: DocumentSourceRef,
): Promise<EvalSource> {
  const keys = storageKeys.evalSource(tenantId);
  if (doc.mime === EMAIL_SOURCE_MIME) {
    const email = JSON.parse(new TextDecoder().decode(await storage.get(doc.sourceKey))) as StoredEmail;
    const attachments = await Promise.all(
      email.attachments.map(async (att) => {
        const storageKey = keys.attachment(att.index);
        await storage.put(storageKey, await storage.get(att.storageKey), att.mime);
        return { ...att, storageKey };
      }),
    );
    const copy: StoredEmail = { ...email, attachments };
    await storage.put(keys.email, new TextEncoder().encode(JSON.stringify(copy)), EMAIL_SOURCE_MIME);
    return { sourceKey: keys.email, sourceMime: EMAIL_SOURCE_MIME, sourceTitle: doc.title, contentKey: doc.externalId };
  }
  if (!doc.mime) throw new Error(`document source ${doc.sourceKey} has no mime`);
  await storage.put(keys.file, await storage.get(doc.sourceKey), doc.mime);
  return { sourceKey: keys.file, sourceMime: doc.mime, sourceTitle: doc.title, contentKey: doc.externalId };
}
