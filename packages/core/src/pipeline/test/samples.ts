import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";

// In-memory sample files for unit tests (the committed fixtures live in /fixtures).

/** A PDF with one text page per entry; an empty string makes a page with no text layer. */
export async function samplePdf(pages: string[][]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = pdf.addPage([595, 842]);
    lines.forEach((line, i) => {
      page.drawText(line, { x: 50, y: 780 - i * 18, size: 11, font });
    });
    if (lines.length === 0) page.drawRectangle({ x: 50, y: 50, width: 400, height: 600, borderWidth: 1 });
  }
  return pdf.save({ useObjectStreams: false });
}

export async function sampleDocx(paragraphs: string[]): Promise<Uint8Array> {
  const doc = new Document({
    sections: [{ children: paragraphs.map((p) => new Paragraph({ children: [new TextRun(p)] })) }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** A valid 1x1 PNG, padded with a tEXt chunk to `size` bytes when given. */
export function samplePng(size = 0): Uint8Array {
  const base = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
    "hex",
  );
  return new Uint8Array(size > base.length ? Buffer.concat([base, Buffer.alloc(size - base.length)]) : base);
}
