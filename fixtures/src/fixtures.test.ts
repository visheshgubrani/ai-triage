import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeEml,
  normalizeForMatch,
  normalizePostmark,
  type ParsedPart,
  type PostmarkInbound,
  parseEmail,
  parseFile,
} from "@ai-triage/core/pipeline";
import { evidenceFields, TEMPLATES, toJsonSchema } from "@ai-triage/schemas";
import { describe, expect, it } from "vitest";
import { loadManifest, readFixture } from "./index";

// Sanity checks on the committed fixtures: each parses with the real parsers, scans have no text
// layer, and every quotable string label actually appears in the document's text.

const dir = join(fileURLToPath(import.meta.url), "../..");
const manifest = await loadManifest(dir);
const limits = { maxPdfPages: 100 };

async function parse(item: (typeof manifest.items)[number]): Promise<ParsedPart[]> {
  const bytes = await readFixture(dir, item);
  if (item.format === "postmark" || item.format === "eml") {
    const email =
      item.format === "postmark"
        ? normalizePostmark(JSON.parse(new TextDecoder().decode(bytes)) as PostmarkInbound)
        : await normalizeEml(bytes);
    const attachments = email.attachments.map((a, index) => ({ ...a, index, storageKey: `att/${index}` }));
    const blobs = new Map(email.attachments.map((a, i) => [`att/${i}`, a.content]));
    return parseEmail({ version: 1, ...email, attachments }, blobs, limits);
  }
  return parseFile({ label: item.filename, bytes, declaredMime: item.mime, storageKey: "file" }, limits);
}

describe("fixtures", () => {
  it("has 60 uniquely named items across every category, tag and split", () => {
    expect(manifest.items).toHaveLength(60);
    expect(new Set(manifest.items.map((i) => i.id)).size).toBe(60);
    for (const value of ["invoice", "support_request", "contract", "other"]) {
      expect(manifest.items.some((i) => i.expectedCategory === value)).toBe(true);
    }
    for (const split of ["dev", "calib", "test"]) expect(manifest.items.some((i) => i.split === split)).toBe(true);
  });

  it.each(manifest.items.map((i) => [i.id, i] as const))(
    "%s parses, and its quotable labels are in the text",
    async (_id, item) => {
      const parts = await parse(item);
      const scan = item.tags.includes("scan");
      expect(parts.some((p) => p.evidenceMode === "unverifiable")).toBe(scan);
      const template = TEMPLATES[item.expectedCategory];
      if (scan || !template) return;
      const text = normalizeForMatch(parts.map((p) => p.text).join("\n")).text;
      for (const field of evidenceFields(toJsonSchema(template))) {
        const value = item.expectedFields[field];
        if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          expect(text, `${field} = ${value}`).toContain(normalizeForMatch(value).text);
        }
      }
    },
  );
});
