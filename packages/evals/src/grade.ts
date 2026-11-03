import { OTHER_CATEGORY } from "@ai-triage/core";
import { type Comparator, type JsonSchema, requiredFields, schemaProperties } from "@ai-triage/schemas";
import { comparatorsFor, compareField, isEmpty } from "./comparators";

// Grading one eval item (docs/architecture.md §6). The grades are stored on the result when it is
// written, so a run keeps the grades it was given even if comparators change later.

export interface FieldScore {
  comparator: Comparator;
  required: boolean;
  /** The label states a value for this field. */
  stated: boolean;
  score: number;
  correct: boolean;
}
export type FieldScores = Record<string, FieldScore>;

export interface Grade {
  categoryCorrect: boolean;
  /** The right category and every required field correct: the definition of a correct auto-approval. */
  requiredCorrect: boolean;
  fullyCorrect: boolean;
  /** Per field, when the category is right and there was an extraction to grade. */
  fieldScores: FieldScores | null;
}

export interface GradeInput {
  expectedCategory: string;
  expectedFields: Record<string, unknown>;
  predictedCategory: string;
  /** null for `other` (no extraction). */
  predictedFields: Record<string, unknown> | null;
  /** The predicted category's schema version; null for `other`. */
  schemaVersion: { version: number; jsonSchema: JsonSchema } | null;
}

export function gradeItem(input: GradeInput): Grade {
  if (input.predictedCategory !== input.expectedCategory) {
    return { categoryCorrect: false, requiredCorrect: false, fullyCorrect: false, fieldScores: null };
  }
  if (input.expectedCategory === OTHER_CATEGORY || !input.schemaVersion) {
    return { categoryCorrect: true, requiredCorrect: true, fullyCorrect: true, fieldScores: {} };
  }
  const { jsonSchema } = input.schemaVersion;
  const comparators = comparatorsFor(input.expectedCategory, input.schemaVersion);
  const required = new Set(requiredFields(jsonSchema));
  const predicted = input.predictedFields ?? {};
  const fieldScores: FieldScores = {};
  for (const field of Object.keys(schemaProperties(jsonSchema))) {
    const comparator = comparators[field] ?? "exact";
    const expected = input.expectedFields[field] ?? null;
    fieldScores[field] = {
      comparator,
      required: required.has(field),
      stated: !isEmpty(expected),
      ...compareField(comparator, expected, predicted[field] ?? null),
    };
  }
  const scores = Object.values(fieldScores);
  return {
    categoryCorrect: true,
    requiredCorrect: scores.every((s) => !s.required || s.correct),
    fullyCorrect: scores.every((s) => s.correct),
    fieldScores,
  };
}

/**
 * The grade of an item whose run failed: wrong end to end, though the classification still counts
 * when it succeeded before the failure.
 */
export const errorGrade = (expectedCategory: string, predictedCategory: string | null): Grade => ({
  categoryCorrect: predictedCategory === expectedCategory,
  requiredCorrect: false,
  fullyCorrect: false,
  fieldScores: null,
});
