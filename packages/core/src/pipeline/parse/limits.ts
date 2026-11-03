// Parser limits on hostile files (docs/security.md, M5). Both checks read only headers, before
// anything is decompressed or decoded.

/** A DOCX (a zip) may hold at most this many entries and this much uncompressed data. */
export const MAX_ZIP_ENTRIES = 5000;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 2 ** 20;
/** Images above this many pixels are refused (decompression bombs, and providers reject them anyway). */
export const MAX_IMAGE_PIXELS = 40_000_000;

/**
 * Entry count and total uncompressed size from a zip's central directory, or null when the file
 * isn't a readable zip. ZIP64 sizes (0xFFFFFFFF) count as infinite: no DOCX needs them.
 */
export function zipStats(bytes: Uint8Array): { entries: number; uncompressedBytes: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  let uncompressedBytes = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const size = view.getUint32(offset + 24, true);
    uncompressedBytes += size === 0xffffffff ? Number.POSITIVE_INFINITY : size;
    offset +=
      46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return { entries, uncompressedBytes };
}

/** Width and height from a PNG's IHDR or a JPEG's first SOF marker, or null if not found. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1] ?? 0;
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return null;
}
