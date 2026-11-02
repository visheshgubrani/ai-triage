import { DOCUMENT_MIMES, type DocumentMime } from "../../index";

const startsWith = (bytes: Uint8Array, ...sig: number[]) => sig.every((b, i) => bytes[i] === b);

/**
 * The mime type implied by a file's leading bytes, for the types the pipeline parses. DOCX is a ZIP,
 * so a ZIP whose first entry is `[Content_Types].xml` counts as DOCX. Returns null when unknown.
 */
export function sniffMime(bytes: Uint8Array): DocumentMime | null {
  if (startsWith(bytes, 0x25, 0x50, 0x44, 0x46, 0x2d)) return DOCUMENT_MIMES.pdf; // %PDF-
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return DOCUMENT_MIMES.png;
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return DOCUMENT_MIMES.jpeg;
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    return head.includes("[Content_Types].xml") || head.includes("word/") ? DOCUMENT_MIMES.docx : null;
  }
  return null;
}

/** Plain text if it decodes as UTF-8 and has no NUL bytes in its first 8 KB. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}
