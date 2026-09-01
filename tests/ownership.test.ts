import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/createGameServer';
import { PROTOCOL_VERSION, type ClientMessage, type RoomSnapshot, type ServerMessage } from '../shared/protocol';

/**
 * Presence, socket ownership and host migration (Phase 4).
 *
 * The policy under test is D-002: the newest connection takes the player slot
 * and the displaced one stays attached as an explicit read-only view, rather
 * than having its socket closed. A player slot and a connection are separate
 * things here, and most of these tests exist to pin that separation down.
 */

class Window {
  readonly messages: ServerMessage[] = [];
  private readonly listeners = new Set<() => void>();
  closedWith: number | null = null;

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const listener of this.listeners) listener();
    });
    socket.on('close', (code) => { this.closedWith = code; });
  }

  static async open(url: string): Promise<Window> {
    const socket = new WebSocket(url);
    const window = new Window(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return window;
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
        reject(new Error('timed out; received ' + JSON.stringify(this.messages).slice(0, 700)));
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
      if (m.type === 'game.snapshot' || m.type === 'session.ready') return m.snapshot;
    }
    throw new Error('no snapshot received');
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.socket.close();
  }
}

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
const isSession = (m: ServerMessage): m is Of<'session.ready'> => m.type === 'session.ready';
const isControl = (m: ServerMessage): m is Of<'session.control'> => m.type === 'session.control';
const isRejection = (m: ServerMessage): m is Of<'command.rejected'> => m.type === 'command.rejected';
const isEnded = (m: ServerMessage): m is Of<'session.ended'> => m.type === 'session.ended';
const snapshotWhere = (predicate: (s: RoomSnapshot) => boolean) =>
  (m: ServerMessage): m is Of<'game.snapshot'> => m.type === 'game.snapshot' && predicate(m.snapshot);

describe('presence, ownership and host migration (Phase 4)', () => {
  let server: GameServerHandle;
  let url: string;
  const windows: Window[] = [];

  beforeEach(async () => {
    server = await createGameServer({
      port: 0,
      host: '127.0.0.1',
      countdownMs: 15,
      heartbeatMs: 5_000,
      reconnectGraceMs: 400,
      reservationTtlMs: 400,
      cleanupIntervalMs: 40,
      typingTtlMs: 40,
    });
    url = 'ws://127.0.0.1:' + server.port + '/ws';
  });

  afterEach(async () => {
    for (const window of windows) window.close();
    windows.length = 0;
    await server.close();
  });

  async function open(): Promise<Window> {
    const window = await Window.open(url);
    windows.push(window);
    return window;
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

  describe('multi-tab ownership (P4-03, D-002)', () => {
    it('keeps the displaced window attached instead of closing its socket', async () => {
      const first = await open();
      first.send({ type: 'room.create', requestId: 'create' });
      const session = await first.waitFor(isSession);
      expect(session.hasControl).toBe(true);

      const second = await open();
      second.send({
        type: 'session.resume',
        requestId: 'resume',
        roomCode: session.roomCode,
        playerToken: session.playerToken,
      });
      const resumed = await second.waitFor(isSession);

      // The heart of the policy. This used to close the old socket with 4001,
      // which left the tab looking broken with no way back.
      const displaced = await first.waitFor(isControl);
      expect(displaced.hasControl).toBe(false);
      expect(displaced.reason).toBe('DISPLACED');
      expect(first.isOpen).toBe(true);
      expect(first.closedWith).toBeNull();

      expect(resumed.hasControl).toBe(true);
      expect(resumed.playerId).toBe(session.playerId);
      // One human, one player, whatever the window count (INV-6).
      expect(resumed.snapshot.players).toHaveLength(1);
      expect(resumed.snapshot.players[0].connectionCount).toBe(2);
    });

    it('refuses commands from the read-only window and says why', async () => {
      const { x, o, xSession } = await match();

      const second = await open();
      second.send({
        type: 'session.resume',
        requestId: 'resume',
        roomCode: xSession.roomCode,
        playerToken: xSession.playerToken,
      });
      await second.waitFor(isSession);
      await x.waitFor(isControl);

      x.send({ type: 'game.move', requestId: 'from-readonly', cell: 0, expectedRevision: x.snapshot().revision });
      const rejection = await x.waitFor(isRejection);
      expect(rejection.code).toBe('NOT_IN_CONTROL');
      expect(rejection.message).toMatch(/take control/i);

      // Chat is a mutation too - read-only means read-only.
      x.send({ type: 'chat.message', requestId: 'chat-from-readonly', text: 'hello' });
      const chatRejection = await x.waitFor(
        (m): m is Of<'command.rejected'> => m.type === 'command.rejected' && m.requestId === 'chat-from-readonly',
      );
      expect(chatRejection.code).toBe('NOT_IN_CONTROL');

      // The board is untouched, and the opponent never saw anything.
      await o.settle();
      expect(o.snapshot().board.every((cell) => cell === null)).toBe(true);
      expect(o.of('chat.message')).toHaveLength(0);
    });

    it('still feeds the read-only window every authoritative update', async () => {
      // A demoted view that showed a stale board would be worse than no view.
      const { x, o, xSession } = await match();
      const second = await open();
      second.send({
        type: 'session.resume', requestId: 'resume',
        roomCode: xSession.roomCode, playerToken: xSession.playerToken,
      });
      await second.waitFor(isSession);
      await x.waitFor(isControl);

      second.send({ type: 'game.move', requestId: 'move', cell: 4, expectedRevision: second.snapshot().revision });
      await o.waitFor(snapshotWhere((s) => s.board[4] === 'X'));
      await x.waitFor(snapshotWhere((s) => s.board[4] === 'X'));
      expect(x.snapshot().board[4]).toBe('X');
    });

    it('lets the displaced window claim control back', async () => {
      const first = await open();
      first.send({ type: 'room.create', requestId: 'create' });
      const session = await first.waitFor(isSession);

      const second = await open();
      second.send({
        type: 'session.resume', requestId: 'resume',
        roomCode: session.roomCode, playerToken: session.playerToken,
      });
      await second.waitFor(isSession);
      await first.waitFor(isControl);

      first.send({ type: 'session.claim', requestId: 'claim' });
      const regained = await first.waitFor(
        (m): m is Of<'session.control'> => m.type === 'session.control' && m.hasControl,
      );
      expect(regained.reason).toBe('GRANTED');

      const lost = await second.waitFor(
        (m): m is Of<'session.control'> => m.type === 'session.control' && !m.hasControl,
      );
      expect(lost.reason).toBe('DISPLACED');
      expect(second.isOpen).toBe(true);
    });

    it('resolves a two-window race for the slot with exactly one winner', async () => {
      // Control is server-authoritative precisely so the loser of a race is told
      // it lost rather than quietly believing it won.
      const first = await open();
      first.send({ type: 'room.create', requestId: 'create' });
      const session = await first.waitFor(isSession);
      const second = await open();
      second.send({
        type: 'session.resume', requestId: 'resume',
        roomCode: session.roomCode, playerToken: session.playerToken,
      });
      await second.waitFor(isSession);
      await first.waitFor(isControl);

      first.send({ type: 'session.claim', requestId: 'claim-first' });
      second.send({ type: 'session.claim', requestId: 'claim-second' });
      await first.settle(400);

      const holders = [first, second].filter((window) => {
        const last = window.of('session.control').at(-1);
        return last?.hasControl === true;
      });
      expect(holders, 'exactly one window may hold the slot').toHaveLength(1);
    });

    it('hands control to a surviving window when the controller disconnects', async () => {
      const first = await open();
      first.send({ type: 'room.create', requestId: 'create' });
      const session = await first.waitFor(isSession);
      const second = await open();
      second.send({
        type: 'session.resume', requestId: 'resume',
        roomCode: session.roomCode, playerToken: session.playerToken,
      });
      await second.waitFor(isSession);
      await first.waitFor(isControl);

      // The controlling window goes away; the other one is still there, so the
      // player never actually left and the match must not pause.
      second.close();
      const reclaimed = await first.waitFor(
        (m): m is Of<'session.control'> => m.type === 'session.control' && m.hasControl,
      );
      expect(reclaimed.reason).toBe('RECLAIMED');
      await first.waitFor(snapshotWhere((s) => s.players[0].connectionCount === 1));
      expect(first.snapshot().players[0].presence).toBe('online');
    });
  });

  describe('presence state machine (P4-01)', () => {
    it('reports online while any window is attached', async () => {
      const { x } = await match();
      expect(x.snapshot().players.every((player) => player.presence === 'online')).toBe(true);
      expect(x.snapshot().players.every((player) => player.connectionCount === 1)).toBe(true);
    });

    it('moves to reconnecting when the last window drops, then back to online', async () => {
      const { x, o, oSession } = await match();
      o.close();

      const paused = await x.waitFor(snapshotWhere((s) => s.phase === 'paused'));
      const away = paused.snapshot.players.find((player) => player.id === oSession.playerId);
      expect(away?.presence).toBe('reconnecting');
      expect(away?.connectionCount).toBe(0);

      const returning = await open();
      returning.send({
        type: 'session.resume', requestId: 'resume',
        roomCode: oSession.roomCode, playerToken: oSession.playerToken,
      });
      await returning.waitFor(isSession);
      await x.waitFor(snapshotWhere((s) =>
        s.players.find((player) => player.id === oSession.playerId)?.presence === 'online'));
    });

    it('moves from reconnecting to offline once the grace period lapses', async () => {
      // reconnectGraceMs is 400ms in this suite, so the transition is observable
      // without the test having to wait out a production-length grace period.
      const { x, o, oSession } = await match();
      o.close();
      await x.waitFor(snapshotWhere((s) =>
        s.players.find((player) => player.id === oSession.playerId)?.presence === 'reconnecting'));

      // The server has to *announce* this one. Presence is derived from the
      // clock, so nothing else would carry the transition and the opponent would
      // sit on "Reconnecting..." forever - correct on the server, wrong on every
      // screen. The sweep detects the drift and broadcasts.
      const gone = await x.waitFor(snapshotWhere((s) =>
        s.players.find((player) => player.id === oSession.playerId)?.presence === 'offline'));
      const stillHeld = gone.snapshot.players.find((player) => player.id === oSession.playerId);
      expect(stillHeld?.presence).toBe('offline');
      expect(stillHeld?.connectionCount).toBe(0);
    });
  });

  describe('cross-device reclaim (P4-05)', () => {
    it('moves a session to a second device with the same identity and mark', async () => {
      const { x, o, xSession } = await match();
      const nameBefore = xSession.displayName;
      const markBefore = xSession.mark;

      // The laptop goes away entirely, then the phone resumes by token.
      x.close();
      await o.waitFor(snapshotWhere((s) => s.phase === 'paused'));

      const phone = await open();
      phone.send({
        type: 'session.resume', requestId: 'phone',
        roomCode: xSession.roomCode, playerToken: xSession.playerToken,
      });
      const resumed = await phone.waitFor(isSession);

      expect(resumed.playerId).toBe(xSession.playerId);
      expect(resumed.displayName).toBe(nameBefore);
      expect(resumed.mark).toBe(markBefore);
      expect(resumed.hasControl).toBe(true);
      // Never a third player, however many devices were involved (INV-6).
      expect(resumed.snapshot.players).toHaveLength(2);
      await o.waitFor(snapshotWhere((s) => s.phase === 'active'));
    });
  });

  describe('host migration (P4-06, P4-07)', () => {
    it('names the room opener as host', async () => {
      const { x, xSession } = await match();
      const host = x.snapshot().players.find((player) => player.isHost);
      expect(host?.id).toBe(xSession.playerId);
      expect(x.snapshot().players.filter((player) => player.isHost)).toHaveLength(1);
    });

    it('keeps the room alive when the host leaves, and migrates the capability', async () => {
      // This used to destroy the room for both players: a room died with
      // whoever opened it.
      const { x, o, xSession, oSession } = await match();

      x.send({ type: 'room.leave', requestId: 'leave' });
      expect((await x.waitFor(isEnded)).reason).toBe('LEFT');

      const survivor = await o.waitFor(snapshotWhere((s) => s.players.length === 1));
      expect(server.manager.size).toBe(1);
      expect(survivor.snapshot.players[0].id).toBe(oSession.playerId);
      expect(survivor.snapshot.players[0].isHost, 'host must migrate to the survivor').toBe(true);
      expect(survivor.snapshot.phase).toBe('waiting');
      expect(survivor.snapshot.board.every((cell) => cell === null)).toBe(true);

      // The leaver's token is dead, but the room itself is still joinable.
      const stale = await open();
      stale.send({
        type: 'session.resume', requestId: 'stale',
        roomCode: xSession.roomCode, playerToken: xSession.playerToken,
      });
      const rejection = await stale.waitFor(isRejection);
      expect(rejection.code).toBe('INVALID_SESSION');

      const newcomer = await open();
      newcomer.send({ type: 'room.join', requestId: 'join-again', roomCode: xSession.roomCode });
      const joined = await newcomer.waitFor(isSession);
      expect(joined.snapshot.players).toHaveLength(2);
    });

    it('clears the conversation when a player leaves', async () => {
      // The chat was private to the two people in it. Whoever takes the freed
      // slot next must not be able to read it.
      const { x, o, xSession } = await match();
      x.send({ type: 'chat.message', requestId: 'secret', text: 'private note' });
      await o.waitFor((m): m is Of<'chat.message'> => m.type === 'chat.message');
      expect(server.manager.getEphemeralStats(xSession.roomCode)?.messages).toBe(1);

      x.send({ type: 'room.leave', requestId: 'leave' });
      await o.waitFor(snapshotWhere((s) => s.players.length === 1));
      expect(server.manager.getEphemeralStats(xSession.roomCode)?.messages).toBe(0);

      const newcomer = await open();
      newcomer.send({ type: 'room.join', requestId: 'join-again', roomCode: xSession.roomCode });
      const joined = await newcomer.waitFor(isSession);
      expect(joined.chat.messages).toHaveLength(0);
    });

    it('destroys the room only once the last player leaves', async () => {
      const { x, o, xSession } = await match();
      x.send({ type: 'room.leave', requestId: 'leave-x' });
      await o.waitFor(snapshotWhere((s) => s.players.length === 1));
      expect(server.manager.size).toBe(1);

      o.send({ type: 'room.leave', requestId: 'leave-o' });
      expect((await o.waitFor(isEnded)).reason).toBe('LEFT');
      expect(server.manager.size).toBe(0);
      expect(server.manager.getEphemeralStats(xSession.roomCode)).toBeNull();
    });
  });
});

describe('server restart behaviour (P4-08, D-003)', () => {
  let first: GameServerHandle;
  let second: GameServerHandle;

  afterEach(async () => {
    await first?.close().catch(() => undefined);
    await second?.close().catch(() => undefined);
  });

  it('refuses a token from a previous process and leaves a path to a new room', async () => {
    // Rooms are deliberately ephemeral (D-003): they do not survive a restart.
    // What must not happen is a client hanging on a token that can never work.
    first = await createGameServer({ port: 0, host: '127.0.0.1', countdownMs: 15, cleanupIntervalMs: 10_000 });
    const address = 'ws://127.0.0.1:' + first.port + '/ws';

    const before = await Window.open(address);
    before.send({ type: 'room.create', requestId: 'create' });
    const session = await before.waitFor(isSession);
    before.close();
    await first.close();

    // A new process on the same port, with no memory of anything.
    second = await createGameServer({
      port: first.port, host: '127.0.0.1', countdownMs: 15, cleanupIntervalMs: 10_000,
    });

    const after = await Window.open(address);
    after.send({
      type: 'session.resume', requestId: 'stale-token',
      roomCode: session.roomCode, playerToken: session.playerToken,
    });
    const rejection = await after.waitFor(isRejection);
    expect(rejection.code).toBe('ROOM_NOT_FOUND');
    expect(rejection.message).toMatch(/room not found/i);

    // The terminal state has a way out: the same socket can open a new room
    // immediately, so the client is never stuck retrying a dead token.
    after.send({ type: 'room.create', requestId: 'fresh' });
    const fresh = await after.waitFor((m): m is Of<'session.ready'> => m.type === 'session.ready' && m.requestId === 'fresh');
    expect(fresh.roomCode).not.toBe(session.roomCode);
    expect(fresh.hasControl).toBe(true);
    after.close();
  });
});

describe('ownership under churn (P4-09, INV-6)', () => {
  let server: GameServerHandle;
  let url: string;
  const windows: Window[] = [];

  beforeEach(async () => {
    server = await createGameServer({
      port: 0, host: '127.0.0.1', countdownMs: 15,
      reconnectGraceMs: 5_000, cleanupIntervalMs: 10_000,
    });
    url = 'ws://127.0.0.1:' + server.port + '/ws';
  });

  afterEach(async () => {
    for (const window of windows) window.close();
    windows.length = 0;
    await server.close();
  });

  it('survives a reconnect storm without ever duplicating the player', async () => {
    const opener = await Window.open(url);
    windows.push(opener);
    opener.send({ type: 'room.create', requestId: 'create' });
    const session = await opener.waitFor(isSession);

    // Twelve windows pile onto the same token in quick succession, the way a
    // flaky connection retrying would. Each one takes the slot from the last.
    const attached: Window[] = [];
    for (let index = 0; index < 12; index += 1) {
      const window = await Window.open(url);
      windows.push(window);
      attached.push(window);
      window.send({
        type: 'session.resume', requestId: 'storm-' + index,
        roomCode: session.roomCode, playerToken: session.playerToken,
      });
    }

    const last = attached[attached.length - 1];
    await last.waitFor(isSession);
    await last.settle(400);

    const snapshot = last.snapshot();
    // The whole point: many connections, still exactly one player (INV-6).
    expect(snapshot.players).toHaveLength(1);
    expect(snapshot.players[0].id).toBe(session.playerId);
    expect(snapshot.players[0].presence).toBe('online');

    // Exactly one window believes it holds the slot.
    const holders = [opener, ...attached].filter((window) => {
      const ready = window.of('session.ready').at(-1);
      const control = window.of('session.control').at(-1);
      const held = control ? control.hasControl : ready?.hasControl ?? false;
      return held;
    });
    expect(holders, 'exactly one window may hold the slot').toHaveLength(1);

    // And that one can actually act, while another cannot.
    const holder = holders[0];
    const bystander = [opener, ...attached].find((window) => window !== holder);
    bystander?.send({ type: 'game.move', requestId: 'nope', cell: 0, expectedRevision: snapshot.revision });
    const refusal = await bystander!.waitFor(isRejection);
    expect(refusal.code).toBe('NOT_IN_CONTROL');
  });

  it('keeps the player online while any window survives a burst of closures', async () => {
    const opener = await Window.open(url);
    windows.push(opener);
    opener.send({ type: 'room.create', requestId: 'create' });
    const session = await opener.waitFor(isSession);

    const extras: Window[] = [];
    for (let index = 0; index < 4; index += 1) {
      const window = await Window.open(url);
      windows.push(window);
      extras.push(window);
      window.send({
        type: 'session.resume', requestId: 'extra-' + index,
        roomCode: session.roomCode, playerToken: session.playerToken,
      });
      await window.waitFor(isSession);
    }

    // Close every window except the original. The player never actually left,
    // so presence must stay online throughout - no pause, no reconnect state.
    for (const window of extras) window.close();

    // Waiting on connectionCount would match the snapshot from room creation,
    // when the opener was also the only connection. The reclaim message is the
    // signal that actually means "the closures have been processed".
    const reclaimed = await opener.waitFor(
      (m): m is Of<'session.control'> => m.type === 'session.control' && m.hasControl,
    );
    expect(reclaimed.reason).toBe('RECLAIMED');
    expect(reclaimed.connectionCount).toBe(1);
    expect(opener.snapshot().players[0].presence).toBe('online');
    opener.send({ type: 'chat.typing', typing: false });
    await opener.settle(150);
    expect(opener.of('command.rejected').filter((m) => m.code === 'NOT_IN_CONTROL')).toHaveLength(0);
  });
});

describe('mark assignment after a departure (P4-07)', () => {
  let server: GameServerHandle;
  let url: string;
  const windows: Window[] = [];

  beforeEach(async () => {
    server = await createGameServer({ port: 0, host: '127.0.0.1', countdownMs: 15, cleanupIntervalMs: 10_000 });
    url = 'ws://127.0.0.1:' + server.port + '/ws';
  });

  afterEach(async () => {
    for (const window of windows) window.close();
    windows.length = 0;
    await server.close();
  });

  async function open(): Promise<Window> {
    const window = await Window.open(url);
    windows.push(window);
    return window;
  }

  it('gives the newcomer whichever mark the room is missing', async () => {
    // joinRoom used to hand out 'O' unconditionally, which was safe only while
    // the creator was permanently X. Now that the X can leave a room that
    // outlives them, an unconditional 'O' produces two O players, no X, and a
    // board nobody can move on because the turn sits on a mark nobody holds.
    const host = await open();
    host.send({ type: 'room.create', requestId: 'create' });
    const hostSession = await host.waitFor(isSession);
    expect(hostSession.mark).toBe('X');

    const guest = await open();
    guest.send({ type: 'room.join', requestId: 'join', roomCode: hostSession.roomCode });
    const guestSession = await guest.waitFor(isSession);
    expect(guestSession.mark).toBe('O');

    host.send({ type: 'room.leave', requestId: 'leave' });
    await guest.waitFor(snapshotWhere((s) => s.players.length === 1));

    const newcomer = await open();
    newcomer.send({ type: 'room.join', requestId: 'join-again', roomCode: hostSession.roomCode });
    const newSession = await newcomer.waitFor(isSession);

    expect(newSession.mark, 'the free mark was X').toBe('X');
    const marks = newSession.snapshot.players.map((player) => player.mark).sort();
    expect(marks).toEqual(['O', 'X']);

    // And the room is genuinely playable again: the turn belongs to someone.
    const active = await newcomer.waitFor(snapshotWhere((s) => s.phase === 'active'));
    const holder = active.snapshot.players.find((player) => player.mark === active.snapshot.turn);
    expect(holder, 'the turn must belong to a player who exists').toBeDefined();
  });
});
