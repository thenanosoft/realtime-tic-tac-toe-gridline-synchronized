import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRUTAL_CHAOS, CHAOS_BUILD_MARKER, createRandom, decide, NO_CHAOS } from '../shared/chaos';
import { runChaosMatch, type SimulationResult } from './support/simulation';

describe('chaos policy determinism (P3-03)', () => {
  it('replays exactly from a seed', () => {
    const draw = (seed: number) => {
      const random = createRandom(seed);
      return Array.from({ length: 50 }, () => decide(random, BRUTAL_CHAOS));
    };
    expect(draw(1234)).toEqual(draw(1234));
    expect(draw(1234)).not.toEqual(draw(1235));
  });

  it('honours its configured bounds', () => {
    const random = createRandom(99);
    for (let index = 0; index < 2_000; index += 1) {
      const verdict = decide(random, BRUTAL_CHAOS);
      expect(verdict.delayMs).toBeGreaterThanOrEqual(BRUTAL_CHAOS.minDelayMs - BRUTAL_CHAOS.jitterMs);
      expect(verdict.delayMs).toBeLessThanOrEqual(BRUTAL_CHAOS.maxDelayMs + BRUTAL_CHAOS.jitterMs);
      expect(verdict.delayMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces no disturbance at all under NO_CHAOS', () => {
    const random = createRandom(7);
    for (let index = 0; index < 500; index += 1) {
      const verdict = decide(random, NO_CHAOS);
      expect(verdict).toMatchObject({ delayMs: 0, duplicate: false, drop: false });
    }
  });

  it('duplicates at roughly the configured rate', () => {
    const random = createRandom(31);
    const profile = { ...BRUTAL_CHAOS, duplicateRate: 0.05 };
    let duplicates = 0;
    const runs = 20_000;
    for (let index = 0; index < runs; index += 1) if (decide(random, profile).duplicate) duplicates += 1;
    const rate = duplicates / runs;
    expect(rate).toBeGreaterThan(0.04);
    expect(rate).toBeLessThan(0.06);
  });
});

describe('chaos matches (P3-04, P3-05, P3-06)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  const summarise = (seed: number, result: SimulationResult) =>
    'seed ' + seed
    + ' | finished=' + result.finished
    + ' | violations=' + JSON.stringify(result.violations)
    + ' | rejections=' + JSON.stringify(result.rejections);

  it('completes a full match at 800ms latency with +/-400ms jitter', async () => {
    const result = await runChaosMatch({ seed: 4242, profile: BRUTAL_CHAOS, advance });
    expect(summarise(4242, result)).toContain('finished=true');
    expect(result.violations).toEqual([]);
    const board = result.serverSnapshot?.board ?? [];
    expect(board.filter(Boolean).length).toBeGreaterThanOrEqual(5);
  }, 30_000);

  it('converges after duplication, reordering and repeated disconnects', async () => {
    // duplicateRate is high enough that zero duplicates is effectively
    // impossible over a match's worth of frames. Pinning a lower rate made this
    // assertion depend on one seed's incidental draw, and it broke the moment
    // optimistic moves changed how much randomness the run consumes - a fixture
    // problem masquerading as a regression.
    const result = await runChaosMatch({
      seed: 8080,
      profile: { ...BRUTAL_CHAOS, duplicateRate: 0.4 },
      disconnectRate: 0.2,
      advance,
    });
    expect(summarise(8080, result)).toContain('finished=true');
    expect(result.violations).toEqual([]);
    expect(result.disconnects).toBeGreaterThan(0);
    expect(result.duplicatesSent).toBeGreaterThan(0);
    for (const snapshot of result.clientSnapshots) {
      expect(snapshot).toEqual(result.serverSnapshot);
    }
  }, 30_000);

  it('holds every invariant across 200 seeded runs', async () => {
    // The headline claim of this phase. Runs in virtual time, so 200 matches
    // each carrying 800ms of latency cost seconds rather than an hour, and any
    // failure names the seed that reproduces it exactly.
    const failures: string[] = [];
    let converged = 0;
    let finished = 0;
    let duplicates = 0;
    let disconnects = 0;

    for (let seed = 1; seed <= 200; seed += 1) {
      const result = await runChaosMatch({
        seed,
        profile: BRUTAL_CHAOS,
        disconnectRate: seed % 4 === 0 ? 0.05 : 0,
        advance,
      });
      if (result.violations.length) failures.push(summarise(seed, result));
      duplicates += result.duplicatesSent;
      disconnects += result.disconnects;
      if (result.finished) {
        finished += 1;
        const server = JSON.stringify(result.serverSnapshot);
        if (result.clientSnapshots.every((snapshot) => JSON.stringify(snapshot) === server)) converged += 1;
      }
    }

    expect(failures, failures.slice(0, 5).join('\n')).toEqual([]);
    // Every run must actually reach a conclusion; a suite that silently stops
    // completing matches would otherwise keep reporting a clean bill of health.
    expect(finished).toBe(200);
    expect(converged).toBe(200);
    // The chaos knobs must actually be firing across the sweep. A suite that
    // quietly stopped duplicating or disconnecting would keep reporting a clean
    // bill of health while testing almost nothing.
    expect(duplicates, 'no duplicated commands across 200 runs').toBeGreaterThan(0);
    expect(disconnects, 'no disconnects across 200 runs').toBeGreaterThan(0);
  }, 180_000);

  it('reproduces a run exactly from its seed', async () => {
    const first = await runChaosMatch({ seed: 555, profile: BRUTAL_CHAOS, advance });
    const second = await runChaosMatch({ seed: 555, profile: BRUTAL_CHAOS, advance });
    expect(first.serverSnapshot?.board).toEqual(second.serverSnapshot?.board);
    expect(first.serverSnapshot?.winner).toEqual(second.serverSnapshot?.winner);
    expect(first.rejections).toEqual(second.rejections);
  }, 30_000);
});

describe('chaos transport is development-only (P3-01)', () => {
  const collect = (directory: string): string[] => {
    const entries: string[] = [];
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) entries.push(...collect(path));
      else entries.push(path);
    }
    return entries;
  };

  it('leaves no trace of the chaos transport in the production bundle', () => {
    // The guard is written inline at the call site rather than behind a helper
    // precisely so this holds: behind a function the minifier cannot prove the
    // branch is dead, and the dynamic-import chunk survives into the output.
    const root = new URL('../out', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    let files: string[];
    try {
      files = collect(root);
    } catch {
      // Skipping is correct whenever the static export has not been built - which
      // includes CI, because `npm test` runs before `build:pages` in the deploy
      // workflow. Gating this on CI alone failed the deploy for exactly that
      // reason. REQUIRE_BUILT_BUNDLE is set only by the post-build step, so the
      // assertion is strict where out/ genuinely exists and silent where it
      // cannot, without ever becoming an unnoticed no-op.
      if (process.env.REQUIRE_BUILT_BUNDLE) {
        throw new Error('out/ is missing, but REQUIRE_BUILT_BUNDLE was set: build:pages must run first');
      }
      return;
    }

    const offenders = files.filter((path) => {
      if (!/\.(js|css|html|txt|json)$/.test(path)) return false;
      const contents = readFileSync(path, 'utf8');
      return contents.includes(CHAOS_BUILD_MARKER)
        || contents.includes('createChaosSocket')
        || contents.includes('readChaosOptions');
    });

    expect(offenders, 'chaos transport leaked into: ' + offenders.join(', ')).toEqual([]);
  });
});
