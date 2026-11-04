import { extractImages, getDocumentProxy } from "unpdf";
import { DOCUMENT_MIMES, OCR_BUDGET_MS } from "../index";
import type { ParsedPart } from "./types";

// Optional OCR (docs/install.md, "OCR"): text for parts that have none, so their evidence can be
// verified and a model that reads no images can still read them. PaddleOCR-VL 1.6 served by
// llama.cpp's server, which speaks OpenAI chat completions on every backend (CPU, Vulkan, CUDA);
// its `OCR:` task prompt returns the page's text in reading order. Off unless OCR_URL is set, and
// best effort: a part OCR can't read keeps today's behavior (unverifiable, sent as an image).

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The model's task prompt for plain text recognition (PaddleOCR-VL's model card). */
export const OCR_PROMPT = "OCR:";

export interface OcrConfig {
  /** OpenAI-compatible base URL, such as http://ocr:8080/v1. */
  url: string;
  timeoutMs: number;
  /** Pages of one document read at most; the rest stay unverifiable. */
  maxPages: number;
}

export interface OcrImage {
  mime: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

/** `url` without trailing slashes (a loop: a `/\/+$/` regex backtracks on long runs of them). */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

export class OcrError extends Error {
  override name = "OcrError";
}

/** One page image to text. Throws OcrError on a refusal, a timeout or an empty answer. */
export async function recognizeText(
  config: OcrConfig,
  image: OcrImage,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const signals = [AbortSignal.timeout(config.timeoutMs), ...(options.signal ? [options.signal] : [])];
  let res: Response;
  try {
    res = await doFetch(`${withoutTrailingSlashes(config.url)}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}` },
              },
              { type: "text", text: OCR_PROMPT },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 4096,
      }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    throw new OcrError(`OCR request failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new OcrError(`OCR answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new OcrError("OCR returned no text");
  return text.trim();
}

/**
 * The page images of a scanned PDF: on each page, the largest image painted on it (a scanner puts
 * one full-page image per page), as PNG. Pages with no image are left out.
 */
export async function pdfPageImages(bytes: Uint8Array, pages: readonly number[]): Promise<Map<number, OcrImage>> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out = new Map<number, OcrImage>();
  for (const page of pages) {
    if (page < 1 || page > pdf.numPages) continue;
    const images = await extractImages(pdf, page, { format: "png" });
    const largest = images.reduce<(typeof images)[number] | null>(
      (best, img) => (!best || img.width * img.height > best.width * best.height ? img : best),
      null,
    );
    if (largest) out.set(page, { mime: "image/png", bytes: largest.data });
  }
  return out;
}

/** Parts OCR can give text: images, and the pages of a scanned PDF (no usable text layer). */
export function needsOcr(part: Pick<ParsedPart, "mime" | "evidenceMode" | "storageKey">): boolean {
  if (part.evidenceMode !== "unverifiable" || !part.storageKey) return false;
  return [DOCUMENT_MIMES.pdf, DOCUMENT_MIMES.png, DOCUMENT_MIMES.jpeg].includes(part.mime as never);
}

export interface OcrOutcome {
  parts: ParsedPart[];
  /** Pages read, and pages that failed (left unverifiable). */
  read: number;
  failed: { partIndex: number; error: string }[];
}

/**
 * Reads the parts that have no text, one page at a time, and returns them with `ocr_text`.
 * `pageImages` gets a scanned PDF's page images (the worker runs it in the parse sandbox).
 */
export async function applyOcr(
  config: OcrConfig,
  parts: readonly ParsedPart[],
  blobs: ReadonlyMap<string, Uint8Array>,
  deps: {
    pageImages: (bytes: Uint8Array, pages: readonly number[]) => Promise<Map<number, OcrImage>>;
    recognize: (image: OcrImage) => Promise<string>;
    now?: () => number;
  },
): Promise<OcrOutcome> {
  const now = deps.now ?? Date.now;
  const deadline = now() + OCR_BUDGET_MS;
  const todo = parts.filter(needsOcr).slice(0, config.maxPages);
  const out = parts.map((p) => ({ ...p }));
  const failed: OcrOutcome["failed"] = [];
  let read = 0;

  // A PDF's pages come from one source; extract their images once.
  const pdfImages = new Map<string, Map<number, OcrImage>>();
  for (const key of new Set(todo.filter((p) => p.mime === DOCUMENT_MIMES.pdf).map((p) => p.storageKey as string))) {
    const bytes = blobs.get(key);
    const pages = todo.filter((p) => p.storageKey === key).map((p) => p.page ?? 1);
    try {
      pdfImages.set(key, bytes ? await deps.pageImages(bytes, pages) : new Map());
    } catch (err) {
      for (const p of todo.filter((t) => t.storageKey === key)) {
        failed.push({ partIndex: p.partIndex, error: `page images: ${(err as Error).message}` });
      }
      pdfImages.set(key, new Map());
    }
  }

  for (const part of todo) {
    if (now() >= deadline) {
      failed.push({ partIndex: part.partIndex, error: `OCR budget (${OCR_BUDGET_MS / 1000} s) used up` });
      continue;
    }
    const key = part.storageKey as string;
    const image: OcrImage | undefined =
      part.mime === DOCUMENT_MIMES.pdf
        ? pdfImages.get(key)?.get(part.page ?? 1)
        : blobs.has(key)
          ? { mime: part.mime as OcrImage["mime"], bytes: blobs.get(key) as Uint8Array }
          : undefined;
    if (!image) {
      if (!failed.some((f) => f.partIndex === part.partIndex)) {
        failed.push({ partIndex: part.partIndex, error: "no image on this page" });
      }
      continue;
    }
    try {
      const text = await deps.recognize(image);
      const target = out.find((p) => p.partIndex === part.partIndex);
      if (target) {
        // As the parsers store text: no NULs, no lone surrogates (Postgres would change them).
        target.text = text.replaceAll("\u0000", "").replace(LONE_SURROGATE, "\uFFFD");
        target.evidenceMode = "ocr_text";
      }
      read += 1;
    } catch (err) {
      failed.push({ partIndex: part.partIndex, error: (err as Error).message });
    }
  }
  return { parts: out, read, failed };
}
