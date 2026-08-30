import { PROTOCOL_VERSION } from '../../shared/protocol';

export type CompatibilityVerdict =
  /** Same protocol on both ends. Nothing to say to the player. */
  | { kind: 'compatible' }
  /**
   * The server predates protocol versioning entirely, so its handshake carries
   * no version at all. Reachable in production because GitHub Pages and Render
   * deploy independently (D-004) and Pages can win the race.
   */
  | { kind: 'legacy-server'; message: string }
  /** Versions differ but both ends can still talk. Worth a nudge, not a stop. */
  | { kind: 'outdated-client'; message: string }
  /**
   * The server no longer supports this client's protocol. Reconnecting cannot
   * fix that, so the caller must stop retrying and say so plainly.
   */
  | { kind: 'unsupported-client'; message: string };

interface ServerHelloLike {
  protocolVersion?: unknown;
  minClientProtocol?: unknown;
}

/**
 * Decides what a client should do about the version it just met.
 *
 * Kept as a pure function rather than living inside the socket hook so the
 * whole compatibility matrix - old client, old server, and both directions of
 * mismatch - is testable without a browser or a live connection (P2-10).
 */
export function evaluateServerHello(
  hello: ServerHelloLike,
  clientProtocol: number = PROTOCOL_VERSION,
): CompatibilityVerdict {
  const serverProtocol = hello.protocolVersion;
  if (typeof serverProtocol !== 'number' || !Number.isFinite(serverProtocol)) {
    return {
      kind: 'legacy-server',
      message: 'The realtime service is running an older version. Some features may be unavailable until it updates.',
    };
  }

  const minClient = hello.minClientProtocol;
  if (typeof minClient === 'number' && Number.isFinite(minClient) && clientProtocol < minClient) {
    return {
      kind: 'unsupported-client',
      message: 'This page is out of date. Refresh to reconnect to the realtime service.',
    };
  }

  if (serverProtocol !== clientProtocol) {
    return {
      kind: 'outdated-client',
      message: 'A newer version of Gridline is live. Refresh when convenient.',
    };
  }

  return { kind: 'compatible' };
}
