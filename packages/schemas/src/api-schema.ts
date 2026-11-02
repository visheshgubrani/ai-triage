import { isObject, schemaProperties } from "./json-schema";
import type { JsonSchema } from "./types";

// Structured outputs accept a subset of JSON Schema: every object closed, no numeric/string/array
// length constraints, no patterns, a fixed set of formats. The raw API can 400 on the rest, so the
// schema sent to Claude is reduced to that subset here, and Ajv enforces the full schema afterwards.

const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "$ref",
  "$defs",
  "description",
  "format",
]);

const FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/** Keywords that toApiSchema() may emit. Exported for the whitelist test. */
export const API_SCHEMA_KEYWORDS: ReadonlySet<string> = KEYWORDS;
export const API_SCHEMA_FORMATS: ReadonlySet<string> = FORMATS;

const NULL: JsonSchema = { type: "null" };
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, NULL] });

/**
 * Reduces a schema to what structured outputs accept. Optional properties become required and
 * nullable (the API needs every key listed in `required`); `x-*` annotations are dropped.
 */
export function toApiSchema(schema: JsonSchema): JsonSchema {
  return reduce(schema);
}

function reduce(node: unknown): JsonSchema {
  if (!isObject(node)) return {};
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (!KEYWORDS.has(key) || key === "additionalProperties") continue;
    if (key === "format" && !(typeof value === "string" && FORMATS.has(value))) continue;
    if (key === "properties" || key === "$defs") {
      out[key] = Object.fromEntries(Object.entries(isObject(value) ? value : {}).map(([k, v]) => [k, reduce(v)]));
    } else if (key === "items") {
      out[key] = reduce(value);
    } else if (key === "anyOf" || key === "allOf") {
      out[key] = Array.isArray(value) ? value.map(reduce) : [];
    } else {
      out[key] = value; // type, required, enum, const, $ref, description, format
    }
  }
  if (out.type === "object" || isObject(out.properties)) {
    const properties = isObject(out.properties) ? (out.properties as Record<string, JsonSchema>) : {};
    const required = new Set(Array.isArray(out.required) ? out.required : []);
    for (const [name, prop] of Object.entries(properties)) {
      if (!required.has(name)) properties[name] = nullable(prop);
    }
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

const EVIDENCE: JsonSchema = {
  type: "object",
  description: "Where the value appears in the document.",
  properties: {
    quote: { type: "string", description: "A short span copied verbatim from the document." },
    page: nullable({ type: "integer", description: "1-based PDF page of the quote; null for other sources." }),
  },
  required: ["quote", "page"],
  additionalProperties: false,
};

/**
 * The extract stage's output: every field as `{ value, evidence }` plus `uncertain_fields`. Built
 * from the full category schema; pass the result through toApiSchema() before sending it.
 */
export function extractOutputSchema(categorySchema: JsonSchema): JsonSchema {
  const fields = schemaProperties(categorySchema);
  const names = Object.keys(fields);
  return {
    type: "object",
    properties: {
      fields: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(fields).map(([name, prop]) => {
            const { description, ...valueSchema } = prop;
            return [
              name,
              {
                type: "object",
                ...(typeof description === "string" ? { description } : {}),
                properties: { value: nullable(valueSchema), evidence: nullable(EVIDENCE) },
                required: ["value", "evidence"],
              },
            ];
          }),
        ),
        required: names,
      },
      uncertain_fields: {
        type: "array",
        description: "Fields whose value is ambiguous, conflicting, partly illegible or inferred.",
        items: { type: "string", enum: names },
      },
    },
    required: ["fields", "uncertain_fields"],
  };
}

/** The classify stage's output. `categories` must already include `other`. */
export function classifyOutputSchema(categories: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      category: { type: "string", enum: [...categories] },
      self_confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Calibrated probability that the category is correct.",
      },
      rationale: { type: "string", description: "One or two sentences citing the decisive evidence." },
    },
    required: ["category", "self_confidence", "rationale"],
    additionalProperties: false,
  };
}
