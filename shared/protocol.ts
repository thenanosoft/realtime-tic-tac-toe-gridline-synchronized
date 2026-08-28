import { z } from 'zod';
import type { Cell, Mark } from './game';

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

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room.create'), requestId }).strict(),
  z.object({ type: z.literal('room.join'), requestId, roomCode }).strict(),
  z.object({ type: z.literal('room.leave'), requestId }).strict(),
  z.object({
    type: z.literal('session.resume'),
    requestId,
    roomCode,
    playerToken: z.string().min(20).max(256),
  }).strict(),
  z.object({
    type: z.literal('game.move'),
    requestId,
    cell: z.number().int().min(0).max(8),
    expectedVersion: z.number().int().nonnegative(),
  }).strict(),
  z.object({ type: z.literal('rematch.vote'), requestId }).strict(),
  z.object({ type: z.literal('chat.message'), requestId, text: z.string().min(1).max(MAX_CHAT_TEXT_LENGTH) }).strict(),
  z.object({ type: z.literal('chat.typing'), typing: z.boolean() }).strict(),
  z.object({ type: z.literal('chat.quick-reaction'), requestId, reaction: z.enum(QUICK_REACTIONS) }).strict(),
  z.object({
    type: z.literal('chat.message-reaction'),
    requestId,
    messageId: z.string().uuid(),
    reaction: z.enum(MESSAGE_REACTIONS),
  }).strict(),
  z.object({ type: z.literal('chat.sticker'), requestId, stickerId: z.enum(STICKER_IDS) }).strict(),
  z.object({
    type: z.literal('chat.image'),
    requestId,
    mime: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
    width: z.number().int().min(1).max(MAX_CHAT_IMAGE_DIMENSION),
    height: z.number().int().min(1).max(MAX_CHAT_IMAGE_DIMENSION),
    byteLength: z.number().int().min(1).max(MAX_CHAT_IMAGE_BYTES),
    data: z.string().min(4).max(encodedImageLimit),
  }).strict(),
  z.object({ type: z.literal('presence.ping'), sentAt: z.number().finite() }).strict(),
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
  reconnectDeadline: number | null;
  wantsRematch: boolean;
}

export interface RoomSnapshot {
  roomCode: string;
  version: number;
  phase: RoomPhase;
  board: Cell[];
  turn: Mark;
  winner: Mark | null;
  winningLine: number[] | null;
  isDraw: boolean;
  round: number;
  countdownEndsAt: number | null;
  players: PlayerSnapshot[];
  updatedAt: number;
}

export interface ChatReactionSnapshot {
  reaction: MessageReaction;
  playerIds: string[];
}

interface ChatMessageBase {
  id: string;
  senderId: string;
  createdAt: number;
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
  typing: Array<{ playerId: string; expiresAt: number }>;
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
  | 'INTERNAL_ERROR';

export type ServerMessage =
  | { type: 'server.hello'; connectionId: string; serverTime: number }
  | {
      type: 'session.ready';
      requestId: string;
      roomCode: string;
      playerToken: string;
      playerId: string;
      displayName: string;
      mark: Mark;
      snapshot: RoomSnapshot;
      chat: ChatSnapshot;
    }
  | { type: 'game.snapshot'; snapshot: RoomSnapshot; ackRequestId?: string }
  | { type: 'chat.message'; message: ChatMessageSnapshot; ackRequestId?: string }
  | { type: 'chat.typing'; playerId: string; isTyping: boolean; expiresAt: number | null }
  | { type: 'chat.message-reaction'; messageId: string; reactions: ChatReactionSnapshot[]; ackRequestId?: string }
  | {
      type: 'chat.quick-reaction';
      id: string;
      senderId: string;
      reaction: QuickReaction;
      createdAt: number;
      ackRequestId?: string;
    }
  | { type: 'session.ended'; reason: 'LEFT' | 'EXPIRED' | 'SERVER_SHUTDOWN'; message: string }
  | { type: 'command.rejected'; requestId?: string; code: RejectionCode; message: string }
  | { type: 'server.notice'; code: 'ROOM_EXPIRED'; message: string }
  | { type: 'presence.pong'; sentAt: number; serverTime: number };
