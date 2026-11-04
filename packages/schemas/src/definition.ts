import { z } from "zod";
import { BUILTIN_CATEGORY_NAMES } from "./templates/names";
import { COMPARATORS, type Comparator, type JsonSchema } from "./types";

// Custom categories (docs/architecture.md §4): a tenant's own document type, defined as data in
// Settings → Categories. A definition is an ordered list of fields; compileDefinition() builds the
// same Zod schema a built-in template is written as, so the stored JSON Schema has exactly the
// shape built-ins have (descriptions, `x-evidence`, `required`), and every consumer (request
// builders, toApiSchema, Ajv, gates, the review form, eval grading) treats both alike. Custom
// categories have no code rules; their comparators come from `x-comparator`.

export const FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "amount",
  "date",
  "email",
  "enum",
  "boolean",
  "text_list",
  "object_list",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Bounds on a definition, which bound the prompt (and so the cost) it adds to every request. */
export const DEFINITION_LIMITS = {
  categoriesPerTenant: 30,
  fields: 40,
  itemFields: 15,
  enumValues: 50,
  description: 500,
  examples: 3,
  example: 300,
} as const;

/** snake_case, 2 to 40 characters. A `:` would break gate reasons (`code:field`). */
const NAME = /^[a-z][a-z0-9_]{1,39}$/;
const name = z.string().regex(NAME, "lowercase letters, digits and _, starting with a letter (2 to 40)");
/** Descriptions are spliced into the prompts one per line, so they stay on one line. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), "one line");

const DEFAULT_COMPARATOR: Record<FieldType, Comparator> = {
  text: "normalized",
  long_text: "free_text",
  number: "amount",
  amount: "amount",
  date: "date",
  email: "normalized",
  enum: "exact",
  boolean: "exact",
  text_list: "set_f1",
  object_list: "set_f1",
};

const ItemField = z.object({
  name,
  type: z.enum(["text", "number", "amount", "date", "boolean"]),
  description: line(DEFINITION_LIMITS.description).min(1),
  required: z.boolean().default(false),
});

export const FieldDefinition = z
  .object({
    name,
    label: z.string().trim().max(80).optional(),
    type: z.enum(FIELD_TYPES),
    description: line(DEFINITION_LIMITS.description).min(1),
    required: z.boolean().default(false),
    /** The value must be backed by a verbatim quote (the evidence gate). Top-level scalars only. */
    quote: z.boolean().default(false),
    comparator: z.enum(COMPARATORS).optional(),
    enum: z.array(z.string().trim().min(1).max(80)).min(1).max(DEFINITION_LIMITS.enumValues).optional(),
    itemFields: z.array(ItemField).min(1).max(DEFINITION_LIMITS.itemFields).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "enum" && !f.enum) ctx.addIssue({ code: "custom", message: "an enum field lists its values" });
    if (f.type === "object_list" && !f.itemFields) {
      ctx.addIssue({ code: "custom", message: "a list of objects lists its item fields" });
    }
    // The evidence gate reads top-level values; a quote rule on a list would be silently ignored.
    if (f.quote && ["boolean", "text_list", "object_list"].includes(f.type)) {
      ctx.addIssue({ code: "custom", message: "only a single value can require a quote" });
    }
  });
export type FieldDefinition = z.infer<typeof FieldDefinition>;

export const CategoryDefinition = z
  .object({
    name: name.refine((n) => !(BUILTIN_CATEGORY_NAMES as readonly string[]).includes(n) && n !== "other", {
      message: "that name is built in",
    }),
    label: z.string().trim().max(80).optional(),
    /** What the classifier reads to recognize it: one line. */
    description: line(DEFINITION_LIMITS.description).min(10),
    /** Short sample subjects or openings, shown to the classifier as examples. */
    examples: z.array(line(DEFINITION_LIMITS.example).min(1)).max(DEFINITION_LIMITS.examples).default([]),
    fields: z.array(FieldDefinition).min(1).max(DEFINITION_LIMITS.fields),
  })
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    for (const f of d.fields) {
      if (seen.has(f.name))
        ctx.addIssue({ code: "custom", message: `field ${f.name} appears twice`, path: ["fields"] });
      seen.add(f.name);
    }
  });
export type CategoryDefinition = z.infer<typeof CategoryDefinition>;
/** A definition as an admin writes it (defaults not applied yet). */
export type CategoryDefinitionInput = z.input<typeof CategoryDefinition>;

function scalar(type: FieldType | "number", values?: string[]): z.ZodType {
  switch (type) {
    case "text":
    case "long_text":
      return z.string().min(1);
    case "number":
    case "amount":
      return z.number();
    case "date":
      return z.iso.date();
    case "email":
      return z.email();
    case "enum":
      return z.enum(values as [string, ...string[]]);
    case "boolean":
      return z.boolean();
    default:
      throw new Error(`not a scalar type: ${type}`);
  }
}

const meta = (description: string, extra: Record<string, unknown>) => ({ description, ...extra });

function fieldSchema(f: FieldDefinition): z.ZodType {
  const base =
    f.type === "text_list"
      ? z.array(z.string().min(1))
      : f.type === "object_list"
        ? z.object(
            Object.fromEntries(
              (f.itemFields ?? []).map((item) => {
                const s = scalar(item.type).meta({ description: item.description });
                return [item.name, item.required ? s : s.optional()];
              }),
            ),
          )
        : scalar(f.type, f.enum);
  const value = f.type === "object_list" ? z.array(base) : base;
  const described = value.meta(
    meta(f.description, {
      ...(f.quote ? { "x-evidence": true } : {}),
      "x-comparator": f.comparator ?? DEFAULT_COMPARATOR[f.type],
    }),
  );
  return f.required ? described : described.optional();
}

/** The Zod schema of a definition, written as a built-in template would be. */
export function definitionSchema(definition: CategoryDefinition) {
  return z
    .object(Object.fromEntries(definition.fields.map((f) => [f.name, fieldSchema(f)])))
    .meta({ description: definition.description });
}

/** The JSON Schema stored for a custom category version (category_schema_versions.json_schema). */
export function compileDefinition(definition: CategoryDefinition): JsonSchema {
  return z.toJSONSchema(definitionSchema(definition), { target: "draft-2020-12" }) as JsonSchema;
}

/** Field order and labels for display: jsonb doesn't keep object key order, the definition does. */
export function displayOrder(definition: CategoryDefinition): string[] {
  return definition.fields.map((f) => f.name);
}
