import { describe, expect, it } from 'vitest';
import {
  ACCENTS,
  ARENA_BOUNDS,
  SIGIL_SIZE,
  SYMBOLS,
  deriveArena,
  deriveIdentity,
  seedFromName,
} from '../shared/identityArt';
import { BOARD_CLEARANCE, REACTION_SIZE, clearsBoard, reactionPath } from '../app/lib/reactionPath';
import { generateTemporaryName } from '../server/rooms/identity';

/**
 * Generated identity, arena variation and the reaction path (Phase 10).
 *
 * The two properties worth testing are the ones that would fail silently:
 * an identity that is not actually deterministic, and a reaction that drifts
 * over a cell someone is about to click. Both are checked across the whole
 * input space rather than on an example.
 */

/** Every name the server can issue: 24 adjectives x 20 animals. */
const ALL_NAMES = (() => {
  const names: string[] = [];
  for (let index = 0; index < 480; index += 1) {
    names.push(generateTemporaryName(new Set(), () => index));
  }
  return [...new Set(names)];
})();

describe('deterministic identity (P10-01, P10-02)', () => {
  it('derives the same identity from the same name, every time', () => {
    for (const name of ALL_NAMES.slice(0, 40)) {
      const first = deriveIdentity(name);
      const second = deriveIdentity(name);
      expect(second).toEqual(first);
      // And again from a fresh seed computation, so the determinism is in the
      // function rather than in a cache it happens to keep.
      expect(seedFromName(name)).toBe(first.seed);
    }
  });

  it('ignores case and surrounding whitespace, because the name is the seed', () => {
    const plain = deriveIdentity('CosmicOtter');
    expect(deriveIdentity('  cosmicotter ').sigil).toEqual(plain.sigil);
    expect(deriveIdentity('COSMICOTTER').accent).toEqual(plain.accent);
  });

  it('gives different names different identities', () => {
    const signatures = new Set(ALL_NAMES.map((name) => {
      const identity = deriveIdentity(name);
      return identity.accent.name + '/' + identity.symbol.id + '/' + identity.sigil.map(Number).join('');
    }));
    // Not a uniqueness guarantee - 480 names over a bounded palette will
    // collide - but two players in one room need to look different, and a
    // generator that produced three outcomes in total would pass a
    // determinism test while failing at its actual job.
    expect(signatures.size).toBeGreaterThan(400);
  });

  it('uses the whole palette rather than a corner of it', () => {
    const accents = new Set(ALL_NAMES.map((name) => deriveIdentity(name).accent.name));
    const symbols = new Set(ALL_NAMES.map((name) => deriveIdentity(name).symbol.id));
    expect(accents.size).toBe(ACCENTS.length);
    expect(symbols.size).toBe(SYMBOLS.length);
  });

  it('draws a symmetric, non-empty sigil', () => {
    for (const name of ALL_NAMES) {
      const { sigil } = deriveIdentity(name);
      expect(sigil).toHaveLength(SIGIL_SIZE * SIGIL_SIZE);
      // A blank sigil is a valid draw and a useless avatar.
      expect(sigil.some(Boolean)).toBe(true);
      for (let row = 0; row < SIGIL_SIZE; row += 1) {
        for (let column = 0; column < SIGIL_SIZE; column += 1) {
          const mirrored = sigil[row * SIGIL_SIZE + (SIGIL_SIZE - 1 - column)];
          expect(sigil[row * SIGIL_SIZE + column]).toBe(mirrored);
        }
      }
    }
  });
});

describe('identity is textual first (P10-03)', () => {
  it('names the accent and the symbol in words for every identity', () => {
    for (const name of ALL_NAMES) {
      const identity = deriveIdentity(name);
      // The colour is never the only carrier: it has a name, and that name is
      // in the description a screen reader receives.
      expect(identity.accent.name).toMatch(/^[A-Z][a-z]+$/);
      expect(identity.symbol.label).toMatch(/^[a-z]+$/);
      expect(identity.description).toContain(name);
      expect(identity.description).toContain(identity.accent.name.toLowerCase());
      expect(identity.description).toContain(identity.symbol.label);
    }
  });

  it('keeps every accent readable on the application ground', () => {
    // The palette is fixed rather than generated precisely so this can be
    // asserted. A random hue would eventually produce an identity colour that
    // cannot be read, which is an identity that cannot be read.
    const channel = (value: number) => {
      const s = value / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ground = luminance('#101216');
    for (const accent of ACCENTS) {
      expect(accent.hex).toMatch(/^#[0-9a-f]{6}$/);
      const ratio = (luminance(accent.hex) + 0.05) / (ground + 0.05);
      expect(ratio, accent.name + ' at ' + ratio.toFixed(2) + ':1').toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('procedural arena variation (P10-04)', () => {
  it('stays inside its declared bounds for every pairing', () => {
    for (let i = 0; i < 60; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        const arena = deriveArena([ALL_NAMES[i], ALL_NAMES[(i * 7 + j * 31) % ALL_NAMES.length]]);
        expect(arena.angle).toBeGreaterThanOrEqual(ARENA_BOUNDS.angle[0]);
        expect(arena.angle).toBeLessThanOrEqual(ARENA_BOUNDS.angle[1]);
        expect(arena.driftX).toBeGreaterThanOrEqual(ARENA_BOUNDS.driftX[0]);
        expect(arena.driftX).toBeLessThanOrEqual(ARENA_BOUNDS.driftX[1]);
        expect(arena.driftY).toBeGreaterThanOrEqual(ARENA_BOUNDS.driftY[0]);
        expect(arena.driftY).toBeLessThanOrEqual(ARENA_BOUNDS.driftY[1]);
        expect(arena.intensity).toBeGreaterThanOrEqual(ARENA_BOUNDS.intensity[0]);
        expect(arena.intensity).toBeLessThanOrEqual(ARENA_BOUNDS.intensity[1]);
        expect(arena.hueShift).toBeGreaterThanOrEqual(ARENA_BOUNDS.hueShift[0]);
        expect(arena.hueShift).toBeLessThanOrEqual(ARENA_BOUNDS.hueShift[1]);
      }
    }
  });

  it('does not depend on which player is listed first', () => {
    // Both clients must see the same room. Snapshot order is sorted by mark, so
    // this would not break today - but an arena derived from arrival order
    // would be a divergence waiting for the first refactor.
    const a = deriveArena(['CosmicOtter', 'VelvetLynx']);
    const b = deriveArena(['VelvetLynx', 'CosmicOtter']);
    expect(b).toEqual(a);
  });

  it('actually varies between rooms', () => {
    const variations = new Set(ALL_NAMES.slice(0, 80).map((name) => {
      const arena = deriveArena([name, 'CosmicOtter']);
      return [arena.angle, arena.driftX, arena.driftY, arena.intensity, arena.hueShift].join('/');
    }));
    expect(variations.size).toBeGreaterThan(60);
  });

  it('varies when a waiting room gains its second player', () => {
    // Not a correctness property, just the one that makes the feature visible:
    // the arena belongs to the match, so it should change when the match does.
    expect(deriveArena(['CosmicOtter'])).not.toEqual(deriveArena(['CosmicOtter', 'VelvetLynx']));
  });
});

describe('the reaction path never crosses the board (P10-05, P10-06)', () => {
  it('keeps the whole glyph clear of the cells along the entire path', () => {
    for (const side of ['x', 'o'] as const) {
      for (let step = 0; step <= 1_000; step += 1) {
        const point = reactionPath(step / 1_000, side);
        expect(clearsBoard(point), side + ' at ' + (step / 1_000) + ' -> x=' + point.x).toBe(true);
      }
    }
  });

  it('clamps progress rather than extrapolating past the ends', () => {
    // A timer that overruns by a frame must not fling the glyph across the
    // board, which is exactly what an unclamped lerp would do.
    expect(reactionPath(-4, 'x')).toEqual(reactionPath(0, 'x'));
    expect(reactionPath(9, 'o')).toEqual(reactionPath(1, 'o'));
    expect(clearsBoard(reactionPath(-4, 'o'))).toBe(true);
    expect(clearsBoard(reactionPath(9, 'x'))).toBe(true);
  });

  it('arrives from the sender’s own side', () => {
    // The point of the animation: a reaction comes from the opponent, so it
    // has to come from where the opponent is.
    expect(reactionPath(0.5, 'x').x).toBeLessThan(0);
    expect(reactionPath(0.5, 'o').x).toBeGreaterThan(1);
    // Mirrored exactly, so neither side gets a longer run-up.
    const left = reactionPath(0.5, 'x');
    const right = reactionPath(0.5, 'o');
    expect(right.x + REACTION_SIZE).toBeCloseTo(1 - left.x, 10);
    expect(right.y).toBe(left.y);
  });

  it('travels toward the board and fades at both ends', () => {
    const start = reactionPath(0, 'x');
    const middle = reactionPath(0.5, 'x');
    const end = reactionPath(1, 'x');
    expect(middle.x).toBeGreaterThan(start.x);
    expect(end.x).toBeGreaterThan(middle.x);
    // And stops at the clearance line rather than at the board edge.
    expect(end.x + REACTION_SIZE).toBeLessThanOrEqual(-BOARD_CLEARANCE);
    expect(start.opacity).toBeLessThan(0.01);
    expect(end.opacity).toBeLessThan(0.01);
    expect(middle.opacity).toBeGreaterThan(0.9);
    // Rising as it goes, so two reactions in quick succession do not overlap.
    expect(end.y).toBeLessThan(start.y);
  });
});
