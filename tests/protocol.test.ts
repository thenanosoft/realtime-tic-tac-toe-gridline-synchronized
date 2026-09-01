import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/createGameServer';
import {
  MIN_SUPPORTED_CLIENT_PROTOCOL,
  PROTOCOL_VERSION,
  type ClientMessage,
  type RoomSnapshot,
  type ServerMessage,
} from '../shared/protocol';

class Probe {
  readonly messages: ServerMessage[] = [];
  private readonly listeners = new Set<() => void>();

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const listener of this.listeners) listener();
    });
  }

  static async connect(url: string): Promise<Probe> {
    const socket = new WebSocket(url);
    // Constructed before the open handshake resolves, because the server sends
    // server.hello the instant the connection lands. Attaching the listener
    // after awaiting 'open' races that first frame and drops it.
    const probe = new Probe(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return probe;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION }));
  }

  sendRaw(payload: string): void {
    this.socket.send(payload);
  }

  of<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
  }

  async waitFor<T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    timeout = 2_000,
  ): Promise<T> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error('Timed out. Received: ' + JSON.stringify(this.messages).slice(0, 900)));
      }, timeout);
      const check = () => {
        const found = this.messages.find(predicate);
        if (!found) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(found as T);
      };
      this.listeners.add(check);
    });
  }

  /** Lets the server go quiet, so "nothing further happened" becomes testable. */
  async settle(ms = 220): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  latestSnapshot(): RoomSnapshot {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message.type === 'game.snapshot' || message.type === 'session.ready') return message.snapshot;
    }
    throw new Error('No authoritative snapshot has been received.');
  }

  close(): void {
    this.socket.close();
  }
}

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

const isHello = (m: ServerMessage): m is Of<'server.hello'> => m.type === 'server.hello';
const isSession = (m: ServerMessage): m is Of<'session.ready'> => m.type === 'session.ready';
const isRejection = (m: ServerMessage): m is Of<'command.rejected'> => m.type === 'command.rejected';
const isChat = (m: ServerMessage): m is Of<'chat.message'> => m.type === 'chat.message';
const isReaction = (m: ServerMessage): m is Of<'chat.message-reaction'> => m.type === 'chat.message-reaction';
const isQuickReaction = (m: ServerMessage): m is Of<'chat.quick-reaction'> => m.type === 'chat.quick-reaction';
const snapshotWhere = (predicate: (snapshot: RoomSnapshot) => boolean) =>
  (m: ServerMessage): m is Of<'game.snapshot'> => m.type === 'game.snapshot' && predicate(m.snapshot);

describe('protocol v2', () => {
  let server: GameServerHandle;
  let url: string;
  const probes: Probe[] = [];

  beforeEach(async () => {
    server = await createGameServer({
      port: 0,
      host: '127.0.0.1',
      countdownMs: 15,
      heartbeatMs: 5_000,
      cleanupIntervalMs: 5,
      typingTtlMs: 40,
    });
    url = 'ws://127.0.0.1:' + server.port + '/ws';
  });

  afterEach(async () => {
    for (const probe of probes) probe.close();
    probes.length = 0;
    await server.close();
  });

  async function connect(): Promise<Probe> {
    const probe = await Probe.connect(url);
    probes.push(probe);
    return probe;
  }

  async function match() {
    const x = await connect();
    const o = await connect();
    x.send({ type: 'room.create', requestId: 'p-create' });
    const xSession = await x.waitFor(isSession);
    o.send({ type: 'room.join', requestId: 'p-join', roomCode: xSession.roomCode });
    const oSession = await o.waitFor(isSession);
    await x.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'active'));
    await o.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'active'));
    return { x, o, xSession, oSession };
  }

  describe('versioning (P2-01)', () => {
    it('advertises its protocol range in the handshake', async () => {
      const probe = await connect();
      const hello = await probe.waitFor(isHello);
      expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(hello.minClientProtocol).toBe(MIN_SUPPORTED_CLIENT_PROTOCOL);
      expect(hello.minClientProtocol).toBeLessThanOrEqual(hello.protocolVersion);
    });

    it('refuses a v1 client at the door rather than failing it mid-match', async () => {
      // MIN_SUPPORTED_CLIENT_PROTOCOL moved to 2 in v3, deliberately. A v1 client
      // sends `expectedVersion`, which the schema stopped accepting in v2, so it
      // could join happily and then fail its first move with a confusing
      // MALFORMED_MESSAGE. Refusing it up front with an actionable message is
      // the honest behaviour.
      const probe = await connect();
      probe.sendRaw(JSON.stringify({ type: 'room.create', requestId: 'legacy' }));
      const rejection = await probe.waitFor(isRejection);
      expect(rejection.code).toBe('PROTOCOL_MISMATCH');
      expect(rejection.message).toMatch(/refresh/i);
      expect(probe.of('session.ready')).toHaveLength(0);
    });

    it('still fully serves the previous protocol version', async () => {
      // The skew window D-004 describes is real, so the server must keep
      // answering one version back. Every v2 command remains valid in v3.
      const probe = await connect();
      probe.sendRaw(JSON.stringify({ type: 'room.create', requestId: 'v2', protocolVersion: PROTOCOL_VERSION - 1 }));
      const session = await probe.waitFor(isSession);
      expect(session.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    });

    it('rejects a client claiming a newer protocol than the server speaks', async () => {
      const probe = await connect();
      probe.sendRaw(JSON.stringify({
        type: 'room.create',
        requestId: 'future',
        protocolVersion: PROTOCOL_VERSION + 1,
      }));
      const rejection = await probe.waitFor(isRejection);
      expect(rejection.code).toBe('PROTOCOL_MISMATCH');
      expect(rejection.requestId).toBe('future');
      expect(probe.of('session.ready')).toHaveLength(0);
    });

    it('keeps serving valid commands on the same socket after a mismatch', async () => {
      const probe = await connect();
      probe.sendRaw(JSON.stringify({ type: 'room.create', requestId: 'future', protocolVersion: 99 }));
      await probe.waitFor(isRejection);
      probe.send({ type: 'room.create', requestId: 'recovered' });
      const session = await probe.waitFor(isSession);
      expect(session.requestId).toBe('recovered');
    });
  });

  describe('game revision ordering (P2-02, P2-04, INV-4)', () => {
    it('increases strictly on every authoritative change', async () => {
      const { x, o } = await match();
      x.send({ type: 'game.move', requestId: 'm1', cell: 0, expectedRevision: x.latestSnapshot().revision });
      await o.waitFor(snapshotWhere((snapshot) => snapshot.board[0] === 'X'));
      o.send({ type: 'game.move', requestId: 'm2', cell: 4, expectedRevision: o.latestSnapshot().revision });
      await x.waitFor(snapshotWhere((snapshot) => snapshot.board[4] === 'O'));

      const revisions = x.of('game.snapshot').map((message) => message.snapshot.revision);
      expect(revisions.length).toBeGreaterThan(1);
      for (let index = 1; index < revisions.length; index += 1) {
        expect(revisions[index]).toBeGreaterThan(revisions[index - 1]);
      }
    });

    it('produces identical snapshots for both clients at the same revision (INV-3)', async () => {
      // This is precisely why emission timing lives outside the snapshot:
      // durations decay between two sends, so a snapshot carrying them could
      // never be compared across clients.
      const { x, o } = await match();
      x.send({ type: 'game.move', requestId: 'conv', cell: 2, expectedRevision: x.latestSnapshot().revision });
      const fromX = await x.waitFor(snapshotWhere((snapshot) => snapshot.board[2] === 'X'));
      const fromO = await o.waitFor(snapshotWhere((snapshot) => snapshot.board[2] === 'X'));
      expect(fromX.snapshot.revision).toBe(fromO.snapshot.revision);
      expect(fromX.snapshot).toEqual(fromO.snapshot);
    });

    it('rejects a move naming a stale revision and restores the real board', async () => {
      const { x, o } = await match();
      const stale = x.latestSnapshot().revision;
      x.send({ type: 'game.move', requestId: 'first', cell: 0, expectedRevision: stale });
      await x.waitFor(snapshotWhere((snapshot) => snapshot.board[0] === 'X'));
      o.send({ type: 'game.move', requestId: 'stale', cell: 1, expectedRevision: stale });
      const rejection = await o.waitFor(isRejection);
      expect(rejection.code).toBe('STALE_STATE');
      expect(o.latestSnapshot().board[1]).toBeNull();
    });
  });

  describe('clock independence (P2-05, INV-11)', () => {
    it('carries no absolute deadline anywhere in the authoritative snapshot', async () => {
      const { x } = await match();
      const snapshot = x.latestSnapshot() as unknown as Record<string, unknown>;
      for (const field of ['countdownEndsAt', 'serverTime', 'updatedAt']) {
        expect(snapshot[field], field + ' must not be part of the snapshot').toBeUndefined();
      }
      for (const player of x.latestSnapshot().players) {
        expect((player as unknown as Record<string, unknown>).reconnectDeadline).toBeUndefined();
      }
    });

    it('sends the countdown as a duration in the emission envelope', async () => {
      const x = await connect();
      const o = await connect();
      x.send({ type: 'room.create', requestId: 'c1' });
      const xSession = await x.waitFor(isSession);
      o.send({ type: 'room.join', requestId: 'c2', roomCode: xSession.roomCode });
      const counting = await o.waitFor(
        (m): m is Of<'session.ready'> => m.type === 'session.ready' && m.snapshot.phase === 'countdown',
      );
      expect(counting.timing.countdownMsRemaining).toBeGreaterThan(0);
      expect(counting.timing.countdownMsRemaining).toBeLessThanOrEqual(15);
      expect(counting.timing.serverTime).toBeTypeOf('number');
    });
  });

  describe('chat sequencing (P2-03, INV-4)', () => {
    it('numbers every chat event on one strictly increasing stream', async () => {
      const { x, o, oSession } = await match();
      expect(oSession.chat.sequence).toBe(0);

      x.send({ type: 'chat.message', requestId: 's1', text: 'one' });
      const first = await o.waitFor(isChat);
      x.send({ type: 'chat.typing', typing: true });
      x.send({ type: 'chat.message', requestId: 's2', text: 'two' });
      await o.waitFor((m): m is Of<'chat.message'> =>
        m.type === 'chat.message' && m.message.kind === 'text' && m.message.text === 'two');
      o.send({ type: 'chat.message-reaction', requestId: 's3', messageId: first.message.id, reaction: '🔥' });
      await o.waitFor(isReaction);
      await o.settle(120);

      const sequences = o.messages.flatMap((message) => {
        if (message.type === 'chat.message') return [message.message.sequence];
        if (
          message.type === 'chat.typing'
          || message.type === 'chat.message-reaction'
          || message.type === 'chat.quick-reaction'
        ) return [message.sequence];
        return [];
      });
      expect(sequences.length).toBeGreaterThanOrEqual(4);
      for (let index = 1; index < sequences.length; index += 1) {
        expect(sequences[index]).toBeGreaterThan(sequences[index - 1]);
      }
    });

    it('restores the stream position in a resume snapshot', async () => {
      const { x, o, xSession } = await match();
      x.send({ type: 'chat.message', requestId: 'r1', text: 'before reload' });
      const sent = await o.waitFor(isChat);
      x.close();

      const resumed = await connect();
      resumed.send({
        type: 'session.resume',
        requestId: 'resume',
        roomCode: xSession.roomCode,
        playerToken: xSession.playerToken,
      });
      const ready = await resumed.waitFor(isSession);
      expect(ready.chat.sequence).toBeGreaterThanOrEqual(sent.message.sequence);
      expect(ready.chat.messages.at(-1)?.sequence).toBe(sent.message.sequence);
    });
  });

  describe('idempotency (P2-06, P2-07, INV-5)', () => {
    it('applies a replayed move exactly once', async () => {
      const { x, o } = await match();
      const revision = x.latestSnapshot().revision;
      x.send({ type: 'game.move', requestId: 'once', cell: 4, expectedRevision: revision });
      await o.waitFor(snapshotWhere((snapshot) => snapshot.board[4] === 'X'));
      const afterFirst = o.latestSnapshot().revision;

      // The same requestId with a now-stale expectedRevision: the ledger has to
      // answer before the staleness check ever runs, or a legitimate retry would
      // come back as STALE_STATE.
      x.send({ type: 'game.move', requestId: 'once', cell: 4, expectedRevision: revision });
      x.send({ type: 'game.move', requestId: 'once', cell: 4, expectedRevision: revision });
      await x.settle();

      expect(o.latestSnapshot().revision).toBe(afterFirst);
      expect(o.latestSnapshot().board.filter(Boolean)).toHaveLength(1);
      expect(o.latestSnapshot().turn).toBe('O');
      expect(x.of('command.rejected')).toHaveLength(0);
    });

    it('stores a replayed chat message once and answers with the original', async () => {
      const { x, o } = await match();
      x.send({ type: 'chat.message', requestId: 'dup', text: 'hello' });
      const original = await o.waitFor(isChat);
      x.send({ type: 'chat.message', requestId: 'dup', text: 'hello' });
      x.send({ type: 'chat.message', requestId: 'dup', text: 'completely different text' });
      await x.settle();

      expect(o.of('chat.message')).toHaveLength(1);
      const replays = x.of('chat.message').filter((message) => message.ackRequestId === 'dup');
      expect(replays.length).toBeGreaterThanOrEqual(2);
      for (const replay of replays) {
        expect(replay.message.id).toBe(original.message.id);
        expect(replay.message.sequence).toBe(original.message.sequence);
      }
    });

    it('does not toggle a message reaction twice for one requestId', async () => {
      const { x, o } = await match();
      x.send({ type: 'chat.message', requestId: 'target', text: 'react to me' });
      const target = await o.waitFor(isChat);
      o.send({ type: 'chat.message-reaction', requestId: 'react', messageId: target.message.id, reaction: '🔥' });
      await x.waitFor(isReaction);
      o.send({ type: 'chat.message-reaction', requestId: 'react', messageId: target.message.id, reaction: '🔥' });
      await o.settle();

      const reactions = x.of('chat.message-reaction');
      expect(reactions).toHaveLength(1);
      expect(reactions[0].reactions[0].reaction).toBe('🔥');
      expect(reactions[0].reactions[0].playerIds).toHaveLength(1);
    });

    it('broadcasts a replayed quick reaction only once', async () => {
      const { x, o } = await match();
      x.send({ type: 'chat.quick-reaction', requestId: 'qr', reaction: '🔥' });
      await o.waitFor(isQuickReaction);
      x.send({ type: 'chat.quick-reaction', requestId: 'qr', reaction: '🔥' });
      x.send({ type: 'chat.quick-reaction', requestId: 'qr', reaction: '👏' });
      await x.settle();
      expect(o.of('chat.quick-reaction')).toHaveLength(1);
    });

    it('counts a replayed rematch vote once', async () => {
      const { x, o } = await match();
      const script = [[0, x, o], [3, o, x], [1, x, o], [4, o, x], [2, x, o]] as const;
      for (const [cell, actor, observer] of script) {
        actor.send({
          type: 'game.move',
          requestId: 'win-' + cell,
          cell,
          expectedRevision: actor.latestSnapshot().revision,
        });
        await observer.waitFor(snapshotWhere((snapshot) => snapshot.board[cell] !== null));
      }
      expect(x.latestSnapshot().winner).toBe('X');

      x.send({ type: 'rematch.vote', requestId: 'vote' });
      await o.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'rematch_waiting'));
      x.send({ type: 'rematch.vote', requestId: 'vote' });
      await x.settle();

      const snapshot = o.latestSnapshot();
      expect(snapshot.phase).toBe('rematch_waiting');
      expect(snapshot.players.filter((player) => player.wantsRematch)).toHaveLength(1);
      expect(snapshot.round).toBe(1);
    });
  });

  describe('schema hardening and fuzzing (P2-08, P2-09)', () => {
    it('rejects unknown fields on an otherwise valid command', async () => {
      const probe = await connect();
      probe.sendRaw(JSON.stringify({
        type: 'room.create',
        requestId: 'extra',
        smuggled: true,
        protocolVersion: PROTOCOL_VERSION,
      }));
      const rejection = await probe.waitFor(isRejection);
      expect(rejection.code).toBe('MALFORMED_MESSAGE');
    });

    it('rejects non-finite numbers', async () => {
      const probe = await connect();
      // NaN is not representable in JSON, so it arrives as the bare token a
      // hand-rolled or buggy client would emit.
      probe.sendRaw('{"type":"presence.ping","sentAt":NaN}');
      const rejection = await probe.waitFor(isRejection);
      expect(rejection.code).toBe('MALFORMED_MESSAGE');
    });

    it('survives ten thousand malformed frames and still serves the next command', async () => {
      let seed = 0x2f6e2b1;
      const random = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return Math.abs(seed % 100_000) / 100_000;
      };
      const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length) % values.length];

      const types = [
        'room.create', 'room.join', 'game.move', 'chat.message', 'chat.image',
        'chat.sticker', 'presence.ping', 'session.resume', '__proto__', '', 'nope',
      ];
      const values: unknown[] = [null, true, -1, 1e308, 'x'.repeat(200), [], {}, { nested: { deep: [1, 2] } }];

      const frames: string[] = [];
      for (let index = 0; index < 10_000; index += 1) {
        const shape = Math.floor(random() * 5) % 5;
        if (shape === 0) frames.push('not json at all ' + index);
        else if (shape === 1) frames.push(JSON.stringify(pick(values)));
        else if (shape === 2) frames.push(JSON.stringify({ type: pick(types) }));
        else if (shape === 3) {
          frames.push(JSON.stringify({
            type: pick(types),
            requestId: pick(values),
            cell: pick(values),
            roomCode: pick(values),
            expectedRevision: pick(values),
            protocolVersion: pick(values),
          }));
        } else frames.push('{"type":"game.move","requestId":' + '['.repeat(20) + '}');
      }

      // The socket rate limiter closes any connection exceeding 100 frames per
      // 10s, so the fuzz is delivered in bounded bursts across fresh sockets.
      const BURST = 80;
      for (let offset = 0; offset < frames.length; offset += BURST) {
        const burst = await Probe.connect(url);
        for (const frame of frames.slice(offset, offset + BURST)) burst.sendRaw(frame);
        await new Promise((resolve) => setTimeout(resolve, 0));
        burst.close();
      }

      // The surviving server is the assertion: still listening, still correct.
      const survivor = await connect();
      survivor.send({ type: 'room.create', requestId: 'after-fuzz' });
      const session = await survivor.waitFor(isSession, 5_000);
      expect(session.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
      expect(server.manager.size).toBeGreaterThan(0);
    }, 60_000);
  });
});
