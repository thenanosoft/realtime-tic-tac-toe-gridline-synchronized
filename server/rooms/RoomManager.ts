import { randomBytes, randomUUID } from 'node:crypto';
import { applyMove, createInitialGame, GameRuleError, type EngineState, type Mark } from '../../shared/game';
import type { RoomPhase, RoomSnapshot, ServerMessage } from '../../shared/protocol';
import { CommandError } from '../errors';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
  seenRequests: Set<string>;
}

interface Room {
  code: string;
  players: Map<string, Player>;
  game: EngineState;
  phase: RoomPhase;
  pausedFrom: 'countdown' | 'active' | null;
  rematchVotes: Set<string>;
  version: number;
  round: number;
  countdownEndsAt: number | null;
  createdAt: number;
  updatedAt: number;
  startTimer: ReturnType<typeof setTimeout> | null;
}

export interface RoomManagerOptions {
  countdownMs?: number;
  reconnectGraceMs?: number;
  emptyRoomTtlMs?: number;
  reservationTtlMs?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
}

export interface SessionResult {
  roomCode: string;
  playerToken: string;
  playerId: string;
  mark: Mark;
  snapshot: RoomSnapshot;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly connectionIndex = new Map<string, { roomCode: string; playerId: string }>();
  private readonly countdownMs: number;
  private readonly reconnectGraceMs: number;
  private readonly emptyRoomTtlMs: number;
  private readonly reservationTtlMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(options: RoomManagerOptions = {}) {
    this.countdownMs = options.countdownMs ?? 2_600;
    this.reconnectGraceMs = options.reconnectGraceMs ?? 15_000;
    this.emptyRoomTtlMs = options.emptyRoomTtlMs ?? 60_000;
    this.reservationTtlMs = options.reservationTtlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.cleanupTimer = setInterval(
      () => this.sweep(),
      options.cleanupIntervalMs ?? 15_000,
    );
    this.cleanupTimer.unref?.();
  }

  createRoom(name: string, peer: Peer): SessionResult {
    if (this.connectionIndex.has(peer.id)) {
      throw new CommandError('ALREADY_IN_ROOM', 'This connection already belongs to a room.');
    }
    const code = this.generateRoomCode();
    const player = this.createPlayer(name, 'X', peer);
    const timestamp = this.now();
    const room: Room = {
      code,
      players: new Map([[player.id, player]]),
      game: createInitialGame(),
      phase: 'waiting',
      pausedFrom: null,
      rematchVotes: new Set(),
      version: 1,
      round: 1,
      countdownEndsAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startTimer: null,
    };
    this.rooms.set(code, room);
    this.connectionIndex.set(peer.id, { roomCode: code, playerId: player.id });
    return this.sessionResult(room, player);
  }

  joinRoom(code: string, name: string, peer: Peer): SessionResult {
    if (this.connectionIndex.has(peer.id)) {
      throw new CommandError('ALREADY_IN_ROOM', 'This connection already belongs to a room.');
    }
    const room = this.requireRoom(code);
    if (room.players.size >= 2) {
      throw new CommandError('ROOM_FULL', 'This room already has two players.');
    }
    const player = this.createPlayer(name, 'O', peer);
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
    if (!player) {
      throw new CommandError('INVALID_SESSION', 'This player session is no longer valid.');
    }

    if (player.peer && player.peer.id !== peer.id) {
      this.connectionIndex.delete(player.peer.id);
      player.peer.close(4001, 'Session resumed in another window');
    }
    player.peer = peer;
    player.connected = true;
    player.reconnectDeadline = null;
    this.connectionIndex.set(peer.id, { roomCode: room.code, playerId: player.id });

    if (room.phase === 'paused' && this.allPlayersConnected(room)) {
      if (room.pausedFrom === 'countdown') {
        this.beginCountdown(room);
      } else {
        room.phase = 'active';
        room.pausedFrom = null;
        this.bump(room);
      }
    } else {
      this.bump(room);
    }
    return this.sessionResult(room, player);
  }

  move(peerId: string, requestId: string, cell: number, expectedVersion: number): void {
    const { room, player } = this.requireMembership(peerId);
    if (player.seenRequests.has(requestId)) {
      player.peer?.send({ type: 'game.snapshot', snapshot: this.snapshot(room), ackRequestId: requestId });
      return;
    }
    if (expectedVersion !== room.version) {
      player.peer?.send({ type: 'game.snapshot', snapshot: this.snapshot(room) });
      throw new CommandError('STALE_STATE', 'The room changed before that move arrived. The latest board has been restored.');
    }
    if (room.phase !== 'active') {
      throw new CommandError(
        room.game.winner || room.game.isDraw ? 'GAME_COMPLETE' : 'GAME_NOT_ACTIVE',
        room.phase === 'paused' ? 'The match is paused while a player reconnects.' : 'The match is not active yet.',
      );
    }
    if (!this.allPlayersConnected(room)) {
      throw new CommandError('OPPONENT_OFFLINE', 'Wait for your opponent to reconnect.');
    }
    try {
      room.game = applyMove(room.game, player.mark, cell);
    } catch (error) {
      if (error instanceof GameRuleError) {
        throw new CommandError(error.code, error.message);
      }
      throw error;
    }
    this.remember(player, requestId);
    if (room.game.winner || room.game.isDraw) {
      room.phase = 'game_over';
    }
    this.bump(room);
    this.broadcast(room, requestId);
  }

  voteRematch(peerId: string, requestId: string): void {
    const { room, player } = this.requireMembership(peerId);
    if (player.seenRequests.has(requestId)) {
      player.peer?.send({ type: 'game.snapshot', snapshot: this.snapshot(room), ackRequestId: requestId });
      return;
    }
    if (room.phase !== 'game_over' && room.phase !== 'rematch_waiting') {
      throw new CommandError('GAME_NOT_ACTIVE', 'A rematch can only be requested after the game.');
    }
    this.remember(player, requestId);
    if (room.rematchVotes.has(player.id)) {
      player.peer?.send({ type: 'game.snapshot', snapshot: this.snapshot(room), ackRequestId: requestId });
      return;
    }
    room.rematchVotes.add(player.id);

    if (room.rematchVotes.size === 2 && this.allPlayersConnected(room)) {
      const players = [...room.players.values()];
      for (const candidate of players) {
        candidate.mark = candidate.mark === 'X' ? 'O' : 'X';
        candidate.seenRequests.clear();
      }
      room.game = createInitialGame();
      room.round += 1;
      room.rematchVotes.clear();
      this.beginCountdown(room);
    } else {
      room.phase = 'rematch_waiting';
      this.bump(room);
    }
    this.broadcast(room, requestId);
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
    if (room.phase === 'countdown' || room.phase === 'active') {
      room.pausedFrom = room.phase;
      room.phase = 'paused';
      room.countdownEndsAt = null;
      this.clearStartTimer(room);
    }
    this.bump(room);
    this.broadcast(room);
  }

  touch(peerId: string): void {
    const indexed = this.connectionIndex.get(peerId);
    const room = indexed ? this.rooms.get(indexed.roomCode) : null;
    if (room) room.updatedAt = this.now();
  }

  broadcastForPeer(peerId: string): void {
    const { room } = this.requireMembership(peerId);
    this.broadcast(room);
  }

  getSnapshotForPeer(peerId: string): RoomSnapshot {
    return this.snapshot(this.requireMembership(peerId).room);
  }

  get size(): number {
    return this.rooms.size;
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    for (const room of this.rooms.values()) this.clearStartTimer(room);
    this.rooms.clear();
    this.connectionIndex.clear();
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
      this.broadcast(room);
    }, this.countdownMs);
    room.startTimer.unref?.();
  }

  private broadcast(room: Room, ackRequestId?: string): void {
    const message: ServerMessage = { type: 'game.snapshot', snapshot: this.snapshot(room), ackRequestId };
    for (const player of room.players.values()) player.peer?.send(message);
  }

  private snapshot(room: Room): RoomSnapshot {
    return {
      roomCode: room.code,
      version: room.version,
      phase: room.phase,
      board: [...room.game.board],
      turn: room.game.turn,
      winner: room.game.winner,
      winningLine: room.game.winningLine ? [...room.game.winningLine] : null,
      isDraw: room.game.isDraw,
      round: room.round,
      countdownEndsAt: room.countdownEndsAt,
      players: [...room.players.values()]
        .sort((a, b) => a.mark.localeCompare(b.mark))
        .map((player) => ({
          id: player.id,
          name: player.name,
          mark: player.mark,
          connected: player.connected,
          reconnectDeadline: player.reconnectDeadline,
          wantsRematch: room.rematchVotes.has(player.id),
        })),
      updatedAt: room.updatedAt,
    };
  }

  private sessionResult(room: Room, player: Player): SessionResult {
    return {
      roomCode: room.code,
      playerToken: player.token,
      playerId: player.id,
      mark: player.mark,
      snapshot: this.snapshot(room),
    };
  }

  private createPlayer(name: string, mark: Mark, peer: Peer): Player {
    return {
      id: randomUUID(),
      token: `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
      name: name.trim().slice(0, 24),
      mark,
      connected: true,
      reconnectDeadline: null,
      peer,
      seenRequests: new Set(),
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

  private allPlayersConnected(room: Room): boolean {
    return room.players.size === 2 && [...room.players.values()].every((player) => player.connected);
  }

  private bump(room: Room): void {
    room.version += 1;
    room.updatedAt = this.now();
  }

  private remember(player: Player, requestId: string): void {
    player.seenRequests.add(requestId);
    if (player.seenRequests.size > 64) {
      const oldest = player.seenRequests.values().next().value;
      if (oldest) player.seenRequests.delete(oldest);
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
    for (const room of this.rooms.values()) {
      const players = [...room.players.values()];
      const allOffline = players.every((player) => !player.connected);
      const offlineTooLong = players.some(
        (player) => !player.connected && player.reconnectDeadline !== null && timestamp - player.reconnectDeadline > this.reservationTtlMs,
      );
      if ((allOffline && timestamp - room.updatedAt >= this.emptyRoomTtlMs) || offlineTooLong) {
        for (const player of players) {
          player.peer?.send({ type: 'server.notice', code: 'ROOM_EXPIRED', message: 'This inactive room has expired.' });
          player.peer?.close(4004, 'Room expired');
          if (player.peer) this.connectionIndex.delete(player.peer.id);
        }
        this.clearStartTimer(room);
        this.rooms.delete(room.code);
      }
    }
  }
}
