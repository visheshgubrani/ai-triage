import { getTemplate, toJsonSchema } from "@ai-triage/schemas";
import { describe, expect, it } from "vitest";
import { errorGrade, gradeItem } from "./grade";

const invoice = getTemplate("invoice", 1);
if (!invoice) throw new Error("invoice template missing");
const schemaVersion = { version: 1, jsonSchema: toJsonSchema(invoice) };

const label = {
  vendor_name: "Kestrel Logistics GmbH",
  invoice_number: "KL-8330",
  invoice_date: "2026-06-07",
  total: 11918.51,
  currency: "GBP",
};

const grade = (predictedFields: Record<string, unknown> | null, predictedCategory = "invoice") =>
  gradeItem({ expectedCategory: "invoice", expectedFields: label, predictedCategory, predictedFields, schemaVersion });

describe("gradeItem", () => {
  it("is correct end to end when every field matches", () => {
    const g = grade({ ...label, vendor_name: "kestrel logistics gmbh" });
    expect(g).toMatchObject({ categoryCorrect: true, requiredCorrect: true, fullyCorrect: true });
    expect(g.fieldScores?.po_number).toMatchObject({ stated: false, correct: true, required: false });
    expect(g.fieldScores?.total).toMatchObject({ comparator: "amount", stated: true, required: true });
  });

  it("separates a wrong optional field from a wrong required one", () => {
    expect(grade({ ...label, currency: "EUR" })).toMatchObject({ requiredCorrect: true, fullyCorrect: false });
    expect(grade({ ...label, total: 1191.85 })).toMatchObject({ requiredCorrect: false, fullyCorrect: false });
  });

  it("counts a value the label doesn't state as wrong", () => {
    expect(grade({ ...label, po_number: "PO-1" }).fullyCorrect).toBe(false);
  });

  it("is wrong everywhere when the category is wrong", () => {
    expect(grade(label, "contract")).toEqual({
      categoryCorrect: false,
      requiredCorrect: false,
      fullyCorrect: false,
      fieldScores: null,
    });
  });

  it("counts `other` predicted as `other` as correct, with no fields", () => {
    expect(
      gradeItem({
        expectedCategory: "other",
        expectedFields: {},
        predictedCategory: "other",
        predictedFields: null,
        schemaVersion: null,
      }),
    ).toEqual({ categoryCorrect: true, requiredCorrect: true, fullyCorrect: true, fieldScores: {} });
  });
});

describe("errorGrade", () => {
  it("keeps a classification that finished before the failure", () => {
    expect(errorGrade("invoice", "invoice")).toMatchObject({ categoryCorrect: true, requiredCorrect: false });
    expect(errorGrade("invoice", null).categoryCorrect).toBe(false);
  });
});
