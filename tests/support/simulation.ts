import { executeClientMessage } from '../../server/createGameServer';
import { RoomManager, type Peer } from '../../server/rooms/RoomManager';
import { createRandom, decide, type ChaosProfile } from '../../shared/chaos';
import { PROTOCOL_VERSION, type ClientMessage, type RoomSnapshot, type ServerMessage } from '../../shared/protocol';
import type { Mark } from '../../shared/game';
import { shouldApplySnapshot, type RevisionCursor } from '../../app/lib/ordering';

/**
 * Headless, deterministic chaos simulation.
 *
 * It runs the real RoomManager through the real command dispatcher against
 * simulated clients that apply the real ordering rules from `app/lib/ordering`.
 * Nothing production-side is reimplemented here - only the transport and the
 * player's choice of move are simulated, which is what keeps a green chaos run
 * from being evidence about a parallel universe.
 *
 * Time comes from the caller's fake timers, so a run carrying 800ms of latency
 * finishes in milliseconds and replays exactly from its seed.
 */

export interface SimulationOptions {
  seed: number;
  profile: ChaosProfile;
  /** Probability, per client turn, that the client's socket is cut. */
  disconnectRate?: number;
  /** Fake-timer driver, e.g. `(ms) => vi.advanceTimersByTimeAsync(ms)`. */
  advance: (ms: number) => Promise<void>;
  /** Virtual milliseconds per driver step. */
  stepMs?: number;
  /** Safety cap so a stuck run fails loudly instead of hanging. */
  maxSteps?: number;
}

export interface Violation {
  invariant: string;
  detail: string;
}

export interface SimulationResult {
  violations: Violation[];
  finished: boolean;
  serverSnapshot: RoomSnapshot | null;
  clientSnapshots: Array<RoomSnapshot | null>;
  clientNames: string[];
  rejections: Record<string, number>;
  disconnects: number;
  duplicatesSent: number;
  steps: number;
}

let peerCounter = 0;

class SimulatedClient {
  readonly peerId: string;
  cursor: RevisionCursor | null = null;
  snapshot: RoomSnapshot | null = null;
  playerId = '';
  playerToken = '';
  roomCode = '';
  mark: Mark | null = null;
  pendingRequestId: string | null = null;
  live = true;
  /** Mirrors the hook's `resyncing`: a snapshot held across a reconnect is stale. */
  resyncing = false;
  readonly appliedRevisions: number[] = [];

  constructor(readonly name: string) {
    peerCounter += 1;
    this.peerId = name + '-peer-' + peerCounter;
  }

  /**
   * Mirrors exactly what the browser renders as an interactive board: active
   * phase, the authoritative turn is ours, and nothing of ours is in flight.
   */
  canMove(): boolean {
    return this.live
      && !this.resyncing
      && this.snapshot !== null
      && this.snapshot.phase === 'active'
      && this.snapshot.turn === this.mark
      && this.pendingRequestId === null;
  }
}

export async function runChaosMatch(options: SimulationOptions): Promise<SimulationResult> {
  const profile: ChaosProfile = { ...options.profile, seed: options.seed };
  const random = createRandom(options.seed);
  const disconnectRate = options.disconnectRate ?? 0;
  const stepMs = options.stepMs ?? 120;
  const maxSteps = options.maxSteps ?? 400;

  const manager = new RoomManager({
    countdownMs: 40,
    reconnectGraceMs: 120_000,
    emptyRoomTtlMs: 120_000,
    waitingRoomTtlMs: 120_000,
    reservationTtlMs: 120_000,
    cleanupIntervalMs: 30_000,
    typingTtlMs: 500,
  });

  const violations: Violation[] = [];
  const rejections: Record<string, number> = {};
  let disconnects = 0;
  let duplicatesSent = 0;
  let requestCounter = 0;

  let clients: SimulatedClient[] = [new SimulatedClient('X'), new SimulatedClient('O')];
  const peers = new Map<string, Peer>();

  const record = (invariant: string, detail: string) => {
    if (violations.length < 20) violations.push({ invariant, detail });
  };

  const authoritative = (): RoomSnapshot | null => {
    for (const client of clients) {
      try {
        return manager.getSnapshotForPeer(client.peerId);
      } catch {
        // Not a member right now - a disconnect is mid-flight. Try the other.
      }
    }
    return null;
  };

  const checkInvariants = () => {
    // INV-1, in its enforceable form. Two clients on different revisions can
    // both *read* as "your turn" mid-propagation, but only one may be able to
    // act: the other has a command in flight. Interactivity is the property
    // that actually matters, and it is what the UI gates on.
    const interactive = clients.filter((client) => client.canMove());
    if (interactive.length > 1) {
      record('INV-1', interactive.map((c) => c.name).join(' and ') + ' could both move');
    }

    const server = authoritative();
    for (const client of clients) {
      if (!client.snapshot) continue;
      if (client.snapshot.players.length > 2) {
        record('INV-6', client.name + ' saw ' + client.snapshot.players.length + ' players');
      }
      // INV-2: nothing a client shows may contradict the server. Scoped to the
      // round, since a rematch clears the board and an older snapshot from the
      // previous round is stale, not wrong.
      if (server && server.round === client.snapshot.round) {
        client.snapshot.board.forEach((cell, index) => {
          if (cell !== null && server.board[index] !== cell) {
            record('INV-2', client.name + ' showed ' + cell + ' at ' + index + ', server has ' + server.board[index]);
          }
        });
      }
    }
  };

  const applySnapshot = (client: SimulatedClient, incoming: RoomSnapshot) => {
    if (!shouldApplySnapshot(client.cursor, incoming)) return;
    const previous = client.cursor;
    if (previous && previous.roomCode === incoming.roomCode && incoming.revision <= previous.revision) {
      record('INV-4', client.name + ' applied revision ' + incoming.revision + ' after ' + previous.revision);
    }
    client.cursor = { roomCode: incoming.roomCode, revision: incoming.revision };
    client.snapshot = incoming;
    client.appliedRevisions.push(incoming.revision);
  };

  const deliver = (client: SimulatedClient, message: ServerMessage) => {
    switch (message.type) {
      case 'session.ready':
        client.playerId = message.playerId;
        client.playerToken = message.playerToken;
        client.roomCode = message.roomCode;
        client.mark = message.mark;
        client.pendingRequestId = null;
        client.resyncing = false;
        applySnapshot(client, message.snapshot);
        break;
      case 'game.snapshot':
        applySnapshot(client, message.snapshot);
        if (message.ackRequestId && client.pendingRequestId === message.ackRequestId) client.pendingRequestId = null;
        break;
      case 'command.rejected':
        rejections[message.code] = (rejections[message.code] ?? 0) + 1;
        client.resyncing = false;
        if (!message.requestId || client.pendingRequestId === message.requestId) client.pendingRequestId = null;
        break;
      case 'session.ended':
        client.live = false;
        break;
      default:
        break;
    }
    checkInvariants();
  };

  const peerFor = (client: SimulatedClient): Peer => ({
    id: client.peerId,
    send(message: ServerMessage) {
      const verdict = decide(random, profile);
      if (verdict.drop) return;
      const encoded = JSON.stringify(message);
      setTimeout(() => deliver(client, JSON.parse(encoded) as ServerMessage), verdict.delayMs);
      if (verdict.duplicate) {
        setTimeout(() => deliver(client, JSON.parse(encoded) as ServerMessage), verdict.duplicateDelayMs);
      }
    },
    close() {
      client.live = false;
    },
  });

  for (const client of clients) peers.set(client.peerId, peerFor(client));

  const submit = (client: SimulatedClient, command: ClientMessage) => {
    const verdict = decide(random, profile);
    if (verdict.drop) return;
    const stamped = { ...command, protocolVersion: PROTOCOL_VERSION } as ClientMessage;
    const run = () => {
      const peer = peers.get(client.peerId);
      if (!peer) return;
      executeClientMessage(stamped, peer, manager);
      checkInvariants();
    };
    setTimeout(run, verdict.delayMs);
    if (verdict.duplicate) {
      // A duplicated command is the sharpest test the ledger gets: the second
      // copy lands after the first has already been applied.
      duplicatesSent += 1;
      setTimeout(run, verdict.duplicateDelayMs);
    }
  };

  const nextRequestId = () => 'req-' + (requestCounter += 1);

  const sendMove = (client: SimulatedClient) => {
    if (!client.snapshot) return;
    const empty = client.snapshot.board.flatMap((cell, index) => (cell === null ? [index] : []));
    if (!empty.length) return;
    const cell = empty[Math.floor(random() * empty.length) % empty.length];
    const requestId = nextRequestId();
    client.pendingRequestId = requestId;
    // The browser gives up on an unacknowledged move after 5s and unblocks the
    // board. Without the same escape hatch a dropped frame would deadlock the run.
    setTimeout(() => {
      if (client.pendingRequestId === requestId) client.pendingRequestId = null;
    }, 5_000);
    submit(client, {
      type: 'game.move',
      requestId,
      cell,
      expectedRevision: client.snapshot.revision,
    });
  };

  const maybeDisconnect = (client: SimulatedClient) => {
    if (disconnectRate <= 0 || random() >= disconnectRate) return;
    // Bounded: an unbounded rate keeps the room permanently paused, so the match
    // never concludes and the run proves nothing.
    if (disconnects >= 3) return;
    if (!client.live || !client.playerToken) return;
    disconnects += 1;
    manager.disconnect(client.peerId);
    peers.delete(client.peerId);

    // A real browser reconnects on a brand-new socket, so the resumed client
    // gets a fresh peer id and must reclaim its slot by token.
    const resumed = new SimulatedClient(client.name);
    resumed.playerToken = client.playerToken;
    resumed.roomCode = client.roomCode;
    resumed.playerId = client.playerId;
    resumed.mark = client.mark;
    resumed.cursor = client.cursor;
    resumed.snapshot = client.snapshot;
    resumed.resyncing = true;
    clients = clients.map((candidate) => (candidate === client ? resumed : candidate));
    peers.set(resumed.peerId, peerFor(resumed));
    submit(resumed, {
      type: 'session.resume',
      requestId: nextRequestId(),
      roomCode: resumed.roomCode,
      playerToken: resumed.playerToken,
    });
  };

  const settled = () => {
    const server = authoritative();
    return server !== null && (server.winner !== null || server.isDraw);
  };

  // --- Open the room -------------------------------------------------------
  submit(clients[0], { type: 'room.create', requestId: nextRequestId() });
  let steps = 0;
  while (!clients[0].roomCode && steps < maxSteps) {
    await options.advance(stepMs);
    steps += 1;
  }
  submit(clients[1], { type: 'room.join', requestId: nextRequestId(), roomCode: clients[0].roomCode });

  // --- Play ----------------------------------------------------------------
  while (!settled() && steps < maxSteps) {
    for (const client of clients) {
      if (client.canMove()) sendMove(client);
    }
    for (const client of [...clients]) maybeDisconnect(client);
    await options.advance(stepMs);
    steps += 1;
  }

  // --- Let the network go quiet, then measure convergence ------------------
  for (let drain = 0; drain < 40; drain += 1) await options.advance(500);

  const server = authoritative();
  const finished = server !== null && (server.winner !== null || server.isDraw);

  if (finished && server) {
    for (const client of clients) {
      if (!client.snapshot) {
        record('INV-3', client.name + ' held no snapshot after the network settled');
        continue;
      }
      if (JSON.stringify(client.snapshot) !== JSON.stringify(server)) {
        record(
          'INV-3',
          client.name + ' did not converge: revision ' + client.snapshot.revision + ' vs server ' + server.revision,
        );
      }
    }
  }

  manager.close();

  return {
    violations,
    finished,
    serverSnapshot: server,
    clientSnapshots: clients.map((client) => client.snapshot),
    clientNames: clients.map((client) => client.name),
    rejections,
    disconnects,
    duplicatesSent,
    steps,
  };
}
