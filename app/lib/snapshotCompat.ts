import type { RoomSnapshot, RoomTiming } from '../../shared/protocol';

/**
 * Fills in what an older server does not send (D-008).
 *
 * GitHub Pages and Render deploy independently, and Pages usually wins: for a
 * few minutes after every release a protocol-7 client is talking to a
 * protocol-6 server. The version handshake already tells the player a newer
 * version is live, and that is the right behaviour - the match still works -
 * but it only holds if the client can actually render what the old server
 * sends. A snapshot without `series` was a thrown TypeError and a blank page,
 * which is the least honest degradation available.
 *
 * So every field added by a protocol version later than the oldest server we
 * still accept gets a default here, at the one place a snapshot enters the
 * client. The alternative - optional chaining scattered through the components
 * - spreads the question across the codebase and answers it differently each
 * time.
 *
 * The defaults are chosen to make the feature *absent* rather than wrong: no
 * series, no turn limit, no draw offer, no replay. A feature the server does
 * not have should look like a feature nobody has turned on.
 */
export function withProtocolDefaults(incoming: RoomSnapshot): RoomSnapshot {
  // Cast once, at the boundary: the type says these fields are present, and
  // the wire is where that stops being guaranteed.
  const wire = incoming as Partial<RoomSnapshot>;
  return {
    ...incoming,
    spectatorCount: wire.spectatorCount ?? 0,
    spectatorPolicy: wire.spectatorPolicy ?? { chat: false },
    contentExpiry: wire.contentExpiry ?? false,
    attachmentBytes: wire.attachmentBytes ?? 0,
    encryption: wire.encryption ?? { enabled: false, epoch: 0 },
    series: wire.series ?? { target: 1, scores: [], draws: 0, decidedBy: null },
    turnLimitMs: wire.turnLimitMs ?? null,
    drawOffer: wire.drawOffer ?? null,
    moves: wire.moves ?? [],
  };
}

export function timingWithDefaults(incoming: RoomTiming): RoomTiming {
  const wire = incoming as Partial<RoomTiming>;
  return {
    ...incoming,
    serverTime: wire.serverTime ?? Date.now(),
    countdownMsRemaining: wire.countdownMsRemaining ?? null,
    turnMsRemaining: wire.turnMsRemaining ?? null,
    reconnect: wire.reconnect ?? [],
  };
}
