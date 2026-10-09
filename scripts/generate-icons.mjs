#!/usr/bin/env node
/**
 * Draws the PWA icons (P11-08).
 *
 * Written rather than installed. The alternatives were an image-processing
 * dependency the project does not otherwise need, or a hosted icon generator -
 * and this repository has spent two phases establishing that sending things to
 * a service you do not need is a cost, not a convenience. A PNG is a signature,
 * three chunks and a CRC; the mark is nine squares. Both are small enough to own.
 *
 * Output is committed, so a build never depends on running this.
 *
 *   node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const GROUND = [0x0a, 0x0b, 0x0e];
const LINE = [0x2a, 0x2d, 0x33];
const SIGNAL = [0xd9, 0xdf, 0xb2];
const MARK_X = [0xd9, 0x82, 0x71];
const MARK_O = [0x8d, 0xbf, 0xc0];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes RGB pixel data as a PNG. Filter 0 on every scanline: no guessing. */
function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixels(x, y);
      const at = rowStart + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The mark: a 3x3 grid with one X and one O on the diagonal.
 *
 * `padding` exists for the maskable variant. A maskable icon can be cropped to
 * a circle by the launcher, so the mark has to sit inside the safe area or the
 * corners of the grid get shaved off.
 */
function drawIcon(size, padding) {
  const inset = Math.round(size * padding);
  const span = size - inset * 2;
  const cell = span / 3;
  const stroke = Math.max(2, Math.round(size * 0.022));

  return (x, y) => {
    const gx = x - inset;
    const gy = y - inset;
    if (gx < 0 || gy < 0 || gx >= span || gy >= span) return GROUND;

    // Grid lines.
    for (let line = 1; line <= 2; line += 1) {
      const at = cell * line;
      if (Math.abs(gx - at) < stroke / 2 || Math.abs(gy - at) < stroke / 2) return LINE;
    }

    const column = Math.min(2, Math.floor(gx / cell));
    const row = Math.min(2, Math.floor(gy / cell));
    const cx = gx - (column + 0.5) * cell;
    const cy = gy - (row + 0.5) * cell;
    const radius = cell * 0.27;

    // A cross in the centre, a ring in the top left, and the signal dot bottom
    // right: enough to read as this product at 48 pixels.
    if (row === 1 && column === 1) {
      const arm = cell * 0.3;
      const thickness = stroke * 1.6;
      const rotatedX = (cx + cy) / Math.SQRT2;
      const rotatedY = (cx - cy) / Math.SQRT2;
      if ((Math.abs(rotatedX) < thickness && Math.abs(rotatedY) < arm)
        || (Math.abs(rotatedY) < thickness && Math.abs(rotatedX) < arm)) return MARK_X;
      return GROUND;
    }
    if (row === 0 && column === 0) {
      const distance = Math.hypot(cx, cy);
      if (distance < radius && distance > radius - stroke * 1.6) return MARK_O;
      return GROUND;
    }
    if (row === 2 && column === 2) {
      if (Math.hypot(cx, cy) < radius * 0.42) return SIGNAL;
      return GROUND;
    }
    return GROUND;
  };
}

const targets = [
  ['icon-192.png', 192, 0.14],
  ['icon-512.png', 512, 0.14],
  // ~20% padding keeps the mark inside the maskable safe area.
  ['icon-maskable-512.png', 512, 0.2],
  ['apple-touch-icon.png', 180, 0.12],
];

for (const [name, size, padding] of targets) {
  writeFileSync(join(OUT, name), encodePng(size, size, drawIcon(size, padding)));
  console.log('wrote public/' + name);
}
