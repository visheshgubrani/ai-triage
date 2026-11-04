import { describe, expect, it } from "vitest";
import {
  API_SCHEMA_FORMATS,
  API_SCHEMA_KEYWORDS,
  CategoryDefinition,
  type CategoryDefinitionInput,
  CLASSIFY_PROMPT_V2,
  compileDefinition,
  DEFINITION_LIMITS,
  evidenceFields,
  extractOutputSchema,
  fieldGuide,
  renderPrompt,
  requiredFields,
  STARTERS,
  schemaProperties,
  TEMPLATES,
  toApiSchema,
  validateFields,
} from "./index";
import { BUILTIN_CATEGORY_NAMES } from "./templates/names";

const parse = (input: CategoryDefinitionInput) => CategoryDefinition.parse(input);

/** Keywords and formats of a reduced schema outside the structured-outputs subset. */
function violations(node: unknown, path = "$"): string[] {
  if (typeof node !== "object" || node === null) return [];
  if (Array.isArray(node)) return node.flatMap((n, i) => violations(n, `${path}[${i}]`));
  const problems: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (path.endsWith(".properties")) {
      problems.push(...violations(value, `${path}.${key}`));
      continue;
    }
    if (!API_SCHEMA_KEYWORDS.has(key)) problems.push(`${path}: keyword ${key}`);
    if (key === "format" && !API_SCHEMA_FORMATS.has(value as string)) problems.push(`${path}: format ${value}`);
    if (typeof value === "object") problems.push(...violations(value, `${path}.${key}`));
  }
  return problems;
}

describe("starter gallery", () => {
  it("has unique ids that match the definitions' names", () => {
    expect(new Set(STARTERS.map((s) => s.id)).size).toBe(STARTERS.length);
    for (const s of STARTERS) expect(s.definition.name).toBe(s.id);
  });

  it.each(STARTERS.map((s) => [s.id, s] as const))("%s compiles to a schema every consumer accepts", (_id, starter) => {
    const definition = parse(starter.definition);
    const schema = compileDefinition(definition);
    // The stored schema survives a jsonb round trip (key order aside) and keeps authored order.
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(Object.keys(schemaProperties(schema))).toEqual(definition.fields.map((f) => f.name));
    expect(requiredFields(schema)).toEqual(definition.fields.filter((f) => f.required).map((f) => f.name));
    expect(evidenceFields(schema)).toEqual(definition.fields.filter((f) => f.quote).map((f) => f.name));
    expect(fieldGuide(schema).split("\n")).toHaveLength(definition.fields.length);
    // The request schema stays inside the structured-outputs subset, and no x-* reaches the model.
    const api = toApiSchema(extractOutputSchema(schema));
    expect(violations(api)).toEqual([]);
    expect(JSON.stringify(api)).not.toContain("x-");
    // Ajv compiles it, and an empty extraction is left to the required_missing gate.
    expect(validateFields(`${definition.name}@test`, schema, {})).toEqual([]);
  });
});

describe("definitions", () => {
  const base: CategoryDefinitionInput = {
    name: "purchase_order",
    description: "A buyer's order to a supplier.",
    fields: [{ name: "po_number", type: "text", description: "The PO number.", required: true, quote: true }],
  };

  it("reserves the built-in names and other", () => {
    expect([...BUILTIN_CATEGORY_NAMES].sort()).toEqual(Object.keys(TEMPLATES).sort());
    for (const name of [...BUILTIN_CATEGORY_NAMES, "other"]) {
      expect(CategoryDefinition.safeParse({ ...base, name }).success, name).toBe(false);
    }
  });

  it("refuses bad names, multi-line descriptions, duplicates and misplaced quotes", () => {
    const bad: CategoryDefinitionInput[] = [
      { ...base, name: "Purchase Order" },
      { ...base, name: "po:x" },
      { ...base, description: "two\nlines here" },
      { ...base, fields: [] },
      { ...base, fields: [base.fields[0] as never, base.fields[0] as never] },
      { ...base, fields: [{ name: "tags", type: "text_list", description: "Tags.", quote: true }] },
      { ...base, fields: [{ name: "kind", type: "enum", description: "Kind." }] },
      { ...base, fields: [{ name: "lines", type: "object_list", description: "Lines." }] },
      {
        ...base,
        fields: Array.from({ length: DEFINITION_LIMITS.fields + 1 }, (_, i) => ({
          name: `f${i}`,
          type: "text" as const,
          description: "A field.",
        })),
      },
    ];
    for (const input of bad) expect(CategoryDefinition.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it("enforces types and enums the way built-in schemas do", () => {
    const schema = compileDefinition(
      parse({
        ...base,
        fields: [
          { name: "kind", type: "enum", description: "Kind.", enum: ["a", "b"] },
          { name: "when", type: "date", description: "Date." },
          { name: "email", type: "email", description: "Email." },
        ],
      }),
    );
    const issues = validateFields("enum@test", schema, { kind: "c", when: "2026-02-30", email: "nope" });
    expect([...new Set(issues.map((i) => i.field))].sort()).toEqual(["email", "kind", "when"]);
    expect(validateFields("enum@test", schema, { kind: "a", when: "2026-02-28", email: "a@b.co" })).toEqual([]);
  });

  it("records the comparator on each field, defaulting by type", () => {
    const schema = compileDefinition(
      parse({
        ...base,
        fields: [
          { name: "ref", type: "text", description: "Ref.", comparator: "exact" },
          { name: "notes", type: "long_text", description: "Notes." },
          { name: "total", type: "amount", description: "Total." },
        ],
      }),
    );
    const props = schemaProperties(schema);
    expect([props.ref?.["x-comparator"], props.notes?.["x-comparator"], props.total?.["x-comparator"]]).toEqual([
      "exact",
      "free_text",
      "amount",
    ]);
  });

  it("classify prompt v2 has no built-in examples and takes the definitions' examples", () => {
    expect(CLASSIFY_PROMPT_V2).not.toMatch(/invoice|support_request|contract/);
    const body = renderPrompt(CLASSIFY_PROMPT_V2, { categories: "- receipt: r", examples: "" });
    expect(body).toContain("- receipt: r");
    expect(body).not.toMatch(/\{\{/);
  });
});
