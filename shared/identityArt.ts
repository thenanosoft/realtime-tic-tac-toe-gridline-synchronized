/**
 * Generated identity (P10-01 … P10-04).
 *
 * Every player already has a temporary name - CosmicOtter, VelvetLynx - handed
 * out by the server. This module turns that name into an accent colour, a
 * symbol and a small sigil, as a pure function.
 *
 * The name is the seed, deliberately, rather than the player id. Three
 * consequences follow, and all three are the point:
 *
 *   - Both clients derive the same identity without anything new on the wire.
 *     There is no protocol change in this phase at all, which means no version
 *     skew window to manage between the two deploys (D-008).
 *   - The identity visibly belongs to the name the player is shown, instead of
 *     to a hidden id. CosmicOtter looks like CosmicOtter to both players and
 *     again after a reconnect.
 *   - Nothing is stored. The identity is recomputed from the name every time,
 *     so there is no identity record to persist, leak or have to expire.
 *
 * Everything here is bounded on purpose. Random hues would eventually produce
 * an unreadable pairing or a room that looks like a different product; a fixed
 * palette of named colours cannot.
 */

/** 32-bit FNV-1a. Small, stable, and not pretending to be a hash for secrets. */
export function seedFromName(name: string): number {
  let hash = 0x811c9dc5;
  const normalized = name.trim().toLowerCase();
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A deterministic stream of values from one seed.
 *
 * Each draw takes its own slice of the hash rather than advancing a shared
 * cursor, so adding a field later cannot change the values of the fields
 * before it - an identity that shifted when the code grew would not be the
 * same identity.
 */
function draw(seed: number, salt: number, modulo: number): number {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  // The final `>>> 0` is load-bearing: `^` yields a *signed* 32-bit integer, so
  // without it roughly half of all seeds produce a negative remainder, a
  // negative array index, and an undefined accent. Caught by asserting that
  // every name in the pool yields a complete identity rather than by spot
  // checks, which would have hit it only half the time.
  return ((value ^ (value >>> 16)) >>> 0) % modulo;
}

export interface AccentColour {
  /** Said aloud in the identity description, so the colour is never the only carrier. */
  name: string;
  /** A light tone, chosen to sit above 4.5:1 on the application ground. */
  hex: string;
  hue: number;
}

/**
 * Twelve accents, all light enough for text on the dark ground.
 *
 * Generated hues were the obvious implementation and the wrong one: the colour
 * also labels a player, so an accent that cannot be read is an identity that
 * cannot be read. These are fixed and contrast-checked by the style suite.
 */
export const ACCENTS: readonly AccentColour[] = [
  { name: 'Amber', hex: '#dfc08c', hue: 38 },
  { name: 'Apricot', hex: '#e0b093', hue: 23 },
  { name: 'Aqua', hex: '#9ad3d0', hue: 177 },
  { name: 'Cedar', hex: '#d9a68c', hue: 20 },
  { name: 'Fern', hex: '#a9cc8f', hue: 95 },
  { name: 'Indigo', hex: '#aeb6e4', hue: 231 },
  { name: 'Lilac', hex: '#cdb2de', hue: 277 },
  { name: 'Mint', hex: '#a6d6b8', hue: 143 },
  { name: 'Rose', hex: '#e2adb6', hue: 347 },
  { name: 'Sand', hex: '#d8cfa9', hue: 50 },
  { name: 'Sky', hex: '#a8c6e6', hue: 211 },
  { name: 'Slate', hex: '#b4bcc4', hue: 208 },
];

export interface IdentitySymbol {
  id: string;
  /** The description a screen reader gets. Never decorative-only (P10-03). */
  label: string;
}

export const SYMBOLS: readonly IdentitySymbol[] = [
  { id: 'orbit', label: 'orbit' },
  { id: 'delta', label: 'delta' },
  { id: 'lattice', label: 'lattice' },
  { id: 'crest', label: 'crest' },
  { id: 'spiral', label: 'spiral' },
  { id: 'beacon', label: 'beacon' },
  { id: 'anchor', label: 'anchor' },
  { id: 'prism', label: 'prism' },
];

export const SIGIL_SIZE = 5;

export interface GeneratedIdentity {
  name: string;
  seed: number;
  accent: AccentColour;
  symbol: IdentitySymbol;
  /**
   * A 5x5 grid, true where the sigil is filled, mirrored left to right.
   *
   * Symmetry is not decoration: an asymmetric 5x5 of random cells reads as
   * noise, and two noisy patterns are harder to tell apart than two symmetric
   * ones. Distinguishable at a glance is the whole job.
   */
  sigil: boolean[];
  /** The identity in words. Always present, and always sufficient on its own. */
  description: string;
}

export function deriveIdentity(name: string): GeneratedIdentity {
  const seed = seedFromName(name);
  const accent = ACCENTS[draw(seed, 1, ACCENTS.length)];
  const symbol = SYMBOLS[draw(seed, 2, SYMBOLS.length)];

  const sigil = Array<boolean>(SIGIL_SIZE * SIGIL_SIZE).fill(false);
  for (let row = 0; row < SIGIL_SIZE; row += 1) {
    for (let column = 0; column < Math.ceil(SIGIL_SIZE / 2); column += 1) {
      // The centre column is drawn slightly less often so the sigils do not all
      // end up with a solid spine.
      const bias = column === 2 ? 3 : 2;
      const filled = draw(seed, 10 + row * 3 + column, bias) === 0;
      sigil[row * SIGIL_SIZE + column] = filled;
      sigil[row * SIGIL_SIZE + (SIGIL_SIZE - 1 - column)] = filled;
    }
  }
  // A blank sigil is a valid draw and a useless avatar, so the centre is lit
  // rather than leaving a player with nothing.
  if (!sigil.some(Boolean)) sigil[Math.floor(sigil.length / 2)] = true;

  return {
    name,
    seed,
    accent,
    symbol,
    sigil,
    description: `${name}: a ${accent.name.toLowerCase()} ${symbol.label} sigil`,
  };
}

/**
 * Arena variation from both players, bounded hard (P10-04).
 *
 * Derived from the pair rather than from one player, so the room belongs to the
 * match instead of to whoever opened it. The ranges are narrow by intent: the
 * brief is subtle variation, and the test asserts the bounds rather than
 * trusting the constants, because the tempting change later is to widen them
 * "just a little" until two rooms stop looking like one product.
 */
export interface ArenaVariation {
  /** Degrees. Rotates where the ambient light falls. */
  angle: number;
  /** Percent offsets for the two ambient glows. */
  driftX: number;
  driftY: number;
  /** Multiplier on the ambient opacity, never enough to change the mood. */
  intensity: number;
  /** Degrees of hue rotation on the room ground. */
  hueShift: number;
}

export const ARENA_BOUNDS = {
  angle: [0, 360],
  driftX: [-9, 9],
  driftY: [-7, 7],
  intensity: [0.85, 1.15],
  hueShift: [-7, 7],
} as const;

export function deriveArena(names: readonly string[]): ArenaVariation {
  // Sorted, so the arena does not depend on which player the client happens to
  // list first - the two players must see the same room (INV-3 in spirit).
  const seed = [...names].sort().reduce((total, name) => (total ^ seedFromName(name)) >>> 0, 0x2545f491);
  const span = (range: readonly [number, number], value: number, steps: number) =>
    range[0] + ((range[1] - range[0]) * value) / (steps - 1);

  return {
    angle: draw(seed, 21, 360),
    driftX: Math.round(span(ARENA_BOUNDS.driftX, draw(seed, 22, 19), 19) * 10) / 10,
    driftY: Math.round(span(ARENA_BOUNDS.driftY, draw(seed, 23, 15), 15) * 10) / 10,
    intensity: Math.round(span(ARENA_BOUNDS.intensity, draw(seed, 24, 13), 13) * 100) / 100,
    hueShift: Math.round(span(ARENA_BOUNDS.hueShift, draw(seed, 25, 15), 15) * 10) / 10,
  };
}
