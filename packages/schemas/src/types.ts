import type { z } from "zod";

/** A JSON Schema node. Category schemas are stored as JSON (category_schema_versions.json_schema). */
export type JsonSchema = { [key: string]: unknown };

/** Field values of one extraction, keyed by field name. */
export type FieldValues = Record<string, unknown>;

/**
 * How evals compare a predicted field to its label (docs/architecture.md §8). `free_text` is for
 * fields the model writes in its own words: only presence is graded (both set, or both empty),
 * because string matching can't tell a good summary from a bad one.
 */
export const COMPARATORS = ["exact", "normalized", "date", "amount", "set_f1", "free_text"] as const;
export type Comparator = (typeof COMPARATORS)[number];

/**
 * A deterministic business rule. `check` returns undefined when the rule doesn't apply (for example,
 * no line items to sum), false when it fails. A failure is a gate failure, so the item goes to review.
 */
export interface CategoryRule {
  id: string;
  description: string;
  check: (values: FieldValues) => boolean | undefined;
}

/**
 * A built-in category. The Zod schema is the source of truth: `toJsonSchema()` turns it into the
 * stored, versioned JSON Schema, which carries the category and field descriptions (used by the
 * prompts) and `x-evidence` (fields whose value must be backed by a verbatim quote).
 */
export interface CategoryTemplate {
  category: string;
  version: number;
  schema: z.ZodObject;
  comparators: Record<string, Comparator>;
  rules: readonly CategoryRule[];
}
