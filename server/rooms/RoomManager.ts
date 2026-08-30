import { randomBytes, randomUUID } from 'node:crypto';
import { applyMove, createInitialGame, GameRuleError, type EngineState, type Mark } from '../../shared/game';
import {
  CHAT_HISTORY_LIMIT,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGE_DIMENSION,
  MAX_CHAT_TEXT_LENGTH,
  ROOM_IMAGE_MEMORY_LIMIT,
  type ChatMessageSnapshot,
  type ChatReactionSnapshot,
  type ChatSnapshot,
  type MessageReaction,
  type QuickReaction,
  type RoomPhase,
  type RoomSnapshot,
  type RoomTiming,
  type ServerMessage,
  type StickerId,
  type SupportedImageMime,
} from '../../shared/protocol';
import { CommandError } from '../errors';
import { generateTemporaryName } from './identity';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * How long a completed request stays in the idempotency ledger. Long enough to
 * cover a reconnect-and-retry cycle, short enough that the ledger cannot grow
 * without bound. REQUEST_LEDGER_LIMIT is the hard backstop.
 */
const REQUEST_LEDGER_TTL_MS = 120_000;
const REQUEST_LEDGER_LIMIT = 512;

type RateBucket = 'chat' | 'reaction' | 'typing' | 'image';

/**
 * What a replay of an already-executed request should produce. The command is
 * never re-executed; the recorded outcome is rebuilt from current room state so
 * the caller receives the same answer it missed (INV-5).
 */
type LedgerOutcome =
  | { kind: 'game' }
  | { kind: 'chat'; messageId: string }
  | { kind: 'reaction'; messageId: string }
  | { kind: 'silent' };

interface LedgerEntry {
  at: number;
  outcome: LedgerOutcome;
}

export interface Peer {
  id: string;
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

interface Player {
  id: string;
  token: string;
  name: string;
  mark: Mark;
  connected: boolean;
  reconnectDeadline: number | null;
  peer: Peer | null;
  requests: Map<string, LedgerEntry>;
  rateLimits: Record<RateBucket, number[]>;
}

interface StoredChatBase {
  id: string;
  requestId: string;
  senderId: string;
  createdAt: number;
  sequence: number;
  reactions: Map<MessageReaction, Set<string>>;
}

type StoredChatMessage =
  | (StoredChatBase & { kind: 'text'; text: string })
  | (StoredChatBase & { kind: 'sticker'; stickerId: StickerId })
  | (StoredChatBase & {
      kind: 'image';
      mime: SupportedImageMime;
      width: number;
      height: number;
      byteLength: number;
      data: string;
    });

interface Room {
  code: string;
  players: Map<string, Player>;
  game: EngineState;
  phase: RoomPhase;
  pausedFrom: 'countdown' | 'active' | null;
  rematchVotes: Set<string>;
  revision: number;
  chatSequence: number;
  round: number;
  countdownEndsAt: number | null;
  createdAt: number;
  updatedAt: number;
  startTimer: ReturnType<typeof setTimeout> | null;
  chatMessages: StoredChatMessage[];
  chatImageBytes: number;
  typing: Map<string, number>;
  typingTimers: Map<string, ReturnType<typeof setTimeout>>;
}

export interface RoomManagerOptions {
  countdownMs?: number;
  reconnectGraceMs?: number;
  emptyRoomTtlMs?: number;
  waitingRoomTtlMs?: number;
  reservationTtlMs?: number;
  cleanupIntervalMs?: number;
  typingTtlMs?: number;
  now?: () => number;
}

export interface SessionResult {
  roomCode: string;
  playerToken: string;
  playerId: string;
  displayName: string;
  mark: Mark;
  snapshot: RoomSnapshot;
  timing: RoomTiming;
  chat: ChatSnapshot;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly connectionIndex = new Map<string, { roomCode: string; playerId: string }>();
  private readonly countdownMs: number;
  private readonly reconnectGraceMs: number;
  private readonly emptyRoomTtlMs: number;
  private readonly waitingRoomTtlMs: number;
  private readonly reservationTtlMs: number;
  private readonly typingTtlMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(options: RoomManagerOptions = {}) {
    this.countdownMs = options.countdownMs ?? 2_600;
    this.reconnectGraceMs = options.reconnectGraceMs ?? 90_000;
    this.emptyRoomTtlMs = options.emptyRoomTtlMs ?? 90_000;
    this.waitingRoomTtlMs = options.waitingRoomTtlMs ?? 10 * 60_000;
    this.reservationTtlMs = options.reservationTtlMs ?? 10 * 60_000;
    this.typingTtlMs = options.typingTtlMs ?? 2_500;
    this.now = options.now ?? Date.now;
    this.cleanupTimer = setInterval(() => this.sweep(), options.cleanupIntervalMs ?? 15_000);
    this.cleanupTimer.unref?.();
  }

  createRoom(peer: Peer): SessionResult {
    if (this.connectionIndex.has(peer.id)) {
      throw new CommandError('ALREADY_IN_ROOM', 'This connection already belongs to a room.');
    }
    const code = this.generateRoomCode();
    const player = this.createPlayer('X', peer, new Set());
    const timestamp = this.now();
    const room: Room = {
      code,
      players: new Map([[player.id, player]]),
      game: createInitialGame(),
      phase: 'waiting',
      pausedFrom: null,
      rematchVotes: new Set(),
      revision: 1,
      chatSequence: 0,
      round: 1,
      countdownEndsAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startTimer: null,
      chatMessages: [],
      chatImageBytes: 0,
      typing: new Map(),
      typingTimers: new Map(),
    };
    this.rooms.set(code, room);
    this.connectionIndex.set(peer.id, { roomCode: code, playerId: player.id });
    return this.sessionResult(room, player);
  }

  joinRoom(code: string, peer: Peer): SessionResult {
    if (this.connectionIndex.has(peer.id)) {
      throw new CommandError('ALREADY_IN_ROOM', 'This connection already belongs to a room.');
    }
    const room = this.requireRoom(code);
    if (room.players.size >= 2) {
      throw new CommandError('ROOM_FULL', 'This room already has two players.');
    }
    const names = new Set([...room.players.values()].map((player) => player.name));
    const player = this.createPlayer('O', peer, names);
    room.players.set(player.id, player);
    this.connectionIndex.set(peer.id, { roomCode: room.code, playerId: player.id });
    this.beginCountdown(room);
    return this.sessionResult(room, player);
  }

  resumeSession(code: string, token: string, peer: Peer): SessionResult {
    if (this.connectionIndex.has(peer.id)) {
      throw new CommandError('ALREADY_IN_ROOM', 'This connection already belongs to a room.');
    }
    const room = this.requireRoom(code);
    const player = [...room.players.values()].find((candidate) => candidate.token === token);
    if (!player) throw new CommandError('INVALID_SESSION', 'This player session is no longer valid.');

    if (player.peer && player.peer.id !== peer.id) {
      this.connectionIndex.delete(player.peer.id);
      player.peer.close(4001, 'Session resumed in another window');
    }
    player.peer = peer;
    player.connected = true;
    player.reconnectDeadline = null;
    this.connectionIndex.set(peer.id, { roomCode: room.code, playerId: player.id });

    if (room.phase === 'paused' && this.allPlayersConnected(room)) {
      if (room.pausedFrom === 'countdown') this.beginCountdown(room);
      else {
        room.phase = 'active';
        room.pausedFrom = null;
        this.bump(room);
      }
    } else {
      this.bump(room);
    }
    return this.sessionResult(room, player);
  }

  leaveRoom(peerId: string): void {
    const { room } = this.requireMembership(peerId);
    this.destroyRoom(room.code, 'LEFT', 'This private session has ended.');
  }

  move(peerId: string, requestId: string, cell: number, expectedRevision: number): void {
    const { room, player } = this.requireMembership(peerId);
    if (this.recall(player, requestId)) {
      player.peer?.send({ type: 'game.snapshot', snapshot: this.snapshot(room), timing: this.timing(room), ackRequestId: requestId });
      return;
    }
    if (expectedRevision !== room.revision) {
      player.peer?.send({ type: 'game.snapshot', snapshot: this.snapshot(room), timing: this.timing(room) });
      throw new CommandError('STALE_STATE', 'The room changed before that move arrived. The latest board has been restored.');
    }
    if (room.phase !== 'active') {
      throw new CommandError(
        room.game.winner || room.game.isDraw ? 'GAME_COMPLETE' : 'GAME_NOT_ACTIVE',
        room.phase === 'paused' ? 'The match is paused while a player reconnects.' : 'The match is not active yet.',
      );
    }
    if (!this.allPlayersConnected(room)) throw new CommandError('OPPONENT_OFFLINE', 'Wait for your opponent to reconnect.');
    try {
      room.game = applyMove(room.game, player.mark, cell);
    } catch (error) {
      if (error instanceof GameRuleError) throw new CommandError(error.code, error.message);
      throw error;
    }
    this.remember(player, requestId, { kind: 'game' });
    if (room.game.winner || room.game.isDraw) room.phase = 'game_over';
    this.bump(room);
    this.broadcastGame(room, requestId);
  }

  voteRematch(peerId: string, requestId: string): void {
    const { room, player } = this.requireMembership(peerId);
    if (this.recall(player, requestId)) {
      player.peer?.send({ type: 'game.snapshot', snapshot: this.snapshot(room), timing: this.timing(room), ackRequestId: requestId });
      return;
    }
    if (room.phase !== 'game_over' && room.phase !== 'rematch_waiting') {
      throw new CommandError('GAME_NOT_ACTIVE', 'A rematch can only be requested after the game.');
    }
    this.remember(player, requestId, { kind: 'game' });
    if (room.rematchVotes.has(player.id)) {
      player.peer?.send({ type: 'game.snapshot', snapshot: this.snapshot(room), timing: this.timing(room), ackRequestId: requestId });
      return;
    }
    room.rematchVotes.add(player.id);

    if (room.rematchVotes.size === 2 && this.allPlayersConnected(room)) {
      // The ledger is deliberately not cleared on rematch. Request ids are
      // UUIDs and are never reused, so clearing would only widen the window in
      // which a delayed duplicate could execute a second time.
      for (const candidate of room.players.values()) {
        candidate.mark = candidate.mark === 'X' ? 'O' : 'X';
      }
      room.game = createInitialGame();
      room.round += 1;
      room.rematchVotes.clear();
      this.beginCountdown(room);
    } else {
      room.phase = 'rematch_waiting';
      this.bump(room);
    }
    this.broadcastGame(room, requestId);
  }

  sendChatMessage(peerId: string, requestId: string, text: string): void {
    const { room, player } = this.requireChatMembership(peerId);
    // The ledger is consulted before the rate limiter: a client retrying a
    // command it never saw acknowledged must not be punished for the retry.
    if (this.replayChat(room, player, requestId)) return;
    this.checkRate(player, 'chat', 12, 8_000);
    const normalized = text.trim();
    if (!normalized) throw new CommandError('INVALID_CHAT', 'Write a message before sending.');
    if (normalized.length > MAX_CHAT_TEXT_LENGTH) {
      throw new CommandError('MESSAGE_TOO_LONG', `Messages can contain up to ${MAX_CHAT_TEXT_LENGTH} characters.`);
    }
    const message: StoredChatMessage = {
      id: randomUUID(), requestId, senderId: player.id, kind: 'text', text: normalized,
      createdAt: this.now(), sequence: 0, reactions: new Map(),
    };
    this.storeAndBroadcastMessage(room, player, message);
  }

  sendSticker(peerId: string, requestId: string, stickerId: StickerId): void {
    const { room, player } = this.requireChatMembership(peerId);
    if (this.replayChat(room, player, requestId)) return;
    this.checkRate(player, 'chat', 12, 8_000);
    const message: StoredChatMessage = {
      id: randomUUID(), requestId, senderId: player.id, kind: 'sticker', stickerId,
      createdAt: this.now(), sequence: 0, reactions: new Map(),
    };
    this.storeAndBroadcastMessage(room, player, message);
  }

  sendImage(
    peerId: string,
    requestId: string,
    image: { mime: SupportedImageMime; width: number; height: number; byteLength: number; data: string },
  ): void {
    const { room, player } = this.requireChatMembership(peerId);
    if (this.replayChat(room, player, requestId)) return;
    this.checkRate(player, 'image', 3, 30_000);
    const bytes = this.validateImage(image.mime, image.width, image.height, image.byteLength, image.data);
    if (bytes.byteLength > MAX_CHAT_IMAGE_BYTES) {
      throw new CommandError('IMAGE_TOO_LARGE', 'The prepared image is too large to share.');
    }
    const message: StoredChatMessage = {
      id: randomUUID(), requestId, senderId: player.id, kind: 'image', ...image,
      byteLength: bytes.byteLength, createdAt: this.now(), sequence: 0, reactions: new Map(),
    };
    this.storeAndBroadcastMessage(room, player, message);
  }

  setTyping(peerId: string, typing: boolean): void {
    const { room, player } = this.requireChatMembership(peerId);
    this.checkRate(player, 'typing', 12, 5_000);
    if (!typing) {
      this.clearTyping(room, player.id, true);
      return;
    }
    const expiresAt = this.now() + this.typingTtlMs;
    room.typing.set(player.id, expiresAt);
    const previousTimer = room.typingTimers.get(player.id);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
      room.typingTimers.delete(player.id);
      if (!this.rooms.has(room.code) || (room.typing.get(player.id) ?? 0) > this.now()) return;
      room.typing.delete(player.id);
      this.broadcastChat(room, {
        type: 'chat.typing', playerId: player.id, isTyping: false,
        msRemaining: null, sequence: this.nextChatSequence(room),
      });
    }, this.typingTtlMs + 25);
    timer.unref?.();
    room.typingTimers.set(player.id, timer);
    room.updatedAt = this.now();
    this.broadcastChat(room, {
      type: 'chat.typing', playerId: player.id, isTyping: true,
      msRemaining: this.typingTtlMs, sequence: this.nextChatSequence(room),
    });
  }

  toggleMessageReaction(peerId: string, requestId: string, messageId: string, reaction: MessageReaction): void {
    const { room, player } = this.requireChatMembership(peerId);
    if (this.replayChat(room, player, requestId)) return;
    this.checkRate(player, 'reaction', 20, 5_000);
    const message = room.chatMessages.find((candidate) => candidate.id === messageId);
    if (!message) throw new CommandError('INVALID_REACTION', 'That message is no longer available.');
    const players = message.reactions.get(reaction) ?? new Set<string>();
    if (players.has(player.id)) players.delete(player.id);
    else players.add(player.id);
    if (players.size) message.reactions.set(reaction, players);
    else message.reactions.delete(reaction);
    this.remember(player, requestId, { kind: 'reaction', messageId });
    room.updatedAt = this.now();
    this.broadcastChat(room, {
      type: 'chat.message-reaction',
      messageId,
      reactions: this.reactionSnapshot(message),
      sequence: this.nextChatSequence(room),
      ackRequestId: requestId,
    });
  }

  sendQuickReaction(peerId: string, requestId: string, reaction: QuickReaction): void {
    const { room, player } = this.requireChatMembership(peerId);
    if (this.recall(player, requestId)) return;
    this.checkRate(player, 'reaction', 20, 5_000);
    this.remember(player, requestId, { kind: 'silent' });
    room.updatedAt = this.now();
    this.broadcastChat(room, {
      type: 'chat.quick-reaction', id: randomUUID(), senderId: player.id, reaction,
      createdAt: this.now(), sequence: this.nextChatSequence(room), ackRequestId: requestId,
    });
  }

  disconnect(peerId: string): void {
    const indexed = this.connectionIndex.get(peerId);
    if (!indexed) return;
    this.connectionIndex.delete(peerId);
    const room = this.rooms.get(indexed.roomCode);
    const player = room?.players.get(indexed.playerId);
    if (!room || !player || player.peer?.id !== peerId) return;

    player.peer = null;
    player.connected = false;
    player.reconnectDeadline = this.now() + this.reconnectGraceMs;
    this.clearTyping(room, player.id, true);
    if (room.phase === 'countdown' || room.phase === 'active') {
      room.pausedFrom = room.phase;
      room.phase = 'paused';
      room.countdownEndsAt = null;
      this.clearStartTimer(room);
    }
    this.bump(room);
    this.broadcastGame(room);
  }

  touch(peerId: string): void {
    const indexed = this.connectionIndex.get(peerId);
    const room = indexed ? this.rooms.get(indexed.roomCode) : null;
    if (room) room.updatedAt = this.now();
  }

  broadcastForPeer(peerId: string): void {
    this.broadcastGame(this.requireMembership(peerId).room);
  }

  getSnapshotForPeer(peerId: string): RoomSnapshot {
    return this.snapshot(this.requireMembership(peerId).room);
  }

  getTimingForPeer(peerId: string): RoomTiming {
    return this.timing(this.requireMembership(peerId).room);
  }

  getEphemeralStats(code: string): { messages: number; imageBytes: number; typingTimers: number } | null {
    const room = this.rooms.get(code.toUpperCase());
    return room ? { messages: room.chatMessages.length, imageBytes: room.chatImageBytes, typingTimers: room.typingTimers.size } : null;
  }

  get size(): number {
    return this.rooms.size;
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    for (const code of [...this.rooms.keys()]) {
      this.destroyRoom(code, 'SERVER_SHUTDOWN', 'The realtime service is restarting.');
    }
    this.connectionIndex.clear();
  }

  destroyRoom(code: string, reason: 'LEFT' | 'EXPIRED' | 'SERVER_SHUTDOWN', message: string): void {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return;
    this.clearStartTimer(room);
    for (const timer of room.typingTimers.values()) clearTimeout(timer);
    room.typingTimers.clear();
    room.typing.clear();

    for (const player of room.players.values()) {
      if (player.peer) {
        this.connectionIndex.delete(player.peer.id);
        player.peer.send({ type: 'session.ended', reason, message });
      }
      player.token = '';
      player.requests.clear();
      for (const entries of Object.values(player.rateLimits)) entries.length = 0;
      player.peer = null;
      player.connected = false;
    }

    for (const chatMessage of room.chatMessages) {
      chatMessage.reactions.clear();
      if (chatMessage.kind === 'image') chatMessage.data = '';
    }
    room.chatMessages.length = 0;
    room.chatImageBytes = 0;
    room.rematchVotes.clear();
    room.game.board.fill(null);
    room.players.clear();
    this.rooms.delete(room.code);
  }

  private beginCountdown(room: Room): void {
    this.clearStartTimer(room);
    room.phase = 'countdown';
    room.pausedFrom = null;
    room.countdownEndsAt = this.now() + this.countdownMs;
    this.bump(room);
    room.startTimer = setTimeout(() => {
      room.startTimer = null;
      if (!this.rooms.has(room.code) || room.phase !== 'countdown') return;
      if (!this.allPlayersConnected(room)) {
        room.pausedFrom = 'countdown';
        room.phase = 'paused';
      } else {
        room.phase = 'active';
        room.pausedFrom = null;
      }
      room.countdownEndsAt = null;
      this.bump(room);
      this.broadcastGame(room);
    }, this.countdownMs);
    room.startTimer.unref?.();
  }

  private storeAndBroadcastMessage(room: Room, player: Player, message: StoredChatMessage): void {
    message.sequence = this.nextChatSequence(room);
    this.remember(player, message.requestId, { kind: 'chat', messageId: message.id });
    room.chatMessages.push(message);
    if (message.kind === 'image') room.chatImageBytes += message.byteLength;
    this.pruneChat(room);
    room.updatedAt = this.now();
    this.broadcastChat(room, { type: 'chat.message', message: this.messageSnapshot(message), ackRequestId: message.requestId });
  }

  private pruneChat(room: Room): void {
    while (room.chatMessages.length > CHAT_HISTORY_LIMIT || room.chatImageBytes > ROOM_IMAGE_MEMORY_LIMIT) {
      const removed = room.chatMessages.shift();
      if (!removed) return;
      removed.reactions.clear();
      if (removed.kind === 'image') {
        room.chatImageBytes -= removed.byteLength;
        removed.data = '';
      }
    }
  }

  private validateImage(
    mime: SupportedImageMime,
    width: number,
    height: number,
    byteLength: number,
    data: string,
  ): Buffer {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new CommandError('INVALID_IMAGE', 'Image data is malformed.');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.byteLength || bytes.byteLength !== byteLength || bytes.toString('base64') !== data) {
      throw new CommandError('INVALID_IMAGE', 'Image data does not match its metadata.');
    }
    const inspected = inspectImage(bytes);
    if (!inspected || inspected.mime !== mime) {
      throw new CommandError('INVALID_IMAGE', 'Image contents do not match the selected format.');
    }
    if (
      inspected.width !== width
      || inspected.height !== height
      || inspected.width > MAX_CHAT_IMAGE_DIMENSION
      || inspected.height > MAX_CHAT_IMAGE_DIMENSION
    ) {
      throw new CommandError('INVALID_IMAGE', 'Image dimensions do not match the prepared attachment.');
    }
    return bytes;
  }

  /**
   * Replays an already-executed chat request to the caller, rebuilding the
   * reply from current room state. Returns false when the request is new.
   *
   * A recorded message that has since been pruned from history is answered with
   * silence rather than a fabricated payload - the request did happen, so it
   * must not execute a second time.
   */
  private replayChat(room: Room, player: Player, requestId: string): boolean {
    const outcome = this.recall(player, requestId);
    if (!outcome) return false;
    if (outcome.kind === 'chat') {
      const stored = room.chatMessages.find((candidate) => candidate.id === outcome.messageId);
      if (stored) {
        player.peer?.send({ type: 'chat.message', message: this.messageSnapshot(stored), ackRequestId: requestId });
      }
    } else if (outcome.kind === 'reaction') {
      const stored = room.chatMessages.find((candidate) => candidate.id === outcome.messageId);
      if (stored) {
        player.peer?.send({
          type: 'chat.message-reaction',
          messageId: outcome.messageId,
          reactions: this.reactionSnapshot(stored),
          sequence: stored.sequence,
          ackRequestId: requestId,
        });
      }
    }
    return true;
  }

  private broadcastGame(room: Room, ackRequestId?: string): void {
    const message: ServerMessage = {
      type: 'game.snapshot', snapshot: this.snapshot(room), timing: this.timing(room), ackRequestId,
    };
    for (const player of room.players.values()) player.peer?.send(message);
  }

  private broadcastChat(room: Room, message: ServerMessage): void {
    for (const player of room.players.values()) player.peer?.send(message);
  }

  /**
   * A pure function of the room's authoritative state at its current revision.
   * Nothing time-dependent belongs here - see RoomTiming and INV-3.
   */
  private snapshot(room: Room): RoomSnapshot {
    return {
      roomCode: room.code,
      revision: room.revision,
      phase: room.phase,
      board: [...room.game.board],
      turn: room.game.turn,
      winner: room.game.winner,
      winningLine: room.game.winningLine ? [...room.game.winningLine] : null,
      isDraw: room.game.isDraw,
      round: room.round,
      players: [...room.players.values()]
        .sort((a, b) => a.mark.localeCompare(b.mark))
        .map((player) => ({
          id: player.id,
          name: player.name,
          mark: player.mark,
          connected: player.connected,
          wantsRematch: room.rematchVotes.has(player.id),
        })),
    };
  }

  /**
   * Deadlines leave the server as durations, never as absolute epochs, so a
   * client with a wrong clock cannot mis-render or mis-enforce them (INV-11).
   */
  private timing(room: Room): RoomTiming {
    const timestamp = this.now();
    return {
      serverTime: timestamp,
      countdownMsRemaining: room.countdownEndsAt === null
        ? null
        : Math.max(0, room.countdownEndsAt - timestamp),
      reconnect: [...room.players.values()]
        .filter((player) => player.reconnectDeadline !== null)
        .map((player) => ({
          playerId: player.id,
          msRemaining: Math.max(0, (player.reconnectDeadline ?? timestamp) - timestamp),
        })),
    };
  }

  private chatSnapshot(room: Room): ChatSnapshot {
    const timestamp = this.now();
    return {
      messages: room.chatMessages.map((message) => this.messageSnapshot(message)),
      typing: [...room.typing.entries()]
        .filter(([, expiresAt]) => expiresAt > timestamp)
        .map(([playerId, expiresAt]) => ({
          playerId,
          msRemaining: expiresAt - timestamp,
          sequence: room.chatSequence,
        })),
      sequence: room.chatSequence,
    };
  }

  private messageSnapshot(message: StoredChatMessage): ChatMessageSnapshot {
    const base = {
      id: message.id,
      senderId: message.senderId,
      createdAt: message.createdAt,
      sequence: message.sequence,
      reactions: this.reactionSnapshot(message),
    };
    if (message.kind === 'text') return { ...base, kind: 'text', text: message.text };
    if (message.kind === 'sticker') return { ...base, kind: 'sticker', stickerId: message.stickerId };
    return {
      ...base,
      kind: 'image',
      mime: message.mime,
      width: message.width,
      height: message.height,
      byteLength: message.byteLength,
      data: message.data,
    };
  }

  private reactionSnapshot(message: StoredChatMessage): ChatReactionSnapshot[] {
    return [...message.reactions.entries()].map(([reaction, playerIds]) => ({ reaction, playerIds: [...playerIds] }));
  }

  private sessionResult(room: Room, player: Player): SessionResult {
    return {
      roomCode: room.code,
      playerToken: player.token,
      playerId: player.id,
      displayName: player.name,
      mark: player.mark,
      snapshot: this.snapshot(room),
      timing: this.timing(room),
      chat: this.chatSnapshot(room),
    };
  }

  private createPlayer(mark: Mark, peer: Peer, excludedNames: ReadonlySet<string>): Player {
    return {
      id: randomUUID(),
      token: `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
      name: generateTemporaryName(excludedNames),
      mark,
      connected: true,
      reconnectDeadline: null,
      peer,
      requests: new Map(),
      rateLimits: { chat: [], reaction: [], typing: [], image: [] },
    };
  }

  private requireRoom(code: string): Room {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) throw new CommandError('ROOM_NOT_FOUND', 'Room not found. Check the code and try again.');
    return room;
  }

  private requireMembership(peerId: string): { room: Room; player: Player } {
    const indexed = this.connectionIndex.get(peerId);
    if (!indexed) throw new CommandError('NOT_IN_ROOM', 'Join a room before sending game commands.');
    const room = this.rooms.get(indexed.roomCode);
    const player = room?.players.get(indexed.playerId);
    if (!room || !player || player.peer?.id !== peerId) {
      throw new CommandError('INVALID_SESSION', 'This player session is no longer active.');
    }
    return { room, player };
  }

  private requireChatMembership(peerId: string): { room: Room; player: Player } {
    const membership = this.requireMembership(peerId);
    if (membership.room.players.size !== 2) {
      throw new CommandError('GAME_NOT_ACTIVE', 'Private chat opens when your opponent joins.');
    }
    return membership;
  }

  private allPlayersConnected(room: Room): boolean {
    return room.players.size === 2 && [...room.players.values()].every((player) => player.connected);
  }

  private bump(room: Room): void {
    room.revision += 1;
    room.updatedAt = this.now();
  }

  private nextChatSequence(room: Room): number {
    room.chatSequence += 1;
    return room.chatSequence;
  }

  /**
   * Returns the recorded outcome if this request has already been executed.
   * Expired entries are dropped on the way past, so the ledger self-prunes on
   * the hot path and does not depend on the sweep timer for correctness.
   */
  private recall(player: Player, requestId: string): LedgerOutcome | null {
    const timestamp = this.now();
    const entry = player.requests.get(requestId);
    if (!entry) return null;
    if (timestamp - entry.at > REQUEST_LEDGER_TTL_MS) {
      player.requests.delete(requestId);
      return null;
    }
    return entry.outcome;
  }

  private remember(player: Player, requestId: string, outcome: LedgerOutcome = { kind: 'silent' }): void {
    const timestamp = this.now();
    player.requests.set(requestId, { at: timestamp, outcome });
    if (player.requests.size <= REQUEST_LEDGER_LIMIT) return;
    for (const [key, entry] of player.requests) {
      if (timestamp - entry.at > REQUEST_LEDGER_TTL_MS) player.requests.delete(key);
    }
    // Map preserves insertion order, so the front of the iterator is the oldest.
    while (player.requests.size > REQUEST_LEDGER_LIMIT) {
      const oldest = player.requests.keys().next().value;
      if (oldest === undefined) break;
      player.requests.delete(oldest);
    }
  }

  private checkRate(player: Player, bucket: RateBucket, limit: number, windowMs: number): void {
    const timestamp = this.now();
    const entries = player.rateLimits[bucket].filter((entry) => timestamp - entry < windowMs);
    entries.push(timestamp);
    player.rateLimits[bucket] = entries;
    if (entries.length > limit) throw new CommandError('RATE_LIMITED', 'Slow down for a moment and try again.');
  }

  private clearTyping(room: Room, playerId: string, broadcast: boolean): void {
    const timer = room.typingTimers.get(playerId);
    if (timer) clearTimeout(timer);
    room.typingTimers.delete(playerId);
    const hadTyping = room.typing.delete(playerId);
    if (hadTyping && broadcast) {
      this.broadcastChat(room, {
        type: 'chat.typing', playerId, isTyping: false,
        msRemaining: null, sequence: this.nextChatSequence(room),
      });
    }
  }

  private generateRoomCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let code = '';
      const bytes = randomBytes(6);
      for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
      if (!this.rooms.has(code)) return code;
    }
    throw new CommandError('INTERNAL_ERROR', 'Could not allocate a room. Please try again.');
  }

  private clearStartTimer(room: Room): void {
    if (room.startTimer) clearTimeout(room.startTimer);
    room.startTimer = null;
  }

  private sweep(): void {
    const timestamp = this.now();
    for (const room of [...this.rooms.values()]) {
      const players = [...room.players.values()];
      const allOffline = players.every((player) => !player.connected);
      const offlineTooLong = players.some(
        (player) => !player.connected && player.reconnectDeadline !== null && timestamp - player.reconnectDeadline > this.reservationTtlMs,
      );
      const ttl = players.length === 1 ? this.waitingRoomTtlMs : this.emptyRoomTtlMs;
      if ((allOffline && timestamp - room.updatedAt >= ttl) || offlineTooLong) {
        this.destroyRoom(room.code, 'EXPIRED', 'This inactive private session has expired.');
      }
    }
  }
}

function inspectImage(bytes: Uint8Array): { mime: SupportedImageMime; width: number; height: number } | null {
  if (
    bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    && ascii(bytes, 12, 16) === 'IHDR'
  ) {
    return { mime: 'image/png', width: uint32Be(bytes, 16), height: uint32Be(bytes, 20) };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      if (marker === 0xda) break;
      const segmentLength = uint16Be(bytes, offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;
      if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
        return {
          mime: 'image/jpeg',
          width: uint16Be(bytes, offset + 7),
          height: uint16Be(bytes, offset + 5),
        };
      }
      offset += 2 + segmentLength;
    }
    return null;
  }

  if (
    bytes.length >= 30
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const chunkType = ascii(bytes, 12, 16);
    if (chunkType === 'VP8X') {
      return {
        mime: 'image/webp',
        width: uint24Le(bytes, 24) + 1,
        height: uint24Le(bytes, 27) + 1,
      };
    }
    if (chunkType === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        mime: 'image/webp',
        width: uint16Le(bytes, 26) & 0x3fff,
        height: uint16Le(bytes, 28) & 0x3fff,
      };
    }
    if (chunkType === 'VP8L' && bytes[20] === 0x2f) {
      const dimensions = uint32Le(bytes, 21);
      return {
        mime: 'image/webp',
        width: (dimensions & 0x3fff) + 1,
        height: ((dimensions >>> 14) & 0x3fff) + 1,
      };
    }
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function uint16Be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]
  ) >>> 0;
}

function uint32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    + (bytes[offset + 1] << 8)
    + (bytes[offset + 2] << 16)
    + bytes[offset + 3] * 0x1000000
  ) >>> 0;
}
