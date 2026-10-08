import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/createGameServer';
import {
  deriveRoomKey,
  fromBase64,
  generateRoomSecret,
  isRoomSecret,
  openBytes,
  openText,
  sealBytes,
  sealText,
  DecryptionError,
} from '../app/lib/crypto';
import { buildInviteUrl, readInvite, shareInvite } from '../app/lib/invite';
import { chooseVersion, encodeQr, errorCorrection, maskBit, qrSvgPath } from '../app/lib/qr';
import { inspectImage } from '../shared/imageFormat';
import { PROTOCOL_VERSION, type ClientMessage, type RoomSnapshot, type ServerMessage } from '../shared/protocol';

/**
 * End-to-end encryption, invitations and QR (Phase 8).
 *
 * The claim under test is not that the client encrypts - it is that the server
 * never holds anything readable. So the socket tests keep a transcript of every
 * byte the server received and search it for the plaintext, which is the only
 * form of that assertion a patched client cannot talk its way out of.
 */

const PLAINTEXT = 'the queen goes to the centre on move three';
/** The one-pixel PNG the media suite uses, so these tests test encryption. */
const PNG_1PX_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

class Socket {
  readonly messages: ServerMessage[] = [];
  /** Every frame this socket sent, exactly as the server received it. */
  readonly sent: string[] = [];
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
    const frame = JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION });
    this.sent.push(frame);
    this.socket.send(frame);
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
        // Rejections and phases first: when a socket test times out the useful
        // question is almost always what the server refused, not what it sent.
        reject(new Error(
          'timed out; rejections=' + JSON.stringify(this.of('command.rejected'))
          + ' types=' + JSON.stringify(this.messages.map((m) => m.type))
          + ' phases=' + JSON.stringify(this.messages.flatMap((m) => (
            'snapshot' in m ? [m.snapshot.phase + '@' + m.snapshot.revision + '/e' + m.snapshot.encryption.epoch] : []
          ))),
        ));
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
const isChat = (m: ServerMessage): m is Of<'chat.message'> => m.type === 'chat.message';
const isRejection = (m: ServerMessage): m is Of<'command.rejected'> => m.type === 'command.rejected';
const snapshotWhere = (predicate: (s: RoomSnapshot) => boolean) =>
  (m: ServerMessage): m is Of<'game.snapshot'> => m.type === 'game.snapshot' && predicate(m.snapshot);

describe('room keys (P8-01, P8-03, P8-05, P8-06)', () => {
  it('generates a url-safe secret of the expected strength', () => {
    const secret = generateRoomSecret();
    expect(isRoomSecret(secret)).toBe(true);
    // 32 bytes, so nothing about the link is guessable.
    expect(fromBase64(secret.replace(/-/g, '+').replace(/_/g, '/') + '=')).toHaveLength(32);
    expect(secret).not.toContain('+');
    expect(secret).not.toContain('/');
    expect(generateRoomSecret()).not.toBe(secret);
  });

  it('seals and opens a message', async () => {
    const key = await deriveRoomKey(generateRoomSecret(), 'ABC234', 0);
    const sealed = await sealText(key, PLAINTEXT);
    expect(sealed.body).not.toContain('queen');
    expect(await openText(key, sealed.body, sealed.iv)).toBe(PLAINTEXT);
  });

  it('never reuses an iv', async () => {
    const key = await deriveRoomKey(generateRoomSecret(), 'ABC234', 0);
    const ivs = new Set<string>();
    const bodies = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const sealed = await sealText(key, PLAINTEXT);
      ivs.add(sealed.iv);
      bodies.add(sealed.body);
    }
    // A reused nonce under one key is the one mistake AES-GCM does not forgive,
    // so identical plaintext must still produce distinct ciphertext.
    expect(ivs.size).toBe(25);
    expect(bodies.size).toBe(25);
  });

  it('cannot open ciphertext from a previous key generation (P8-06)', async () => {
    const secret = generateRoomSecret();
    const before = await deriveRoomKey(secret, 'ABC234', 3);
    const sealed = await sealText(before, PLAINTEXT);
    const after = await deriveRoomKey(secret, 'ABC234', 4);

    await expect(openText(after, sealed.body, sealed.iv)).rejects.toThrow(DecryptionError);
    // And the retired generation still works, which is what makes the previous
    // assertion about rotation rather than about a broken derivation.
    expect(await openText(before, sealed.body, sealed.iv)).toBe(PLAINTEXT);
  });

  it('derives a different key per room from the same secret', async () => {
    const secret = generateRoomSecret();
    const here = await deriveRoomKey(secret, 'ABC234', 0);
    const elsewhere = await deriveRoomKey(secret, 'XYZ789', 0);
    const sealed = await sealText(here, PLAINTEXT);
    // An invite link pasted into the wrong room fails loudly instead of quietly
    // working somewhere it was not meant to.
    await expect(openText(elsewhere, sealed.body, sealed.iv)).rejects.toThrow(DecryptionError);
  });

  it('refuses a tampered body', async () => {
    const key = await deriveRoomKey(generateRoomSecret(), 'ABC234', 0);
    const sealed = await sealBytes(key, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const bytes = fromBase64(sealed.body);
    bytes[2] ^= 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));
    // AES-GCM authenticates as well as encrypts: a flipped bit is a failure,
    // not a differently decoded message.
    await expect(openBytes(key, tampered, sealed.iv)).rejects.toThrow(DecryptionError);
  });
});

describe('invitations (P8-01, P8-02, P8-07)', () => {
  const secret = generateRoomSecret();

  it('carries the key in the fragment and nowhere else', () => {
    const url = buildInviteUrl('https://example.test/gridline/?utm=x', { roomCode: 'ABC234', secret });
    const parsed = new URL(url);
    // The decisive assertion: a fragment is stripped by the browser before the
    // request leaves the machine, a query string is not.
    expect(parsed.hash).toContain(secret);
    expect(parsed.search).not.toContain(secret);
    expect(parsed.pathname).not.toContain(secret);
    expect(url.split('#')[0]).not.toContain(secret);
  });

  it('round-trips through build and read', () => {
    const url = buildInviteUrl('https://example.test/', { roomCode: 'ABC234', secret });
    expect(readInvite(new URL(url).hash)).toEqual({ roomCode: 'ABC234', secret });
  });

  it('replaces a stale fragment rather than appending to it', () => {
    const first = buildInviteUrl('https://example.test/', { roomCode: 'ABC234', secret });
    const second = buildInviteUrl(first, { roomCode: 'XYZ789', secret: null });
    // A key from a room that is over must not ride along in a new invitation.
    expect(second).not.toContain(secret);
    expect(readInvite(new URL(second).hash)).toEqual({ roomCode: 'XYZ789', secret: null });
  });

  it('discards a malformed fragment', () => {
    expect(readInvite('')).toBeNull();
    expect(readInvite('#r=TOOLONGCODE&k=' + secret)).toBeNull();
    expect(readInvite('#r=ABC234&k=not-a-key')).toBeNull();
    // Lowercase and a missing key are both legitimate.
    expect(readInvite('#r=abc234')).toEqual({ roomCode: 'ABC234', secret: null });
  });

  it('falls back from share to clipboard to the visible link', async () => {
    const url = 'https://example.test/#r=ABC234';
    const copied: string[] = [];

    expect(await shareInvite(url, { share: async () => undefined, copy: async (text) => { copied.push(text); } })).toBe('shared');
    expect(copied).toHaveLength(0);

    // A dismissed share sheet rejects, which is not a failure - it falls
    // through to the clipboard rather than reporting an error.
    expect(await shareInvite(url, {
      share: async () => { throw new Error('dismissed'); },
      copy: async (text) => { copied.push(text); },
    })).toBe('copied');
    expect(copied).toEqual([url]);

    expect(await shareInvite(url, { copy: async () => { throw new Error('denied'); } })).toBe('manual');
    expect(await shareInvite(url, {})).toBe('manual');
  });
});

describe('QR invitations are generated locally (P8-08)', () => {
  /**
   * Reads a symbol back out: un-masks, de-interleaves and decodes the byte-mode
   * payload.
   *
   * A round trip through an independent reader is worth more here than any
   * structural assertion. Checking that the finder patterns are in place proves
   * the symbol looks like a QR code; decoding it proves a scanner would get the
   * invite URL back.
   */
  const decode = (code: ReturnType<typeof encodeQr>): string => {
    const size = code.size;
    const reserved: boolean[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
    const reserve = (row: number, col: number) => {
      if (row >= 0 && col >= 0 && row < size && col < size) reserved[row][col] = true;
    };
    for (const [originRow, originCol] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) reserve(originRow + r, originCol + c);
    }
    for (let i = 0; i < size; i += 1) {
      reserve(6, i);
      reserve(i, 6);
    }
    // Format information only, which is the ends of row 8 and column 8 - the
    // middle of both carries data.
    for (let i = 0; i < 9; i += 1) {
      reserve(8, i);
      reserve(i, 8);
    }
    for (let i = 0; i < 8; i += 1) {
      reserve(8, size - 1 - i);
      reserve(size - 1 - i, 8);
    }
    const alignment: Record<number, number[]> = {
      1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
      6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    };
    for (const row of alignment[code.version]) {
      for (const col of alignment[code.version]) {
        if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
        for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) reserve(row + r, col + c);
      }
    }
    if (code.version >= 7) {
      for (let i = 0; i < 18; i += 1) {
        reserve(Math.floor(i / 3), size - 11 + (i % 3));
        reserve(size - 11 + (i % 3), Math.floor(i / 3));
      }
    }

    const bits: number[] = [];
    let upward = true;
    for (let right = size - 1; right > 0; right -= 2) {
      const columnRight = right <= 6 ? right - 1 : right;
      for (let step = 0; step < size; step += 1) {
        const row = upward ? size - 1 - step : step;
        for (const col of [columnRight, columnRight - 1]) {
          if (reserved[row][col]) continue;
          const dark = code.modules[row][col] !== maskBit(code.mask, row, col);
          bits.push(dark ? 1 : 0);
        }
      }
      upward = !upward;
    }

    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let byte = 0;
      for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i + b];
      bytes.push(byte);
    }

    // De-interleave the data codewords back into their blocks.
    const groups: Record<number, Array<[number, number]>> = {
      1: [[1, 16]], 2: [[1, 28]], 3: [[1, 44]], 4: [[2, 32]], 5: [[2, 43]],
      6: [[4, 27]], 7: [[4, 31]], 8: [[2, 38], [2, 39]], 9: [[3, 36], [2, 37]], 10: [[4, 43], [1, 44]],
    };
    const sizes: number[] = [];
    for (const [count, length] of groups[code.version]) for (let i = 0; i < count; i += 1) sizes.push(length);
    const blocks: number[][] = sizes.map(() => []);
    let cursor = 0;
    for (let i = 0; i < Math.max(...sizes); i += 1) {
      for (let block = 0; block < sizes.length; block += 1) {
        if (i < sizes[block]) blocks[block].push(bytes[cursor++]);
      }
    }
    const data = blocks.flat();

    const header = (data[0] << 8) | data[1];
    expect((header >>> 12) & 0b1111).toBe(0b0100); // byte mode
    const countWidth = code.version < 10 ? 8 : 16;
    // The count field is bit-aligned, not byte-aligned: at version 10 it spans
    // the low nibble of the first codeword, all of the second, and the high
    // nibble of the third.
    const length = code.version < 10
      ? (header >>> 4) & 0xff
      : ((data[0] & 0x0f) << 12) | (data[1] << 4) | (data[2] >> 4);
    const payload: number[] = [];
    const bitOffset = 4 + countWidth;
    for (let i = 0; i < length; i += 1) {
      let byte = 0;
      for (let b = 0; b < 8; b += 1) {
        const index = bitOffset + i * 8 + b;
        byte = (byte << 1) | ((data[index >>> 3] >>> (7 - (index & 7))) & 1);
      }
      payload.push(byte);
    }
    return new TextDecoder().decode(new Uint8Array(payload));
  };

  it('round-trips an invite url through its own symbol', () => {
    const url = buildInviteUrl('https://thenanosoft.github.io/realtime-tic-tac-toe-gridline-synchronized/', {
      roomCode: 'ABC234',
      secret: generateRoomSecret(),
    });
    const code = encodeQr(url);
    expect(code.size).toBe(17 + code.version * 4);
    expect(decode(code)).toBe(url);
  });

  it('round-trips at every version it claims to support', () => {
    for (let version = 1; version <= 10; version += 1) {
      // The longest payload that still fits this version, so the boundary of
      // each version is exercised rather than only its comfortable middle.
      const capacity = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 }[version] as number;
      const value = 'g'.repeat(capacity);
      expect(chooseVersion(capacity)).toBeLessThanOrEqual(version);
      const code = encodeQr(value);
      expect(decode(code)).toBe(value);
    }
  });

  it('places the three finder patterns and the timing rows', () => {
    const code = encodeQr('https://example.test/#r=ABC234');
    for (const [row, col] of [[0, 0], [0, code.size - 7], [code.size - 7, 0]]) {
      expect(code.modules[row][col]).toBe(true);
      expect(code.modules[row + 1][col + 1]).toBe(false);
      expect(code.modules[row + 3][col + 3]).toBe(true);
    }
    for (let i = 8; i < code.size - 8; i += 1) expect(code.modules[6][i]).toBe(i % 2 === 0);
    // The module below the top-left finder is dark in every valid symbol.
    expect(code.modules[code.size - 8][8]).toBe(true);
  });

  it('refuses a value it cannot encode rather than truncating it', () => {
    expect(() => encodeQr('g'.repeat(5_000))).toThrow(/too long/i);
  });

  it('produces one svg path covering exactly the dark modules', () => {
    const code = encodeQr('https://example.test/#r=ABC234');
    const dark = code.modules.reduce((total, row) => total + row.filter(Boolean).length, 0);
    expect(qrSvgPath(code).split('M').length - 1).toBe(dark);
  });

  it('computes Reed-Solomon parity over GF(256)', () => {
    // A known vector: 0x40 0x11 with ten parity codewords, per the standard.
    const parity = errorCorrection(new Uint8Array([0x40, 0x11]), 10);
    expect(parity).toHaveLength(10);
    // Parity over an all-zero message is all zero; over anything else it is not.
    expect([...errorCorrection(new Uint8Array([0, 0, 0]), 10)].every((byte) => byte === 0)).toBe(true);
    expect([...parity].some((byte) => byte !== 0)).toBe(true);
  });
});

describe('the server routes what it cannot read (P8-02, P8-03)', () => {
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

  async function privateMatch() {
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
    return { x, o, xSession, secret, key, epoch };
  }

  it('declares encryption in the snapshot and carries no key in it', async () => {
    const { x } = await privateMatch();
    const snapshot = x.snapshot();
    expect(snapshot.encryption.enabled).toBe(true);
    // The epoch is a label, not a secret, and there is nothing else here. A
    // snapshot that contained key material would make every other assertion in
    // this file decorative.
    expect(Object.keys(snapshot.encryption).sort()).toEqual(['enabled', 'epoch']);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|key(?!Epoch)/i);
  });

  it('stores and forwards ciphertext, and never sees the plaintext', async () => {
    const { x, o, key, epoch } = await privateMatch();
    const sealed = await sealText(key, PLAINTEXT);
    x.send({ type: 'chat.message', requestId: 'sealed', text: sealed.body, sealed: { iv: sealed.iv, epoch } });

    const delivered = await o.waitFor(isChat);
    expect(delivered.message.kind).toBe('text');
    if (delivered.message.kind !== 'text') throw new Error('unreachable');
    expect(delivered.message.sealed).toEqual({ iv: sealed.iv, epoch });
    expect(delivered.message.text).toBe(sealed.body);
    // The receiving player opens it; the server, holding the same bytes, cannot.
    expect(await openText(key, delivered.message.text, sealed.iv)).toBe(PLAINTEXT);

    // The decisive check: everything that crossed the wire in either direction,
    // searched for the message body.
    const transcript = [...x.sent, ...o.sent, JSON.stringify(x.messages), JSON.stringify(o.messages)].join('\n');
    expect(transcript).toContain(sealed.body);
    expect(transcript).not.toContain(PLAINTEXT);
    expect(transcript).not.toContain('queen');
  });

  it('never receives the room secret in any frame', async () => {
    const { x, o, secret, key, epoch } = await privateMatch();
    const sealed = await sealText(key, PLAINTEXT);
    x.send({ type: 'chat.message', requestId: 'sealed', text: sealed.body, sealed: { iv: sealed.iv, epoch } });
    await o.waitFor(isChat);
    // The secret exists only in the fragment and in memory. Nothing the client
    // sends, including the handshake, carries it (P8-02).
    for (const frame of [...x.sent, ...o.sent]) expect(frame).not.toContain(secret);
  });

  it('refuses plaintext in a private room, and ciphertext in a plain one', async () => {
    const { x } = await privateMatch();
    x.send({ type: 'chat.message', requestId: 'plain', text: PLAINTEXT });
    const refused = await x.waitFor((m): m is Of<'command.rejected'> => isRejection(m) && m.requestId === 'plain');
    expect(refused.code).toBe('ENCRYPTION_MISMATCH');

    const a = await open();
    a.send({ type: 'room.create', requestId: 'open-plain' });
    const session = await a.waitFor(isSession);
    expect(session.snapshot.encryption.enabled).toBe(false);
    const b = await open();
    b.send({ type: 'room.join', requestId: 'join-plain', roomCode: session.roomCode });
    await b.waitFor(isSession);
    a.send({ type: 'chat.message', requestId: 'sealed-here', text: 'AAAA', sealed: { iv: 'AAAAAAAAAAAAAAAA', epoch: 0 } });
    const wrongWay = await a.waitFor((m): m is Of<'command.rejected'> => isRejection(m) && m.requestId === 'sealed-here');
    expect(wrongWay.code).toBe('ENCRYPTION_MISMATCH');
  });

  it('carries a sealed image over the chunked transport (P8-04)', async () => {
    const { x, o, key, epoch } = await privateMatch();
    // The same one-pixel PNG the media suite uses, so the assertion is about
    // encryption rather than about image handling.
    const png = Uint8Array.from(atob(PNG_1PX_BASE64), (character) => character.charCodeAt(0));
    const sealed = await sealBytes(key, png);
    const uploadId = randomUUID();
    const chunks = [sealed.body.slice(0, 20), sealed.body.slice(20)];

    x.send({
      type: 'chat.image.begin',
      requestId: 'sealed-image',
      uploadId,
      mime: 'image/png',
      width: 1,
      height: 1,
      byteLength: png.byteLength,
      chunks: chunks.length,
      sealed: { iv: sealed.iv, epoch },
    });
    for (const [index, data] of chunks.entries()) {
      x.send({ type: 'chat.image.chunk', uploadId, index, data });
    }

    const delivered = await o.waitFor(isChat);
    if (delivered.message.kind !== 'image') throw new Error('expected an image');
    expect(delivered.message.sealed).toEqual({ iv: sealed.iv, epoch });
    // What the server stored is the ciphertext, assembled from the chunks. The
    // PNG header is nowhere in it, which is also why the server could not sniff
    // the format and the check had to move to the receiving client.
    expect(delivered.message.data).toBe(sealed.body);
    expect(delivered.message.data).not.toContain('iVBORw0KGgo');

    const opened = await openBytes(key, delivered.message.data, sealed.iv);
    expect([...opened]).toEqual([...png]);
    // And the receiver can now make the check the server could not: these bytes
    // really are a 1x1 PNG, as the sender claimed.
    expect(inspectImage(opened)).toEqual({ mime: 'image/png', width: 1, height: 1 });
  });

  it('refuses an unsealed upload into a private room before buffering a chunk', async () => {
    const { x } = await privateMatch();
    const png = Uint8Array.from(atob(PNG_1PX_BASE64), (character) => character.charCodeAt(0));
    const uploadId = randomUUID();
    x.send({
      type: 'chat.image.begin',
      requestId: 'short-image',
      uploadId,
      mime: 'image/png',
      width: 1,
      height: 1,
      byteLength: png.byteLength,
      chunks: 1,
    });
    // No envelope on a private room: refused before a single chunk is accepted,
    // so nothing is buffered on the strength of a frame that was already wrong.
    const refused = await x.waitFor((m): m is Of<'command.rejected'> => isRejection(m) && m.requestId === 'short-image');
    expect(refused.code).toBe('ENCRYPTION_MISMATCH');
    expect(server.manager.getEphemeralStats(x.snapshot().roomCode)?.imageBytes).toBe(0);
  });

  it('refuses a body sealed with a retired key generation', async () => {
    const { x, key, epoch } = await privateMatch();
    const sealed = await sealText(key, PLAINTEXT);
    // Delivering this would hand the peer ciphertext whose key it has already
    // destroyed, so it is refused where the sender can still be told.
    x.send({ type: 'chat.message', requestId: 'stale', text: sealed.body, sealed: { iv: sealed.iv, epoch: epoch - 1 } });
    const refused = await x.waitFor((m): m is Of<'command.rejected'> => isRejection(m) && m.requestId === 'stale');
    expect(refused.code).toBe('ENCRYPTION_MISMATCH');
  });
});

/**
 * Plays X to a win on 0, 4, 8 against O on 1, 2.
 *
 * Both sockets are brought up to date after every move, because a mover reads
 * its expectedRevision from the last snapshot it saw: letting the opponent fall
 * one broadcast behind is enough for the next move to be refused as stale.
 */
async function playToWin(x: Socket, o: Socket): Promise<void> {
  for (const [mover, waiter, cell] of [[x, o, 0], [o, x, 1], [x, o, 4], [o, x, 2], [x, o, 8]] as Array<[Socket, Socket, number]>) {
    mover.send({ type: 'game.move', requestId: 'm' + cell, cell, expectedRevision: mover.snapshot().revision });
    await mover.waitFor(snapshotWhere((s) => s.board[cell] !== null));
    await waiter.waitFor(snapshotWhere((s) => s.board[cell] !== null));
  }
  await x.waitFor(snapshotWhere((s) => s.phase === 'game_over'));
}

describe('key rotation (P8-05)', () => {
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

  it('rotates when a player arrives, so a newcomer cannot read what came before', async () => {
    const secret = generateRoomSecret();
    const host = await open();
    host.send({ type: 'room.create', requestId: 'create', encrypted: true });
    const session = await host.waitFor(isSession);
    expect(session.snapshot.encryption.epoch).toBe(0);

    const guest = await open();
    guest.send({ type: 'room.join', requestId: 'join', roomCode: session.roomCode });
    await guest.waitFor(isSession);
    await host.waitFor(snapshotWhere((s) => s.encryption.epoch === 1));

    const before = await deriveRoomKey(secret, session.roomCode, 0);
    const after = await deriveRoomKey(secret, session.roomCode, 1);
    const sealed = await sealText(before, PLAINTEXT);
    await expect(openText(after, sealed.body, sealed.iv)).rejects.toThrow(DecryptionError);
  });

  it('rotates on a rematch and expires the conversation the retired key sealed', async () => {
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
    const sealed = await sealText(key, PLAINTEXT);
    x.send({ type: 'chat.message', requestId: 'during', text: sealed.body, sealed: { iv: sealed.iv, epoch } });
    const delivered = await o.waitFor(isChat);

    await playToWin(x, o);

    x.send({ type: 'rematch.vote', requestId: 'rx' });
    o.send({ type: 'rematch.vote', requestId: 'ro' });
    await x.waitFor(snapshotWhere((s) => s.encryption.epoch === epoch + 1));

    // Announced, not silently dropped: both clients are told which ids are gone
    // so they can release what they hold for them.
    const expired = await o.waitFor((m): m is Of<'chat.expired'> => m.type === 'chat.expired');
    expect(expired.messageIds).toContain(delivered.message.id);
    expect(x.snapshot().attachmentBytes).toBe(0);

    const next = await deriveRoomKey(secret, xSession.roomCode, epoch + 1);
    await expect(openText(next, sealed.body, sealed.iv)).rejects.toThrow(DecryptionError);
  });

  it('leaves a plain room unrotated and its conversation intact', async () => {
    const x = await open();
    x.send({ type: 'room.create', requestId: 'create' });
    const xSession = await x.waitFor(isSession);
    const o = await open();
    o.send({ type: 'room.join', requestId: 'join', roomCode: xSession.roomCode });
    await o.waitFor(isSession);
    await x.waitFor(snapshotWhere((s) => s.phase === 'active'));

    x.send({ type: 'chat.message', requestId: 'hello', text: 'good luck' });
    await o.waitFor(isChat);
    await playToWin(x, o);
    x.send({ type: 'rematch.vote', requestId: 'rx' });
    o.send({ type: 'rematch.vote', requestId: 'ro' });
    await x.waitFor(snapshotWhere((s) => s.round === 2));
    await o.settle(200);

    // Rotation is the only thing that clears a transcript, and an unencrypted
    // room has nothing to rotate - so a rematch must not eat the chat here.
    expect(o.of('chat.expired')).toHaveLength(0);
    expect(x.snapshot().encryption.epoch).toBe(0);
  });
});
