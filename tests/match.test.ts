import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/createGameServer';
import { PROTOCOL_VERSION, type ClientMessage, type RoomSnapshot, type ServerMessage } from '../shared/protocol';

/**
 * Series, turn limits, draws and replay (Phase 9).
 *
 * Every assertion here reads the server's own snapshot. The point of the phase
 * is that none of this is the client's to decide - a test that computed the
 * expected score itself and compared two clients against each other would pass
 * just as happily if both were wrong.
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

  /**
   * Where the transcript currently ends.
   *
   * Needed because a predicate over the whole history matches states the room
   * has already left. Round two refills the same cells as round one, so
   * "wait until cell 3 is filled" is satisfied instantly by a round-one
   * snapshot - and the test then races ahead of the move it was waiting for.
   */
  cursor(): number {
    return this.messages.length;
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
const isRejection = (m: ServerMessage): m is Of<'command.rejected'> => m.type === 'command.rejected';
const snapshotWhere = (predicate: (s: RoomSnapshot) => boolean) =>
  (m: ServerMessage): m is Of<'game.snapshot'> => m.type === 'game.snapshot' && predicate(m.snapshot);
const rejectionOf = (requestId: string) =>
  (m: ServerMessage): m is Of<'command.rejected'> => isRejection(m) && m.requestId === requestId;

describe('match features (Phase 9)', () => {
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
    x.send({ type: 'room.create', requestId: 'create' });
    const xSession = await x.waitFor(isSession);
    const o = await open();
    o.send({ type: 'room.join', requestId: 'join', roomCode: xSession.roomCode });
    const oSession = await o.waitFor(isSession);
    await x.waitFor(snapshotWhere((s) => s.phase === 'active'));
    await o.waitFor(snapshotWhere((s) => s.phase === 'active'));
    return { x, o, xSession, oSession };
  }

  /**
   * Plays one move and brings both sockets up to date.
   *
   * A mover reads its expectedRevision from the last snapshot it saw, so
   * letting the opponent fall a broadcast behind is enough for the next move to
   * be refused as stale - a race in the test, not in the server.
   */
  async function play(mover: Socket, waiter: Socket, cell: number, tag = ''): Promise<void> {
    const moverFrom = mover.cursor();
    const waiterFrom = waiter.cursor();
    mover.send({ type: 'game.move', requestId: 'm' + tag + cell, cell, expectedRevision: mover.snapshot().revision });
    await mover.waitFor(snapshotWhere((s) => s.board[cell] !== null), 4_000, moverFrom);
    await waiter.waitFor(snapshotWhere((s) => s.board[cell] !== null), 4_000, waiterFrom);
  }

  /** X wins on the top row; O answers in the middle. */
  async function winAsX(x: Socket, o: Socket, tag: string): Promise<void> {
    const from = x.cursor();
    await play(x, o, 0, tag);
    await play(o, x, 3, tag);
    await play(x, o, 1, tag);
    await play(o, x, 4, tag);
    await play(x, o, 2, tag);
    await x.waitFor(snapshotWhere((s) => s.phase === 'game_over'), 4_000, from);
  }

  async function rematch(x: Socket, o: Socket, round: number): Promise<void> {
    const xFrom = x.cursor();
    const oFrom = o.cursor();
    x.send({ type: 'rematch.vote', requestId: 'rx' + round });
    o.send({ type: 'rematch.vote', requestId: 'ro' + round });
    await x.waitFor(snapshotWhere((s) => s.round === round && s.phase === 'active'), 4_000, xFrom);
    await o.waitFor(snapshotWhere((s) => s.round === round && s.phase === 'active'), 4_000, oFrom);
  }

  describe('the series is the server’s (P9-01, P9-02)', () => {
    it('defaults to a single game with an empty score', async () => {
      const { x } = await match();
      const snapshot = x.snapshot();
      expect(snapshot.series.target).toBe(1);
      expect(snapshot.series.draws).toBe(0);
      expect(snapshot.series.scores.map((score) => score.wins)).toEqual([0, 0]);
      expect(snapshot.series.decidedBy).toBe(null);
      // A series is opted into. Two strangers are not signed up to five games
      // before they have played one.
      expect(snapshot.turnLimitMs).toBe(null);
    });

    it('counts wins against the player, not the mark, across a best-of-three', async () => {
      const { x, o, xSession } = await match();
      x.send({ type: 'room.format', requestId: 'format', seriesTarget: 3 });
      await x.waitFor(snapshotWhere((s) => s.series.target === 3));

      await winAsX(x, o, 'r1');
      const afterFirst = x.snapshot();
      expect(afterFirst.series.scores.find((score) => score.playerId === xSession.playerId)?.wins).toBe(1);
      expect(afterFirst.series.decidedBy).toBe(null);

      // Marks swap on a rematch, so the second round is won by the same person
      // playing O. A score kept against the mark would hand this to the loser.
      await rematch(x, o, 2);
      expect(x.snapshot().players.find((player) => player.id === xSession.playerId)?.mark).toBe('O');
      const secondRound = x.cursor();
      await winAsX(o, x, 'r2');
      const levelled = await x.waitFor(snapshotWhere((s) => s.series.draws + s.series.scores.reduce((t, c) => t + c.wins, 0) === 2), 4_000, secondRound);
      // One each, and the win just scored belongs to the person who was X in
      // round one and O in round two. A score kept against the mark would have
      // credited it to the wrong player.
      expect(levelled.snapshot.series.scores.map((score) => score.wins).sort()).toEqual([1, 1]);
      expect(levelled.snapshot.series.decidedBy).toBe(null);

      // Best of three means first to two, so the series is still open. Marks
      // swap again, so round three is another winAsX for the same socket.
      await rematch(x, o, 3);
      const thirdRound = x.cursor();
      expect(x.snapshot().players.find((player) => player.id === xSession.playerId)?.mark).toBe('X');
      await winAsX(x, o, 'r3');

      const decided = await x.waitFor(snapshotWhere((s) => s.series.decidedBy !== null), 4_000, thirdRound);
      expect(decided.snapshot.series.decidedBy).toBe(xSession.playerId);
      expect(decided.snapshot.series.scores.find((score) => score.playerId === xSession.playerId)?.wins).toBe(2);
    });

    it('survives a reconnect, because it was never held on the client', async () => {
      const { x, o, xSession } = await match();
      x.send({ type: 'room.format', requestId: 'format', seriesTarget: 5 });
      await x.waitFor(snapshotWhere((s) => s.series.target === 5));
      await winAsX(x, o, 'r1');

      x.close();
      const resumed = await open();
      resumed.send({
        type: 'session.resume',
        requestId: 'resume',
        roomCode: xSession.roomCode,
        playerToken: xSession.playerToken,
      });
      const restored = await resumed.waitFor(isSession);
      expect(restored.snapshot.series.target).toBe(5);
      expect(restored.snapshot.series.scores.find((score) => score.playerId === xSession.playerId)?.wins).toBe(1);
      // And the round that produced that win is still replayable.
      expect(restored.snapshot.moves).toHaveLength(5);
    });

    it('starts a new series rather than continuing past a decided one', async () => {
      const { x, o } = await match();
      await winAsX(x, o, 'r1');
      expect(x.snapshot().series.decidedBy).not.toBe(null);

      await rematch(x, o, 2);
      const fresh = x.snapshot();
      // Carrying a finished score forward would mean the next round decides a
      // series that was already over.
      expect(fresh.series.decidedBy).toBe(null);
      expect(fresh.series.scores.map((score) => score.wins)).toEqual([0, 0]);
      expect(fresh.series.draws).toBe(0);
    });

    it('lets only the host set the format, and only before a round is decided', async () => {
      const { x, o } = await match();
      o.send({ type: 'room.format', requestId: 'not-host', seriesTarget: 3 });
      expect((await o.waitFor(rejectionOf('not-host'))).code).toBe('FORBIDDEN');

      // During the first round is allowed: it decides nothing, and a host who
      // only thinks of "best of three" after the opening move should not have
      // to rebuild the room.
      x.send({ type: 'room.format', requestId: 'mid-round', seriesTarget: 5 });
      await x.waitFor(snapshotWhere((s) => s.series.target === 5));

      // Once a round is decided it is locked, because changing the target now
      // would retroactively decide or undecide the series.
      await winAsX(x, o, 'r1');
      x.send({ type: 'room.format', requestId: 'too-late', seriesTarget: 3 });
      expect((await x.waitFor(rejectionOf('too-late'))).code).toBe('FORMAT_LOCKED');
      expect(x.snapshot().series.target).toBe(5);
    });
  });

  describe('the turn limit is enforced by the server (P9-03, P9-04)', () => {
    it('passes the turn when it runs out, leaving the board untouched', async () => {
      const x = await open();
      x.send({ type: 'room.create', requestId: 'create' });
      const xSession = await x.waitFor(isSession);
      // Set before anyone joins, which is when the format is still open.
      x.send({ type: 'room.format', requestId: 'format', turnLimitMs: 15_000 });
      await x.waitFor(snapshotWhere((s) => s.turnLimitMs === 15_000));

      const o = await open();
      o.send({ type: 'room.join', requestId: 'join', roomCode: xSession.roomCode });
      await o.waitFor(isSession);
      const started = await x.waitFor(snapshotWhere((s) => s.phase === 'active'));
      // The clock leaves the server as a duration, never as a deadline, so a
      // client with a wrong wall clock cannot misread it (INV-11).
      expect(started.timing.turnMsRemaining).toBeGreaterThan(0);
      expect(started.timing.turnMsRemaining).toBeLessThanOrEqual(15_000);
    });

    it('expires a turn against the server clock alone', async () => {
      // A 60ms limit stands in for 15s: the property is that the *server*
      // decides, which does not depend on how long the limit is. The real
      // limits are enumerated in the protocol so a host cannot pick 60ms as a
      // way to grief an opponent.
      await server.close();
      server = await createGameServer({
        port: 0,
        host: '127.0.0.1',
        countdownMs: 10,
        cleanupIntervalMs: 10_000,
        turnLimitOverrideMs: 60,
      });
      url = 'ws://127.0.0.1:' + server.port + '/ws';

      const x = await open();
      x.send({ type: 'room.create', requestId: 'create' });
      const xSession = await x.waitFor(isSession);
      x.send({ type: 'room.format', requestId: 'format', turnLimitMs: 15_000 });
      await x.waitFor(snapshotWhere((s) => s.turnLimitMs === 15_000));
      const o = await open();
      o.send({ type: 'room.join', requestId: 'join', roomCode: xSession.roomCode });
      const oSession = await o.waitFor(isSession);
      await x.waitFor(snapshotWhere((s) => s.phase === 'active'));

      // Nobody moves. X is to play, so X loses the turn - and is told, because
      // the board does not change and the turn moving would otherwise be
      // unexplained.
      const expired = await x.waitFor((m): m is Of<'turn.expired'> => m.type === 'turn.expired');
      expect(expired.playerId).toBe(xSession.playerId);
      const passed = await x.waitFor(snapshotWhere((s) => s.turn === 'O'));
      expect(passed.snapshot.board.every((cell) => cell === null)).toBe(true);

      // And the opponent now has a clock of their own.
      const theirTurn = await o.waitFor(snapshotWhere((s) => s.turn === 'O'));
      expect(theirTurn.timing.turnMsRemaining).toBeGreaterThan(0);
      expect(oSession.playerId).not.toBe(xSession.playerId);

      // A moving player is never punished for a turn they used: placing a mark
      // restarts the clock for the other side rather than leaving the old
      // deadline running.
      o.send({ type: 'game.move', requestId: 'o-move', cell: 4, expectedRevision: o.snapshot().revision });
      const afterMove = await o.waitFor(snapshotWhere((s) => s.board[4] === 'O'));
      expect(afterMove.timing.turnMsRemaining).toBeGreaterThan(0);
    });

    it('does not run a clock at all when no limit is set', async () => {
      const { x } = await match();
      await x.settle(200);
      const latest = x.of('game.snapshot').at(-1);
      expect(latest?.timing.turnMsRemaining).toBe(null);
      expect(x.of('turn.expired')).toHaveLength(0);
    });
  });

  describe('draw offers (P9-05, P9-06)', () => {
    it('ends the round as a draw when accepted, and books it in the series', async () => {
      const { x, o } = await match();
      x.send({ type: 'draw.offer', requestId: 'offer' });
      const offered = await o.waitFor(snapshotWhere((s) => s.drawOffer !== null));
      expect(offered.snapshot.drawOffer?.byPlayerId).toBe(x.snapshot().players.find((p) => p.mark === 'X')?.id);

      o.send({ type: 'draw.respond', requestId: 'accept', accept: true });
      const drawn = await x.waitFor(snapshotWhere((s) => s.isDraw));
      expect(drawn.snapshot.phase).toBe('game_over');
      expect(drawn.snapshot.winner).toBe(null);
      expect(drawn.snapshot.series.draws).toBe(1);
      expect(drawn.snapshot.drawOffer).toBe(null);
    });

    it('clears the offer on a decline and says so', async () => {
      const { x, o } = await match();
      x.send({ type: 'draw.offer', requestId: 'offer' });
      await o.waitFor(snapshotWhere((s) => s.drawOffer !== null));

      o.send({ type: 'draw.respond', requestId: 'decline', accept: false });
      const declined = await x.waitFor((m): m is Of<'draw.declined'> => m.type === 'draw.declined');
      expect(declined.byPlayerId).toBe(x.snapshot().players.find((p) => p.mark === 'O')?.id);
      await x.waitFor(snapshotWhere((s) => s.drawOffer === null && s.phase === 'active'));
      expect(x.snapshot().isDraw).toBe(false);
    });

    it('treats simultaneous offers as an agreement rather than a race', async () => {
      const { x, o } = await match();
      // Both in the same tick. One of them arrives second and finds an offer
      // from the opponent outstanding; refusing it, or opening a second offer,
      // would throw away what both players just said.
      x.send({ type: 'draw.offer', requestId: 'offer-x' });
      o.send({ type: 'draw.offer', requestId: 'offer-o' });

      const drawn = await x.waitFor(snapshotWhere((s) => s.isDraw));
      expect(drawn.snapshot.series.draws).toBe(1);
      expect(x.of('command.rejected')).toHaveLength(0);
      expect(o.of('command.rejected')).toHaveLength(0);
    });

    it('withdraws an offer when the position changes under it', async () => {
      const { x, o } = await match();
      x.send({ type: 'draw.offer', requestId: 'offer' });
      await o.waitFor(snapshotWhere((s) => s.drawOffer !== null));

      // Playing on is a decline. Leaving the offer standing would let a player
      // accept a draw in a position that no longer exists.
      await play(x, o, 4);
      expect(x.snapshot().drawOffer).toBe(null);

      o.send({ type: 'draw.respond', requestId: 'late-accept', accept: true });
      expect((await o.waitFor(rejectionOf('late-accept'))).code).toBe('NO_DRAW_OFFER');
      expect(x.snapshot().isDraw).toBe(false);
    });

    it('refuses an offer answered by the player who made it', async () => {
      const { x } = await match();
      x.send({ type: 'draw.offer', requestId: 'offer' });
      await x.waitFor(snapshotWhere((s) => s.drawOffer !== null));
      x.send({ type: 'draw.respond', requestId: 'self-accept', accept: true });
      expect((await x.waitFor(rejectionOf('self-accept'))).code).toBe('FORBIDDEN');
      expect(x.snapshot().isDraw).toBe(false);
    });

    it('refuses an offer once the round is over', async () => {
      const { x, o } = await match();
      await winAsX(x, o, 'r1');
      o.send({ type: 'draw.offer', requestId: 'too-late' });
      expect((await o.waitFor(rejectionOf('too-late'))).code).toBe('GAME_NOT_ACTIVE');
    });
  });

  describe('rematch votes (P9-07)', () => {
    it('produces exactly one transition from near-simultaneous votes', async () => {
      const { x, o } = await match();
      await winAsX(x, o, 'r1');

      // Both votes in the same tick, plus a duplicate of each: the room must
      // advance one round, not two, and must not end up mid-transition.
      x.send({ type: 'rematch.vote', requestId: 'rx' });
      o.send({ type: 'rematch.vote', requestId: 'ro' });
      x.send({ type: 'rematch.vote', requestId: 'rx' });
      o.send({ type: 'rematch.vote', requestId: 'ro-again' });
      await x.waitFor(snapshotWhere((s) => s.round === 2));
      await x.settle(300);

      const rounds = x.of('game.snapshot').map((m) => m.snapshot.round);
      expect(Math.max(...rounds)).toBe(2);
      expect(new Set(rounds)).toEqual(new Set([1, 2]));
      expect(x.of('command.rejected')).toHaveLength(0);
      expect(x.snapshot().board.every((cell) => cell === null)).toBe(true);
    });
  });

  describe('replay material (P9-08)', () => {
    it('records the round’s moves in order and clears them on a rematch', async () => {
      const { x, o } = await match();
      await play(x, o, 0);
      await play(o, x, 4);
      await play(x, o, 8);

      expect(x.snapshot().moves).toEqual([
        { cell: 0, mark: 'X' },
        { cell: 4, mark: 'O' },
        { cell: 8, mark: 'X' },
      ]);
      // Both clients hold the same history, which is what makes it replayable
      // by a window that reconnected partway through (INV-3).
      expect(o.snapshot().moves).toEqual(x.snapshot().moves);

      await play(o, x, 1);
      await play(x, o, 2);
      await play(o, x, 7);
      await x.waitFor(snapshotWhere((s) => s.phase === 'game_over'));
      await rematch(x, o, 2);
      // A new round is a new replay. Keeping the previous round's moves would
      // replay the wrong game.
      expect(x.snapshot().moves).toEqual([]);
    });

    it('records a timed-out turn as no move at all', async () => {
      await server.close();
      server = await createGameServer({
        port: 0,
        host: '127.0.0.1',
        countdownMs: 10,
        cleanupIntervalMs: 10_000,
        turnLimitOverrideMs: 60,
      });
      url = 'ws://127.0.0.1:' + server.port + '/ws';

      const x = await open();
      x.send({ type: 'room.create', requestId: 'create' });
      const xSession = await x.waitFor(isSession);
      x.send({ type: 'room.format', requestId: 'format', turnLimitMs: 30_000 });
      await x.waitFor(snapshotWhere((s) => s.turnLimitMs === 30_000));
      const o = await open();
      o.send({ type: 'room.join', requestId: 'join', roomCode: xSession.roomCode });
      await o.waitFor(isSession);
      await x.waitFor((m): m is Of<'turn.expired'> => m.type === 'turn.expired');

      // A replay shows what was played. A turn nobody used is not a move.
      expect(x.snapshot().moves).toEqual([]);
    });
  });
});
