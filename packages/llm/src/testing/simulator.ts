import { createHash } from "node:crypto";

// The simulator (docs/llm.md, "sim:" models): an OpenAI-compatible Chat Completions endpoint that
// answers any classify or extract request with schema-valid output built from the document text,
// so load tests, integration tests and custom categories run end to end with no model and no
// spend. Answers are deterministic for a request. Latency and faults (429 with Retry-After, 500,
// slow answers, malformed JSON, refusals) are knobs, set at start or during a run (POST /sim/config).
//
// Classify scores each offered category by how often its name and description words appear in
// the document. Extract fills each field from the text where it can (a labelled value, the first
// date, email or amount), quoting it verbatim so the evidence gate can verify it, and leaves the
// rest null. It's a plausible model, not a good one: numbers it produces measure the system.

export interface SimulatorOptions {
  /** Mean added latency per call. */
  latencyMs: number;
  /** Up to this much more or less, per call. */
  jitterMs: number;
  /** Fault rates, each 0..1. */
  rate429: number;
  rate500: number;
  /** Answers after `slowMs` (longer than a client's timeout tests timeouts). */
  rateSlow: number;
  slowMs: number;
  rateMalformed: number;
  rateRefusal: number;
  /** Retry-After on a 429, in seconds. */
  retryAfterSeconds: number;
}

export const DEFAULT_SIMULATOR_OPTIONS: SimulatorOptions = {
  latencyMs: 300,
  jitterMs: 200,
  rate429: 0,
  rate500: 0,
  rateSlow: 0,
  slowMs: 30_000,
  rateMalformed: 0,
  rateRefusal: 0,
  retryAfterSeconds: 5,
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface SimulatedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  delayMs: number;
}

const STOPWORDS = new Set(
  "about above after again their there these those which while where would could should other others things documents document customer".split(
    " ",
  ),
);

/** A deterministic 0..1 from a seed and a salt. */
function unit(seed: string, salt: string): number {
  const h = createHash("sha1").update(`${seed}:${salt}`).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

/** The document: every text part of the user message. */
function documentText(messages: unknown[]): string {
  const user = messages.find((m) => isObject(m) && m.role === "user") as Json | undefined;
  const content = user?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is Json => isObject(p) && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

function systemText(messages: unknown[]): string {
  const system = messages.find((m) => isObject(m) && m.role === "system") as Json | undefined;
  return typeof system?.content === "string" ? system.content : "";
}

const words = (text: string) => (text.toLowerCase().match(/[a-z][a-z]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));

/** Classify: the offered category whose name and description words the document uses most. */
function classify(schema: Json, system: string, text: string, seed: string): Json {
  const categoryProp = (schema.properties as Json).category as Json;
  const categories = (categoryProp.enum as string[]) ?? ["other"];
  const descriptions = new Map<string, string>();
  for (const line of system.split("\n")) {
    const m = /^- ([a-z][a-z0-9_]*): (.*)$/.exec(line.trim());
    if (m?.[1] && m[2]) descriptions.set(m[1], m[2]);
  }
  const haystack = text.toLowerCase();
  const scores = categories
    .filter((c) => c !== "other")
    .map((category) => {
      const terms = new Set([
        ...category.split("_").filter((w) => w.length > 3),
        ...words(descriptions.get(category) ?? ""),
      ]);
      let score = 0;
      for (const term of terms) {
        const hits = haystack.split(term).length - 1;
        // The name counts most; description words a little, capped so long descriptions don't win.
        score += Math.min(hits, 3) * (category.includes(term) ? 3 : 1);
      }
      return { category, score };
    })
    .sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
  const best = scores[0];
  const second = scores[1]?.score ?? 0;
  if (!best || best.score === 0) {
    return { category: "other", self_confidence: 0.85, rationale: "No category's terms appear in the document." };
  }
  const clear = best.score >= 2 * Math.max(second, 1);
  const jitter = unit(seed, "confidence");
  const confidence = Math.round((clear ? 0.9 + 0.09 * jitter : 0.55 + 0.25 * jitter) * 1000) / 1000;
  return {
    category: best.category,
    self_confidence: confidence,
    rationale: `The document uses the terms of ${best.category} most (simulated).`,
  };
}

/** The first non-null alternative of a nullable schema. */
function nonNull(schema: Json): Json {
  if (Array.isArray(schema.anyOf)) {
    const option = (schema.anyOf as Json[]).find((s) => s.type !== "null");
    return option ? nonNull(option) : { type: "null" };
  }
  if (Array.isArray(schema.type)) {
    const type = (schema.type as string[]).find((t) => t !== "null") ?? "null";
    return { ...schema, type };
  }
  return schema;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const ISO_DATE = /\b(20\d\d)-([01]\d)-([0-3]\d)\b/;
const WRITTEN_DATE = new RegExp(
  `\\b(?:(${MONTHS.join("|")}) (\\d{1,2}), (20\\d\\d)|(\\d{1,2}) (${MONTHS.join("|")}) (20\\d\\d))\\b`,
  "i",
);
const EMAIL = /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/;
const AMOUNT = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/;
const CURRENCY = /\b(USD|EUR|GBP|CHF|JPY|CAD|AUD)\b/;

/** A value and the exact text it was read from (the evidence quote), or null. */
type Found = { value: unknown; quote: string | null } | null;

/** The first date in `text`, as YYYY-MM-DD, quoting it as written. */
function findDate(text: string): Found {
  const iso = ISO_DATE.exec(text);
  const written = WRITTEN_DATE.exec(text);
  const first = iso && (!written || iso.index <= written.index) ? iso : written;
  if (!first) return null;
  if (first === iso) return { value: iso[0], quote: iso[0] };
  const [, m1, d1, y1, d2, m2, y2] = first;
  const month = MONTHS.indexOf((m1 ?? m2 ?? "").toLowerCase()) + 1;
  const day = Number(d1 ?? d2);
  return { value: `${y1 ?? y2}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, quote: first[0] };
}

/** An amount such as "1,240.00" as a number, quoting it as written. */
function findAmount(text: string): Found {
  const m = AMOUNT.exec(text);
  if (!m) return null;
  const value = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(value) ? { value, quote: m[0] } : null;
}

/**
 * What follows the field's label, such as "Invoice number: INV-1001", "Invoice No. INV-1001",
 * "Total due: 1,240.00 EUR" or "Tax (20%): 20.00". Up to the end of the line.
 */
function labelled(field: string, text: string): string | null {
  const words = field.split("_");
  const last = words.at(-1);
  const variants = [words.join("[ _-]?")];
  if (last === "number") variants.push(`${words.slice(0, -1).join("[ _-]?")}[ _-]?(?:no\\.?|nr\\.?|#)`);
  for (const label of variants) {
    const m = new RegExp(`\\b${label}\\b[^:#\\n]{0,20}?[:#]\\s*([^\\n]{1,80})`, "i").exec(text);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** The first heading line ("# Northwind Supplies"), the usual place of a document's issuer. */
function heading(text: string): string | null {
  for (const line of text.split("\n")) {
    const m = /^#\s+(.+)$/.exec(line.trim());
    if (m?.[1] && !/^(invoice|rechnung|facture|factura|receipt)$/i.test(m[1].trim())) return m[1].trim();
  }
  return null;
}

function generate(schema: Json, field: string, text: string, seed: string): Found {
  const s = nonNull(schema);
  const raw = labelled(field, text);
  if (Array.isArray(s.enum)) {
    const values = s.enum as unknown[];
    const hit = values.find(
      (v) => typeof v === "string" && text.toLowerCase().includes(v.toLowerCase().replace(/_/g, " ")),
    );
    return { value: hit ?? values[0] ?? null, quote: null };
  }
  switch (s.type) {
    case "string": {
      if (s.format === "date" || /date|_on$/.test(field))
        return findDate(raw ?? (raw === null && field.endsWith("date") ? "" : text));
      if (s.format === "email" || /email/.test(field)) {
        const m = EMAIL.exec(raw ?? text);
        return m ? { value: m[0], quote: m[0] } : null;
      }
      if (field === "currency") {
        const m = CURRENCY.exec(raw ?? text);
        return m?.[1] ? { value: m[1], quote: m[1] } : null;
      }
      if (raw) return { value: raw, quote: raw };
      if (field.endsWith("_name")) {
        const h = heading(text);
        return h ? { value: h, quote: h } : null;
      }
      return null;
    }
    case "number":
    case "integer": {
      if (!raw && !/total|amount|price/.test(field)) return null;
      const found = findAmount(raw ?? text);
      if (!found) return null;
      return s.type === "integer" ? { value: Math.round(found.value as number), quote: found.quote } : found;
    }
    case "boolean":
      return { value: false, quote: null };
    case "array": {
      // A list of objects (line items) is left empty: half-filled rows would fail validation.
      const items = isObject(s.items) ? (s.items as Json) : { type: "string" };
      if (nonNull(items).type === "object") return { value: [], quote: null };
      const item = generate(items, field, text, seed);
      return { value: item ? [item.value] : [], quote: null };
    }
    case "object": {
      const props = isObject(s.properties) ? (s.properties as Record<string, Json>) : {};
      return {
        value: Object.fromEntries(
          Object.entries(props).map(([k, v]) => [k, generate(v, k, text, seed)?.value ?? null]),
        ),
        quote: null,
      };
    }
    default:
      return null;
  }
}

/** Extract: every field as { value, evidence }, quoting the value where it appears verbatim. */
function extract(schema: Json, text: string, seed: string): Json {
  const fieldsSchema = (schema.properties as Json).fields as Json;
  const props = (fieldsSchema.properties as Record<string, Json>) ?? {};
  const fields: Json = {};
  const uncertain: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const valueSchema = ((prop.properties as Json)?.value ?? {}) as Json;
    const found = generate(valueSchema, name, text, seed);
    const value = found?.value ?? null;
    const evidence = found?.quote && text.includes(found.quote) ? { quote: found.quote, page: null } : null;
    fields[name] = { value, evidence };
    if (value !== null && unit(seed, `uncertain:${name}`) < 0.05) uncertain.push(name);
  }
  return { fields, uncertain_fields: uncertain };
}

/** Answers one Chat Completions request body (POST /v1/chat/completions). */
export function simulate(body: unknown, options: SimulatorOptions, random = Math.random): SimulatedResponse {
  const req = isObject(body) ? body : {};
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const seed = createHash("sha1").update(JSON.stringify(messages)).digest("hex");
  const delayMs = Math.max(0, Math.round(options.latencyMs + (random() * 2 - 1) * options.jitterMs));
  const roll = random();
  let edge = options.rate429;
  if (roll < edge) {
    return {
      status: 429,
      headers: { "retry-after": String(options.retryAfterSeconds) },
      body: { error: { message: "Rate limit reached (simulated)", type: "rate_limit_error" } },
      delayMs: Math.min(delayMs, 50),
    };
  }
  edge += options.rate500;
  if (roll < edge) {
    return { status: 500, headers: {}, body: { error: { message: "Internal error (simulated)" } }, delayMs };
  }
  edge += options.rateSlow;
  const slow = roll < edge;

  const format = isObject(req.response_format) ? req.response_format : {};
  const schema = isObject(format.json_schema) && isObject(format.json_schema.schema) ? format.json_schema.schema : {};
  const text = documentText(messages);
  const isClassify = isObject(schema.properties) && "category" in schema.properties;
  const output = isClassify ? classify(schema, systemText(messages), text, seed) : extract(schema, text, seed);
  const r2 = random();
  const malformed = r2 < options.rateMalformed;
  const refused = !malformed && r2 < options.rateMalformed + options.rateRefusal;
  const content = refused ? null : malformed ? `${JSON.stringify(output).slice(0, 20)}` : JSON.stringify(output);
  const promptTokens = Math.ceil((systemText(messages).length + text.length) / 4);
  const completionTokens = Math.ceil((content?.length ?? 0) / 4);
  return {
    status: 200,
    headers: {},
    delayMs: slow ? options.slowMs : delayMs,
    body: {
      id: `chatcmpl-sim-${seed.slice(0, 12)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: typeof req.model === "string" ? req.model : "simulated",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content, refusal: refused ? "I can't help with that (simulated)." : null },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
  };
}
