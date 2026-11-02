import {
  classifyOutputSchema,
  createAjv,
  type FieldValues,
  type JsonSchema,
  schemaProperties,
} from "@ai-triage/schemas";
import { PipelineError } from "./errors";

export interface ClassifyOutput {
  category: string;
  selfConfidence: number;
  rationale: string;
}

export interface EvidenceQuote {
  quote: string;
  page: number | null;
}

export interface ExtractOutput {
  /** Every schema field, null when the document doesn't state it. */
  values: FieldValues;
  evidence: Record<string, EvidenceQuote | null>;
  uncertain: string[];
}

const ajv = createAjv();
const classifyValidators = new Map<string, ReturnType<typeof ajv.compile>>();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks the classifier's answer against the full schema, including the 0..1 range the API schema drops. */
export function parseClassifyOutput(output: unknown, categories: readonly string[]): ClassifyOutput {
  const key = categories.join("\n");
  let validate = classifyValidators.get(key);
  if (!validate) {
    validate = ajv.compile(classifyOutputSchema(categories));
    classifyValidators.set(key, validate);
  }
  if (!validate(output) || !isRecord(output)) {
    throw new PipelineError("invalid_output", `classify output is invalid: ${ajv.errorsText(validate.errors)}`);
  }
  return {
    category: output.category as string,
    selfConfidence: output.self_confidence as number,
    rationale: output.rationale as string,
  };
}

/**
 * Unwraps the extract envelope into values, evidence and uncertain fields. Values are not
 * validated here: schema violations are a gate (review), not a failure of the run.
 */
export function parseExtractOutput(output: unknown, schema: JsonSchema): ExtractOutput {
  if (!isRecord(output) || !isRecord(output.fields)) {
    throw new PipelineError("invalid_output", "extract output has no `fields` object");
  }
  const fields = output.fields;
  const names = Object.keys(schemaProperties(schema));
  const values: FieldValues = {};
  const evidence: Record<string, EvidenceQuote | null> = {};
  for (const name of names) {
    const entry = isRecord(fields[name]) ? fields[name] : {};
    values[name] = entry.value ?? null;
    const ev = entry.evidence;
    evidence[name] =
      isRecord(ev) && typeof ev.quote === "string" && ev.quote.trim()
        ? { quote: ev.quote, page: typeof ev.page === "number" ? ev.page : null }
        : null;
  }
  const uncertain = Array.isArray(output.uncertain_fields)
    ? [...new Set(output.uncertain_fields.filter((f): f is string => typeof f === "string" && names.includes(f)))]
    : [];
  return { values, evidence, uncertain };
}
