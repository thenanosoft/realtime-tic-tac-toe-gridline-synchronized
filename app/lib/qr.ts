/**
 * A QR encoder, written here on purpose (P8-08).
 *
 * Every hosted QR generator works by being sent the thing you want encoded. For
 * an invite URL carrying a room key in its fragment that is not a convenience,
 * it is handing the key to a third party - so the one piece of this phase that
 * looks like a UI detail is the piece that would have undone the rest. The
 * encoder is small enough to own: byte mode, error correction level M, versions
 * 1 to 10, which covers an invite URL several times over.
 */

/** Total codewords, data codewords and block layout per version at level M. */
interface VersionSpec {
  totalCodewords: number;
  /** Groups of equal-sized blocks: [blockCount, dataCodewordsPerBlock]. */
  groups: Array<[number, number]>;
  /** Centres of the alignment patterns. */
  alignment: number[];
  /** Bits of zero padding after the interleaved codewords. */
  remainderBits: number;
}

const VERSIONS: Record<number, VersionSpec> = {
  1: { totalCodewords: 26, groups: [[1, 16]], alignment: [], remainderBits: 0 },
  2: { totalCodewords: 44, groups: [[1, 28]], alignment: [6, 18], remainderBits: 7 },
  3: { totalCodewords: 70, groups: [[1, 44]], alignment: [6, 22], remainderBits: 7 },
  4: { totalCodewords: 100, groups: [[2, 32]], alignment: [6, 26], remainderBits: 7 },
  5: { totalCodewords: 134, groups: [[2, 43]], alignment: [6, 30], remainderBits: 7 },
  6: { totalCodewords: 172, groups: [[4, 27]], alignment: [6, 34], remainderBits: 7 },
  7: { totalCodewords: 196, groups: [[4, 31]], alignment: [6, 22, 38], remainderBits: 0 },
  8: { totalCodewords: 242, groups: [[2, 38], [2, 39]], alignment: [6, 24, 42], remainderBits: 0 },
  9: { totalCodewords: 292, groups: [[3, 36], [2, 37]], alignment: [6, 26, 46], remainderBits: 0 },
  10: { totalCodewords: 346, groups: [[4, 43], [1, 44]], alignment: [6, 28, 50], remainderBits: 0 },
};

export const QR_MAX_VERSION = 10;
/** 0b00 is error correction level M. */
const EC_LEVEL_BITS = 0b00;

export class QrCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrCapacityError';
  }
}

export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** Row-major, true where the module is dark. */
  modules: boolean[][];
}

// --- GF(256), the field Reed-Solomon works over ----------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    // 0x11d is the primitive polynomial the QR specification fixes.
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

function multiply(a: number, b: number): number {
  if (!a || !b) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** The degree-count generator polynomial, a product of (x - a^i). */
function generatorPolynomial(count: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < count; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= multiply(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

export function errorCorrection(data: Uint8Array, count: number): Uint8Array {
  const generator = generatorPolynomial(count);
  const remainder = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[count - 1] = 0;
    if (factor) {
      for (let i = 0; i < count; i += 1) remainder[i] ^= multiply(generator[i + 1], factor);
    }
  }
  return remainder;
}

// --- Bit stream -------------------------------------------------------------

class BitWriter {
  readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      if (bit) out[index >>> 3] |= 0x80 >>> (index & 7);
    });
    return out;
  }
}

function dataCapacity(spec: VersionSpec): number {
  return spec.groups.reduce((total, group) => total + group[0] * group[1], 0);
}

function blockCount(spec: VersionSpec): number {
  return spec.groups.reduce((total, group) => total + group[0], 0);
}

/** Bits in the character count field, which widens at version 10. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

export function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
    const available = dataCapacity(VERSIONS[version]) * 8 - 4 - countBits(version);
    if (byteLength * 8 <= available) return version;
  }
  throw new QrCapacityError('That value is too long to encode as a QR code at this error correction level.');
}

function encodeData(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = dataCapacity(VERSIONS[version]);
  const writer = new BitWriter();
  writer.push(0b0100, 4); // byte mode
  writer.push(bytes.length, countBits(version));
  for (const byte of bytes) writer.push(byte, 8);
  // Terminator, then alignment to a byte, then the two alternating pad
  // codewords the specification names.
  writer.push(0, Math.min(4, capacity * 8 - writer.bits.length));
  while (writer.bits.length % 8) writer.bits.push(0);
  const written = writer.toBytes();
  const padded = new Uint8Array(capacity);
  padded.set(written);
  for (let i = written.length; i < capacity; i += 1) {
    padded[i] = (i - written.length) % 2 === 0 ? 0xec : 0x11;
  }
  return padded;
}

/**
 * Splits into blocks, computes parity, and interleaves.
 *
 * Interleaving is what makes the error correction useful in practice: a smudge
 * over one region of the symbol is spread across every block rather than
 * destroying one of them outright.
 */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const spec = VERSIONS[version];
  const ecPerBlock = (spec.totalCodewords - dataCapacity(spec)) / blockCount(spec);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [blocks, size] of spec.groups) {
    for (let i = 0; i < blocks; i += 1) {
      const block = data.subarray(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(errorCorrection(block, ecPerBlock));
    }
  }
  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return new Uint8Array(out);
}

// --- Symbol layout ----------------------------------------------------------

type Grid = Array<Array<boolean | null>>;

function placeFixedPatterns(grid: Grid, version: number): void {
  const size = grid.length;
  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || x < 0 || y >= size || x >= size) continue;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const onRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[y][x] = inside && (onRing || inCore);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    grid[6][i] = dark;
    grid[i][6] = dark;
  }

  const centres = VERSIONS[version].alignment;
  for (const row of centres) {
    for (const col of centres) {
      // Omitted where a finder pattern already occupies the area.
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          grid[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }

  // Reserve the format areas and the always-dark module, before data is placed.
  for (let i = 0; i < 9; i += 1) {
    if (grid[8][i] === null) grid[8][i] = false;
    if (grid[i][8] === null) grid[i][8] = false;
  }
  for (let i = 0; i < 8; i += 1) {
    if (grid[8][size - 1 - i] === null) grid[8][size - 1 - i] = false;
    if (grid[size - 1 - i][8] === null) grid[size - 1 - i][8] = false;
  }
  grid[size - 8][8] = true;

  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      grid[size - 11 + col][row] = false;
      grid[row][size - 11 + col] = false;
    }
  }
}

/** The data path: two-module columns, right to left, snaking up and down. */
function placeData(grid: Grid, codewords: Uint8Array, remainderBits: number): void {
  const size = grid.length;
  const bits: number[] = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  }
  for (let i = 0; i < remainderBits; i += 1) bits.push(0);

  let index = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    // Column 6 is the vertical timing pattern; the path steps over it.
    const columnRight = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [columnRight, columnRight - 1]) {
        if (grid[row][col] !== null) continue;
        grid[row][col] = index < bits.length ? bits[index] === 1 : false;
        index += 1;
      }
    }
    upward = !upward;
  }
}

export function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return ((((row * col) % 2) + ((row * col) % 3)) % 2) === 0;
    default: return ((((row + col) % 2) + ((row * col) % 3)) % 2) === 0;
  }
}

function bchFormat(value: number): number {
  let encoded = value << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if (encoded & (1 << (i + 10))) encoded ^= 0x537 << i;
  }
  // The final XOR is there so an all-zero format is not a valid pattern.
  return ((value << 10) | encoded) ^ 0x5412;
}

function bchVersion(version: number): number {
  let encoded = version << 12;
  for (let i = 5; i >= 0; i -= 1) {
    if (encoded & (1 << (i + 12))) encoded ^= 0x1f25 << i;
  }
  return (version << 12) | encoded;
}

function writeFormat(modules: boolean[][], mask: number, version: number): void {
  const size = modules.length;
  const format = bchFormat((EC_LEVEL_BITS << 3) | mask);
  const bit = (position: number) => ((format >>> position) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) modules[8][i] = bit(i);
  modules[8][7] = bit(6);
  modules[8][8] = bit(7);
  modules[7][8] = bit(8);
  for (let i = 9; i <= 14; i += 1) modules[14 - i][8] = bit(i);
  for (let i = 0; i <= 7; i += 1) modules[size - 1 - i][8] = bit(i);
  for (let i = 8; i <= 14; i += 1) modules[8][size - 15 + i] = bit(i);
  modules[size - 8][8] = true;

  if (version >= 7) {
    const info = bchVersion(version);
    for (let i = 0; i < 18; i += 1) {
      const on = ((info >>> i) & 1) === 1;
      modules[Math.floor(i / 3)][size - 11 + (i % 3)] = on;
      modules[size - 11 + (i % 3)][Math.floor(i / 3)] = on;
    }
  }
}

/**
 * The four penalty rules from the specification.
 *
 * Choosing the lowest-penalty mask is not cosmetic. A symbol whose data happens
 * to mask into long runs, or into something resembling a finder pattern, is the
 * one a phone camera fails to read - and that failure would look to the user
 * like the invitation being broken.
 */
export function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  const scoreLine = (get: (index: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) {
        run += 1;
        continue;
      }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    if (run >= 5) score += 3 + (run - 5);
  };
  for (let i = 0; i < size; i += 1) {
    scoreLine((j) => modules[i][j]);
    scoreLine((j) => modules[j][i]);
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = modules[row][col];
      if (
        value === modules[row][col + 1]
        && value === modules[row + 1][col]
        && value === modules[row + 1][col + 1]
      ) score += 3;
    }
  }

  const finderLike = [true, false, true, true, true, false, true, false, false, false, false];
  const run = (get: (index: number) => boolean, start: number, reversed: boolean) => {
    for (let i = 0; i < 11; i += 1) {
      if (get(start + (reversed ? 10 - i : i)) !== finderLike[i]) return false;
    }
    return true;
  };
  for (let i = 0; i < size; i += 1) {
    for (let start = 0; start + 11 <= size; start += 1) {
      for (const reversed of [false, true]) {
        if (run((j) => modules[i][j], start, reversed)) score += 40;
        if (run((j) => modules[j][i], start, reversed)) score += 40;
      }
    }
  }

  const dark = modules.reduce((total, row) => total + row.filter(Boolean).length, 0);
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

export function encodeQr(value: string): QrCode {
  const bytes = new TextEncoder().encode(value);
  const version = chooseVersion(bytes.length);
  const codewords = interleave(encodeData(bytes, version), version);
  const size = 17 + version * 4;

  const template: Grid = Array.from({ length: size }, () => (
    Array.from({ length: size }, () => null as boolean | null)
  ));
  placeFixedPatterns(template, version);
  const reserved = template.map((row) => row.map((cell) => cell !== null));
  placeData(template, codewords, VERSIONS[version].remainderBits);

  let best: QrCode | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = template.map((row, rowIndex) => row.map((cell, colIndex) => (
      // Function patterns are never masked.
      reserved[rowIndex][colIndex] ? cell === true : (cell === true) !== maskBit(mask, rowIndex, colIndex)
    )));
    writeFormat(modules, mask, version);
    const score = penalty(modules);
    if (score < bestScore) {
      bestScore = score;
      best = { version, size, mask, modules };
    }
  }
  if (!best) throw new QrCapacityError('No mask could be applied.');
  return best;
}

/**
 * An SVG path covering every dark module, as a single d attribute.
 *
 * One path rather than a few hundred rects: the difference is a few kilobytes
 * of DOM per render, in a dialog that gets opened and closed repeatedly.
 */
export function qrSvgPath(code: QrCode): string {
  const segments: string[] = [];
  for (let row = 0; row < code.size; row += 1) {
    for (let col = 0; col < code.size; col += 1) {
      if (code.modules[row][col]) segments.push('M' + col + ' ' + row + 'h1v1h-1z');
    }
  }
  return segments.join('');
}
