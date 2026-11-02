import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";

const FIXED_DATE = new Date("2026-10-01T00:00:00Z");

/**
 * Renders lines to a text PDF. A line starting with "# " is a bold heading; "---" starts a new page.
 * Long lines wrap. Metadata dates are fixed so the bytes don't depend on when this runs.
 */
export async function renderPdf(lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setProducer("ai-triage fixtures");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let y = 790;
  const draw = (text: string, font: PDFFont, size: number) => {
    for (const line of wrap(text, font, size, 495)) {
      if (y < 60) {
        page = pdf.addPage([595, 842]);
        y = 790;
      }
      page.drawText(line, { x: 50, y, size, font });
      y -= size + 5;
    }
  };
  for (const line of lines) {
    if (line === "---") {
      page = pdf.addPage([595, 842]);
      y = 790;
    } else if (line.startsWith("# ")) {
      y -= 4;
      draw(line.slice(2), bold, 14);
      y -= 4;
    } else if (line === "") {
      y -= 8;
    } else {
      draw(line, regular, 10.5);
    }
  }
  return pdf.save({ useObjectStreams: false });
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && current) {
      out.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  out.push(current);
  return out;
}

export async function renderDocx(lines: string[]): Promise<Uint8Array> {
  const doc = new Document({
    creator: "ai-triage fixtures",
    sections: [
      {
        children: lines
          .filter((l) => l !== "---")
          .map((l) =>
            l.startsWith("# ")
              ? new Paragraph({ children: [new TextRun({ text: l.slice(2), bold: true, size: 28 })] })
              : new Paragraph({ children: [new TextRun(l)] }),
          ),
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** Rasterizes the first page of a PDF to PNG with poppler's pdftoppm (a dev-only tool). */
export function rasterize(pdf: Uint8Array, dpi = 110): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "scan-"));
  try {
    writeFileSync(join(dir, "in.pdf"), pdf);
    execFileSync("pdftoppm", [
      "-png",
      "-r",
      String(dpi),
      "-singlefile",
      "-gray",
      join(dir, "in.pdf"),
      join(dir, "out"),
    ]);
    return new Uint8Array(readFileSync(join(dir, "out.png")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A PDF with no text layer: the PNG as the only content of one page, like a scanner produces. */
export async function imageOnlyPdf(png: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setProducer("ai-triage fixtures scanner");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const image = await pdf.embedPng(png);
  const page = pdf.addPage([595, 842]);
  page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  return pdf.save({ useObjectStreams: false });
}

export interface MailInput {
  id: string;
  from: { name: string; email: string };
  to: string;
  subject: string;
  date: string;
  text: string;
  html?: string;
  attachments?: { name: string; contentType: string; bytes: Uint8Array }[];
}

/** A Postmark inbound webhook payload, as Postmark would POST it. */
export function postmarkPayload(m: MailInput) {
  return {
    FromName: m.from.name,
    MessageStream: "inbound",
    From: m.from.email,
    FromFull: { Email: m.from.email, Name: m.from.name, MailboxHash: "" },
    To: m.to,
    ToFull: [{ Email: m.to, Name: "", MailboxHash: "" }],
    OriginalRecipient: m.to,
    Subject: m.subject,
    MessageID: `fixture-${m.id}`,
    Date: m.date,
    TextBody: m.text,
    HtmlBody: m.html ?? "",
    StrippedTextReply: "",
    Tag: "",
    Headers: [{ Name: "Message-ID", Value: `<${m.id}@mail.fixtures.test>` }],
    Attachments: (m.attachments ?? []).map((a) => ({
      Name: a.name,
      Content: Buffer.from(a.bytes).toString("base64"),
      ContentType: a.contentType,
      ContentLength: a.bytes.length,
    })),
  };
}

/** The same message as an .eml file (plain-text body, no attachments). */
export function emlFile(m: MailInput): Uint8Array {
  return new TextEncoder().encode(
    [
      `Message-ID: <${m.id}@mail.fixtures.test>`,
      `From: ${m.from.name} <${m.from.email}>`,
      `To: ${m.to}`,
      `Subject: ${m.subject}`,
      `Date: ${m.date}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      m.text,
      "",
    ].join("\r\n"),
  );
}
