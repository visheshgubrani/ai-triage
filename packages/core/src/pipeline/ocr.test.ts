import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_MIMES, OCR_BUDGET_MS } from "../index";
import { verifyEvidence } from "./evidence";
import { applyOcr, type OcrConfig, pdfPageImages, recognizeText } from "./ocr";
import { documentContent } from "./requests";
import type { ParsedPart } from "./types";

const config: OcrConfig = { url: "http://ocr.test/v1", timeoutMs: 1000, maxPages: 20 };
const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, "../../../../fixtures/docs", name)));

const part = (over: Partial<ParsedPart>): ParsedPart => ({
  partIndex: 0,
  kind: "file",
  mime: DOCUMENT_MIMES.pdf,
  label: "scan.pdf",
  page: 1,
  text: "",
  evidenceMode: "unverifiable",
  storageKey: "t/x/scan.pdf",
  ...over,
});

describe("pdfPageImages", () => {
  it("takes each page's full-page image out of a scanned PDF, as PNG", async () => {
    const images = await pdfPageImages(fixture("scan-inv.pdf"), [1, 2]);
    expect([...images.keys()]).toEqual([1]);
    const png = images.get(1)?.bytes ?? new Uint8Array();
    expect(Buffer.from(png.subarray(0, 8)).toString("hex")).toBe("89504e470d0a1a0a");
    // 910 × 1287, the scan's own resolution (PNG IHDR width and height).
    expect(Buffer.from(png).readUInt32BE(16)).toBe(910);
    expect(Buffer.from(png).readUInt32BE(20)).toBe(1287);
  });
});

describe("recognizeText", () => {
  it("asks the OpenAI-compatible server with the OCR prompt and returns the text", async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const fetch = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return Response.json({ choices: [{ message: { content: "  Invoice KL-2857 \n" } }] });
    }) as typeof globalThis.fetch;
    const text = await recognizeText(config, { mime: "image/png", bytes: new Uint8Array([1, 2]) }, { fetch });
    expect(text).toBe("Invoice KL-2857");
    expect(sent).toMatchObject({ url: "http://ocr.test/v1/chat/completions", body: { temperature: 0 } });
    expect(JSON.stringify(sent)).toContain('"text":"OCR:"');
  });

  it("refuses an error answer and an empty one", async () => {
    const image = { mime: "image/png" as const, bytes: new Uint8Array([1]) };
    const failing = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    await expect(recognizeText(config, image, { fetch: failing })).rejects.toThrow("503");
    const empty = (async () => Response.json({ choices: [{ message: { content: " " } }] })) as unknown as typeof fetch;
    await expect(recognizeText(config, image, { fetch: empty })).rejects.toThrow("no text");
  });
});

describe("applyOcr", () => {
  const blobs = new Map([
    ["t/x/scan.pdf", new Uint8Array([0])],
    ["t/x/photo.png", new Uint8Array([1])],
  ]);
  const pages = async (_bytes: Uint8Array, wanted: readonly number[]) =>
    new Map(wanted.map((p) => [p, { mime: "image/png" as const, bytes: new Uint8Array([p]) }]));

  it("reads scanned pages and photos, leaves text and failed pages alone", async () => {
    const parts = [
      part({ partIndex: 0, page: 1 }),
      part({ partIndex: 1, page: 2 }),
      part({ partIndex: 2, mime: DOCUMENT_MIMES.png, page: null, storageKey: "t/x/photo.png" }),
      part({ partIndex: 3, mime: DOCUMENT_MIMES.text, page: null, text: "hello", evidenceMode: "text" }),
    ];
    const out = await applyOcr(config, parts, blobs, {
      pageImages: pages,
      recognize: async (img) => {
        if (img.bytes[0] === 2) throw new Error("timeout");
        return `text of ${img.bytes[0]}`;
      },
    });
    expect(out.parts.map((p) => [p.evidenceMode, p.text])).toEqual([
      ["ocr_text", "text of 1"],
      ["unverifiable", ""],
      ["ocr_text", "text of 1"],
      ["text", "hello"],
    ]);
    expect(out.read).toBe(2);
    expect(out.failed).toEqual([{ partIndex: 1, error: "timeout" }]);
    // The input parts are untouched.
    expect(parts[0]?.evidenceMode).toBe("unverifiable");
  });

  it("stops at the page cap and the time budget", async () => {
    const parts = [1, 2, 3].map((page) => part({ partIndex: page - 1, page }));
    const capped = await applyOcr({ ...config, maxPages: 2 }, parts, blobs, {
      pageImages: pages,
      recognize: async () => "x",
    });
    expect(capped.parts.map((p) => p.evidenceMode)).toEqual(["ocr_text", "ocr_text", "unverifiable"]);

    let clock = 0;
    const slow = await applyOcr(config, parts, blobs, {
      pageImages: pages,
      now: () => clock,
      recognize: async () => {
        clock += OCR_BUDGET_MS;
        return "x";
      },
    });
    expect(slow.read).toBe(1);
    expect(slow.failed.map((f) => f.error)).toEqual([
      expect.stringContaining("budget"),
      expect.stringContaining("budget"),
    ]);
  });
});

describe("OCR'd parts downstream", () => {
  const ocrPage = part({ text: "Invoice No.: KL-2857\nTotal due: 10,648.99 USD", evidenceMode: "ocr_text" });

  it("count as text for the evidence gate: page-scoped for a scanned PDF", () => {
    const result = verifyEvidence(
      [ocrPage],
      { invoice_number: { quote: "KL-2857", page: 1 }, total: { quote: "10,648.99", page: 2 } },
      ["invoice_number", "total"],
    );
    expect(result.unverifiable).toBe(false);
    expect(result.checks.map((c) => c.status)).toEqual(["verified", "not_found"]);
    // Without a page (a text-only model read only the OCR'd text), any OCR'd page is searched.
    const pageless = verifyEvidence([ocrPage], { total: { quote: "10,648.99 USD", page: null } }, ["total"]);
    expect(pageless.checks[0]?.status).toBe("verified");
  });

  it("go to the model as text with the original, or as text alone for a model that reads no PDFs", () => {
    const blobs = new Map([["t/x/scan.pdf", new Uint8Array([37, 80, 68, 70])]]);
    const withPdf = documentContent([ocrPage], blobs);
    expect(withPdf.map((c) => c.type)).toEqual(["text", "document"]);
    expect(withPdf[0]).toMatchObject({ text: expect.stringContaining('page="1" read="ocr">') });
    const textOnly = documentContent([ocrPage], blobs, { pdf: false, images: false });
    expect(textOnly.map((c) => c.type)).toEqual(["text"]);
  });
});
