import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/createGameServer';
import { deriveRoomKey, fromBase64, generateRoomSecret, sealBytes, sealText } from '../app/lib/crypto';
import { PROTOCOL_VERSION, type ClientMessage, type RoomSnapshot, type ServerMessage } from '../shared/protocol';

/**
 * The no-content log audit (P12-04).
 *
 * INV-8 says no message body and no image byte is ever written to a log. This
 * runs a whole match - text, stickers, reactions, a plain image and a sealed
 * one - with every output stream captured, and then searches everything that
 * was written for the things that were said.
 *
 * It is deliberately a *capture* rather than a review of the source. A log line
 * added in a hurry, or an error handler that serialises the frame it choked on,
 * is exactly the failure a reading would miss and this catches.
 */

const SECRETS = {
  text: 'the knight on f3 and then we talk about it',
  sticker: 'handshake',
} as const;

/** A real one-pixel PNG, so the image path is exercised rather than mocked. */
const PNG_1PX_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
        reject(new Error('timed out; types=' + JSON.stringify(this.messages.map((m) => m.type))));
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

  cursor(): number {
    return this.messages.length;
  }

  snapshot(): RoomSnapshot {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m.type === 'game.snapshot' || m.type === 'session.ready') return m.snapshot;
    }
    throw new Error('no snapshot');
  }

  close(): void {
    this.socket.close();
  }
}

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
const isSession = (m: ServerMessage): m is Of<'session.ready'> => m.type === 'session.ready';
const isChat = (m: ServerMessage): m is Of<'chat.message'> => m.type === 'chat.message';
const snapshotWhere = (predicate: (s: RoomSnapshot) => boolean) =>
  (m: ServerMessage): m is Of<'game.snapshot'> => m.type === 'game.snapshot' && predicate(m.snapshot);

describe('nothing anyone said reaches a log (P12-04, INV-8)', () => {
  let server: GameServerHandle;
  let url: string;
  const sockets: Socket[] = [];
  const captured: string[] = [];
  const restore: Array<() => void> = [];

  beforeEach(async () => {
    captured.length = 0;
    // Every console channel, plus the raw streams underneath them - a library
    // that writes straight to stdout would otherwise slip past a console spy.
    for (const channel of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      const spy = vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '));
      });
      restore.push(() => spy.mockRestore());
    }
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return original(chunk as string, ...(rest as []));
      }) as typeof stream.write;
      restore.push(() => { stream.write = original; });
    }

    server = await createGameServer({ port: 0, host: '127.0.0.1', countdownMs: 15, cleanupIntervalMs: 10_000 });
    url = 'ws://127.0.0.1:' + server.port + '/ws';
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await server.close();
    while (restore.length) restore.pop()?.();
  });

  async function open(): Promise<Socket> {
    const socket = await Socket.open(url);
    sockets.push(socket);
    return socket;
  }

  it('runs a whole match - text, sticker, reaction, images - and writes none of it', async () => {
    const secret = generateRoomSecret();
    const x = await open();
    x.send({ type: 'room.create', requestId: 'create', encrypted: true });
    const xSession = await x.waitFor(isSession);
    const o = await open();
    o.send({ type: 'room.join', requestId: 'join', roomCode: xSession.roomCode });
    await o.waitFor(isSession);
    await x.waitFor(snapshotWhere((s) => s.phase === 'active'));

    const epoch = x.snapshot().encryption.epoch;
    const key = await deriveRoomKey(secret, xSession.roomCode, epoch);

    // Sealed text.
    const sealedText = await sealText(key, SECRETS.text);
    x.send({ type: 'chat.message', requestId: 'say', text: sealedText.body, sealed: { iv: sealedText.iv, epoch } });
    await o.waitFor(isChat);

    // A sticker and a quick reaction, which are enumerations rather than free
    // text but are still things a person chose to send.
    o.send({ type: 'chat.sticker', requestId: 'sticker', stickerId: SECRETS.sticker });
    o.send({ type: 'chat.quick-reaction', requestId: 'react', reaction: '🔥' });

    // A sealed image over the chunked transport.
    const png = fromBase64(PNG_1PX_BASE64);
    const sealedImage = await sealBytes(key, png);
    const uploadId = randomUUID();
    x.send({
      type: 'chat.image.begin',
      requestId: 'image',
      uploadId,
      mime: 'image/png',
      width: 1,
      height: 1,
      byteLength: png.byteLength,
      chunks: 2,
      sealed: { iv: sealedImage.iv, epoch },
    });
    x.send({ type: 'chat.image.chunk', uploadId, index: 0, data: sealedImage.body.slice(0, 16) });
    x.send({ type: 'chat.image.chunk', uploadId, index: 1, data: sealedImage.body.slice(16) });
    const delivered = await o.waitFor(isChat, 4_000, 1);

    // And a full game, so the move and rematch paths run too.
    for (const [mover, waiter, cell] of [[x, o, 0], [o, x, 3], [x, o, 1], [o, x, 4], [x, o, 2]] as Array<[Socket, Socket, number]>) {
      const from = mover.cursor();
      const waiterFrom = waiter.cursor();
      mover.send({ type: 'game.move', requestId: 'm' + cell, cell, expectedRevision: mover.snapshot().revision });
      await mover.waitFor(snapshotWhere((s) => s.board[cell] !== null), 4_000, from);
      await waiter.waitFor(snapshotWhere((s) => s.board[cell] !== null), 4_000, waiterFrom);
    }
    await x.waitFor(snapshotWhere((s) => s.phase === 'game_over'));

    // Provoke the error paths as well: a malformed frame and a refused command
    // are where a careless handler would serialise what it choked on.
    o.socket.send('{"type":"chat.message","text":"' + SECRETS.text + '","requestId":"broken"');
    o.send({ type: 'game.move', requestId: 'after-the-end', cell: 8, expectedRevision: o.snapshot().revision });
    await o.waitFor((m): m is Of<'command.rejected'> => m.type === 'command.rejected');

    const log = captured.join('\n');
    // Nothing anyone wrote, chose or uploaded appears anywhere in the output.
    expect(log).not.toContain(SECRETS.text);
    expect(log).not.toContain('knight');
    expect(log).not.toContain(sealedText.body);
    expect(log).not.toContain(sealedImage.body);
    expect(log).not.toContain(PNG_1PX_BASE64);
    expect(log).not.toContain(secret);
    expect(log).not.toContain(xSession.playerToken);
    // Even the ciphertext stays out: a log of unreadable bytes is still a log
    // of the conversation, and it would outlive the room that held the key.
    if (delivered.message.kind === 'image') expect(log).not.toContain(delivered.message.data);

    // In fact the server writes nothing at all during a match. Asserted as well
    // as the above, because "it did not log the secret" is weaker than "it did
    // not log", and the second is the property this product actually claims.
    expect(captured.filter((line) => line.trim().length > 0)).toEqual([]);
  }, 30_000);
});
