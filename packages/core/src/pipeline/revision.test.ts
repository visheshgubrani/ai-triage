import { TEMPLATES, toJsonSchema } from "@ai-triage/schemas";
import { describe, expect, it } from "vitest";
import { checkUserRevision } from "./revision";

const template = TEMPLATES.invoice;
if (!template) throw new Error("invoice template missing");
const invoice = { id: "test-invoice-v1", version: 1, jsonSchema: toJsonSchema(template) };
const valid = { vendor_name: "Acme", invoice_number: "INV-1", invoice_date: "2026-10-01", total: 110 };

describe("checkUserRevision", () => {
  it("passes valid values, and records failed rules without blocking", () => {
    const ok = checkUserRevision({ category: "invoice", schemaVersion: invoice, values: valid });
    expect(ok.validationIssues).toEqual([]);
    expect(ok.gateResults.evidence).toBeNull();

    const discounted = { ...valid, subtotal: 100, tax: 5, total: 110 };
    const result = checkUserRevision({ category: "invoice", schemaVersion: invoice, values: discounted });
    expect(result.validationIssues).toEqual([]);
    expect(result.gateResults.rules).toContainEqual(expect.objectContaining({ id: "totals_add_up", passed: false }));
  });

  it("reports schema violations against the full schema", () => {
    const result = checkUserRevision({
      category: "invoice",
      schemaVersion: invoice,
      values: { ...valid, invoice_date: "1 Oct 2026", currency: "usd" },
    });
    expect([...new Set(result.validationIssues.map((i) => i.field))].sort()).toEqual(["currency", "invoice_date"]);
  });
});
