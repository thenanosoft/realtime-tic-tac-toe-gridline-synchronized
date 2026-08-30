import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/createGameServer';
import {
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGE_DIMENSION,
  MAX_CHAT_TEXT_LENGTH,
  type ClientMessage,
  type RoomSnapshot,
  type ServerMessage,
} from '../shared/protocol';
import { TEMPORARY_NAME_PATTERN } from '../server/rooms/identity';

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
const isChatMessage = (message: ServerMessage): message is Extract<ServerMessage, { type: 'chat.message' }> => message.type === 'chat.message';
const isSessionEnded = (message: ServerMessage): message is Extract<ServerMessage, { type: 'session.ended' }> => message.type === 'session.ended';
const snapshotWhere = (predicate: (snapshot: RoomSnapshot) => boolean) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: 'game.snapshot' }> => message.type === 'game.snapshot' && predicate(message.snapshot);
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

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
      waitingRoomTtlMs: 25,
      cleanupIntervalMs: 5,
      typingTtlMs: 35,
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
    x.send({ type: 'room.create', requestId: 'create-x' });
    const xSession = await x.waitFor(isSession);
    o.send({ type: 'room.join', requestId: 'join-o', roomCode: xSession.roomCode });
    const oSession = await o.waitFor(isSession);
    await x.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'active'));
    await o.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'active'));
    expect(xSession.displayName).toMatch(TEMPORARY_NAME_PATTERN);
    expect(oSession.displayName).toMatch(TEMPORARY_NAME_PATTERN);
    expect(oSession.displayName).not.toBe(xSession.displayName);
    return { x, o, xSession, oSession };
  }

  async function move(actor: TestClient, observer: TestClient, requestId: string, cell: number, count: number) {
    actor.send({ type: 'game.move', requestId, cell, expectedRevision: actor.latestSnapshot().revision });
    const actorState = await actor.waitFor(snapshotWhere((snapshot) => snapshot.board.filter(Boolean).length === count));
    const observerState = await observer.waitFor(snapshotWhere((snapshot) => snapshot.board.filter(Boolean).length === count));
    expect(observerState.snapshot).toEqual(actorState.snapshot);
    return actorState.snapshot;
  }

  it('lets two players join, rejects a third, and rejects malformed or illegal commands', async () => {
    const { x, o, xSession } = await createMatch();
    const third = await connect();
    third.send({ type: 'room.join', requestId: 'join-third', roomCode: xSession.roomCode });
    expect((await third.waitFor(isRejection)).code).toBe('ROOM_FULL');

    o.send({ type: 'game.move', requestId: 'wrong-turn', cell: 0, expectedRevision: o.latestSnapshot().revision });
    expect((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'wrong-turn')).code).toBe('WRONG_TURN');

    x.sendRaw('{not json');
    expect((await x.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.code === 'MALFORMED_MESSAGE')).code).toBe('MALFORMED_MESSAGE');

    x.sendRaw(JSON.stringify({ type: 'game.move', requestId: 'bad-cell', cell: 99, expectedRevision: x.latestSnapshot().revision }));
    expect((await x.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'bad-cell')).code).toBe('INVALID_CELL');
  });

  it('serializes simultaneous and duplicate move attempts into one canonical update', async () => {
    const { x, o } = await createMatch();
    const sharedRevision = x.latestSnapshot().revision;
    expect(o.latestSnapshot().revision).toBe(sharedRevision);
    x.send({ type: 'game.move', requestId: 'race-x', cell: 0, expectedRevision: sharedRevision });
    o.send({ type: 'game.move', requestId: 'race-o', cell: 1, expectedRevision: sharedRevision });
    const state = await x.waitFor(snapshotWhere((snapshot) => snapshot.board[0] === 'X'));
    expect(state.snapshot.board.filter(Boolean)).toHaveLength(1);
    expect(['WRONG_TURN', 'STALE_STATE']).toContain((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'race-o')).code);

    x.send({ type: 'game.move', requestId: 'race-x', cell: 0, expectedRevision: sharedRevision });
    const duplicate = await x.waitFor(snapshotWhere((snapshot) => snapshot.board[0] === 'X' && snapshot.board.filter(Boolean).length === 1));
    expect(duplicate.snapshot.turn).toBe('O');
  });

  it('synchronizes victory, rejects post-game moves, and requires two rematch votes', async () => {
    const { x, o, xSession } = await createMatch();
    await move(x, o, 'x-0', 0, 1);
    await move(o, x, 'o-3', 3, 2);
    await move(x, o, 'x-1', 1, 3);
    await move(o, x, 'o-4', 4, 4);
    const finished = await move(x, o, 'x-2', 2, 5);
    expect(finished.phase).toBe('game_over');
    expect(finished.winner).toBe('X');
    expect(finished.winningLine).toEqual([0, 1, 2]);

    o.send({ type: 'game.move', requestId: 'too-late', cell: 8, expectedRevision: o.latestSnapshot().revision });
    expect((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'too-late')).code).toBe('GAME_COMPLETE');

    x.send({ type: 'rematch.vote', requestId: 'rematch-x' });
    const waiting = await o.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'rematch_waiting'));
    expect(waiting.snapshot.players.find((player) => player.id === xSession.playerId)?.wantsRematch).toBe(true);
    expect(waiting.snapshot.board.filter(Boolean)).toHaveLength(5);

    o.send({ type: 'rematch.vote', requestId: 'rematch-o' });
    const restartedX = await x.waitFor(snapshotWhere((snapshot) => snapshot.round === 2 && snapshot.phase === 'active'));
    const restartedO = await o.waitFor(snapshotWhere((snapshot) => snapshot.round === 2 && snapshot.phase === 'active'));
    expect(restartedX.snapshot).toEqual(restartedO.snapshot);
    expect(restartedX.snapshot.board.every((cell) => cell === null)).toBe(true);
    expect(restartedX.snapshot.players.find((player) => player.id === xSession.playerId)?.mark).toBe('O');
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

  it('delivers private text, deduplicates retries, and rejects unauthenticated or oversized chat', async () => {
    const { x, o, xSession } = await createMatch();
    x.send({ type: 'chat.message', requestId: 'text-one', text: 'Nice move 😂' });
    const received = await o.waitFor((message): message is Extract<ServerMessage, { type: 'chat.message' }> => message.type === 'chat.message' && message.ackRequestId === 'text-one');
    expect(received.message.kind).toBe('text');
    expect(received.message.senderId).toBe(xSession.playerId);
    if (received.message.kind === 'text') expect(received.message.text).toBe('Nice move 😂');

    x.send({ type: 'chat.message', requestId: 'text-one', text: 'Nice move 😂' });
    const resumed = await connect();
    resumed.send({ type: 'session.resume', requestId: 'resume-for-dedupe', roomCode: xSession.roomCode, playerToken: xSession.playerToken });
    const state = await resumed.waitFor(isSession);
    expect(state.chat.messages.filter((message) => message.kind === 'text' && message.text === 'Nice move 😂')).toHaveLength(1);

    const outsider = await connect();
    outsider.send({ type: 'chat.message', requestId: 'other-room-attempt', text: 'not allowed' });
    expect((await outsider.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'other-room-attempt')).code).toBe('NOT_IN_ROOM');

    o.sendRaw(JSON.stringify({ type: 'chat.message', requestId: 'oversized-text', text: 'x'.repeat(MAX_CHAT_TEXT_LENGTH + 1) }));
    expect((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'oversized-text')).code).toBe('MESSAGE_TOO_LONG');
  });

  it('broadcasts typing and expires it automatically when the stop event is lost', async () => {
    const { x, o, xSession } = await createMatch();
    x.send({ type: 'chat.typing', typing: true });
    const started = await o.waitFor((message): message is Extract<ServerMessage, { type: 'chat.typing' }> => message.type === 'chat.typing' && message.playerId === xSession.playerId && message.isTyping);
    expect(started.msRemaining).toBeTypeOf('number');
    const stopped = await o.waitFor((message): message is Extract<ServerMessage, { type: 'chat.typing' }> => message.type === 'chat.typing' && message.playerId === xSession.playerId && !message.isTyping, 500);
    expect(stopped.msRemaining).toBeNull();
  });

  it('validates and synchronizes quick reactions, message reactions, and stickers', async () => {
    const { x, o, oSession } = await createMatch();
    x.send({ type: 'chat.message', requestId: 'reactable', text: 'Good game' });
    const chat = await o.waitFor((message): message is Extract<ServerMessage, { type: 'chat.message' }> => message.type === 'chat.message' && message.ackRequestId === 'reactable');
    o.send({ type: 'chat.message-reaction', requestId: 'heart-it', messageId: chat.message.id, reaction: '❤️' });
    const updated = await x.waitFor((message): message is Extract<ServerMessage, { type: 'chat.message-reaction' }> => message.type === 'chat.message-reaction' && message.messageId === chat.message.id);
    expect(updated.reactions).toEqual([{ reaction: '❤️', playerIds: [oSession.playerId] }]);

    o.send({ type: 'chat.quick-reaction', requestId: 'instant-fire', reaction: '🔥' });
    const quick = await x.waitFor((message): message is Extract<ServerMessage, { type: 'chat.quick-reaction' }> => message.type === 'chat.quick-reaction' && message.ackRequestId === 'instant-fire');
    expect(quick.reaction).toBe('🔥');
    expect(quick.senderId).toBe(oSession.playerId);

    x.send({ type: 'chat.sticker', requestId: 'sticker-fire', stickerId: 'fire' });
    const sticker = await o.waitFor((message): message is Extract<ServerMessage, { type: 'chat.message' }> => message.type === 'chat.message' && message.ackRequestId === 'sticker-fire');
    expect(sticker.message.kind).toBe('sticker');
    if (sticker.message.kind === 'sticker') expect(sticker.message.stickerId).toBe('fire');

    x.sendRaw(JSON.stringify({ type: 'chat.sticker', requestId: 'bad-sticker', stickerId: 'remote-url' }));
    expect((await x.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'bad-sticker')).code).toBe('INVALID_STICKER');
    o.sendRaw(JSON.stringify({ type: 'chat.quick-reaction', requestId: 'bad-reaction', reaction: 'custom' }));
    expect((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'bad-reaction')).code).toBe('INVALID_REACTION');
  });

  it('relays allowlisted images in RAM and rejects mismatched or oversized metadata', async () => {
    const { x, o, xSession } = await createMatch();
    const png = ONE_PIXEL_PNG;
    x.send({
      type: 'chat.image', requestId: 'image-one', mime: 'image/png', width: 1, height: 1,
      byteLength: png.byteLength, data: png.toString('base64'),
    });
    const image = await o.waitFor((message): message is Extract<ServerMessage, { type: 'chat.message' }> => message.type === 'chat.message' && message.ackRequestId === 'image-one');
    expect(image.message.kind).toBe('image');
    if (image.message.kind === 'image') {
      expect(image.message.mime).toBe('image/png');
      expect(Buffer.from(image.message.data, 'base64')).toEqual(png);
    }
    expect(server.manager.getEphemeralStats(xSession.roomCode)?.imageBytes).toBe(png.byteLength);

    o.sendRaw(JSON.stringify({
      type: 'chat.image', requestId: 'bad-mime', mime: 'image/webp', width: 1, height: 1,
      byteLength: png.byteLength, data: png.toString('base64'),
    }));
    expect((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'bad-mime')).code).toBe('INVALID_IMAGE');
    o.sendRaw(JSON.stringify({
      type: 'chat.image', requestId: 'oversized-image', mime: 'image/png', width: 1, height: 1,
      byteLength: MAX_CHAT_IMAGE_BYTES + 1, data: png.toString('base64'),
    }));
    expect((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'oversized-image')).code).toBe('INVALID_IMAGE');

    o.send({
      type: 'chat.image', requestId: 'wrong-dimensions', mime: 'image/png', width: 2, height: 1,
      byteLength: png.byteLength, data: png.toString('base64'),
    });
    expect((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'wrong-dimensions')).code).toBe('INVALID_IMAGE');

    const deceptivePng = Buffer.from(png);
    deceptivePng.writeUInt32BE(MAX_CHAT_IMAGE_DIMENSION + 1, 16);
    o.send({
      type: 'chat.image', requestId: 'intrinsic-too-large', mime: 'image/png', width: 1, height: 1,
      byteLength: deceptivePng.byteLength, data: deceptivePng.toString('base64'),
    });
    expect((await o.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'intrinsic-too-large')).code).toBe('INVALID_IMAGE');
  });

  it('rejects all binary client frames instead of accumulating untrusted chunks', async () => {
    const client = await connect();
    const closed = new Promise<number>((resolve) => client.socket.once('close', resolve));
    client.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await closed).toBe(1003);
  });

  it('centralizes explicit room destruction and clears chat, images, typing, identities, and tokens', async () => {
    const { x, o, xSession } = await createMatch();
    const png = ONE_PIXEL_PNG;
    x.send({ type: 'chat.message', requestId: 'cleanup-text', text: 'ephemeral' });
    await o.waitFor((message): message is Extract<ServerMessage, { type: 'chat.message' }> => message.type === 'chat.message' && message.ackRequestId === 'cleanup-text');
    x.send({ type: 'chat.image', requestId: 'cleanup-image', mime: 'image/png', width: 1, height: 1, byteLength: png.byteLength, data: png.toString('base64') });
    await o.waitFor((message): message is Extract<ServerMessage, { type: 'chat.message' }> => message.type === 'chat.message' && message.ackRequestId === 'cleanup-image');
    o.send({ type: 'chat.typing', typing: true });
    await x.waitFor((message): message is Extract<ServerMessage, { type: 'chat.typing' }> => message.type === 'chat.typing' && message.isTyping);
    expect(server.manager.getEphemeralStats(xSession.roomCode)).toEqual({ messages: 2, imageBytes: png.byteLength, typingTimers: 1 });

    x.send({ type: 'room.leave', requestId: 'leave-now' });
    expect((await x.waitFor(isSessionEnded)).reason).toBe('LEFT');
    expect((await o.waitFor(isSessionEnded)).reason).toBe('LEFT');
    expect(server.manager.getEphemeralStats(xSession.roomCode)).toBeNull();
    expect(server.manager.size).toBe(0);

    const stale = await connect();
    stale.send({ type: 'session.resume', requestId: 'stale-token', roomCode: xSession.roomCode, playerToken: xSession.playerToken });
    expect((await stale.waitFor((message): message is Extract<ServerMessage, { type: 'command.rejected' }> => message.type === 'command.rejected' && message.requestId === 'stale-token')).code).toBe('ROOM_NOT_FOUND');
  });

  it('marks a disconnect, then restores the same canonical session and board', async () => {
    const { x, o, oSession } = await createMatch();
    x.send({ type: 'chat.message', requestId: 'chat-before-refresh', text: 'Still here' });
    await o.waitFor(isChatMessage);
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
    expect(restored.displayName).toBe(oSession.displayName);
    expect(restored.chat.messages.some((message) => message.kind === 'text' && message.text === 'Still here')).toBe(true);
    expect(restored.snapshot.board[4]).toBe('X');
    expect(restored.snapshot.phase).toBe('active');
    expect(restored.snapshot.turn).toBe('O');
    const xRestored = await x.waitFor(snapshotWhere((snapshot) => snapshot.phase === 'active' && snapshot.board[4] === 'X' && snapshot.revision === restored.snapshot.revision));
    expect(xRestored.snapshot).toEqual(restored.snapshot);
  });

  it('lets a valid resume supersede an older socket for the same player', async () => {
    const original = await connect();
    original.send({ type: 'room.create', requestId: 'original-room' });
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
    player.send({ type: 'room.create', requestId: 'empty-room' });
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
