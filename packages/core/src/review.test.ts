import { describe, expect, it } from "vitest";
import { FAILURE_REASONS, GATE_CODES, ROUTE_REASONS } from "./index";
import { describeReason, fieldDiff, gateFieldMarks } from "./review";

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

describe("describeReason", () => {
  it("says what each stored reason means, keeping the field", () => {
    expect(describeReason("sender_unauthenticated")).toMatchObject({
      code: "sender_unauthenticated",
      label: "Sender not verified",
    });
    expect(describeReason("required_missing:issue_summary")).toMatchObject({
      code: "required_missing",
      field: "issue_summary",
      label: "Missing: Issue summary",
    });
    expect(describeReason("schema_invalid:parties").label).toBe("Invalid value: Parties");
    expect(describeReason("rule_failed:totals_add_up").label).toBe("Check failed: Totals add up");
    expect(describeReason("skipped:auto_replies").label).toBe("Skipped: auto-reply");
  });

  it("has words for every closed reason, and keeps an unknown one as it is", () => {
    for (const code of [...GATE_CODES, ...ROUTE_REASONS, ...FAILURE_REASONS]) {
      const text = describeReason(code);
      expect(text.label).not.toBe(code);
      expect(text.help).not.toBe("");
    }
    expect(describeReason("something_new:x")).toEqual({
      code: "something_new",
      field: "x",
      label: "something_new:x",
      help: "",
    });
  });

  it("shows a missing field once, when a refused approval reports it again", () => {
    const marks = gateFieldMarks({
      failures: [{ code: "required_missing", field: "invoice_number" }],
      validationIssues: [{ field: "invoice_number", path: "/invoice_number", message: "is required" }],
    });
    expect(marks.byField).toEqual({ invoice_number: ["Required, but missing"] });
  });

  it("explains sender and injection failures on the document", () => {
    const marks = gateFieldMarks({
      failures: [
        { code: "sender_unauthenticated" },
        { code: "injection_suspected", detail: "ignore previous instructions" },
      ],
    });
    expect(marks.document[0]).toMatch(/sender checks/);
    expect(marks.document[1]).toMatch(/"ignore previous instructions"/);
  });
});
