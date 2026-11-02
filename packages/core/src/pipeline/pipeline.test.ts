import { TEMPLATES, toJsonSchema } from "@ai-triage/schemas";
import { describe, expect, it } from "vitest";
import { BUILTIN_CATEGORIES } from "../index";
import { PipelineError } from "./errors";
import { evaluateExtraction } from "./evaluate";
import { gateReason, runGates } from "./gates";
import { parseClassifyOutput, parseExtractOutput } from "./outputs";
import { buildClassifyRequest, buildExtractRequest, MAX_REQUEST_BYTES } from "./requests";
import type { ParsedPart } from "./types";

const invoiceSchema = toJsonSchema(TEMPLATES.invoice ?? (undefined as never));
const model = { model: "claude-opus-5-5" as const, effort: "low" as const, maxTokens: 4096 };

const email: ParsedPart = {
  partIndex: 0,
  kind: "email_body",
  mime: "text/plain",
  label: null,
  page: null,
  text: "Subject: Invoice INV-9\nFrom: billing@acme.test\n\nAcme Supplies Ltd\nInvoice INV-9 dated 2026-10-01\nTotal: 120.00",
  evidenceMode: "text",
  storageKey: null,
};
const pdfPage = (page: number): ParsedPart => ({
  partIndex: page,
  kind: "attachment",
  mime: "application/pdf",
  label: 'inv "9".pdf',
  page,
  text: `page ${page}`,
  evidenceMode: "pdf_text",
  storageKey: "t/tenant-a/e/123/att/0",
});

it("has a template for every built-in category", () => {
  expect(Object.keys(TEMPLATES).sort()).toEqual([...BUILTIN_CATEGORIES].sort());
});

describe("requests", () => {
  const categories = [
    { name: "support_request", description: "Help needed." },
    { name: "invoice", description: "A bill." },
  ];
  const blobs = new Map([["t/tenant-a/e/123/att/0", new Uint8Array([37, 80, 68, 70])]]);

  it("are deterministic, sort categories with other last, and send each PDF once", () => {
    const build = () =>
      buildClassifyRequest({
        model,
        promptBody: "Categories:\n{{categories}}",
        categories,
        parts: [email, pdfPage(1), pdfPage(2)],
        blobs,
      });
    const request = build();
    expect(JSON.stringify(build())).toBe(JSON.stringify(request));
    expect(request.system).toBe("Categories:\n- invoice: A bill.\n- support_request: Help needed.");
    expect((request.outputSchema.properties as { category: { enum: string[] } }).category.enum).toEqual([
      "invoice",
      "support_request",
      "other",
    ]);
    expect(request.content.map((c) => c.type)).toEqual(["text", "document", "text"]);
    expect(request.content[1]).toMatchObject({ type: "document", title: 'inv "9".pdf', data: "JVBERg==" });
  });

  it("leak no storage keys or tenant ids into the request", () => {
    const request = buildExtractRequest({
      model,
      promptBody: "{{category}} {{category_description}}\n{{field_guide}}",
      category: "invoice",
      schema: invoiceSchema,
      parts: [email, pdfPage(1)],
      blobs,
    });
    expect(JSON.stringify(request)).not.toContain("tenant-a");
    expect(request.system).toContain("- invoice_number (required, quote required)");
  });

  it("refuse documents over the request size limit", () => {
    const huge = new Map([["t/tenant-a/e/123/att/0", new Uint8Array(MAX_REQUEST_BYTES)]]);
    expect(() =>
      buildClassifyRequest({ model, promptBody: "{{categories}}", categories, parts: [pdfPage(1)], blobs: huge }),
    ).toThrow(expect.objectContaining({ reason: "request_too_large" }));
  });
});

describe("outputs", () => {
  it("validate the classifier's range and categories", () => {
    const cats = ["invoice", "other"];
    expect(parseClassifyOutput({ category: "invoice", self_confidence: 0.9, rationale: "r" }, cats)).toEqual({
      category: "invoice",
      selfConfidence: 0.9,
      rationale: "r",
    });
    for (const bad of [
      { category: "invoice", self_confidence: 1.5, rationale: "r" },
      { category: "contract", self_confidence: 0.5, rationale: "r" },
      "not json",
    ]) {
      expect(() => parseClassifyOutput(bad, cats)).toThrow(PipelineError);
    }
  });

  it("unwrap the extract envelope, keeping only declared fields", () => {
    const out = parseExtractOutput(
      {
        fields: { total: { value: 120, evidence: { quote: "Total: 120.00", page: null } }, bogus: { value: 1 } },
        uncertain_fields: ["total", "bogus"],
      },
      invoiceSchema,
    );
    expect(out.values).toMatchObject({ total: 120, vendor_name: null });
    expect(out.values).not.toHaveProperty("bogus");
    expect(out.evidence.total).toEqual({ quote: "Total: 120.00", page: null });
    expect(out.uncertain).toEqual(["total"]);
    expect(() => parseExtractOutput({}, invoiceSchema)).toThrow(PipelineError);
  });
});

describe("gates and evaluateExtraction", () => {
  const values = { vendor_name: "Acme Supplies Ltd", invoice_number: "INV-9", invoice_date: "2026-10-01", total: 120 };
  const quotes = {
    vendor_name: { quote: "Acme Supplies Ltd", page: null },
    invoice_number: { quote: "Invoice INV-9", page: null },
    invoice_date: { quote: "dated 2026-10-01", page: null },
    total: { quote: "Total: 120.00", page: null },
  };
  const evaluate = (output: Partial<Parameters<typeof evaluateExtraction>[0]["output"]> = {}, score = 0.97) =>
    evaluateExtraction({
      category: "invoice",
      schemaVersion: { id: "sv-invoice", version: 1, jsonSchema: invoiceSchema },
      output: { values, evidence: quotes, uncertain: [], ...output },
      parts: [email],
      score,
      policy: { threshold: 0.9, automation: "auto_when_confident", auditRate: 0 },
      trigger: "ingest",
      auditDraw: 0.5,
      ids: { documentId: "d", extractionId: "e" },
    });

  it("auto-approves a clean, fully evidenced extraction", () => {
    const result = evaluate();
    expect(result.failures).toEqual([]);
    expect(result.route).toMatchObject({ decision: "auto", reasons: [] });
    expect(result.gateResults.evidence.checks.every((c) => c.status === "verified")).toBe(true);
  });

  it("records every failing gate as a reason", () => {
    const result = evaluate(
      {
        values: { ...values, total: null, currency: "usd", subtotal: 100, tax: 10 },
        evidence: { ...quotes, vendor_name: { quote: "Acme Corp", page: null }, subtotal: null, tax: null },
        uncertain: ["invoice_date"],
      },
      0.5,
    );
    expect(result.route.decision).toBe("review");
    expect(result.route.reasons.sort()).toEqual(
      [
        "below_threshold",
        "evidence_missing:subtotal",
        "evidence_missing:tax",
        "evidence_not_found:vendor_name",
        "required_missing:total",
        "schema_invalid:currency",
        "uncertain:invoice_date",
      ].sort(),
    );
  });

  it("fails the rule gate and the other-category gate", () => {
    const rules = evaluate({
      values: { ...values, subtotal: 100, tax: 10 },
      evidence: { ...quotes, subtotal: { quote: "Acme", page: null }, tax: { quote: "Acme", page: null } },
    });
    expect(rules.route.reasons).toEqual(["rule_failed:totals_add_up"]);
    const other = runGates({
      category: "other",
      required: [],
      values: {},
      uncertain: [],
      validationIssues: [],
      evidence: { unverifiable: false, checks: [] },
      rules: [],
    });
    expect(other.map(gateReason)).toEqual(["category_other"]);
  });
});
