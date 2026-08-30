/**
 * Deterministic network-chaos policy.
 *
 * The policy is pure and seeded so that a failing chaos run can be replayed
 * exactly from its seed. It is shared by the browser transport (`?chaos=1`,
 * development only) and by the headless simulation, so both exercise the same
 * decision logic rather than two hand-written approximations of it.
 *
 * Nothing here performs I/O or reads a clock. Callers supply the transport.
 */

export interface ChaosProfile {
  /** Any 32-bit integer. The same seed always produces the same run. */
  seed: number;
  /** Inclusive lower bound of the base one-way delay. */
  minDelayMs: number;
  /** Inclusive upper bound of the base one-way delay. */
  maxDelayMs: number;
  /** Symmetric jitter added to each delay, in the range [-jitterMs, +jitterMs]. */
  jitterMs: number;
  /** Probability in [0,1] that an outbound command is delivered twice. */
  duplicateRate: number;
  /** Probability in [0,1] that a frame is lost, modelling a socket dying mid-send. */
  dropRate: number;
}

/** The brief's headline configuration: 800ms latency with +/-400ms jitter. */
export const BRUTAL_CHAOS: ChaosProfile = {
  seed: 1,
  minDelayMs: 800,
  maxDelayMs: 800,
  jitterMs: 400,
  duplicateRate: 0.05,
  dropRate: 0,
};

/** The default for the browser's `?chaos=1`: a wide, uncomfortable spread. */
export const BROWSER_CHAOS: ChaosProfile = {
  seed: 1,
  minDelayMs: 200,
  maxDelayMs: 1_200,
  jitterMs: 200,
  duplicateRate: 0.05,
  dropRate: 0,
};

export const NO_CHAOS: ChaosProfile = {
  seed: 1,
  minDelayMs: 0,
  maxDelayMs: 0,
  jitterMs: 0,
  duplicateRate: 0,
  dropRate: 0,
};

export interface ChaosDecision {
  /** Delay before this frame is delivered. Never negative. */
  delayMs: number;
  /** Deliver a second identical copy, after its own independent delay. */
  duplicate: boolean;
  /** Never deliver this frame at all. */
  drop: boolean;
  /** Delay for the duplicate copy, meaningful only when `duplicate` is true. */
  duplicateDelayMs: number;
}

export type Random = () => number;

/**
 * mulberry32. Small, fast, and good enough for transport chaos - the property
 * that matters here is exact reproducibility from a seed, not cryptographic
 * quality.
 */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function delayFor(random: Random, profile: ChaosProfile): number {
  const span = Math.max(0, profile.maxDelayMs - profile.minDelayMs);
  const base = profile.minDelayMs + random() * span;
  const jitter = (random() * 2 - 1) * profile.jitterMs;
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Decides the fate of one frame.
 *
 * Delays are drawn independently per frame, which is what produces reordering:
 * no explicit "shuffle" step is needed, and the resulting order is the one a
 * genuinely variable link would produce.
 */
export function decide(random: Random, profile: ChaosProfile): ChaosDecision {
  const delayMs = delayFor(random, profile);
  const drop = random() < profile.dropRate;
  const duplicate = !drop && random() < profile.duplicateRate;
  const duplicateDelayMs = duplicate ? delayFor(random, profile) : 0;
  return { delayMs, duplicate, drop, duplicateDelayMs };
}

/**
 * Marker used to prove chaos code is absent from a production bundle.
 *
 * Deliberately a string no other part of the app would contain, so the build
 * assertion in `tests/chaos.test.ts` cannot pass by accident.
 */
export const CHAOS_BUILD_MARKER = 'gridline-chaos-transport-b7f3';
