import { describe, expect, it } from 'vitest';
import { evaluateServerHello } from '../app/lib/protocolCompatibility';
import { MIN_SUPPORTED_CLIENT_PROTOCOL, PROTOCOL_VERSION } from '../shared/protocol';

/**
 * The full version-skew matrix (P2-10). GitHub Pages and Render deploy
 * independently, so every one of these combinations is reachable in production
 * during a rollout - not a theoretical edge case.
 */
describe('protocol compatibility matrix (P2-10)', () => {
  const hello = (protocolVersion: unknown, minClientProtocol: unknown) => ({ protocolVersion, minClientProtocol });

  it('says nothing when both ends agree', () => {
    const verdict = evaluateServerHello(hello(PROTOCOL_VERSION, MIN_SUPPORTED_CLIENT_PROTOCOL));
    expect(verdict.kind).toBe('compatible');
  });

  it('degrades with an explanation against a server that predates versioning', () => {
    // A v1 server sends no protocolVersion at all, so the field is absent
    // rather than wrong. Guessing a value here would be worse than saying so.
    const verdict = evaluateServerHello({});
    expect(verdict.kind).toBe('legacy-server');
    expect(verdict.kind !== 'compatible' && verdict.message).toMatch(/older version/i);
  });

  it('treats a malformed version as a legacy server rather than trusting it', () => {
    for (const value of ['2', null, Number.NaN, Infinity, {}, []]) {
      expect(evaluateServerHello(hello(value, 1)).kind).toBe('legacy-server');
    }
  });

  it('nudges when the server is newer but still accepts this client', () => {
    const verdict = evaluateServerHello(hello(PROTOCOL_VERSION + 1, MIN_SUPPORTED_CLIENT_PROTOCOL));
    expect(verdict.kind).toBe('outdated-client');
    expect(verdict.kind !== 'compatible' && verdict.message).toMatch(/refresh/i);
  });

  it('stops when the server no longer supports this client', () => {
    const verdict = evaluateServerHello(hello(PROTOCOL_VERSION + 5, PROTOCOL_VERSION + 1));
    expect(verdict.kind).toBe('unsupported-client');
    expect(verdict.kind !== 'compatible' && verdict.message).toMatch(/out of date/i);
  });

  it('nudges rather than stopping when the client is ahead of the server', () => {
    // Possible when Pages deploys before Render. The client is newer, but the
    // server still accepts the older protocol, so the session continues.
    const verdict = evaluateServerHello(hello(PROTOCOL_VERSION - 1, MIN_SUPPORTED_CLIENT_PROTOCOL), PROTOCOL_VERSION);
    expect(verdict.kind).toBe('outdated-client');
  });

  it('ignores a missing minClientProtocol instead of assuming the worst', () => {
    expect(evaluateServerHello(hello(PROTOCOL_VERSION, undefined)).kind).toBe('compatible');
  });
});
