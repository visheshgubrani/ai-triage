import { z } from "zod";
import type { CategoryTemplate, JsonSchema } from "./types";

/** The JSON Schema stored in category_schema_versions (full constraints, enforced with Ajv). */
export function toJsonSchema(template: CategoryTemplate): JsonSchema {
  return z.toJSONSchema(template.schema, { target: "draft-2020-12" }) as JsonSchema;
}

export const isObject = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Top-level properties of an object schema, in declaration order. */
export function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  return isObject(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
}

export function requiredFields(schema: JsonSchema): string[] {
  return Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
}

/** Fields flagged `x-evidence`: a non-null value must cite a verbatim quote. */
export function evidenceFields(schema: JsonSchema): string[] {
  return Object.entries(schemaProperties(schema))
    .filter(([, prop]) => prop["x-evidence"] === true)
    .map(([name]) => name);
}

export function schemaDescription(schema: JsonSchema): string {
  return typeof schema.description === "string" ? schema.description : "";
}

/** One line per field for the extract prompt: name, required/optional, quote rule, description. */
export function fieldGuide(schema: JsonSchema): string {
  const required = new Set(requiredFields(schema));
  return Object.entries(schemaProperties(schema))
    .map(([name, prop]) => {
      const tags = [required.has(name) ? "required" : "optional"];
      if (prop["x-evidence"] === true) tags.push("quote required");
      const description = typeof prop.description === "string" ? `: ${prop.description}` : "";
      return `- ${name} (${tags.join(", ")})${description}`;
    })
    .join("\n");
}
