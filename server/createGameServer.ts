import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { clientMessageSchema, type ClientMessage, type RejectionCode, type ServerMessage } from '../shared/protocol';
import { CommandError } from './errors';
import { RoomManager, type Peer, type RoomManagerOptions } from './rooms/RoomManager';

const MAX_FRAME_BYTES = 2_050_000;
const RATE_WINDOW_MS = 10_000;
const RATE_WINDOW_MESSAGES = 100;
const KNOWN_MESSAGE_TYPES = new Set([
  'room.create',
  'room.join',
  'room.leave',
  'session.resume',
  'game.move',
  'rematch.vote',
  'chat.message',
  'chat.typing',
  'chat.quick-reaction',
  'chat.message-reaction',
  'chat.sticker',
  'chat.image',
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
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

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

    socket.on('message', (raw, isBinary) => handleRawMessage(raw, isBinary, state, manager));
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

function handleRawMessage(raw: RawData, isBinary: boolean, state: SocketState, manager: RoomManager): void {
  if (isBinary) {
    state.peer.close(1003, 'Binary frames are not accepted');
    return;
  }
  const byteLength = Array.isArray(raw)
    ? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
    : raw.byteLength;
  if (byteLength > MAX_FRAME_BYTES) {
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
    const code = rejectionForInvalidPayload(possibleType, parsedJson);
    const message = invalidPayloadMessage(code);
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
      const session = manager.createRoom(peer);
      peer.send({ type: 'session.ready', requestId: message.requestId, ...session });
      manager.broadcastForPeer(peer.id);
      return;
    }
    case 'room.join': {
      const session = manager.joinRoom(message.roomCode, peer);
      peer.send({ type: 'session.ready', requestId: message.requestId, ...session });
      manager.broadcastForPeer(peer.id);
      return;
    }
    case 'room.leave':
      manager.leaveRoom(peer.id);
      return;
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
    case 'chat.message':
      manager.sendChatMessage(peer.id, message.requestId, message.text);
      return;
    case 'chat.typing':
      manager.setTyping(peer.id, message.typing);
      return;
    case 'chat.quick-reaction':
      manager.sendQuickReaction(peer.id, message.requestId, message.reaction);
      return;
    case 'chat.message-reaction':
      manager.toggleMessageReaction(peer.id, message.requestId, message.messageId, message.reaction);
      return;
    case 'chat.sticker':
      manager.sendSticker(peer.id, message.requestId, message.stickerId);
      return;
    case 'chat.image':
      manager.sendImage(peer.id, message.requestId, message);
      return;
    case 'presence.ping':
      manager.touch(peer.id);
      peer.send({ type: 'presence.pong', sentAt: message.sentAt, serverTime: Date.now() });
  }
}

function rejectionForInvalidPayload(possibleType: unknown, payload: unknown): RejectionCode {
  if (possibleType === 'game.move' && typeof payload === 'object' && payload !== null && 'cell' in payload) return 'INVALID_CELL';
  if (possibleType === 'chat.message') {
    const text = typeof payload === 'object' && payload !== null && 'text' in payload ? (payload as { text?: unknown }).text : null;
    return typeof text === 'string' && text.length > 1_000 ? 'MESSAGE_TOO_LONG' : 'INVALID_CHAT';
  }
  if (possibleType === 'chat.sticker') return 'INVALID_STICKER';
  if (possibleType === 'chat.quick-reaction' || possibleType === 'chat.message-reaction') return 'INVALID_REACTION';
  if (possibleType === 'chat.image') return 'INVALID_IMAGE';
  if (typeof possibleType === 'string' && !KNOWN_MESSAGE_TYPES.has(possibleType)) return 'UNKNOWN_MESSAGE';
  return 'MALFORMED_MESSAGE';
}

function invalidPayloadMessage(code: RejectionCode): string {
  switch (code) {
    case 'INVALID_CELL': return 'Choose a whole-number cell between 0 and 8.';
    case 'MESSAGE_TOO_LONG': return 'Messages can contain up to 1000 characters.';
    case 'INVALID_CHAT': return 'Chat message payload is invalid.';
    case 'INVALID_STICKER': return 'Unknown sticker.';
    case 'INVALID_REACTION': return 'Unknown reaction.';
    case 'INVALID_IMAGE': return 'Image metadata or content is invalid.';
    case 'UNKNOWN_MESSAGE': return 'Unknown command.';
    default: return 'Message payload is invalid.';
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
