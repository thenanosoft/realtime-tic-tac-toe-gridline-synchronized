import { z } from 'zod';
import type { Cell, Mark } from './game';

export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const requestId = z.string().min(1).max(80);
const playerName = z.string().trim().min(1).max(24);
const roomCode = z.string().trim().toUpperCase().regex(ROOM_CODE_PATTERN);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room.create'), requestId, name: playerName }).strict(),
  z.object({ type: z.literal('room.join'), requestId, roomCode, name: playerName }).strict(),
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
      mark: Mark;
      snapshot: RoomSnapshot;
    }
  | { type: 'game.snapshot'; snapshot: RoomSnapshot; ackRequestId?: string }
  | { type: 'command.rejected'; requestId?: string; code: RejectionCode; message: string }
  | { type: 'server.notice'; code: 'ROOM_EXPIRED'; message: string }
  | { type: 'presence.pong'; sentAt: number; serverTime: number };
