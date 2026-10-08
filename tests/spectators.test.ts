import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/createGameServer';
import { PROTOCOL_VERSION, type ClientMessage, type RoomSnapshot, type ServerMessage } from '../shared/protocol';

/**
 * Spectators and capabilities (Phase 6).
 *
 * The property that matters is not that the UI hides things from a watcher, but
 * that the server never sends them. A policy enforced in the client is a
 * suggestion; these tests read the spectator's socket directly.
 */

class Socket {
  readonly messages: ServerMessage[] = [];
  private readonly listeners = new Set<() => void>();

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const listener of this.listeners) listener();
    });
  }

  static async open(url: string): Promise<Socket> {
    const socket = new WebSocket(url);
    const wrapper = new Socket(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return wrapper;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION }));
  }

  of<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  async waitFor<T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    timeout = 3_000,
  ): Promise<T> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error('timed out; got ' + JSON.stringify(this.messages).slice(0, 600)));
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

  async settle(ms = 250): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  snapshot(): RoomSnapshot {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m.type === 'game.snapshot' || m.type === 'session.ready' || m.type === 'spectator.ready') return m.snapshot;
    }
    throw new Error('no snapshot');
  }

  close(): void {
    this.socket.close();
  }
}

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
const isSession = (m: ServerMessage): m is Of<'session.ready'> => m.type === 'session.ready';
const isWatching = (m: ServerMessage): m is Of<'spectator.ready'> => m.type === 'spectator.ready';
const isRejection = (m: ServerMessage): m is Of<'command.rejected'> => m.type === 'command.rejected';
const isChat = (m: ServerMessage): m is Of<'chat.message'> => m.type === 'chat.message';
const snapshotWhere = (predicate: (s: RoomSnapshot) => boolean) =>
  (m: ServerMessage): m is Of<'game.snapshot'> => m.type === 'game.snapshot' && predicate(m.snapshot);

describe('spectators and capabilities (Phase 6)', () => {
  let server: GameServerHandle;
  let url: string;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await createGameServer({ port: 0, host: '127.0.0.1', countdownMs: 15, cleanupIntervalMs: 10_000 });
    url = 'ws://127.0.0.1:' + server.port + '/ws';
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await server.close();
  });

  async function open(): Promise<Socket> {
    const socket = await Socket.open(url);
    sockets.push(socket);
    return socket;
  }

  async function match() {
    const x = await open();
    const o = await open();
    x.send({ type: 'room.create', requestId: 'create' });
    const xSession = await x.waitFor(isSession);
    o.send({ type: 'room.join', requestId: 'join', roomCode: xSession.roomCode });
    const oSession = await o.waitFor(isSession);
    await x.waitFor(snapshotWhere((s) => s.phase === 'active'));
    await o.waitFor(snapshotWhere((s) => s.phase === 'active'));
    return { x, o, xSession, oSession };
  }

  async function watch(roomCode: string) {
    const viewer = await open();
    viewer.send({ type: 'room.spectate', requestId: 'watch', roomCode });
    const ready = await viewer.waitFor(isWatching);
    return { viewer, ready };
  }

  describe('joining as a spectator (P6-03)', () => {
    it('attaches to a full room and receives the live board', async () => {
      const { x, o, xSession } = await match();
      const { viewer, ready } = await watch(xSession.roomCode);

      expect(ready.capability).toBe('spectator');
      expect(ready.spectatorId).toMatch(/[0-9a-f-]{36}/);
      expect(ready.displayName).not.toBe(xSession.displayName);
      expect(ready.snapshot.players).toHaveLength(2);

      // A watcher is told nothing a player would need to act with.
      expect((ready as unknown as Record<string, unknown>).playerToken).toBeUndefined();
      expect((ready as unknown as Record<string, unknown>).mark).toBeUndefined();

      // And sees moves as they happen.
      x.send({ type: 'game.move', requestId: 'm1', cell: 4, expectedRevision: x.snapshot().revision });
      await viewer.waitFor(snapshotWhere((s) => s.board[4] === 'X'));
      await o.settle(50);
    });

    it('refuses to watch a room that still has an open seat', async () => {
      // A room with one player wants a second player, not an audience.
      const opener = await open();
      opener.send({ type: 'room.create', requestId: 'create' });
      const session = await opener.waitFor(isSession);

      const viewer = await open();
      viewer.send({ type: 'room.spectate', requestId: 'watch', roomCode: session.roomCode });
      const rejection = await viewer.waitFor(isRejection);
      expect(rejection.code).toBe('ROOM_NOT_FULL');
      expect(rejection.message).toMatch(/join it/i);
    });

    it('counts watchers in the authoritative snapshot (P6-07)', async () => {
      const { x, xSession } = await match();
      expect(x.snapshot().spectatorCount).toBe(0);

      const first = await watch(xSession.roomCode);
      await x.waitFor(snapshotWhere((s) => s.spectatorCount === 1));

      const second = await watch(xSession.roomCode);
      await x.waitFor(snapshotWhere((s) => s.spectatorCount === 2));

      // Leaving is a detach: no slot freed, no host migration, match undisturbed.
      second.viewer.send({ type: 'room.leave', requestId: 'stop' });
      await x.waitFor(snapshotWhere((s) => s.spectatorCount === 1));
      expect(x.snapshot().phase).toBe('active');
      expect(x.snapshot().players).toHaveLength(2);
      expect(first.ready.roomCode).toBe(xSession.roomCode);
    });
  });

  describe('capability enforcement is server-side (P6-02, P6-04, INV-10)', () => {
    it('refuses a forged move from a spectator', async () => {
      // Hand-written frame, bypassing any client-side role check entirely.
      const { x, o, xSession } = await match();
      const { viewer } = await watch(xSession.roomCode);

      viewer.send({ type: 'game.move', requestId: 'forged', cell: 0, expectedRevision: viewer.snapshot().revision });
      const rejection = await viewer.waitFor(isRejection);
      expect(rejection.code).toBe('FORBIDDEN');
      expect(rejection.message).toMatch(/watching/i);

      await x.settle();
      expect(x.snapshot().board.every((cell) => cell === null)).toBe(true);
      expect(o.snapshot().board.every((cell) => cell === null)).toBe(true);
    });

    it('refuses chat, reactions and rematch votes from a spectator', async () => {
      const { xSession } = await match();
      const { viewer } = await watch(xSession.roomCode);

      const attempts: ClientMessage[] = [
        { type: 'chat.message', requestId: 'c', text: 'let me in' },
        { type: 'chat.quick-reaction', requestId: 'q', reaction: '🔥' },
        { type: 'rematch.vote', requestId: 'r' },
        { type: 'session.claim', requestId: 's' },
      ];
      for (const attempt of attempts) viewer.send(attempt);
      await viewer.settle();

      const codes = viewer.of('command.rejected').map((m) => m.code);
      expect(codes).toHaveLength(attempts.length);
      expect(new Set(codes)).toEqual(new Set(['FORBIDDEN']));
    });
  });

  describe('spectator privacy is enforced on the wire (P6-05)', () => {
    it('sends a watcher no chat at all under the default policy', async () => {
      const { x, o, xSession } = await match();
      const { viewer } = await watch(xSession.roomCode);
      expect(viewer.snapshot().spectatorPolicy.chat).toBe(false);

      x.send({ type: 'chat.message', requestId: 'private', text: 'a private note' });
      await o.waitFor(isChat);
      x.send({ type: 'chat.typing', typing: true });
      x.send({ type: 'chat.quick-reaction', requestId: 'qr', reaction: '🔥' });
      await viewer.settle(300);

      // Read off the socket, not the screen: the frames never arrive, so there
      // is nothing for a patched client to reveal.
      expect(viewer.of('chat.message')).toHaveLength(0);
      expect(viewer.of('chat.typing')).toHaveLength(0);
      expect(viewer.of('chat.quick-reaction')).toHaveLength(0);
      const raw = JSON.stringify(viewer.messages);
      expect(raw).not.toContain('a private note');

      // Meanwhile the players' own conversation is unaffected.
      expect(o.of('chat.message')).toHaveLength(1);
    });

    it('lets the host open chat to watchers, and only the host (P6-06)', async () => {
      const { x, o, xSession, oSession } = await match();
      const { viewer } = await watch(xSession.roomCode);

      // The guest is not the host, whatever they claim.
      o.send({ type: 'room.policy', requestId: 'not-host', spectatorChat: true });
      const refusal = await o.waitFor(isRejection);
      expect(refusal.code).toBe('FORBIDDEN');
      expect(refusal.message).toMatch(/host/i);
      expect(oSession.snapshot.players.find((p) => p.id === oSession.playerId)?.isHost).toBe(false);

      x.send({ type: 'room.policy', requestId: 'open-chat', spectatorChat: true });
      await viewer.waitFor(snapshotWhere((s) => s.spectatorPolicy.chat));

      x.send({ type: 'chat.message', requestId: 'now-shared', text: 'welcome, watchers' });
      const seen = await viewer.waitFor(isChat);
      expect(seen.message.kind === 'text' && seen.message.text).toBe('welcome, watchers');
    });

    it('closes chat again and stops delivery immediately', async () => {
      const { x, xSession } = await match();
      const { viewer } = await watch(xSession.roomCode);

      x.send({ type: 'room.policy', requestId: 'open', spectatorChat: true });
      await viewer.waitFor(snapshotWhere((s) => s.spectatorPolicy.chat));
      x.send({ type: 'chat.message', requestId: 'one', text: 'first' });
      await viewer.waitFor(isChat);

      x.send({ type: 'room.policy', requestId: 'close', spectatorChat: false });
      await viewer.waitFor(snapshotWhere((s) => !s.spectatorPolicy.chat));
      x.send({ type: 'chat.message', requestId: 'two', text: 'second' });
      await viewer.settle(300);

      expect(viewer.of('chat.message')).toHaveLength(1);
      expect(JSON.stringify(viewer.messages)).not.toContain('second');
    });
  });

  describe('teardown', () => {
    it('ends a watcher session when the room is destroyed', async () => {
      const { x, o, xSession } = await match();
      const { viewer } = await watch(xSession.roomCode);

      x.send({ type: 'room.leave', requestId: 'leave-x' });
      o.send({ type: 'room.leave', requestId: 'leave-o' });

      const ended = await viewer.waitFor((m): m is Of<'session.ended'> => m.type === 'session.ended');
      expect(ended.reason).toBe('LEFT');
      expect(server.manager.size).toBe(0);
    });
  });
});
