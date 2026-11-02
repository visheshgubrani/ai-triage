import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { DOCUMENT_MIMES, type PartKind } from "../../index";
import { PipelineError } from "../errors";
import type { ParsedPart } from "../types";
import { renderEmailBody, type StoredAttachment, type StoredEmail } from "./email";
import { looksLikeText, sniffMime } from "./mime";

export interface ParseLimits {
  maxPdfPages: number;
}

/** A PDF averaging fewer non-whitespace characters per page than this has no usable text layer (a scan). */
export const MIN_PDF_PAGE_CHARS = 40;
/** Images below this size in an email are almost always logos or tracking pixels. */
export const MIN_EMAIL_IMAGE_BYTES = 20 * 1024;

type Part = Omit<ParsedPart, "partIndex">;

interface Binary {
  kind: PartKind;
  label: string | null;
  bytes: Uint8Array;
  declaredMime: string | null;
  storageKey: string;
}

const nonWhitespace = (text: string) => text.replace(/\s/g, "").length;

/** Parses one binary into parts, or returns null if its type isn't supported. */
async function parseBinary(file: Binary, limits: ParseLimits): Promise<Part[] | null> {
  const mime =
    sniffMime(file.bytes) ??
    (file.declaredMime?.startsWith("text/plain") && looksLikeText(file.bytes) ? DOCUMENT_MIMES.text : null);
  const base = { kind: file.kind, mime: mime ?? "", label: file.label, storageKey: file.storageKey };
  try {
    switch (mime) {
      case DOCUMENT_MIMES.pdf: {
        const pdf = await getDocumentProxy(new Uint8Array(file.bytes));
        if (pdf.numPages > limits.maxPdfPages) {
          throw new PipelineError(
            "too_many_pages",
            `${file.label ?? "PDF"} has ${pdf.numPages} pages (limit ${limits.maxPdfPages})`,
          );
        }
        const { text } = await extractText(pdf, { mergePages: false });
        // Judged per PDF, not per page: a short last page doesn't make a text PDF a scan, and a
        // value read from an image-only page still fails the evidence check (its quote isn't there).
        const chars = text.reduce((sum, page) => sum + nonWhitespace(page), 0);
        const evidenceMode = chars >= MIN_PDF_PAGE_CHARS * text.length ? "pdf_text" : "unverifiable";
        return text.map((pageText, i) => ({ ...base, page: i + 1, text: pageText, evidenceMode }));
      }
      case DOCUMENT_MIMES.docx: {
        const { value } = await mammoth.extractRawText({ buffer: Buffer.from(file.bytes) });
        return [{ ...base, page: null, text: value.trim(), evidenceMode: "text" }];
      }
      case DOCUMENT_MIMES.png:
      case DOCUMENT_MIMES.jpeg:
        return [{ ...base, page: null, text: "", evidenceMode: "unverifiable" }];
      case DOCUMENT_MIMES.text:
        return [{ ...base, page: null, text: new TextDecoder().decode(file.bytes).trim(), evidenceMode: "text" }];
      default:
        return null;
    }
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError("parse_error", `could not parse ${file.label ?? "file"}: ${(err as Error).message}`);
  }
}

/** Numbers the parts; drops NUL characters, which some PDFs contain and Postgres text can't store. */
const numbered = (parts: Part[]): ParsedPart[] =>
  parts.map((p, partIndex) => ({ ...p, text: p.text.replaceAll("\u0000", ""), partIndex }));

/** Parses an uploaded or API file. An unsupported type fails the run. */
export async function parseFile(
  file: { label: string | null; bytes: Uint8Array; declaredMime: string | null; storageKey: string },
  limits: ParseLimits,
): Promise<ParsedPart[]> {
  const parts = await parseBinary({ ...file, kind: "file" }, limits);
  if (!parts) throw new PipelineError("unsupported_file", `unsupported file type (${file.declaredMime ?? "unknown"})`);
  return numbered(parts);
}

/** Inline images (cid:) and small images are signatures and logos, not content. */
export function isContentAttachment(att: Pick<StoredAttachment, "mime" | "contentId" | "size">): boolean {
  if (!att.mime.startsWith("image/")) return true;
  return att.contentId === null && att.size >= MIN_EMAIL_IMAGE_BYTES;
}

/**
 * Parses a stored email: part 0 is the rendered body, followed by each content attachment
 * (unsupported types are skipped). `attachments` holds the bytes of every content attachment.
 */
export async function parseEmail(
  email: StoredEmail,
  attachments: ReadonlyMap<string, Uint8Array>,
  limits: ParseLimits,
): Promise<ParsedPart[]> {
  const parts: Part[] = [
    {
      kind: "email_body",
      mime: DOCUMENT_MIMES.text,
      label: null,
      page: null,
      text: renderEmailBody(email),
      evidenceMode: "text",
      storageKey: null,
    },
  ];
  for (const att of email.attachments.filter(isContentAttachment)) {
    const bytes = attachments.get(att.storageKey);
    if (!bytes) throw new PipelineError("parse_error", `attachment ${att.filename} is missing from storage`);
    const parsed = await parseBinary(
      { kind: "attachment", label: att.filename, bytes, declaredMime: att.mime, storageKey: att.storageKey },
      limits,
    );
    if (parsed) parts.push(...parsed);
  }
  return numbered(parts);
}
