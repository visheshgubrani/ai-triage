import { describe, expect, it } from "vitest";
import { effectiveMime } from "./sniff";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("effectiveMime", () => {
  it("keeps a declared type, so a mislabelled file is still refused", () => {
    expect(effectiveMime("application/pdf; charset=binary", bytes("%PDF-1.7"), "a.pdf")).toBe("application/pdf");
    expect(effectiveMime("application/zip", bytes("%PDF-1.7"), "a.pdf")).toBe("application/zip");
  });

  it("reads the type of an undeclared or octet-stream file from its first bytes", () => {
    expect(effectiveMime("application/octet-stream", bytes("%PDF-1.7\n…"), "invoice.pdf")).toBe("application/pdf");
    expect(effectiveMime(null, bytes("%PDF-1.4"), null)).toBe("application/pdf");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    expect(effectiveMime("", png, "scan")).toBe("image/png");
    expect(effectiveMime(null, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "photo.jpg")).toBe("image/jpeg");
  });

  it("needs the name for DOCX and text, and the content to match", () => {
    expect(effectiveMime(null, bytes("PK\u0003\u0004…"), "terms.docx")).toContain("wordprocessingml");
    expect(effectiveMime(null, bytes("PK\u0003\u0004…"), "archive.zip")).toBeNull();
    expect(effectiveMime("application/octet-stream", bytes("Invoice INV-1"), "invoice.txt")).toBe("text/plain");
    expect(effectiveMime(null, new Uint8Array([0x41, 0, 0x42]), "data.txt")).toBeNull();
    expect(effectiveMime("application/octet-stream", bytes("hello"), "a.bin")).toBe("application/octet-stream");
  });
});
