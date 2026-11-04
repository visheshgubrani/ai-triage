// A small MIME writer for the variety generator: headers, multiparts, and bodies in the encodings
// and charsets real mail uses. It writes what senders send, quirks included; it's not a validator.

export type Charset = "utf-8" | "iso-8859-1" | "windows-1252" | "shift_jis";
export type TransferEncoding = "7bit" | "8bit" | "quoted-printable" | "base64";

export interface Leaf {
  contentType: string;
  /** Raw bytes, or text encoded as `charset`. */
  body: Uint8Array | string;
  charset?: Charset;
  encoding?: TransferEncoding;
  disposition?: string;
  contentId?: string;
  extraHeaders?: string[];
}

export interface Multi {
  multipart: "mixed" | "alternative" | "related" | `report; report-type=${string}`;
  parts: MimePart[];
}

export type MimePart = Leaf | Multi;

/** Shift_JIS for "請求書をお送りします" (Node can decode Shift_JIS but not encode it). */
export const SHIFT_JIS_INVOICE = Uint8Array.from([
  0x90, 0xbf, 0x8b, 0x81, 0x8f, 0x91, 0x82, 0xf0, 0x82, 0xa8, 0x91, 0x97, 0x82, 0xe8, 0x82, 0xb5, 0x82, 0xdc, 0x82,
  0xb7,
]);

function encodeText(text: string, charset: Charset): Uint8Array {
  // Latin-1 covers both single-byte charsets for the generator's text.
  return charset === "utf-8" ? new TextEncoder().encode(text) : Uint8Array.from(Buffer.from(text, "latin1"));
}

function quotedPrintable(bytes: Uint8Array): string {
  let out = "";
  let line = "";
  for (const b of bytes) {
    const ch =
      b === 0x0a
        ? "\n"
        : b >= 33 && b <= 126 && b !== 61
          ? String.fromCharCode(b)
          : b === 32
            ? " "
            : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    if (ch === "\n") {
      out += `${line}\r\n`;
      line = "";
      continue;
    }
    if (line.length + ch.length > 75) {
      out += `${line}=\r\n`;
      line = "";
    }
    line += ch;
  }
  return out + line;
}

const base64 = (bytes: Uint8Array) =>
  (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");

let boundaryCount = 0;

function renderPart(part: MimePart): string {
  if ("multipart" in part) {
    const boundary = `=_variety_${(boundaryCount++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const body = part.parts.map((p) => `--${boundary}\r\n${renderPart(p)}`).join("\r\n");
    return `Content-Type: multipart/${part.multipart}; boundary="${boundary}"\r\n\r\n${body}\r\n--${boundary}--\r\n`;
  }
  const charset = part.charset ?? "utf-8";
  const bytes = typeof part.body === "string" ? encodeText(part.body, charset) : part.body;
  const encoding = part.encoding ?? (typeof part.body === "string" ? "quoted-printable" : "base64");
  const type = part.contentType.startsWith("text/") ? `${part.contentType}; charset=${charset}` : part.contentType;
  const headers = [
    `Content-Type: ${type}`,
    `Content-Transfer-Encoding: ${encoding}`,
    ...(part.disposition ? [`Content-Disposition: ${part.disposition}`] : []),
    ...(part.contentId ? [`Content-ID: <${part.contentId}>`] : []),
    ...(part.extraHeaders ?? []),
  ];
  const body =
    encoding === "base64"
      ? base64(bytes)
      : encoding === "quoted-printable"
        ? quotedPrintable(bytes)
        : new TextDecoder("latin1").decode(bytes).replace(/\r?\n/g, "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

/** A whole message: top-level headers (one string each, folding included) and its body part. */
export function renderMessage(headers: string[], body: MimePart): Uint8Array {
  const rendered = renderPart(body);
  return Uint8Array.from(Buffer.from(`${headers.join("\r\n")}\r\nMIME-Version: 1.0\r\n${rendered}`, "latin1"));
}

/** A UTF-8 header value as an RFC 2047 encoded word when it isn't plain ASCII. */
export function encodedWord(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?utf-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
