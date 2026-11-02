import type { EvidenceMode } from "../index";
import type { EvidenceQuote } from "./outputs";

// The evidence gate (docs/architecture.md §6): a quote must appear in the source after
// normalization. `text` parts are searched for quotes without a page; `pdf_text` quotes must be on
// the cited page; any `unverifiable` part (a scan or image) sends the document to review. A match
// proves the quote exists, not that it supports the value.

export interface EvidencePart {
  partIndex: number;
  page: number | null;
  text: string;
  evidenceMode: EvidenceMode;
}

export type EvidenceCheck =
  | { field: string; status: "verified"; partIndex: number; page: number | null; start: number; end: number }
  | { field: string; status: "missing" }
  | { field: string; status: "not_found"; quote: string; page: number | null };

export interface EvidenceResult {
  /** True when any part is a scan or image: the document can't be fully verified. */
  unverifiable: boolean;
  checks: EvidenceCheck[];
}

const SINGLE_QUOTES = /[‘’‚‛′´`]/;
const DOUBLE_QUOTES = /[“”„‟″]/;
const DASHES = /[‐-―−﹘﹣－]/;
const INVISIBLE = /[­​-‍⁠﻿]/;

export interface NormalizedText {
  text: string;
  /** For each normalized character, the [start, end) range of the original it came from. */
  starts: number[];
  ends: number[];
}

/**
 * NFKC, lowercase, typographic quotes and dashes unified, invisible characters dropped, and runs of
 * whitespace collapsed to one space. Keeps a map back to original offsets for highlighting.
 */
export function normalizeForMatch(original: string): NormalizedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of original) {
    const start = i;
    i += ch.length;
    if (INVISIBLE.test(ch)) continue;
    for (let c of ch.normalize("NFKC").toLowerCase()) {
      if (/\s/.test(c)) {
        if (text.length === 0 || text.endsWith(" ")) continue;
        c = " ";
      } else if (SINGLE_QUOTES.test(c)) c = "'";
      else if (DOUBLE_QUOTES.test(c)) c = '"';
      else if (DASHES.test(c)) c = "-";
      text += c;
      starts.push(start);
      ends.push(i);
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text, starts, ends };
}

/** Finds `quote` in one of `parts`; returns the original offsets of the first match. */
function find(quote: string, parts: readonly EvidencePart[]) {
  const needle = normalizeForMatch(quote).text;
  if (!needle) return null;
  for (const part of parts) {
    const hay = normalizeForMatch(part.text);
    const at = hay.text.indexOf(needle);
    if (at >= 0) {
      return {
        partIndex: part.partIndex,
        page: part.page,
        start: hay.starts[at] ?? 0,
        end: hay.ends[at + needle.length - 1] ?? 0,
      };
    }
  }
  return null;
}

/**
 * Checks the quote of each field in `fields` (those that need evidence and have a value). A quote
 * citing a page is searched on that PDF page only; one without a page, in the text parts.
 */
export function verifyEvidence(
  parts: readonly EvidencePart[],
  evidence: Readonly<Record<string, EvidenceQuote | null>>,
  fields: readonly string[],
): EvidenceResult {
  const textParts = parts.filter((p) => p.evidenceMode === "text");
  const pdfParts = parts.filter((p) => p.evidenceMode === "pdf_text");
  const checks = fields.map((field): EvidenceCheck => {
    const ev = evidence[field];
    if (!ev?.quote.trim()) return { field, status: "missing" };
    // A page only means something for PDFs; with no text PDF in the document, search the text parts.
    const candidates = ev.page !== null && pdfParts.length > 0 ? pdfParts.filter((p) => p.page === ev.page) : textParts;
    const hit = find(ev.quote, candidates);
    return hit ? { field, status: "verified", ...hit } : { field, status: "not_found", quote: ev.quote, page: ev.page };
  });
  return { unverifiable: parts.some((p) => p.evidenceMode === "unverifiable"), checks };
}
