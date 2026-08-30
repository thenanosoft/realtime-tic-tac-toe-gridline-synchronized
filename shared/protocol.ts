import { z } from 'zod';
import type { Cell, Mark } from './game';

/**
 * Wire protocol version.
 *
 * 1 - the original protocol: `RoomSnapshot.version`, `game.move.expectedVersion`,
 *     no ordinal on chat events, absolute server epochs compared against the
 *     client clock.
 * 2 - `revision`/`expectedRevision`, a monotonic `sequence` on every chat event,
 *     and server-relative deadlines so a skewed client clock cannot affect
 *     ordering or timeouts.
 *
 * GitHub Pages and Render deploy independently, so a version skew window always
 * exists. The server therefore keeps accepting MIN_SUPPORTED_CLIENT_PROTOCOL for
 * one release cycle rather than cutting old clients off mid-match, and clients
 * compare against `server.hello` to tell the player to refresh.
 */
export const PROTOCOL_VERSION = 2;
export const MIN_SUPPORTED_CLIENT_PROTOCOL = 1;
export const LEGACY_CLIENT_PROTOCOL = 1;

export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
export const MAX_CHAT_TEXT_LENGTH = 1_000;
export const MAX_CHAT_IMAGE_BYTES = 1_500_000;
export const MAX_CHAT_IMAGE_SOURCE_BYTES = 8_000_000;
export const MAX_CHAT_IMAGE_DIMENSION = 1_600;
export const CHAT_HISTORY_LIMIT = 80;
export const ROOM_IMAGE_MEMORY_LIMIT = 6_000_000;
export const SUPPORTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const STICKER_IDS = ['handshake', 'fire', 'laugh', 'mind-blown', 'bullseye', 'sparkles'] as const;
export const QUICK_REACTIONS = ['😂', '🔥', '👏', '😮', '💀', '❤️', '🎯', '🤝'] as const;
export const MESSAGE_REACTIONS = ['😂', '🔥', '👏', '❤️', '🎯'] as const;

export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];
export type StickerId = (typeof STICKER_IDS)[number];
export type QuickReaction = (typeof QUICK_REACTIONS)[number];
export type MessageReaction = (typeof MESSAGE_REACTIONS)[number];

const requestId = z.string().min(1).max(80);
const roomCode = z.string().trim().toUpperCase().regex(ROOM_CODE_PATTERN);
const encodedImageLimit = Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 + 4;

// Optional so that a v1 client reaching a v2 server still parses. Absent is read
// as LEGACY_CLIENT_PROTOCOL, never as "trusted".
const envelope = { protocolVersion: z.number().int().min(1).max(1_000).optional() };

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room.create'), requestId, ...envelope }).strict(),
  z.object({ type: z.literal('room.join'), requestId, roomCode, ...envelope }).strict(),
  z.object({ type: z.literal('room.leave'), requestId, ...envelope }).strict(),
  z.object({
    type: z.literal('session.resume'),
    requestId,
    roomCode,
    playerToken: z.string().min(20).max(256),
    ...envelope,
  }).strict(),
  z.object({
    type: z.literal('game.move'),
    requestId,
    cell: z.number().int().min(0).max(8),
    expectedRevision: z.number().int().nonnegative(),
    ...envelope,
  }).strict(),
  z.object({ type: z.literal('rematch.vote'), requestId, ...envelope }).strict(),
  z.object({ type: z.literal('chat.message'), requestId, text: z.string().min(1).max(MAX_CHAT_TEXT_LENGTH), ...envelope }).strict(),
  z.object({ type: z.literal('chat.typing'), typing: z.boolean(), ...envelope }).strict(),
  z.object({ type: z.literal('chat.quick-reaction'), requestId, reaction: z.enum(QUICK_REACTIONS), ...envelope }).strict(),
  z.object({
    type: z.literal('chat.message-reaction'),
    requestId,
    messageId: z.string().uuid(),
    reaction: z.enum(MESSAGE_REACTIONS),
    ...envelope,
  }).strict(),
  z.object({ type: z.literal('chat.sticker'), requestId, stickerId: z.enum(STICKER_IDS), ...envelope }).strict(),
  z.object({
    type: z.literal('chat.image'),
    requestId,
    mime: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
    width: z.number().int().min(1).max(MAX_CHAT_IMAGE_DIMENSION),
    height: z.number().int().min(1).max(MAX_CHAT_IMAGE_DIMENSION),
    byteLength: z.number().int().min(1).max(MAX_CHAT_IMAGE_BYTES),
    data: z.string().min(4).max(encodedImageLimit),
    ...envelope,
  }).strict(),
  z.object({ type: z.literal('presence.ping'), sentAt: z.number().finite(), ...envelope }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type RoomPhase =
  | 'waiting'
  | 'countdown'
  | 'active'
  | 'paused'
  | 'game_over'
  | 'rematch_waiting';

export interface PlayerSnapshot {
  id: string;
  name: string;
  mark: Mark;
  connected: boolean;
  wantsRematch: boolean;
}

/**
 * Emission-scoped timing, deliberately kept *outside* RoomSnapshot.
 *
 * Durations decay with wall-clock time, so a snapshot containing them would
 * differ between two emissions at the same revision - and INV-3 requires that
 * two clients at the same revision hold byte-identical authoritative state.
 * Splitting them keeps the snapshot a pure function of the room at a revision
 * while still letting deadlines travel as durations rather than as absolute
 * epochs a skewed client clock could misread (INV-11).
 */
export interface RoomTiming {
  serverTime: number;
  countdownMsRemaining: number | null;
  reconnect: Array<{ playerId: string; msRemaining: number }>;
}

export interface RoomSnapshot {
  roomCode: string;
  /**
   * Server-assigned, strictly increasing on every authoritative change to the
   * room. A client must never apply a snapshot whose revision is not greater
   * than the one it already holds (INV-4). Named `revision` rather than
   * `version` so it cannot be confused with `protocolVersion`.
   */
  revision: number;
  phase: RoomPhase;
  board: Cell[];
  turn: Mark;
  winner: Mark | null;
  winningLine: number[] | null;
  isDraw: boolean;
  round: number;
  players: PlayerSnapshot[];
}

export interface ChatReactionSnapshot {
  reaction: MessageReaction;
  playerIds: string[];
}

interface ChatMessageBase {
  id: string;
  senderId: string;
  createdAt: number;
  /**
   * Server-assigned position in the room's single chat event stream. Messages
   * are ordered by this, never by `createdAt` and never by arrival order.
   */
  sequence: number;
  reactions: ChatReactionSnapshot[];
}

export type ChatMessageSnapshot =
  | (ChatMessageBase & { kind: 'text'; text: string })
  | (ChatMessageBase & { kind: 'sticker'; stickerId: StickerId })
  | (ChatMessageBase & {
      kind: 'image';
      mime: SupportedImageMime;
      width: number;
      height: number;
      byteLength: number;
      data: string;
    });

export interface ChatSnapshot {
  messages: ChatMessageSnapshot[];
  typing: Array<{ playerId: string; msRemaining: number; sequence: number }>;
  /** Highest sequence the room had issued when this snapshot was taken. */
  sequence: number;
}

export type RejectionCode =
  | 'MALFORMED_MESSAGE'
  | 'UNKNOWN_MESSAGE'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'INVALID_SESSION'
  | 'ALREADY_IN_ROOM'
  | 'NOT_IN_ROOM'
  | 'GAME_NOT_ACTIVE'
  | 'OPPONENT_OFFLINE'
  | 'INVALID_CELL'
  | 'CELL_OCCUPIED'
  | 'WRONG_TURN'
  | 'STALE_STATE'
  | 'GAME_COMPLETE'
  | 'INVALID_CHAT'
  | 'MESSAGE_TOO_LONG'
  | 'INVALID_STICKER'
  | 'INVALID_REACTION'
  | 'INVALID_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'PROTOCOL_MISMATCH'
  | 'INTERNAL_ERROR';

export type ServerMessage =
  | {
      type: 'server.hello';
      connectionId: string;
      serverTime: number;
      /** Absent means a v1 server: the client degrades rather than guessing. */
      protocolVersion: number;
      minClientProtocol: number;
    }
  | {
      type: 'session.ready';
      requestId: string;
      roomCode: string;
      playerToken: string;
      playerId: string;
      displayName: string;
      mark: Mark;
      snapshot: RoomSnapshot;
      timing: RoomTiming;
      chat: ChatSnapshot;
    }
  | { type: 'game.snapshot'; snapshot: RoomSnapshot; timing: RoomTiming; ackRequestId?: string }
  | { type: 'chat.message'; message: ChatMessageSnapshot; ackRequestId?: string }
  | {
      type: 'chat.typing';
      playerId: string;
      isTyping: boolean;
      msRemaining: number | null;
      sequence: number;
    }
  | {
      type: 'chat.message-reaction';
      messageId: string;
      reactions: ChatReactionSnapshot[];
      sequence: number;
      ackRequestId?: string;
    }
  | {
      type: 'chat.quick-reaction';
      id: string;
      senderId: string;
      reaction: QuickReaction;
      createdAt: number;
      sequence: number;
      ackRequestId?: string;
    }
  | { type: 'session.ended'; reason: 'LEFT' | 'EXPIRED' | 'SERVER_SHUTDOWN'; message: string }
  | { type: 'command.rejected'; requestId?: string; code: RejectionCode; message: string }
  | { type: 'server.notice'; code: 'ROOM_EXPIRED'; message: string }
  | { type: 'presence.pong'; sentAt: number; serverTime: number };
