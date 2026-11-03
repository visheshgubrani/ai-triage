import { Document, Packer, Paragraph } from "docx";
import { describe, expect, it } from "vitest";
import { imageDimensions, MAX_IMAGE_PIXELS, MAX_ZIP_UNCOMPRESSED_BYTES, zipStats } from "./limits";

/** A zip holding one entry whose central directory claims `size` uncompressed bytes. */
function zipClaiming(size: number): Uint8Array {
  const name = new TextEncoder().encode("word/document.xml");
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint32(24, size, true);
  cv.setUint16(28, name.length, true);
  central.set(name, 46);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, 0, true);
  const out = new Uint8Array(central.length + eocd.length);
  out.set(central);
  out.set(eocd, central.length);
  return out;
}

describe("zipStats", () => {
  it("reads a real DOCX's central directory", async () => {
    const doc = new Document({ sections: [{ children: [new Paragraph("Invoice 42")] }] });
    const stats = zipStats(new Uint8Array(await Packer.toBuffer(doc)));
    expect(stats?.entries).toBeGreaterThan(3);
    expect(stats?.uncompressedBytes).toBeLessThan(MAX_ZIP_UNCOMPRESSED_BYTES);
  });

  it("sees what a zip bomb claims before anything is inflated", () => {
    expect(zipStats(zipClaiming(0xfffffff0))?.uncompressedBytes).toBeGreaterThan(MAX_ZIP_UNCOMPRESSED_BYTES);
    expect(zipStats(zipClaiming(0xffffffff))?.uncompressedBytes).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns null for something that isn't a zip", () => {
    expect(zipStats(new TextEncoder().encode("not a zip at all, just text"))).toBeNull();
  });
});

describe("imageDimensions", () => {
  it("reads PNG and JPEG headers", () => {
    const png = new Uint8Array(24);
    const pv = new DataView(png.buffer);
    pv.setUint32(0, 0x89504e47);
    pv.setUint32(12, 0x49484452);
    pv.setUint32(16, 100_000);
    pv.setUint32(20, 100_000);
    const size = imageDimensions(png);
    expect(size).toEqual({ width: 100_000, height: 100_000 });
    expect((size?.width ?? 0) * (size?.height ?? 0)).toBeGreaterThan(MAX_IMAGE_PIXELS);

    // SOI, an APP0 segment of length 4, then SOF0 with height 300 and width 400.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 44, 1, 144, 3]);
    expect(imageDimensions(jpeg)).toEqual({ width: 400, height: 300 });
  });
});
