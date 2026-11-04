import { DOCUMENT_MIMES, type Effort, EMAIL_SOURCE_MIME, type LlmStage, type ModelRef } from "@ai-triage/core";
import {
  applyOcr,
  type CategoryOption,
  type EmailSender,
  isContentAttachment,
  type MailSignals,
  needsOcr,
  type OcrConfig,
  type ParsedPart,
  type ParseLimits,
  parseEmail,
  parseFile,
  pdfPageImages,
  recognizeText,
  type StoredEmail,
} from "@ai-triage/core/pipeline";
import { loadSchemaVersions, type PipelineConfig, stagePolicy, type TenantTx } from "@ai-triage/db";
import { type JsonSchema, schemaDescription } from "@ai-triage/schemas";
import type { Storage } from "@ai-triage/storage";
import { log, recordOcrPage } from "../observe";
import { pageImagesInSandbox, parseInSandbox, type SandboxOptions } from "../parse/sandbox";

// What a model request is built from, shared by the pipeline stages and the eval runner, so an eval
// of a document sends exactly the bytes production would (and replays from the same cassettes).

/** Where a document's (or an eval item's) source lives: `documents.source_key`, `mime`, `title`. */
export interface SourceRef {
  sourceKey: string;
  mime: string | null;
  /** The file name for files: it labels the parts and goes on the wire as a PDF's title. */
  title: string | null;
}

/**
 * Parse limits, plus the sandbox the worker parses in (tests without one parse inline), and the
 * optional OCR (OCR_URL) with the fetch it uses.
 */
export type SourceParseLimits = ParseLimits & {
  sandbox?: SandboxOptions;
  ocr?: (OcrConfig & { fetch?: typeof fetch }) | null;
};

/**
 * Parses a stored source: the normalized email and its attachments, or the file. With OCR on,
 * scans and photos then get their text (`ocr_text`); a page OCR can't read stays unverifiable.
 */
export async function parseSource(
  storage: Storage,
  source: SourceRef,
  { ocr, ...limits }: SourceParseLimits,
): Promise<ParsedPart[]> {
  const parts = await parseOnly(storage, source, limits);
  if (!ocr || !parts.some(needsOcr)) return parts;
  const blobs = await loadBlobs(storage, parts.filter(needsOcr));
  const started = performance.now();
  const outcome = await applyOcr(ocr, parts, blobs, {
    pageImages: (bytes, pages) =>
      limits.sandbox ? pageImagesInSandbox({ bytes, pages: [...pages] }, limits.sandbox) : pdfPageImages(bytes, pages),
    recognize: async (image) => {
      const t = performance.now();
      try {
        const text = await recognizeText(ocr, image, { fetch: ocr.fetch });
        recordOcrPage(true, performance.now() - t);
        return text;
      } catch (err) {
        recordOcrPage(false, performance.now() - t);
        throw err;
      }
    },
  });
  const fields = { source: source.sourceKey, pages: outcome.read, ms: Math.round(performance.now() - started) };
  if (outcome.failed.length > 0) log.warn("OCR left pages unread", { ...fields, failed: outcome.failed });
  else log.info("OCR read the document", fields);
  return outcome.parts;
}

async function parseOnly(
  storage: Storage,
  source: SourceRef,
  { sandbox, ...limits }: Omit<SourceParseLimits, "ocr">,
): Promise<ParsedPart[]> {
  if (source.mime === EMAIL_SOURCE_MIME) {
    const email = JSON.parse(new TextDecoder().decode(await storage.get(source.sourceKey))) as StoredEmail;
    const attachments = email.attachments.filter(isContentAttachment);
    const blobs = new Map(
      await Promise.all(attachments.map(async (a) => [a.storageKey, await storage.get(a.storageKey)] as const)),
    );
    if (sandbox) return parseInSandbox({ kind: "email", email, blobs, limits }, sandbox);
    return parseEmail(email, blobs, limits);
  }
  const bytes = await storage.get(source.sourceKey);
  const file = { label: source.title, bytes, declaredMime: source.mime, storageKey: source.sourceKey };
  if (sandbox) return parseInSandbox({ kind: "file", file, limits }, sandbox);
  return parseFile(file, limits);
}

/**
 * What the sender gate checks: an email source's Authentication-Results headers (none for emails
 * stored before they were recorded), or null for a file. Read from the source, like the parts, so
 * production and evals see the same thing.
 */
export async function loadSender(storage: Storage, source: SourceRef): Promise<EmailSender | null> {
  if (source.mime !== EMAIL_SOURCE_MIME) return null;
  const email = JSON.parse(new TextDecoder().decode(await storage.get(source.sourceKey))) as StoredEmail;
  return { authResults: email.authResults ?? [], ...(email.receivedBy ? { receivedBy: email.receivedBy } : {}) };
}

/** What the intake filters read: an email source's header signals (none for files). */
export async function loadSignals(storage: Storage, source: SourceRef): Promise<MailSignals | undefined> {
  if (source.mime !== EMAIL_SOURCE_MIME) return undefined;
  const email = JSON.parse(new TextDecoder().decode(await storage.get(source.sourceKey))) as StoredEmail;
  return email.signals;
}

const BINARY = new Set<string>([DOCUMENT_MIMES.pdf, DOCUMENT_MIMES.png, DOCUMENT_MIMES.jpeg]);

/** The PDFs and images among the parts, which are sent to the model as they are (if it reads them). */
export async function loadBlobs(
  storage: Storage,
  parts: readonly Pick<ParsedPart, "storageKey" | "mime">[],
): Promise<Map<string, Uint8Array>> {
  const keys = new Set(parts.flatMap((p) => (p.storageKey && BINARY.has(p.mime) ? [p.storageKey] : [])));
  return new Map(await Promise.all([...keys].map(async (key) => [key, await storage.get(key)] as const)));
}

/** Model, effort and output budget of a stage under a config. */
export function stageModel(config: PipelineConfig, stage: LlmStage) {
  const policy = stagePolicy(config.policy);
  return stage === "classify"
    ? {
        model: config.classifyModel as ModelRef,
        effort: config.classifyEffort as Effort,
        maxTokens: policy.classifyMaxTokens,
      }
    : {
        model: config.extractModel as ModelRef,
        effort: config.extractEffort as Effort,
        maxTokens: policy.extractMaxTokens,
      };
}

/** The config's categories as the classifier sees them: name and the schema version's description. */
export async function loadCategoryOptions(tx: TenantTx, config: PipelineConfig): Promise<CategoryOption[]> {
  const versions = await loadSchemaVersions(
    tx,
    config.categories.map((c) => c.schemaVersionId),
  );
  return config.categories.map((c) => {
    const version = versions.find((v) => v.id === c.schemaVersionId);
    const examples = (version?.definition as { examples?: string[] } | null)?.examples;
    return {
      name: c.category,
      description: schemaDescription((version?.jsonSchema ?? {}) as JsonSchema),
      ...(examples?.length ? { examples } : {}),
    };
  });
}
