import { DOCUMENT_MIMES, type DocumentMime } from "@ai-triage/core";

/** What clients send when they don't know a file's type (many HTTP libraries, scanners and relays). */
const GENERIC_MIMES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/unknown"]);

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) => prefix.every((b, i) => bytes[i] === b);

/**
 * The type of a file whose sender declared none (or only `application/octet-stream`): from its first
 * bytes, or for DOCX and text from its name plus a check of the content. A declared type is kept as it
 * is, so a mislabelled file is still refused. Returns null when the file is none of the accepted kinds.
 */
export function effectiveMime(declared: string | null, bytes: Uint8Array, filename: string | null): string | null {
  const mime = declared?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!GENERIC_MIMES.has(mime)) return mime;
  const name = filename?.toLowerCase() ?? "";
  let sniffed: DocumentMime | null = null;
  // %PDF-, the PNG signature, a JPEG SOI marker, a zip local header.
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) sniffed = DOCUMENT_MIMES.pdf;
  else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) sniffed = DOCUMENT_MIMES.png;
  else if (startsWith(bytes, [0xff, 0xd8, 0xff])) sniffed = DOCUMENT_MIMES.jpeg;
  else if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && name.endsWith(".docx")) sniffed = DOCUMENT_MIMES.docx;
  else if (name.endsWith(".txt") && isText(bytes)) sniffed = DOCUMENT_MIMES.text;
  return sniffed ?? (mime || null);
}

function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
