import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/createGameServer';
import type { ClientMessage, RoomSnapshot, ServerMessage } from '../shared/protocol';

class TestClient {
  private readonly messages: ServerMessage[] = [];
  private readonly listeners = new Set<() => void>();

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const listener of this.listeners) listener();
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const client = new TestClient(socket);
    return client;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(message: string): void {
    this.socket.send(message);
  }

  async waitFor<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T, timeout?: number): Promise<T>;
  async waitFor(predicate: (message: ServerMessage) => boolean, timeout?: number): Promise<ServerMessage>;
  async waitFor(predicate: (message: ServerMessage) => boolean, timeout = 2_000): Promise<ServerMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Timed out waiting for a server message. Received: ${JSON.stringify(this.messages)}`));
      }, timeout);
      const check = () => {
        const found = this.messages.find(predicate);
        if (!found) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(found);
      };
      this.listeners.add(check);
    });
  }

  close(): void {
    this.socket.close();
  }

  latestSnapshot(): RoomSnapshot {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message.type === 'game.snapshot' || message.type === 'session.ready') return message.snapshot;
    }
    throw new Error('No authoritative snapshot has been received.');
  }
}

const isSession = (message: ServerMessage): message is Extract<ServerMessage, { type: 'session.ready' }> => message.type === 'session.ready';
const isRejection = (message: ServerMessage): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected';
const snapshotWhere = (predicate: (snapshot: RoomSnapshot) => boolean) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: 'game.snapshot' }> => message.type === 'game.snapshot' && predicate(message.snapshot);

describe('real WebSocket multiplayer authority', () => {
  let server: GameServerHandle;
  let url: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    server = await createGameServer({
      port: 0,
      host: '127.0.0.1',
      countdownMs: 15,
      heartbeatMs: 5_000,
      emptyRoomTtlMs: 25,
      cleanupIntervalMs: 5,
    });
    url = `ws://127.0.0.1:${server.port}/ws`;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    await server.close();
  });

  async function connect(): Promise<TestClient> {
    const client = await TestClient.connect(url);
    clients.push(client);
    return client;
  }

  async function createMatch() {
    const x = await connect();
    const o = await connect();
    x.send({ type: 'room.create', requestId: 'create-x', name: 'Ada' });
    const xSession = await x.waitFor(isSession);
    o.send({ type: 'room.join', requestId: 'join-o', roomCode: xSession.roomCode, name: 'Grace' });
    const oSession = await o.waitFor(isSession);
    await x.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'active'));
    await o.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'active'));
    return { x, o, xSession, oSession };
  }

  async function move(actor: TestClient, observer: TestClient, requestId: string, cell: number, count: number) {
    actor.send({ type: 'game.move', requestId, cell, expectedVersion: actor.latestSnapshot().version });
    const actorState = await actor.waitFor(snapshotWhere((snapshot) => snapshot.board.filter(Boolean).length === count));
    const observerState = await observer.waitFor(snapshotWhere((snapshot) => snapshot.board.filter(Boolean).length === count));
    expect(observerState.snapshot).toEqual(actorState.snapshot);
    return actorState.snapshot;
  }

  it('lets two players join, rejects a third, and rejects malformed or illegal commands', async () => {
    const { x, o, xSession } = await createMatch();
    const third = await connect();
    third.send({ type: 'room.join', requestId: 'join-third', roomCode: xSession.roomCode, name: 'Linus' });
    expect((await third.waitFor(isRejection)).code).toBe('ROOM_FULL');

    o.send({ type: 'game.move', requestId: 'wrong-turn', cell: 0, expectedVersion: o.latestSnapshot().version });
    expect((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'wrong-turn')).code).toBe('WRONG_TURN');

    x.sendRaw('{not json');
    expect((await x.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.code === 'MALFORMED_MESSAGE')).code).toBe('MALFORMED_MESSAGE');

    x.sendRaw(JSON.stringify({ type: 'game.move', requestId: 'bad-cell', cell: 99, expectedVersion: x.latestSnapshot().version }));
    expect((await x.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'bad-cell')).code).toBe('INVALID_CELL');
  });

  it('serializes simultaneous and duplicate move attempts into one canonical update', async () => {
    const { x, o } = await createMatch();
    const sharedVersion = x.latestSnapshot().version;
    expect(o.latestSnapshot().version).toBe(sharedVersion);
    x.send({ type: 'game.move', requestId: 'race-x', cell: 0, expectedVersion: sharedVersion });
    o.send({ type: 'game.move', requestId: 'race-o', cell: 1, expectedVersion: sharedVersion });
    const state = await x.waitFor(snapshotWhere((snapshot) => snapshot.board[0] === 'X'));
    expect(state.snapshot.board.filter(Boolean)).toHaveLength(1);
    expect(['WRONG_TURN', 'STALE_STATE']).toContain((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'race-o')).code);

    x.send({ type: 'game.move', requestId: 'race-x', cell: 0, expectedVersion: sharedVersion });
    const duplicate = await x.waitFor(snapshotWhere((snapshot) => snapshot.board[0] === 'X' && snapshot.board.filter(Boolean).length === 1));
    expect(duplicate.snapshot.turn).toBe('O');
  });

  it('synchronizes victory, rejects post-game moves, and requires two rematch votes', async () => {
    const { x, o } = await createMatch();
    await move(x, o, 'x-0', 0, 1);
    await move(o, x, 'o-3', 3, 2);
    await move(x, o, 'x-1', 1, 3);
    await move(o, x, 'o-4', 4, 4);
    const finished = await move(x, o, 'x-2', 2, 5);
    expect(finished.phase).toBe('game_over');
    expect(finished.winner).toBe('X');
    expect(finished.winningLine).toEqual([0, 1, 2]);

    o.send({ type: 'game.move', requestId: 'too-late', cell: 8, expectedVersion: o.latestSnapshot().version });
    expect((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'too-late')).code).toBe('GAME_COMPLETE');

    x.send({ type: 'rematch.vote', requestId: 'rematch-x' });
    const waiting = await o.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'rematch_waiting'));
    expect(waiting.snapshot.players.find((player) => player.name === 'Ada')?.wantsRematch).toBe(true);
    expect(waiting.snapshot.board.filter(Boolean)).toHaveLength(5);

    o.send({ type: 'rematch.vote', requestId: 'rematch-o' });
    const restartedX = await x.waitFor(snapshotWhere((snapshot) => snapshot.round === 2 && snapshot.phase === 'active'));
    const restartedO = await o.waitFor(snapshotWhere((snapshot) => snapshot.round === 2 && snapshot.phase === 'active'));
    expect(restartedX.snapshot).toEqual(restartedO.snapshot);
    expect(restartedX.snapshot.board.every((cell) => cell === null)).toBe(true);
    expect(restartedX.snapshot.players.find((player) => player.name === 'Ada')?.mark).toBe('O');
  });

  it('reaches an identical draw state on both clients', async () => {
    const { x, o } = await createMatch();
    const sequence: Array<[TestClient, TestClient, string, number]> = [
      [x, o, 'd-x0', 0], [o, x, 'd-o1', 1], [x, o, 'd-x2', 2],
      [o, x, 'd-o4', 4], [x, o, 'd-x3', 3], [o, x, 'd-o5', 5],
      [x, o, 'd-x7', 7], [o, x, 'd-o6', 6], [x, o, 'd-x8', 8],
    ];
    let snapshot: RoomSnapshot | null = null;
    for (let index = 0; index < sequence.length; index += 1) {
      const [actor, observer, id, cell] = sequence[index];
      snapshot = await move(actor, observer, id, cell, index + 1);
    }
    expect(snapshot?.isDraw).toBe(true);
    expect(snapshot?.winner).toBeNull();
    expect(snapshot?.phase).toBe('game_over');
  });

  it('marks a disconnect, then restores the same canonical session and board', async () => {
    const { x, o, oSession } = await createMatch();
    await move(x, o, 'before-refresh', 4, 1);
    o.close();
    const paused = await x.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'paused'));
    expect(paused.snapshot.players.find((player) => player.id === oSession.playerId)?.connected).toBe(false);

    const resumed = await connect();
    resumed.send({
      type: 'session.resume',
      requestId: 'resume-o',
      roomCode: oSession.roomCode,
      playerToken: oSession.playerToken,
    });
    const restored = await resumed.waitFor(isSession);
    expect(restored.playerId).toBe(oSession.playerId);
    expect(restored.snapshot.board[4]).toBe('X');
    expect(restored.snapshot.phase).toBe('active');
    expect(restored.snapshot.turn).toBe('O');
    const xRestored = await x.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'active' && snapshot.board[4] === 'X' && snapshot.version === restored.snapshot.version));
    expect(xRestored.snapshot).toEqual(restored.snapshot);
  });

  it('lets a valid resume supersede an older socket for the same player', async () => {
    const original = await connect();
    original.send({ type: 'room.create', requestId: 'original-room', name: 'Ada' });
    const session = await original.waitFor(isSession);
    const oldSocketClosed = new Promise<number>((resolve) => original.socket.once('close', resolve));

    const replacement = await connect();
    replacement.send({
      type: 'session.resume',
      requestId: 'replacement-session',
      roomCode: session.roomCode,
      playerToken: session.playerToken,
    });
    const resumed = await replacement.waitFor(isSession);
    expect(resumed.playerId).toBe(session.playerId);
    expect(await oldSocketClosed).toBe(4001);
    expect(resumed.snapshot.players).toHaveLength(1);
  });

  it('cleans up a completely empty room', async () => {
    const player = await connect();
    player.send({ type: 'room.create', requestId: 'empty-room', name: 'Ada' });
    await player.waitFor(isSession);
    expect(server.manager.size).toBe(1);
    player.close();
    await waitUntil(() => server.manager.size === 0, 500);
    expect(server.manager.size).toBe(0);
  });
});

async function waitUntil(predicate: () => boolean, timeout: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error('Condition did not become true before timeout.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
