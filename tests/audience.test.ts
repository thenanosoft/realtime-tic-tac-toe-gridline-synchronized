import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/createGameServer';
import { PROTOCOL_VERSION, type ClientMessage, type RoomSnapshot, type ServerMessage } from '../shared/protocol';

/**
 * A room with an audience that can join it (Phase 13).
 *
 * The property under test is that a seat is a role the room assigns, not a
 * prize for arriving second. Everything here reads the server's own snapshot:
 * who is playing, who is waiting, and who said what.
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

  cursor(): number {
    return this.messages.length;
  }

  of<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  async waitFor<T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    timeout = 4_000,
    since = 0,
  ): Promise<T> {
    const existing = this.messages.slice(since).find(predicate);
    if (existing) return existing;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(
          'timed out; rejections=' + JSON.stringify(this.of('command.rejected'))
          + ' types=' + JSON.stringify(this.messages.map((m) => m.type)),
        ));
      }, timeout);
      const check = () => {
        const found = this.messages.slice(since).find(predicate);
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
const isChat = (m: ServerMessage): m is Of<'chat.message'> => m.type === 'chat.message';
const isRejection = (m: ServerMessage): m is Of<'command.rejected'> => m.type === 'command.rejected';
const rejectionOf = (requestId: string) =>
  (m: ServerMessage): m is Of<'command.rejected'> => isRejection(m) && m.requestId === requestId;
const snapshotWhere = (predicate: (s: RoomSnapshot) => boolean) =>
  (m: ServerMessage): m is Of<'game.snapshot'> => m.type === 'game.snapshot' && predicate(m.snapshot);

describe('an audience that can join the game (Phase 13)', () => {
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

  /** A room with two players and `watchers` people watching it. */
  async function room(watchers = 0) {
    const host = await open();
    host.send({ type: 'room.create', requestId: 'create' });
    const hostSession = await host.waitFor(isSession);
    const guest = await open();
    guest.send({ type: 'room.join', requestId: 'join', roomCode: hostSession.roomCode });
    const guestSession = await guest.waitFor(isSession);
    await host.waitFor(snapshotWhere((s) => s.phase === 'active'));

    const watching: Array<{ socket: Socket; ready: Of<'spectator.ready'> }> = [];
    for (let index = 0; index < watchers; index += 1) {
      const socket = await open();
      socket.send({ type: 'room.spectate', requestId: 'watch' + index, roomCode: hostSession.roomCode });
      watching.push({ socket, ready: await socket.waitFor(isWatching) });
    }
    return { host, guest, hostSession, guestSession, watching };
  }

  /** Plays the host to a win on the top row, so the room is between rounds. */
  async function finishTheRound(host: Socket, guest: Socket): Promise<void> {
    for (const [mover, cell] of [[host, 0], [guest, 3], [host, 1], [guest, 4], [host, 2]] as Array<[Socket, number]>) {
      const from = mover.cursor();
      mover.send({ type: 'game.move', requestId: 'm' + cell, cell, expectedRevision: mover.snapshot().revision });
      await mover.waitFor(snapshotWhere((s) => s.board[cell] !== null), 4_000, from);
      await (mover === host ? guest : host).waitFor(snapshotWhere((s) => s.board[cell] !== null));
    }
    await host.waitFor(snapshotWhere((s) => s.phase === 'game_over'));
  }

  describe('watchers are counted and can ask to play (P13-06, P13-07)', () => {
    it('shows the queue to everyone, oldest first', async () => {
      const { host, watching } = await room(2);
      expect(host.snapshot().spectatorCount).toBe(2);
      expect(host.snapshot().playRequests).toEqual([]);

      watching[1].socket.send({ type: 'room.request-play', requestId: 'first' });
      await host.waitFor(snapshotWhere((s) => s.playRequests.length === 1));
      watching[0].socket.send({ type: 'room.request-play', requestId: 'second' });
      const both = await host.waitFor(snapshotWhere((s) => s.playRequests.length === 2));

      // Ordered by when they asked, not by who they are - the queue is a queue.
      expect(both.snapshot.playRequests.map((request) => request.spectatorId))
        .toEqual([watching[1].ready.spectatorId, watching[0].ready.spectatorId]);
      expect(both.snapshot.playRequests[0].name).toBe(watching[1].ready.displayName);
      // And everyone sees it, not only the host: hiding the queue would make
      // the host's choice look arbitrary to the people waiting in it.
      await watching[0].socket.waitFor(snapshotWhere((s) => s.playRequests.length === 2));
    });

    it('treats asking twice as asking once, and keeps the original place', async () => {
      const { host, watching } = await room(2);
      watching[0].socket.send({ type: 'room.request-play', requestId: 'a1' });
      await host.waitFor(snapshotWhere((s) => s.playRequests.length === 1));
      watching[1].socket.send({ type: 'room.request-play', requestId: 'b1' });
      await host.waitFor(snapshotWhere((s) => s.playRequests.length === 2));

      watching[0].socket.send({ type: 'room.request-play', requestId: 'a2' });
      await host.settle(200);
      const queue = host.snapshot().playRequests;
      expect(queue).toHaveLength(2);
      expect(queue[0].spectatorId).toBe(watching[0].ready.spectatorId);
    });

    it('lets a watcher change their mind', async () => {
      const { host, watching } = await room(1);
      watching[0].socket.send({ type: 'room.request-play', requestId: 'ask' });
      await host.waitFor(snapshotWhere((s) => s.playRequests.length === 1));
      watching[0].socket.send({ type: 'room.withdraw-play', requestId: 'withdraw' });
      await host.waitFor(snapshotWhere((s) => s.playRequests.length === 0));
    });

    it('takes the request away when the watcher leaves', async () => {
      const { host, watching } = await room(1);
      watching[0].socket.send({ type: 'room.request-play', requestId: 'ask' });
      await host.waitFor(snapshotWhere((s) => s.playRequests.length === 1));

      watching[0].socket.close();
      // Otherwise the host is offered a seat for someone who is not here.
      await host.waitFor(snapshotWhere((s) => s.playRequests.length === 0 && s.spectatorCount === 0));
    });

    it('refuses the request from someone who is already playing', async () => {
      const { guest } = await room(1);
      guest.send({ type: 'room.request-play', requestId: 'already' });
      expect((await guest.waitFor(rejectionOf('already'))).code).toBe('NOT_WATCHING');
    });
  });

  describe('the host seats a watcher (P13-08)', () => {
    it('swaps the watcher in and the player out, keeping both in the room', async () => {
      const { host, guest, guestSession, watching } = await room(1);
      const watcher = watching[0];
      watcher.socket.send({ type: 'room.request-play', requestId: 'ask' });
      await host.waitFor(snapshotWhere((s) => s.playRequests.length === 1));

      // Between rounds only. Mid-round, the answer is no and says why.
      host.send({ type: 'room.seat', requestId: 'too-soon', spectatorId: watcher.ready.spectatorId });
      expect((await host.waitFor(rejectionOf('too-soon'))).code).toBe('ROUND_IN_PROGRESS');

      // Finish the round so the room is between games.
      await finishTheRound(host, guest);

      const seatCursor = host.cursor();
      host.send({ type: 'room.seat', requestId: 'seat', spectatorId: watcher.ready.spectatorId });

      // The watcher is handed a seat, with a token of their own.
      const seated = await watcher.socket.waitFor(isSession);
      expect(seated.playerToken.length).toBeGreaterThan(20);
      expect(seated.displayName).toBe(watcher.ready.displayName);
      // The player they replaced is still here, watching.
      const demoted = await guest.waitFor(isWatching);
      expect(demoted.displayName).toBe(guestSession.displayName);

      const after = await host.waitFor(snapshotWhere((s) => s.players.some((p) => p.id === seated.playerId)), 4_000, seatCursor);
      expect(after.snapshot.players).toHaveLength(2);
      expect(after.snapshot.players.map((p) => p.name).sort())
        .toEqual([watcher.ready.displayName, host.snapshot().players.find((p) => p.isHost)?.name].sort());
      expect(after.snapshot.spectatorCount).toBe(1);
      // The queue entry is spent, not left behind.
      expect(after.snapshot.playRequests).toEqual([]);
    });

    it('starts a new series, because a different opponent is a different match-up', async () => {
      const { host, guest, watching } = await room(1);
      await finishTheRound(host, guest);
      expect(host.snapshot().series.scores.some((score) => score.wins === 1)).toBe(true);

      host.send({ type: 'room.seat', requestId: 'seat', spectatorId: watching[0].ready.spectatorId });
      const fresh = await host.waitFor(snapshotWhere((s) => s.series.scores.every((score) => score.wins === 0)));
      // Carrying the score forward would credit the newcomer with rounds
      // somebody else lost.
      expect(fresh.snapshot.series.draws).toBe(0);
      expect(fresh.snapshot.board.every((cell) => cell === null)).toBe(true);
    });

    it('refuses to seat anyone but the host, and refuses an absent watcher', async () => {
      const { host, guest, watching } = await room(1);
      guest.send({ type: 'room.seat', requestId: 'not-host', spectatorId: watching[0].ready.spectatorId });
      expect((await guest.waitFor(rejectionOf('not-host'))).code).toBe('FORBIDDEN');

      // Between rounds, so the refusal is about the watcher rather than about
      // the timing - the phase check comes first and would mask it.
      await finishTheRound(host, guest);
      // From here on, because snapshots from before the watcher arrived also
      // report nobody watching - and waiting on one of those would send the
      // seat command while the watcher was still in the room, which is a
      // different test passing by accident.
      const departure = host.cursor();
      watching[0].socket.close();
      await host.waitFor(snapshotWhere((s) => s.spectatorCount === 0), 4_000, departure);

      host.send({ type: 'room.seat', requestId: 'ghost', spectatorId: watching[0].ready.spectatorId });
      expect((await host.waitFor(rejectionOf('ghost'))).code).toBe('NOT_IN_ROOM');
    });
  });

  describe('watchers are in the conversation (P13-05, P13-09)', () => {
    it('lets a watcher talk, and names them on every screen', async () => {
      const { host, guest, watching } = await room(1);
      const watcher = watching[0];

      watcher.socket.send({ type: 'chat.message', requestId: 'hello', text: 'good game so far' });
      const seenByHost = await host.waitFor(isChat);
      const seenByGuest = await guest.waitFor(isChat);

      // The name travels with the message, because the sender is not in the
      // player list and never will be while they are watching.
      expect(seenByHost.message.senderName).toBe(watcher.ready.displayName);
      expect(seenByHost.message.senderRole).toBe('spectator');
      expect(seenByGuest.message.senderName).toBe(watcher.ready.displayName);
      expect(seenByHost.message.kind === 'text' && seenByHost.message.text).toBe('good game so far');
    });

    it('keeps a name on what was said before the speaker changed role', async () => {
      const { host, guest, guestSession, watching } = await room(1);
      guest.send({ type: 'chat.message', requestId: 'early', text: 'as a player' });
      const early = await host.waitFor(isChat);
      expect(early.message.senderName).toBe(guestSession.displayName);

      await finishTheRound(host, guest);
      host.send({ type: 'room.seat', requestId: 'seat', spectatorId: watching[0].ready.spectatorId });
      await guest.waitFor(isWatching);

      // The message was resolved when it was said, so being seated out later
      // cannot take the speaker's name off their earlier words.
      const history = host.of('chat.message').map((m) => m.message.senderName);
      expect(history).toContain(guestSession.displayName);
    });

    it('still refuses a watcher the things that belong to a seat', async () => {
      const { watching } = await room(1);
      const watcher = watching[0].socket;
      for (const attempt of [
        { type: 'chat.quick-reaction', requestId: 'q', reaction: '🔥' },
        { type: 'rematch.vote', requestId: 'r' },
      ] as ClientMessage[]) {
        watcher.send(attempt);
      }
      await watcher.settle(250);
      expect(watcher.of('command.rejected').map((m) => m.code)).toEqual(['FORBIDDEN', 'FORBIDDEN']);
    });

    it('falls silent again the moment the host closes the conversation', async () => {
      const { host, watching } = await room(1);
      host.send({ type: 'room.policy', requestId: 'close', spectatorChat: false });
      await watching[0].socket.waitFor(snapshotWhere((s) => !s.spectatorPolicy.chat));

      watching[0].socket.send({ type: 'chat.message', requestId: 'blocked', text: 'can I still talk' });
      const refused = await watching[0].socket.waitFor(rejectionOf('blocked'));
      expect(refused.code).toBe('FORBIDDEN');
      // Refused at the server, so the message never reaches the room at all.
      await host.settle(200);
      expect(JSON.stringify(host.messages)).not.toContain('can I still talk');
    });
  });
});
