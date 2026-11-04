import { describe, expect, it } from "vitest";
import { comparatorsFor, compareField, setF1, toAmount, toIsoDate } from "./comparators";

const correct = (c: Parameters<typeof compareField>[0], e: unknown, p: unknown) => compareField(c, e, p).correct;

describe("compareField", () => {
  it("treats a missing label as expecting null, in both directions", () => {
    expect(correct("exact", null, null)).toBe(true);
    expect(correct("exact", undefined, "")).toBe(true);
    expect(correct("exact", null, "PO-1")).toBe(false);
    expect(correct("exact", "PO-1", null)).toBe(false);
    expect(correct("set_f1", [], null)).toBe(true);
  });

  it("exact compares canonical JSON", () => {
    expect(correct("exact", "KL-8330", "KL-8330")).toBe(true);
    expect(correct("exact", "KL-8330", "kl-8330")).toBe(false);
    expect(correct("exact", { a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(correct("exact", 12, "12")).toBe(false);
  });

  it("normalized ignores case, punctuation and spacing", () => {
    expect(correct("normalized", "Kestrel Logistics GmbH", "kestrel  logistics, GmbH.")).toBe(true);
    expect(correct("normalized", "Kestrel Logistics", "Kestrel Freight")).toBe(false);
  });

  it("date compares calendar dates", () => {
    expect(correct("date", "2026-06-07", "2026-06-07T00:00:00Z")).toBe(true);
    expect(correct("date", "2026-06-07", "2026-07-06")).toBe(false);
    expect(correct("date", "2026-06-07", "07/06/2026")).toBe(false);
    expect(toIsoDate("2026-02-30")).toBeNull();
  });

  it("amount allows a cent of difference and reads numeric strings", () => {
    expect(correct("amount", 11918.51, 11918.5)).toBe(true);
    expect(correct("amount", 11918.51, 11918.52)).toBe(true);
    expect(correct("amount", 11918.51, 11918.49)).toBe(false);
    expect(correct("amount", 1234.56, "$1,234.56")).toBe(true);
    expect(toAmount("n/a")).toBeNull();
  });

  it("free_text only checks presence", () => {
    expect(correct("free_text", "Charged twice for one order", "The customer was charged twice.")).toBe(true);
    expect(correct("free_text", "Charged twice", null)).toBe(false);
  });

  it("set_f1 matches elements on the keys the label states", () => {
    const parties = [
      { name: "Acme Ltd", role: "supplier" },
      { name: "Globex Corp", role: "customer" },
    ];
    expect(compareField("set_f1", parties, [...parties].reverse())).toEqual({ score: 1, correct: true });
    expect(
      compareField("set_f1", parties, [
        { name: "ACME LTD.", role: "Supplier", address: "extra keys are ignored" },
        { name: "Globex Corp", role: "customer" },
      ]).correct,
    ).toBe(true);
    const half = compareField("set_f1", parties, [{ name: "Acme Ltd", role: "supplier" }]);
    expect(half.score).toBeCloseTo(2 / 3);
    expect(half.correct).toBe(false);
    expect(setF1([{ description: "Freight", amount: 10 }], [{ description: "freight", amount: "10.00" }])).toBe(1);
  });
});

describe("comparatorsFor", () => {
  it("uses the built-in template's comparators", () => {
    const schema = { type: "object", properties: { issue_summary: { type: "string" }, severity: { type: "string" } } };
    expect(comparatorsFor("support_request", { version: 1, jsonSchema: schema })).toEqual({
      issue_summary: "free_text",
      severity: "exact",
    });
  });

  it("takes a custom category's declared comparator before the type's", () => {
    const schema = {
      type: "object",
      properties: {
        ref: { type: "string", "x-comparator": "exact" },
        notes: { type: "string", "x-comparator": "free_text" },
        name: { type: "string" },
        bogus: { type: "string", "x-comparator": "fuzzy" },
      },
    };
    expect(comparatorsFor("purchase_order", { version: 1, jsonSchema: schema })).toEqual({
      ref: "exact",
      notes: "free_text",
      name: "normalized",
      bogus: "normalized",
    });
  });

  it("derives comparators from types for other categories", () => {
    const schema = {
      type: "object",
      properties: {
        when: { type: "string", format: "date" },
        total: { type: "number" },
        tags: { type: "array" },
        note: { type: "string" },
        ok: { type: "boolean" },
      },
    };
    expect(comparatorsFor("custom", { version: 1, jsonSchema: schema })).toEqual({
      when: "date",
      total: "amount",
      tags: "set_f1",
      note: "normalized",
      ok: "exact",
    });
  });
});
