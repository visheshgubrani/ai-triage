import { type Comparator, getTemplate, type JsonSchema, schemaProperties } from "@ai-triage/schemas";

// Typed field comparators (docs/architecture.md §8). A missing expected key means the document
// doesn't state the field, so the right answer is null: null vs null is correct, null vs a value is
// wrong either way round.

/** Amounts within a cent count as equal. */
export const AMOUNT_TOLERANCE = 0.01;

export interface FieldComparison {
  /** 0..1; partial credit only for `set_f1`. */
  score: number;
  correct: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Case, accents' compatibility forms, punctuation and spacing don't matter. */
export const normalizeText = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** JSON with sorted keys, so equal values compare equal whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** `YYYY-MM-DD` (an ISO datetime contributes its date), if it's a real calendar date. */
export function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return date.getUTCMonth() === Number(mo) - 1 && date.getUTCDate() === Number(d) ? `${y}-${mo}-${d}` : null;
}

/** A number, or a numeric string with currency symbols and thousands separators (dot decimals). */
export function toAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^\d.-]/g, "");
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
}

const amountsEqual = (a: number, b: number) => Math.abs(a - b) <= AMOUNT_TOLERANCE + 1e-9;

/** One stated value inside a set element: strings normalized, numbers as amounts, the rest exact. */
function valueMatches(expected: unknown, predicted: unknown): boolean {
  if (typeof expected === "number") {
    const amount = toAmount(predicted);
    return amount !== null && amountsEqual(amount, expected);
  }
  if (typeof expected === "string")
    return typeof predicted === "string" && normalizeText(expected) === normalizeText(predicted);
  return canonicalJson(expected) === canonicalJson(predicted);
}

/** A set element matches when every key the label states matches (extra predicted keys are ignored). */
function elementMatches(expected: unknown, predicted: unknown): boolean {
  if (!isRecord(expected)) return valueMatches(expected, predicted);
  if (!isRecord(predicted)) return false;
  return Object.entries(expected).every(([key, value]) => isEmpty(value) || valueMatches(value, predicted[key]));
}

/** F1 of a greedy one-to-one matching, in label order. */
export function setF1(expected: readonly unknown[], predicted: readonly unknown[]): number {
  if (expected.length + predicted.length === 0) return 1;
  const used = new Set<number>();
  let matched = 0;
  for (const e of expected) {
    const index = predicted.findIndex((p, j) => !used.has(j) && elementMatches(e, p));
    if (index >= 0) {
      used.add(index);
      matched++;
    }
  }
  return (2 * matched) / (expected.length + predicted.length);
}

const verdict = (correct: boolean): FieldComparison => ({ score: correct ? 1 : 0, correct });
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

export function compareField(comparator: Comparator, expected: unknown, predicted: unknown): FieldComparison {
  const expectedEmpty = isEmpty(expected);
  const predictedEmpty = isEmpty(predicted);
  if (expectedEmpty || predictedEmpty) return verdict(expectedEmpty && predictedEmpty);
  switch (comparator) {
    case "free_text":
      return verdict(true);
    case "exact":
      return verdict(canonicalJson(expected) === canonicalJson(predicted));
    case "normalized":
      return verdict(
        typeof expected === "string" && typeof predicted === "string"
          ? normalizeText(expected) === normalizeText(predicted)
          : canonicalJson(expected) === canonicalJson(predicted),
      );
    case "date": {
      const e = toIsoDate(expected);
      return verdict(e !== null && e === toIsoDate(predicted));
    }
    case "amount": {
      const e = toAmount(expected);
      const p = toAmount(predicted);
      return verdict(e !== null && p !== null && amountsEqual(e, p));
    }
    case "set_f1": {
      const score = setF1(asArray(expected), asArray(predicted));
      return { score, correct: score === 1 };
    }
  }
}

/** A comparator from a field's JSON Schema type, for categories without a template. */
function deriveComparator(prop: JsonSchema): Comparator {
  if (prop.type === "array") return "set_f1";
  if (prop.type === "number" || prop.type === "integer") return "amount";
  if (prop.type === "string") return prop.format === "date" ? "date" : "normalized";
  return "exact";
}

/** The comparator for each field of a schema version: the built-in template's, else derived from types. */
export function comparatorsFor(
  category: string,
  schemaVersion: { version: number; jsonSchema: JsonSchema },
): Record<string, Comparator> {
  const template = getTemplate(category, schemaVersion.version);
  return Object.fromEntries(
    Object.entries(schemaProperties(schemaVersion.jsonSchema)).map(([field, prop]) => [
      field,
      template?.comparators[field] ?? deriveComparator(prop),
    ]),
  );
}
