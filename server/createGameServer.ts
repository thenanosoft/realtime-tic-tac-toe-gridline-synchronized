import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { clientMessageSchema, type ClientMessage, type RejectionCode, type ServerMessage } from '../shared/protocol';
import { CommandError } from './errors';
import { RoomManager, type Peer, type RoomManagerOptions } from './rooms/RoomManager';

const MAX_MESSAGE_BYTES = 4_096;
const RATE_WINDOW_MS = 10_000;
const RATE_WINDOW_MESSAGES = 45;
const KNOWN_MESSAGE_TYPES = new Set([
  'room.create',
  'room.join',
  'session.resume',
  'game.move',
  'rematch.vote',
  'presence.ping',
]);

export interface GameServerOptions extends RoomManagerOptions {
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  heartbeatMs?: number;
}

export interface GameServerHandle {
  port: number;
  host: string;
  manager: RoomManager;
  close(): Promise<void>;
}

interface SocketState {
  peer: SocketPeer;
  messageTimes: number[];
  alive: boolean;
}

class SocketPeer implements Peer {
  constructor(
    public readonly id: string,
    private readonly socket: WebSocket,
  ) {}

  send(message: ServerMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason.slice(0, 120));
    }
  }
}

export async function createGameServer(options: GameServerOptions = {}): Promise<GameServerHandle> {
  const manager = new RoomManager(options);
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const httpServer = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'ok', rooms: manager.size, now: Date.now() }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  httpServer.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws' || (allowedOrigins.size > 0 && (!origin || !allowedOrigins.has(origin)))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  const states = new Map<WebSocket, SocketState>();

  webSocketServer.on('connection', (socket: WebSocket) => {
    const peer = new SocketPeer(randomUUID(), socket);
    const state: SocketState = { peer, messageTimes: [], alive: true };
    states.set(socket, state);
    peer.send({ type: 'server.hello', connectionId: peer.id, serverTime: Date.now() });

    socket.on('pong', () => {
      state.alive = true;
      manager.touch(peer.id);
    });

    socket.on('message', (raw) => handleRawMessage(raw, state, manager));
    socket.on('close', () => {
      states.delete(socket);
      manager.disconnect(peer.id);
    });
    socket.on('error', () => {
      // The close event performs authoritative presence cleanup.
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const [socket, state] of states) {
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, options.heartbeatMs ?? 15_000);
  heartbeatTimer.unref?.();

  const host = options.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 3001, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('WebSocket server did not bind to a TCP port.');

  return {
    port: address.port,
    host,
    manager,
    close: async () => {
      clearInterval(heartbeatTimer);
      manager.close();
      for (const socket of states.keys()) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close(() => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      });
    },
  };
}

function handleRawMessage(raw: RawData, state: SocketState, manager: RoomManager): void {
  const byteLength = Array.isArray(raw)
    ? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
    : raw.byteLength;
  if (byteLength > MAX_MESSAGE_BYTES) {
    state.peer.close(1009, 'Message too large');
    return;
  }

  const now = Date.now();
  state.messageTimes = state.messageTimes.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  state.messageTimes.push(now);
  if (state.messageTimes.length > RATE_WINDOW_MESSAGES) {
    reject(state.peer, undefined, 'RATE_LIMITED', 'Too many commands. Reconnect and try again.');
    state.peer.close(1008, 'Rate limit exceeded');
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString());
  } catch {
    reject(state.peer, undefined, 'MALFORMED_MESSAGE', 'Message must be valid JSON.');
    return;
  }

  const parsed = clientMessageSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const possibleType = typeof parsedJson === 'object' && parsedJson !== null && 'type' in parsedJson
      ? (parsedJson as { type?: unknown }).type
      : null;
    const invalidCell = possibleType === 'game.move' && typeof parsedJson === 'object' && parsedJson !== null && 'cell' in parsedJson;
    const code: RejectionCode = invalidCell
      ? 'INVALID_CELL'
      : typeof possibleType === 'string' && !KNOWN_MESSAGE_TYPES.has(possibleType)
        ? 'UNKNOWN_MESSAGE'
        : 'MALFORMED_MESSAGE';
    const message = code === 'INVALID_CELL'
      ? 'Choose a whole-number cell between 0 and 8.'
      : code === 'UNKNOWN_MESSAGE'
        ? 'Unknown command.'
        : 'Message payload is invalid.';
    reject(state.peer, getRequestId(parsedJson), code, message);
    return;
  }

  try {
    dispatch(parsed.data, state.peer, manager);
  } catch (error) {
    if (error instanceof CommandError) {
      reject(state.peer, 'requestId' in parsed.data ? parsed.data.requestId : undefined, error.code, error.message);
      return;
    }
    reject(state.peer, 'requestId' in parsed.data ? parsed.data.requestId : undefined, 'INTERNAL_ERROR', 'The server could not process that command.');
  }
}

function dispatch(message: ClientMessage, peer: SocketPeer, manager: RoomManager): void {
  switch (message.type) {
    case 'room.create': {
      const session = manager.createRoom(message.name, peer);
      peer.send({ type: 'session.ready', requestId: message.requestId, ...session });
      manager.broadcastForPeer(peer.id);
      return;
    }
    case 'room.join': {
      const session = manager.joinRoom(message.roomCode, message.name, peer);
      peer.send({ type: 'session.ready', requestId: message.requestId, ...session });
      manager.broadcastForPeer(peer.id);
      return;
    }
    case 'session.resume': {
      const session = manager.resumeSession(message.roomCode, message.playerToken, peer);
      peer.send({ type: 'session.ready', requestId: message.requestId, ...session });
      manager.broadcastForPeer(peer.id);
      return;
    }
    case 'game.move':
      manager.move(peer.id, message.requestId, message.cell, message.expectedVersion);
      return;
    case 'rematch.vote':
      manager.voteRematch(peer.id, message.requestId);
      return;
    case 'presence.ping':
      manager.touch(peer.id);
      peer.send({ type: 'presence.pong', sentAt: message.sentAt, serverTime: Date.now() });
  }
}

function reject(peer: Peer, requestId: string | undefined, code: RejectionCode, message: string): void {
  peer.send({ type: 'command.rejected', requestId, code, message });
}

function getRequestId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('requestId' in value)) return undefined;
  const requestId = (value as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' ? requestId.slice(0, 80) : undefined;
}
