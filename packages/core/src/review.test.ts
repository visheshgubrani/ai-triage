import { describe, expect, it } from "vitest";
import { fieldDiff, gateFieldMarks } from "./review";

describe("fieldDiff", () => {
  it("reports changed top-level fields, ignoring key order and null versus absent", () => {
    const before = { total: 110, po_number: null, line_items: [{ description: "Paper", amount: 100 }] };
    const after = { total: 120, line_items: [{ amount: 100, description: "Paper" }], currency: "USD" };
    expect(fieldDiff(before, after)).toEqual([
      { field: "currency", before: null, after: "USD" },
      { field: "total", before: 110, after: 120 },
    ]);
    expect(fieldDiff(before, { ...before })).toEqual([]);
  });
});

describe("gateFieldMarks", () => {
  it("puts field failures on fields, and rules and unverifiable evidence on the document", () => {
    const marks = gateFieldMarks({
      failures: [
        { code: "required_missing", field: "total" },
        { code: "uncertain", field: "total" },
        { code: "schema_invalid", field: "", detail: "/line_items/0/amount must be number" },
        { code: "rule_failed", field: "totals_add_up", detail: "Subtotal plus tax equals the total." },
        { code: "evidence_unverifiable" },
      ],
      validationIssues: [{ field: "invoice_date", path: "/invoice_date", message: "must match format date" }],
    });
    expect(marks.byField).toEqual({
      total: ["Required, but missing", "The model marked this uncertain"],
      line_items: ["Invalid: /line_items/0/amount must be number"],
      invoice_date: ["/invoice_date must match format date"],
    });
    expect(marks.document).toEqual([
      "Subtotal plus tax equals the total.",
      "Scanned or image content: evidence can't be verified",
    ]);
  });
});
