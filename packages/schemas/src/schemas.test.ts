import { describe, expect, it } from "vitest";
import {
  API_SCHEMA_FORMATS,
  API_SCHEMA_KEYWORDS,
  classifyOutputSchema,
  evidenceFields,
  extractOutputSchema,
  fieldGuide,
  type JsonSchema,
  PROMPTS,
  renderPrompt,
  requiredFields,
  runCategoryRules,
  TEMPLATES,
  toApiSchema,
  toJsonSchema,
  validateFields,
} from "./index";

/** Walks a schema and returns every violation of the structured-outputs subset. */
function apiViolations(node: unknown, path = "$"): string[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return [`${path}: not a schema`];
  const schema = node as JsonSchema;
  const problems: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!API_SCHEMA_KEYWORDS.has(key)) problems.push(`${path}: keyword ${key}`);
    if (key === "format" && !API_SCHEMA_FORMATS.has(value as string)) problems.push(`${path}: format ${value}`);
    if (key === "properties" || key === "$defs") {
      for (const [name, child] of Object.entries(value as JsonSchema))
        problems.push(...apiViolations(child, `${path}.${name}`));
    }
    if (key === "items") problems.push(...apiViolations(value, `${path}[]`));
    if (key === "anyOf" || key === "allOf") {
      for (const [i, child] of (value as unknown[]).entries()) problems.push(...apiViolations(child, `${path}|${i}`));
    }
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) problems.push(`${path}: object not closed`);
    const keys = Object.keys((schema.properties as JsonSchema) ?? {});
    if (JSON.stringify(schema.required) !== JSON.stringify(keys)) problems.push(`${path}: not every key required`);
  }
  return problems;
}

const schemas = Object.fromEntries(Object.entries(TEMPLATES).map(([name, t]) => [name, toJsonSchema(t)]));

describe("toApiSchema", () => {
  it.each(Object.keys(TEMPLATES))("reduces the %s extract envelope to the supported subset", (category) => {
    const api = toApiSchema(extractOutputSchema(schemas[category] as JsonSchema));
    expect(apiViolations(api)).toEqual([]);
  });

  it("keeps the built-in schemas inside OpenAI's strict mode too (no allOf, fewer formats)", () => {
    // The openai-compatible adapter (packages/llm) sends the same reduced schema with strict: true.
    const openAiFormats = new Set([
      "date-time",
      "time",
      "date",
      "duration",
      "email",
      "hostname",
      "ipv4",
      "ipv6",
      "uuid",
    ]);
    const found = { keywords: new Set<string>(), formats: new Set<string>() };
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (!Array.isArray(node)) found.keywords.add(key);
        if (key === "format") found.formats.add(value as string);
        walk(value);
      }
    };
    walk(toApiSchema(classifyOutputSchema(["invoice", "other"])));
    for (const schema of Object.values(schemas)) walk(toApiSchema(extractOutputSchema(schema as JsonSchema)));
    expect(found.keywords.has("allOf")).toBe(false);
    expect([...found.formats].filter((f) => !openAiFormats.has(f))).toEqual([]);
  });

  it("reduces the classify schema to the supported subset", () => {
    const api = toApiSchema(classifyOutputSchema(["contract", "invoice", "other"]));
    expect(apiViolations(api)).toEqual([]);
    expect(api.properties).toMatchObject({ self_confidence: { type: "number" } });
  });

  it("makes optional properties nullable and keeps formats the API supports", () => {
    const api = toApiSchema(schemas.invoice as JsonSchema);
    const props = api.properties as Record<string, JsonSchema>;
    expect(props.invoice_date).toEqual({ type: "string", format: "date", description: "Issue date, as YYYY-MM-DD." });
    expect(props.due_date).toEqual({
      anyOf: [{ type: "string", format: "date", description: "Payment due date, as YYYY-MM-DD." }, { type: "null" }],
    });
  });
});

describe("validateFields (full schema)", () => {
  const valid = {
    vendor_name: "Acme",
    invoice_number: "INV-1",
    invoice_date: "2026-03-01",
    total: 10,
    currency: null,
    due_date: null,
  };

  it("accepts nulls for optional fields", () => {
    expect(validateFields("invoice@test", schemas.invoice as JsonSchema, valid)).toEqual([]);
  });

  it("enforces constraints stripped from the API schema", () => {
    const issues = validateFields("invoice@test", schemas.invoice as JsonSchema, { ...valid, currency: "usd" });
    expect(issues).toMatchObject([{ field: "currency", keyword: "pattern" }]);

    const contract = validateFields("contract@test", schemas.contract as JsonSchema, {
      contract_type: "nda",
      parties: [{ name: "A" }],
      effective_date: "2026-02-30",
      term_months: -1,
    });
    expect(contract.map((i) => `${i.field}:${i.keyword}`).sort()).toEqual([
      "effective_date:format",
      "effective_date:pattern",
      "parties:minItems",
      "term_months:exclusiveMinimum",
    ]);
  });

  it("leaves missing required fields to the required_missing gate", () => {
    expect(validateFields("invoice@test", schemas.invoice as JsonSchema, { total: 1 })).toEqual([]);
  });
});

describe("category rules", () => {
  const items = [
    { description: "a", amount: 60 },
    { description: "b", amount: 40 },
  ];

  it("checks invoice arithmetic and dates", () => {
    const ok = runCategoryRules("invoice", 1, { line_items: items, subtotal: 100, tax: 20, total: 120 });
    expect(ok.every((r) => r.passed)).toBe(true);
    const bad = runCategoryRules("invoice", 1, {
      line_items: items,
      subtotal: 100,
      tax: 20,
      total: 125,
      invoice_date: "2026-03-10",
      due_date: "2026-03-01",
    });
    expect(bad.filter((r) => !r.passed).map((r) => r.id)).toEqual(["totals_add_up", "due_after_issue"]);
  });

  it("sums line items against total minus tax when there is no subtotal", () => {
    expect(runCategoryRules("invoice", 1, { line_items: items, tax: 5, total: 105 })).toMatchObject([
      { id: "line_items_sum", passed: true },
    ]);
  });

  it("omits rules that don't apply, and unknown versions have none", () => {
    expect(runCategoryRules("invoice", 1, { total: 5, subtotal: null })).toEqual([]);
    expect(runCategoryRules("invoice", 99, { line_items: items, total: 1 })).toEqual([]);
    expect(runCategoryRules("contract", 1, { effective_date: "2026-05-01", end_date: "2026-04-01" })).toMatchObject([
      { id: "end_after_effective", passed: false },
    ]);
  });
});

describe("schema metadata and prompts", () => {
  it("exposes required and quote-backed fields from the stored schema", () => {
    expect(requiredFields(schemas.invoice as JsonSchema)).toEqual([
      "vendor_name",
      "invoice_number",
      "invoice_date",
      "total",
    ]);
    expect(evidenceFields(schemas.support_request as JsonSchema)).toEqual([
      "customer_name",
      "customer_email",
      "product",
      "order_id",
    ]);
    expect(fieldGuide(schemas.invoice as JsonSchema)).toContain("- total (required, quote required): Total amount due");
  });

  it("every template field has a comparator", () => {
    for (const [name, template] of Object.entries(TEMPLATES)) {
      expect(Object.keys(template.comparators).sort(), name).toEqual(Object.keys(template.schema.shape).sort());
    }
  });

  it("renders prompts and refuses unknown placeholders", () => {
    const body = renderPrompt(PROMPTS.extract.body, {
      category: "invoice",
      category_description: "d",
      field_guide: "g",
    });
    expect(body).not.toMatch(/\{\{/);
    expect(renderPrompt(PROMPTS.classify.body, { categories: "- invoice: x" })).toContain("- invoice: x");
    expect(() => renderPrompt("{{nope}}", {})).toThrow("{{nope}}");
  });
});
