import type { SupportedImageMime } from './protocol';

/**
 * Format sniffing, shared between server and client.
 *
 * It lived on the server while the server could read every attachment. Under
 * Phase 8 encryption it cannot: the bytes arriving are ciphertext, so the only
 * place a magic number can be checked is the receiving client, after it
 * decrypts. The check did not get weaker - it moved to the only party still
 * able to perform it.
 */
export interface InspectedImage {
  mime: SupportedImageMime;
  width: number;
  height: number;
}

export function inspectImage(bytes: Uint8Array): InspectedImage | null {
  if (
    bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    && ascii(bytes, 12, 16) === 'IHDR'
  ) {
    return { mime: 'image/png', width: uint32Be(bytes, 16), height: uint32Be(bytes, 20) };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      if (marker === 0xda) break;
      const segmentLength = uint16Be(bytes, offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;
      if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
        return {
          mime: 'image/jpeg',
          width: uint16Be(bytes, offset + 7),
          height: uint16Be(bytes, offset + 5),
        };
      }
      offset += 2 + segmentLength;
    }
    return null;
  }

  if (
    bytes.length >= 30
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const chunkType = ascii(bytes, 12, 16);
    if (chunkType === 'VP8X') {
      return {
        mime: 'image/webp',
        width: uint24Le(bytes, 24) + 1,
        height: uint24Le(bytes, 27) + 1,
      };
    }
    if (chunkType === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        mime: 'image/webp',
        width: uint16Le(bytes, 26) & 0x3fff,
        height: uint16Le(bytes, 28) & 0x3fff,
      };
    }
    if (chunkType === 'VP8L' && bytes[20] === 0x2f) {
      const dimensions = uint32Le(bytes, 21);
      return {
        mime: 'image/webp',
        width: (dimensions & 0x3fff) + 1,
        height: ((dimensions >>> 14) & 0x3fff) + 1,
      };
    }
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function uint16Be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]
  ) >>> 0;
}

function uint32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    + (bytes[offset + 1] << 8)
    + (bytes[offset + 2] << 16)
    + bytes[offset + 3] * 0x1000000
  ) >>> 0;
}
