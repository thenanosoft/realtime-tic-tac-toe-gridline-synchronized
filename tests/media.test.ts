import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/createGameServer';
import {
  PROTOCOL_VERSION,

  UPLOAD_CHUNK_BYTES,
  type ClientMessage,
  type RoomSnapshot,
  type ServerMessage,
} from '../shared/protocol';

/**
 * Chunked media, memory budgets, cancellation and rate-limit behaviour (Phase 7).
 *
 * The theme is that nothing unbounded is allowed to accumulate: not a partial
 * upload, not a room's attachments, not the process total, and not a client's
 * send queue.
 */

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

class Client {
  readonly messages: ServerMessage[] = [];
  private readonly listeners = new Set<() => void>();

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const listener of this.listeners) listener();
    });
  }

  static async open(url: string): Promise<Client> {
    const socket = new WebSocket(url);
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return client;
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
        reject(new Error('timed out; got ' + JSON.stringify(this.messages).slice(0, 500)));
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

  async settle(ms = 200): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  close(): void {
    this.socket.close();
  }
}

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
const isSession = (m: ServerMessage): m is Of<'session.ready'> => m.type === 'session.ready';
const isChat = (m: ServerMessage): m is Of<'chat.message'> => m.type === 'chat.message';
const isRejection = (m: ServerMessage): m is Of<'command.rejected'> => m.type === 'command.rejected';
const snapshotWhere = (predicate: (s: RoomSnapshot) => boolean) =>
  (m: ServerMessage): m is Of<'game.snapshot'> => m.type === 'game.snapshot' && predicate(m.snapshot);

/** Splits a base64 payload exactly as the browser client does. */
function chunk(data: string): string[] {
  const parts: string[] = [];
  for (let offset = 0; offset < data.length; offset += UPLOAD_CHUNK_BYTES) {
    parts.push(data.slice(offset, offset + UPLOAD_CHUNK_BYTES));
  }
  return parts.length ? parts : [''];
}

describe('chunked media and memory budgets (Phase 7)', () => {
  let server: GameServerHandle;
  let url: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    server = await createGameServer({ port: 0, host: '127.0.0.1', countdownMs: 15, cleanupIntervalMs: 10_000 });
    url = 'ws://127.0.0.1:' + server.port + '/ws';
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    await server.close();
  });

  async function open(): Promise<Client> {
    const client = await Client.open(url);
    clients.push(client);
    return client;
  }

  async function match() {
    const x = await open();
    const o = await open();
    x.send({ type: 'room.create', requestId: 'create' });
    const xSession = await x.waitFor(isSession);
    o.send({ type: 'room.join', requestId: 'join', roomCode: xSession.roomCode });
    await o.waitFor(isSession);
    await x.waitFor(snapshotWhere((s) => s.phase === 'active'));
    await o.waitFor(snapshotWhere((s) => s.phase === 'active'));
    return { x, o, roomCode: xSession.roomCode };
  }

  async function upload(client: Client, uploadId: string, requestId = 'img') {
    const data = PNG_1PX.toString('base64');
    const parts = chunk(data);
    client.send({
      type: 'chat.image.begin',
      requestId,
      uploadId,
      mime: 'image/png',
      width: 1,
      height: 1,
      byteLength: PNG_1PX.byteLength,
      chunks: parts.length,
    });
    parts.forEach((part, index) => client.send({ type: 'chat.image.chunk', uploadId, index, data: part }));
    return parts.length;
  }

  const UPLOAD_A = '11111111-1111-4111-8111-111111111111';
  const UPLOAD_B = '22222222-2222-4222-8222-222222222222';

  describe('chunked transfer (P7-01)', () => {
    it('assembles an image from chunks and acknowledges progress', async () => {
      const { x, o, roomCode } = await match();
      const expected = await upload(x, UPLOAD_A);

      const delivered = await o.waitFor(isChat);
      expect(delivered.message.kind).toBe('image');
      if (delivered.message.kind === 'image') {
        expect(delivered.message.byteLength).toBe(PNG_1PX.byteLength);
        expect(delivered.message.mime).toBe('image/png');
      }

      // The sender is told how much landed, so a stall is visible rather than
      // silently pending.
      const progress = x.of('upload.progress');
      expect(progress.length).toBeGreaterThanOrEqual(expected);
      expect(progress[0]).toMatchObject({ uploadId: UPLOAD_A, received: 0, expected });
      expect(progress.at(-1)?.received).toBe(expected);
      expect(server.manager.getEphemeralStats(roomCode)?.imageBytes).toBe(PNG_1PX.byteLength);
    });

    it('refuses a chunk for an upload that was never opened', async () => {
      const { x } = await match();
      x.send({ type: 'chat.image.chunk', uploadId: UPLOAD_B, index: 0, data: 'AAAA' });
      const rejection = await x.waitFor(isRejection);
      expect(rejection.code).toBe('UPLOAD_NOT_FOUND');
    });

    it('refuses one player feeding another player’s upload', async () => {
      const { x, o } = await match();
      await upload(x, UPLOAD_A);
      await o.waitFor(isChat);

      // A fresh upload from x, then o tries to push into it.
      x.send({
        type: 'chat.image.begin', requestId: 'second', uploadId: UPLOAD_B,
        mime: 'image/png', width: 1, height: 1, byteLength: PNG_1PX.byteLength, chunks: 2,
      });
      await x.waitFor((m): m is Of<'upload.progress'> => m.type === 'upload.progress' && m.uploadId === UPLOAD_B);

      o.send({ type: 'chat.image.chunk', uploadId: UPLOAD_B, index: 0, data: 'AAAA' });
      const rejection = await o.waitFor(isRejection);
      expect(rejection.code).toBe('UPLOAD_NOT_FOUND');
    });
  });

  describe('cancellation and orphan cleanup (P7-06, P7-07)', () => {
    it('frees a partial upload when the sender cancels', async () => {
      const { x, roomCode } = await match();
      x.send({
        type: 'chat.image.begin', requestId: 'half', uploadId: UPLOAD_A,
        mime: 'image/png', width: 1, height: 1, byteLength: PNG_1PX.byteLength, chunks: 4,
      });
      x.send({ type: 'chat.image.chunk', uploadId: UPLOAD_A, index: 0, data: 'AAAA' });
      await x.waitFor((m): m is Of<'upload.progress'> => m.type === 'upload.progress' && m.received === 1);

      x.send({ type: 'chat.image.cancel', uploadId: UPLOAD_A });
      await x.settle();

      // Nothing was stored, and the budget is back where it started.
      expect(server.manager.getEphemeralStats(roomCode)?.messages).toBe(0);
      expect(server.manager.getEphemeralStats(roomCode)?.imageBytes).toBe(0);

      // The cancelled id is genuinely gone, not merely ignored.
      x.send({ type: 'chat.image.chunk', uploadId: UPLOAD_A, index: 1, data: 'BBBB' });
      const rejection = await x.waitFor(isRejection);
      expect(rejection.code).toBe('UPLOAD_NOT_FOUND');
    });

    it('leaves no partial upload behind when the room is destroyed', async () => {
      const { x, o, roomCode } = await match();
      x.send({
        type: 'chat.image.begin', requestId: 'abandoned', uploadId: UPLOAD_A,
        mime: 'image/png', width: 1, height: 1, byteLength: PNG_1PX.byteLength, chunks: 8,
      });
      x.send({ type: 'chat.image.chunk', uploadId: UPLOAD_A, index: 0, data: 'AAAA' });
      await x.waitFor((m): m is Of<'upload.progress'> => m.type === 'upload.progress' && m.received === 1);

      x.send({ type: 'room.leave', requestId: 'leave-x' });
      o.send({ type: 'room.leave', requestId: 'leave-o' });
      await o.settle();

      expect(server.manager.size).toBe(0);
      expect(server.manager.getEphemeralStats(roomCode)).toBeNull();
    });
  });

  describe('memory budgets (P7-02, P7-03, P7-04, D-006)', () => {
    it('refuses an upload that would cross the room ceiling rather than evicting', async () => {
      // A tiny ceiling, so the limit is reachable without pushing ten megabytes
      // of real image data through a socket to prove a rule about arithmetic.
      const tight = await createGameServer({
        port: 0, host: '127.0.0.1', countdownMs: 15, cleanupIntervalMs: 10_000,
        roomImageLimitBytes: PNG_1PX.byteLength + 10,
      });
      try {
        const address = 'ws://127.0.0.1:' + tight.port + '/ws';
        const a = await Client.open(address);
        const b = await Client.open(address);
        clients.push(a, b);
        a.send({ type: 'room.create', requestId: 'c' });
        const session = await a.waitFor(isSession);
        b.send({ type: 'room.join', requestId: 'j', roomCode: session.roomCode });
        await b.waitFor(isSession);
        await a.waitFor(snapshotWhere((s) => s.phase === 'active'));

        await upload(a, UPLOAD_A);
        const stored = await b.waitFor(isChat);
        const before = tight.manager.getEphemeralStats(session.roomCode)?.imageBytes ?? 0;
        expect(before).toBe(PNG_1PX.byteLength);

        await upload(a, UPLOAD_B, 'second');
        const rejection = await a.waitFor(isRejection);
        expect(rejection.code).toBe('MEMORY_BUDGET');
        expect(rejection.message).toMatch(/smaller|expire/i);

        // D-006: the earlier image is untouched. Refusing is honest; silently
        // dropping someone's picture to make room reads as data loss.
        expect(tight.manager.getEphemeralStats(session.roomCode)?.imageBytes).toBe(before);
        expect(b.of('chat.message').map((m) => m.message.id)).toContain(stored.message.id);
        expect(b.of('chat.message')).toHaveLength(1);
      } finally {
        await tight.close();
      }
    });

    it('reports the room’s attachment usage in the authoritative snapshot', async () => {
      const { x, o } = await match();
      await upload(x, UPLOAD_A);
      await o.waitFor(isChat);

      // Chat does not bump the revision, so the figure rides the next
      // authoritative update rather than one of its own.
      x.send({ type: 'game.move', requestId: 'nudge', cell: 0, expectedRevision: (o.of('game.snapshot').at(-1)?.snapshot.revision ?? 1) });
      const grown = await o.waitFor(snapshotWhere((s) => s.board[0] !== null));
      expect(grown.snapshot.attachmentBytes).toBe(PNG_1PX.byteLength);
    });
  });

  describe('rate-limit intelligence (P7-09)', () => {
    it('lets a fast but normal player keep talking', async () => {
      // The old flat window throttled twelve messages in eight seconds, which
      // punished enthusiasm and spam identically. A burst allowance separates
      // the two.
      const { x, o } = await match();
      for (let index = 0; index < 8; index += 1) {
        x.send({ type: 'chat.message', requestId: 'fast-' + index, text: 'message ' + index });
      }
      await o.settle(400);
      expect(o.of('chat.message')).toHaveLength(8);
      expect(x.of('command.rejected').filter((m) => m.code === 'RATE_LIMITED')).toHaveLength(0);
    });

    it('throttles a spammer once the burst is spent', async () => {
      const { x, o } = await match();
      for (let index = 0; index < 40; index += 1) {
        x.send({ type: 'chat.message', requestId: 'spam-' + index, text: 'flood ' + index });
      }
      await o.settle(400);

      const throttled = x.of('command.rejected').filter((m) => m.code === 'RATE_LIMITED');
      expect(throttled.length).toBeGreaterThan(0);
      // The burst still got through: throttling starts, it does not start at zero.
      expect(o.of('chat.message').length).toBeGreaterThanOrEqual(8);
      expect(o.of('chat.message').length).toBeLessThan(40);
    });
  });

  describe('content expiry (P7-08)', () => {
    it('is off unless the host turns it on', async () => {
      const { x } = await match();
      const snapshot = x.of('game.snapshot').at(-1)?.snapshot ?? x.of('session.ready').at(-1)?.snapshot;
      expect(snapshot?.contentExpiry).toBe(false);

      x.send({ type: 'room.policy', requestId: 'expire-on', spectatorChat: false, expireContent: true });
      await x.waitFor(snapshotWhere((s) => s.contentExpiry));
    });

    it('announces expiry rather than dropping content silently', async () => {
      // Announced so clients can revoke the blob URLs they hold - otherwise the
      // bytes outlive the server's copy inside the browser.
      // The expiry horizon is five minutes. Rather than waiting it out, the
      // room's clock is injected through the seam RoomManager already exposes,
      // so the real sweep runs against a room that genuinely looks old.
      let clock = Date.now();
      const expiring = await createGameServer({
        port: 0, host: '127.0.0.1', countdownMs: 15, cleanupIntervalMs: 30,
        now: () => clock,
      });
      try {
        const address = 'ws://127.0.0.1:' + expiring.port + '/ws';
        const a = await Client.open(address);
        const b = await Client.open(address);
        clients.push(a, b);
        a.send({ type: 'room.create', requestId: 'c' });
        const session = await a.waitFor(isSession);
        b.send({ type: 'room.join', requestId: 'j', roomCode: session.roomCode });
        await b.waitFor(isSession);
        await a.waitFor(snapshotWhere((s) => s.phase === 'active'));

        a.send({ type: 'room.policy', requestId: 'p', spectatorChat: false, expireContent: true });
        await a.waitFor(snapshotWhere((s) => s.contentExpiry));
        a.send({ type: 'chat.message', requestId: 'm', text: 'short lived' });
        const sent = await b.waitFor(isChat);

        expect(expiring.manager.getEphemeralStats(session.roomCode)?.messages).toBe(1);
        clock += 10 * 60_000;

        const expired = await b.waitFor((m): m is Of<'chat.expired'> => m.type === 'chat.expired');
        expect(expired.messageIds).toContain(sent.message.id);
        expect(expiring.manager.getEphemeralStats(session.roomCode)?.messages).toBe(0);
      } finally {
        await expiring.close();
      }
    });
  });
});
