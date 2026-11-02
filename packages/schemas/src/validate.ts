import type { ValidateFunction } from "ajv";
import { createAjv } from "./ajv";
import type { FieldValues, JsonSchema } from "./types";

export interface ValidationIssue {
  /** Top-level field the issue is about, or "" for the document as a whole. */
  field: string;
  keyword: string;
  path: string;
  message: string;
}

const ajv = createAjv();
const compiled = new Map<string, ValidateFunction>();

/**
 * Validates extracted values against the full (stored) category schema. `key` identifies the schema
 * version, so each version is compiled once. Nulls are removed first: the model reports a missing
 * optional value as null, while the schema expresses it as an absent key. Missing required fields
 * are reported by the `required_missing` gate, so their `required` errors are left out here.
 */
export function validateFields(key: string, schema: JsonSchema, values: FieldValues): ValidationIssue[] {
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(key, validate);
  }
  if (validate(dropNulls(values))) return [];
  return (validate.errors ?? [])
    .filter((e) => !(e.keyword === "required" && e.instancePath === ""))
    .map((e) => ({
      field: e.instancePath.split("/")[1] ?? "",
      keyword: e.keyword,
      path: e.instancePath,
      message: e.message ?? e.keyword,
    }));
}

export function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, dropNulls(v)]),
  ) as T;
}
