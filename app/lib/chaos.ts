import {
  BROWSER_CHAOS,
  CHAOS_BUILD_MARKER,
  createRandom,
  decide,
  type ChaosProfile,
  type Random,
} from '../../shared/chaos';

/**
 * Development-only chaos transport, reached via `?chaos=1`.
 *
 * This module is loaded through a dynamic `import()` that sits inside a branch
 * which constant-folds to `false` in a production build, so it never reaches
 * the shipped bundle. `tests/chaos.test.ts` asserts that by grepping the built
 * output for CHAOS_BUILD_MARKER.
 *
 * The wrapper presents the subset of the WebSocket surface the socket hook
 * actually uses, so the hook is unaware it is talking through a degraded link -
 * which is the point. Chaos that the application can detect proves nothing.
 */

type Listener = (event: never) => void;

const OPEN = 1;

export interface ChaosSocketOptions extends Partial<ChaosProfile> {
  /** Probability per received frame of the socket being cut. */
  disconnectRate?: number;
}

export function readChaosOptions(search: string): ChaosSocketOptions | null {
  const params = new URLSearchParams(search);
  if (params.get('chaos') !== '1') return null;
  const number = (key: string, fallback: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    seed: number('seed', Math.floor(Math.random() * 0xffffffff)),
    minDelayMs: number('minDelay', BROWSER_CHAOS.minDelayMs),
    maxDelayMs: number('maxDelay', BROWSER_CHAOS.maxDelayMs),
    jitterMs: number('jitter', BROWSER_CHAOS.jitterMs),
    duplicateRate: number('duplicate', BROWSER_CHAOS.duplicateRate),
    dropRate: number('drop', BROWSER_CHAOS.dropRate),
    disconnectRate: number('disconnect', 0.02),
  };
}

/**
 * Wraps a real WebSocket with independent per-frame delay, duplication, loss
 * and abrupt disconnection.
 *
 * Delays are drawn per frame rather than per connection, so reordering emerges
 * naturally instead of being injected as a separate step.
 */
class ChaosSocket {
  private readonly socket: WebSocket;
  private readonly random: Random;
  private readonly profile: ChaosProfile;
  private readonly disconnectRate: number;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(url: string, options: ChaosSocketOptions) {
    this.profile = { ...BROWSER_CHAOS, ...options };
    this.disconnectRate = options.disconnectRate ?? 0;
    this.random = createRandom(this.profile.seed);
    this.socket = new WebSocket(url);

    this.socket.addEventListener('open', (event) => this.emit('open', event));
    this.socket.addEventListener('error', (event) => this.emit('error', event));
    this.socket.addEventListener('close', (event) => {
      this.clearTimers();
      this.emit('close', event);
    });
    this.socket.addEventListener('message', (event) => {
      const verdict = decide(this.random, this.profile);
      if (verdict.drop) return;
      if (this.disconnectRate > 0 && this.random() < this.disconnectRate) {
        // 1006-style abrupt loss, so the hook's reconnect path is exercised
        // rather than its clean-shutdown path.
        this.schedule(() => this.socket.close(4009, 'chaos disconnect'), verdict.delayMs);
        return;
      }
      this.schedule(() => this.emit('message', event), verdict.delayMs);
      if (verdict.duplicate) this.schedule(() => this.emit('message', event), verdict.duplicateDelayMs);
    });

    if (typeof console !== 'undefined') {
      console.info(
        '%c' + CHAOS_BUILD_MARKER,
        'color:#d9dfb2',
        'chaos transport active - seed',
        this.profile.seed,
      );
    }
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string): void {
    const verdict = decide(this.random, this.profile);
    if (verdict.drop) return;
    this.schedule(() => {
      if (this.socket.readyState === OPEN) this.socket.send(data);
    }, verdict.delayMs);
    if (verdict.duplicate) {
      this.schedule(() => {
        if (this.socket.readyState === OPEN) this.socket.send(data);
      }, verdict.duplicateDelayMs);
    }
  }

  close(code?: number, reason?: string): void {
    this.clearTimers();
    this.socket.close(code, reason);
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? new Set<Listener>();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  private schedule(action: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      action();
    }, delayMs);
    this.timers.add(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) (listener as (value: unknown) => void)(event);
  }
}

export function createChaosSocket(url: string, options: ChaosSocketOptions): WebSocket {
  // The hook only uses readyState, send, close and addEventListener. Presenting
  // the wrapper as a WebSocket keeps the transport swap invisible to it.
  return new ChaosSocket(url, options) as unknown as WebSocket;
}
