import { describe, expect, it } from 'vitest';
import { timingWithDefaults, withProtocolDefaults } from '../app/lib/snapshotCompat';
import type { RoomSnapshot, RoomTiming } from '../shared/protocol';

/**
 * Talking to a server that has not deployed yet (D-008).
 *
 * The two halves deploy independently and Pages usually wins, so for a few
 * minutes after every release a current client is talking to the previous
 * server. The version handshake already says "a newer version is live" and
 * lets the match continue - which is only honest if the client can render what
 * the old server actually sends.
 *
 * These are the snapshots as earlier protocols put them on the wire, built by
 * deleting fields rather than by hand, so the test says exactly what a v6 or v4
 * server omits.
 */

const current: RoomSnapshot = {
  roomCode: 'ABC234',
  revision: 7,
  phase: 'active',
  board: Array(9).fill(null),
  turn: 'X',
  winner: null,
  winningLine: null,
  isDraw: false,
  round: 1,
  players: [],
  spectatorCount: 0,
  spectatorPolicy: { chat: false },
  contentExpiry: false,
  attachmentBytes: 0,
  encryption: { enabled: true, epoch: 2 },
  series: { target: 3, scores: [{ playerId: 'a', wins: 1 }], draws: 0, decidedBy: null },
  turnLimitMs: 15_000,
  drawOffer: { byPlayerId: 'a', round: 1 },
  moves: [{ cell: 4, mark: 'X' }],
  playRequests: [{ spectatorId: 'w1', name: 'VelvetLynx' }],
};

const without = (snapshot: RoomSnapshot, fields: Array<keyof RoomSnapshot>): RoomSnapshot => {
  const copy = { ...snapshot } as Record<string, unknown>;
  for (const field of fields) delete copy[field];
  // Through unknown: the whole point is that this object is missing fields the
  // type requires, which is precisely what an older server sends.
  return copy as unknown as RoomSnapshot;
};

describe('a snapshot from an older server (D-008)', () => {
  it('fills in everything protocol 7 added', () => {
    // What a v6 server sends: no series, no turn limit, no draw offer, no
    // move history. Before this, reading `snapshot.series.target` threw and
    // the page went blank - the least honest degradation available.
    const v6 = without(current, ['series', 'turnLimitMs', 'drawOffer', 'moves']);
    const filled = withProtocolDefaults(v6);

    expect(filled.series).toEqual({ target: 1, scores: [], draws: 0, decidedBy: null });
    expect(filled.turnLimitMs).toBe(null);
    expect(filled.drawOffer).toBe(null);
    expect(filled.moves).toEqual([]);
    // Absent, not wrong: a feature the server does not have should look like a
    // feature nobody has turned on.
    expect(filled.series.target).toBe(1);
    expect(filled.encryption).toEqual({ enabled: true, epoch: 2 });
  });

  it('fills in everything protocols 4 to 6 added', () => {
    const v3 = without(current, [
      'series', 'turnLimitMs', 'drawOffer', 'moves',
      'encryption', 'spectatorCount', 'spectatorPolicy', 'contentExpiry', 'attachmentBytes',
    ]);
    const filled = withProtocolDefaults(v3);

    expect(filled.encryption).toEqual({ enabled: false, epoch: 0 });
    // Chat closed to watchers is the safe default in both directions: a room
    // whose policy is unknown must not be assumed to be open.
    expect(filled.spectatorPolicy).toEqual({ chat: false });
    expect(filled.spectatorCount).toBe(0);
    expect(filled.contentExpiry).toBe(false);
    expect(filled.attachmentBytes).toBe(0);
  });

  it('leaves a current snapshot exactly as it was', () => {
    expect(withProtocolDefaults(current)).toEqual(current);
  });

  it('keeps a false or zero value rather than replacing it with a default', () => {
    // The bug this guards: `||` instead of `??` turns "encryption is off" and
    // "no attachments" into "the server did not say", which is a different
    // claim entirely.
    const quiet: RoomSnapshot = {
      ...current,
      encryption: { enabled: false, epoch: 0 },
      attachmentBytes: 0,
      contentExpiry: false,
      turnLimitMs: null,
    };
    const filled = withProtocolDefaults(quiet);
    expect(filled.encryption).toEqual({ enabled: false, epoch: 0 });
    expect(filled.attachmentBytes).toBe(0);
    expect(filled.contentExpiry).toBe(false);
  });

  it('fills in the timing envelope the same way', () => {
    const timing = { serverTime: 1_000, countdownMsRemaining: null, reconnect: [] } as unknown as RoomTiming;
    const filled = timingWithDefaults(timing);
    expect(filled.turnMsRemaining).toBe(null);
    expect(filled.reconnect).toEqual([]);
    expect(filled.serverTime).toBe(1_000);
  });
});
