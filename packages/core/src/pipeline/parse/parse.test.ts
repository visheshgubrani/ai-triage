import { describe, expect, it } from "vitest";
import { DOCUMENT_MIMES } from "../../index";
import { PipelineError } from "../errors";
import { sampleDocx, samplePdf, samplePng } from "../test/samples";
import {
  normalizeEml,
  normalizePostmark,
  parseEmail,
  parseFile,
  renderEmailBody,
  type StoredEmail,
  sniffMime,
} from "./index";

const limits = { maxPdfPages: 3 };
const file = (bytes: Uint8Array, declaredMime: string | null = null) => ({
  label: "f",
  bytes,
  declaredMime,
  storageKey: "k",
});

const reason = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err instanceof PipelineError ? err.reason : String(err);
  }
  return "no error";
};

describe("sniffMime", () => {
  it("recognizes the supported binary types by magic bytes", async () => {
    expect(sniffMime(await samplePdf([["x"]]))).toBe(DOCUMENT_MIMES.pdf);
    expect(sniffMime(await sampleDocx(["x"]))).toBe(DOCUMENT_MIMES.docx);
    expect(sniffMime(samplePng())).toBe(DOCUMENT_MIMES.png);
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(DOCUMENT_MIMES.jpeg);
    expect(sniffMime(new TextEncoder().encode("hello"))).toBeNull();
  });
});

describe("parseFile", () => {
  it("splits a text PDF into pages with pdf_text evidence", async () => {
    const lines = ["Invoice INV-1001 from Acme Supplies Ltd", "Total due: 1,250.00 USD, payable within 30 days"];
    const parts = await parseFile(
      file(await samplePdf([lines, ["Page two has terms and conditions of the sale."]])),
      limits,
    );
    expect(parts.map((p) => [p.partIndex, p.page, p.evidenceMode, p.mime])).toEqual([
      [0, 1, "pdf_text", DOCUMENT_MIMES.pdf],
      [1, 2, "pdf_text", DOCUMENT_MIMES.pdf],
    ]);
    expect(parts[0]?.text).toContain("INV-1001");
  });

  it("treats a PDF without a text layer as unverifiable, and enforces the page limit", async () => {
    const scan = await parseFile(file(await samplePdf([[], []])), limits);
    expect(scan.map((p) => p.evidenceMode)).toEqual(["unverifiable", "unverifiable"]);
    expect(await reason(parseFile(file(await samplePdf([["a"], ["b"], ["c"], ["d"]])), limits))).toBe("too_many_pages");
  });

  it("extracts DOCX text, keeps images unverifiable, and reads declared plain text", async () => {
    const [docx] = await parseFile(file(await sampleDocx(["Mutual NDA", "Effective 1 March 2026"])), limits);
    expect(docx).toMatchObject({ evidenceMode: "text", mime: DOCUMENT_MIMES.docx, page: null });
    expect(docx?.text).toContain("Effective 1 March 2026");
    expect(await parseFile(file(samplePng()), limits)).toMatchObject([{ evidenceMode: "unverifiable", text: "" }]);
    const text = new TextEncoder().encode("Order 42 is late");
    expect(await parseFile(file(text, "text/plain; charset=utf-8"), limits)).toMatchObject([
      { text: "Order 42 is late" },
    ]);
  });

  it("fails on unsupported or corrupt files", async () => {
    expect(await reason(parseFile(file(new Uint8Array([1, 2, 3])), limits))).toBe("unsupported_file");
    const corrupt = new TextEncoder().encode("%PDF-1.7 this is not really a pdf");
    expect(await reason(parseFile(file(corrupt), limits))).toBe("parse_error");
  });
});

describe("email", () => {
  it("normalizes a Postmark payload", () => {
    const email = normalizePostmark({
      MessageID: "pm-1",
      Subject: " Invoice 7 ",
      FromFull: { Email: "billing@acme.test", Name: "Acme Billing" },
      Date: "Mon, 2 Nov 2026 10:00:00 +0000",
      OriginalRecipient: "Demo@Inbound.localhost",
      ToFull: [{ Email: "demo@inbound.localhost" }],
      HtmlBody: "<p>Hello <b>there</b></p><img src='cid:logo'>",
      Headers: [{ Name: "Message-ID", Value: "<abc@acme.test>" }],
      Attachments: [
        { Name: "a.pdf", Content: Buffer.from("%PDF-").toString("base64"), ContentType: "application/pdf" },
      ],
    });
    expect(email).toMatchObject({
      messageId: "abc@acme.test",
      subject: "Invoice 7",
      from: "Acme Billing <billing@acme.test>",
      recipients: ["demo@inbound.localhost"],
      text: "Hello there",
    });
    expect(email.attachments[0]).toMatchObject({ filename: "a.pdf", mime: "application/pdf", size: 5 });
  });

  it("normalizes an .eml with an attachment", async () => {
    const eml = [
      "Message-ID: <m1@example.test>",
      "From: Jane Doe <jane@example.test>",
      "To: support@inbound.localhost",
      "Subject: Broken kettle",
      "Date: Tue, 3 Nov 2026 09:00:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "My kettle arrived broken.",
      "--b",
      'Content-Type: text/plain; name="note.txt"',
      'Content-Disposition: attachment; filename="note.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("order 55812").toString("base64"),
      "--b--",
      "",
    ].join("\r\n");
    const email = await normalizeEml(new TextEncoder().encode(eml));
    expect(email).toMatchObject({
      messageId: "m1@example.test",
      from: "Jane Doe <jane@example.test>",
      date: "Tue, 3 Nov 2026 09:00:00 +0000",
      recipients: ["support@inbound.localhost"],
      text: "My kettle arrived broken.",
    });
    expect(email.attachments).toMatchObject([{ filename: "note.txt", contentId: null }]);
  });

  it("parses the body and content attachments, skipping inline and tiny images", async () => {
    const pdf = await samplePdf([["Statement of work for the Q1 migration project, signed by both parties."]]);
    const stored: StoredEmail = {
      version: 1,
      messageId: "m",
      subject: "SOW",
      from: "a@b.test",
      date: "Mon, 2 Nov 2026",
      text: "See attached.",
      attachments: [
        {
          index: 0,
          filename: "sow.pdf",
          mime: "application/pdf",
          size: pdf.length,
          contentId: null,
          storageKey: "k/pdf",
        },
        { index: 1, filename: "logo.png", mime: "image/png", size: 50_000, contentId: "logo", storageKey: "k/logo" },
        { index: 2, filename: "pixel.png", mime: "image/png", size: 70, contentId: null, storageKey: "k/pixel" },
        { index: 3, filename: "photo.png", mime: "image/png", size: 30_000, contentId: null, storageKey: "k/photo" },
      ],
    };
    const blobs = new Map([
      ["k/pdf", pdf],
      ["k/photo", samplePng(30_000)],
    ]);
    const parts = await parseEmail(stored, blobs, limits);
    expect(parts.map((p) => [p.partIndex, p.kind, p.label, p.evidenceMode])).toEqual([
      [0, "email_body", null, "text"],
      [1, "attachment", "sow.pdf", "pdf_text"],
      [2, "attachment", "photo.png", "unverifiable"],
    ]);
    expect(parts[0]?.text).toBe(renderEmailBody(stored));
    expect(parts[0]?.text).toBe("Subject: SOW\nFrom: a@b.test\nDate: Mon, 2 Nov 2026\n\nSee attached.");
    expect(await reason(parseEmail(stored, new Map(), limits))).toBe("parse_error");
  });
});
