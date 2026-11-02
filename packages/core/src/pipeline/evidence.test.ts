import { describe, expect, it } from "vitest";
import { type EvidencePart, normalizeForMatch, verifyEvidence } from "./evidence";

const body: EvidencePart = {
  partIndex: 0,
  page: null,
  evidenceMode: "text",
  text: "Subject: Invoice\n\nVendor:  Acme—Supplies Ltd\nTotal due: “$1,250.00”",
};
const pdf = (page: number, text: string): EvidencePart => ({ partIndex: page, page, evidenceMode: "pdf_text", text });

describe("normalizeForMatch", () => {
  it("folds case, quotes, dashes, ligatures and whitespace, and maps back to original offsets", () => {
    const n = normalizeForMatch("  The ﬁnal “Quote” – done​ ");
    expect(n.text).toBe('the final "quote" - done');
    const original = "  The ﬁnal";
    const m = normalizeForMatch(original);
    const at = m.text.indexOf("final");
    expect(original.slice(m.starts[at], m.ends[at + 4])).toBe("ﬁnal");
  });
});

describe("verifyEvidence", () => {
  it("verifies quotes in text parts and returns original offsets", () => {
    const result = verifyEvidence([body], { vendor_name: { quote: "acme-supplies  ltd", page: null } }, [
      "vendor_name",
    ]);
    expect(result.unverifiable).toBe(false);
    const [check] = result.checks;
    expect(check).toMatchObject({ field: "vendor_name", status: "verified", partIndex: 0 });
    if (check?.status === "verified") expect(body.text.slice(check.start, check.end)).toBe("Acme—Supplies Ltd");
  });

  it("requires a PDF quote on the cited page", () => {
    const parts = [pdf(1, "Invoice INV-77"), pdf(2, "Total 99.00")];
    const ok = verifyEvidence(parts, { total: { quote: "Total 99.00", page: 2 } }, ["total"]);
    expect(ok.checks[0]).toMatchObject({ status: "verified", page: 2 });
    const wrongPage = verifyEvidence(parts, { total: { quote: "Total 99.00", page: 1 } }, ["total"]);
    expect(wrongPage.checks[0]).toMatchObject({ status: "not_found", page: 1 });
    const noPage = verifyEvidence(parts, { total: { quote: "Total 99.00", page: null } }, ["total"]);
    expect(noPage.checks[0]).toMatchObject({ status: "not_found" });
  });

  it("searches text parts when a page is cited but the document has no text PDF", () => {
    expect(verifyEvidence([body], { t: { quote: "Total due", page: 1 } }, ["t"]).checks[0]).toMatchObject({
      status: "verified",
    });
  });

  it("reports missing quotes, paraphrases and unverifiable documents", () => {
    const scan: EvidencePart = { partIndex: 1, page: 1, evidenceMode: "unverifiable", text: "" };
    const result = verifyEvidence([body, scan], { a: null, b: { quote: "Acme Corporation", page: null } }, ["a", "b"]);
    expect(result.unverifiable).toBe(true);
    expect(result.checks.map((c) => c.status)).toEqual(["missing", "not_found"]);
  });
});
