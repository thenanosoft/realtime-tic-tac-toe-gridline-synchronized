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
 * 3 - a player slot and a connection become separate things: several windows may
 *     attach to one player, exactly one holds control, and presence becomes a
 *     four-state machine rather than a boolean. Adds `session.claim`,
 *     `session.control`, and host identity.
 * 4 - capabilities: a connection is a player or a spectator, and every command is
 *     authorised against that rather than against membership alone. Adds
 *     `room.spectate`, `room.policy` and `spectator.ready`.
 * 5 - images move in bounded chunks with acknowledgements, timeouts and
 *     cancellation, and attachment memory is budgeted per room and per process.
 *     Adds `chat.image.begin`, `chat.image.chunk`, `chat.image.cancel` and
 *     `upload.progress`.
 * 6 - chat bodies may arrive sealed. A `sealed` envelope carries the AES-GCM IV
 *     and the key generation; when it is present the `text` or image `data` is
 *     ciphertext the server cannot read, and the snapshot says which generation
 *     is current. Adds `room.create.encrypted`.
 * 7 - the match gains depth, all of it server-authoritative: a best-of series
 *     with the score on the server, an optional turn limit enforced by the
 *     server rather than counted by the client, a draw offer, and the move
 *     history a replay is built from. Adds `room.format`, `draw.offer`,
 *     `draw.respond`, `turn.expired` and `draw.declined`.
 * 8 - a room is a place with an audience rather than a pair with onlookers.
 *     Watchers can ask to play, the host seats them, and the player they
 *     replace becomes a watcher. Chat carries its sender's name and role, so a
 *     four-person conversation is readable. Adds `room.request-play`,
 *     `room.withdraw-play` and `room.seat`.
 *
 * GitHub Pages and Render deploy independently, so a version skew window always
 * exists. The server therefore keeps accepting MIN_SUPPORTED_CLIENT_PROTOCOL for
 * one release cycle rather than cutting old clients off mid-match, and clients
 * compare against `server.hello` to tell the player to refresh.
 */
export const PROTOCOL_VERSION = 8;
/**
 * Raised to 2 in this release, deliberately.
 *
 * A v1 client cannot play against this server whatever we do - it sends
 * `expectedVersion`, which the schema stopped accepting in v2 - so it would join
 * happily and then fail on its first move with a confusing MALFORMED_MESSAGE.
 * Refusing it at the door with PROTOCOL_MISMATCH and a "refresh" message is the
 * honest behaviour. A v2 client, by contrast, is still fully served: every v2
 * command remains valid in v3.
 */
export const MIN_SUPPORTED_CLIENT_PROTOCOL = 7;
export const LEGACY_CLIENT_PROTOCOL = 1;

export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
export const MAX_CHAT_TEXT_LENGTH = 1_000;
export const MAX_CHAT_IMAGE_BYTES = 1_500_000;
export const MAX_CHAT_IMAGE_SOURCE_BYTES = 8_000_000;
export const MAX_CHAT_IMAGE_DIMENSION = 1_600;
export const CHAT_HISTORY_LIMIT = 80;
/**
 * Attachment memory budgets.
 *
 * A room refuses an upload that would cross its ceiling rather than silently
 * evicting an older image (D-006): a picture vanishing from the conversation
 * with no explanation reads as data loss, while a refusal can be acted on.
 */
export const ROOM_IMAGE_MEMORY_LIMIT = 10_000_000;
export const PROCESS_IMAGE_MEMORY_LIMIT = 50_000_000;

/** Bounded frames rather than one giant payload. */
export const UPLOAD_CHUNK_BYTES = 64_000;
/** An upload with no activity for this long is abandoned and its buffer freed. */
export const UPLOAD_IDLE_TIMEOUT_MS = 20_000;
/**
 * Optional lifetime for chat content even inside a live room. Off by default;
 * the host turns it on.
 */
export const CONTENT_EXPIRY_MS = 5 * 60_000;
/**
 * Ciphertext is longer than its plaintext: AES-GCM adds a 16-byte tag, and
 * base64 adds a third again on top. A sealed body therefore needs its own
 * ceiling. The plaintext bound is applied by the sender before sealing and
 * re-checked by the server for unsealed messages only - the server cannot
 * measure the length of something it cannot read.
 */
export const MAX_SEALED_TEXT_LENGTH = 6_000;
/**
 * Series lengths, and the turn limits a host may choose.
 *
 * Enumerated rather than free numbers so the server is not in the business of
 * deciding whether 1.5 seconds is a reasonable turn. A limit short enough to
 * be unplayable is a way to grief an opponent.
 */
export const SERIES_TARGETS = [1, 3, 5] as const;
export const TURN_LIMITS_MS = [15_000, 30_000] as const;
export type SeriesTarget = (typeof SERIES_TARGETS)[number];
export type TurnLimitMs = (typeof TURN_LIMITS_MS)[number];

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

/**
 * What the server is told about a sealed body, which is everything except how
 * to read it.
 *
 * The IV must be unique per message under a given key, so it is generated fresh
 * for every seal and travels in the clear - that is what an IV is for. `epoch`
 * names the key generation, so a client that has rotated can say that a message
 * predates its current key instead of failing to decrypt it and guessing why.
 */
const sealedSchema = z.object({
  iv: z.string().min(16).max(24),
  epoch: z.number().int().min(0).max(100_000),
}).strict();

export const clientMessageSchema = z.discriminatedUnion('type', [
  // `encrypted` is a declaration, not a key exchange. The server records that
  // bodies in this room are ciphertext and which generation is current; the key
  // itself is derived on each client from a secret that exists only in the URL
  // fragment (P8-01).
  z.object({ type: z.literal('room.create'), requestId, encrypted: z.boolean().optional(), ...envelope }).strict(),
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
  /**
   * Match format, set by the host. Both fields are optional so one can be
   * changed without restating the other, which keeps a client that only knows
   * about one of them from silently resetting the other.
   */
  z.object({
    type: z.literal('room.format'),
    requestId,
    seriesTarget: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
    turnLimitMs: z.union([z.literal(15_000), z.literal(30_000), z.null()]).optional(),
    ...envelope,
  }).strict(),
  z.object({ type: z.literal('draw.offer'), requestId, ...envelope }).strict(),
  /** A watcher asking for the next seat, and changing their mind. */
  z.object({ type: z.literal('room.request-play'), requestId, ...envelope }).strict(),
  z.object({ type: z.literal('room.withdraw-play'), requestId, ...envelope }).strict(),
  /**
   * The host seating a watcher. Identified by spectator id rather than by name:
   * names are generated and readable, which makes them good for a person to
   * choose by and bad for a command to be addressed with.
   */
  z.object({ type: z.literal('room.seat'), requestId, spectatorId: z.string().uuid(), ...envelope }).strict(),
  z.object({ type: z.literal('draw.respond'), requestId, accept: z.boolean(), ...envelope }).strict(),
  // "Take control here": moves the player slot to this connection. A separate
  // command rather than a client-side toggle, because two windows can race for
  // the slot and the loser has to be told it lost (D-002).
  z.object({ type: z.literal('session.claim'), requestId, ...envelope }).strict(),
  z.object({ type: z.literal('room.spectate'), requestId, roomCode, ...envelope }).strict(),
  z.object({ type: z.literal('room.policy'), requestId, spectatorChat: z.boolean(), expireContent: z.boolean().optional(), ...envelope }).strict(),
  // Chunked upload. The whole image never exists as a single frame on the wire.
  z.object({
    type: z.literal('chat.image.begin'),
    requestId,
    uploadId: z.string().uuid(),
    mime: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
    width: z.number().int().min(1).max(MAX_CHAT_IMAGE_DIMENSION),
    height: z.number().int().min(1).max(MAX_CHAT_IMAGE_DIMENSION),
    byteLength: z.number().int().min(1).max(MAX_CHAT_IMAGE_BYTES),
    chunks: z.number().int().min(1).max(2_000),
    sealed: sealedSchema.optional(),
    ...envelope,
  }).strict(),
  z.object({
    type: z.literal('chat.image.chunk'),
    uploadId: z.string().uuid(),
    index: z.number().int().min(0).max(1_999),
    data: z.string().min(1).max(UPLOAD_CHUNK_BYTES * 2),
    ...envelope,
  }).strict(),
  z.object({ type: z.literal('chat.image.cancel'), uploadId: z.string().uuid(), ...envelope }).strict(),
  z.object({
    type: z.literal('chat.message'),
    requestId,
    text: z.string().min(1).max(MAX_SEALED_TEXT_LENGTH),
    sealed: sealedSchema.optional(),
    ...envelope,
  }).strict(),
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

/**
 * Server-authoritative presence. The client renders this; it never derives it.
 *
 * online        at least one window is attached
 * reconnecting  no window attached, still inside the reconnect grace period
 * offline       grace elapsed, but the slot is still reserved by token
 * expired       the reservation has lapsed and the slot is gone
 */
export type PresenceState = 'online' | 'reconnecting' | 'offline' | 'expired';

export interface PlayerSnapshot {
  id: string;
  name: string;
  mark: Mark;
  presence: PresenceState;
  /**
   * How many windows or devices are attached to this player. Exactly one of
   * them holds control; the rest are read-only views (D-002).
   */
  connectionCount: number;
  isHost: boolean;
  wantsRematch: boolean;
}

/**
 * What a connection may do. Decided by the server, never asserted by the client.
 * Room-scoped and ephemeral - there are no accounts behind these.
 */
export type Capability = 'player' | 'spectator';

/**
 * The score, held by the server because the client must not be the authority on
 * who is winning.
 *
 * Keyed by player id rather than by mark: marks swap on every rematch, so a
 * score kept against a mark would change hands with it.
 */
export interface SeriesSnapshot {
  /** Rounds needed to win. 1 means a single game with no series at all. */
  target: SeriesTarget;
  scores: Array<{ playerId: string; wins: number }>;
  draws: number;
  /** Set once a player has taken the series; null while it is still open. */
  decidedBy: string | null;
}

export interface DrawOfferSnapshot {
  byPlayerId: string;
  /** The round it was made in, so an offer cannot outlive its game. */
  round: number;
}

/** A watcher who has asked for the next seat (P13-07). */
export interface PlayRequestSnapshot {
  spectatorId: string;
  name: string;
}

export interface SpectatorPolicy {
  /**
   * Spectators receive no chat at all by default. Withholding it on the wire
   * rather than hiding it in the UI is what separates a policy from a
   * suggestion.
   */
  chat: boolean;
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
  /**
   * What is left of the current turn, as a duration.
   *
   * A duration rather than a deadline for the same reason the countdown is: the
   * client renders it against its own monotonic clock, so a wrong wall clock
   * cannot make a turn look longer or shorter than the server will enforce
   * (INV-11). The server is the only thing that decides when time is up.
   */
  turnMsRemaining: number | null;
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
  /** How many people are watching without holding a slot. */
  spectatorCount: number;
  spectatorPolicy: SpectatorPolicy;
  /** When true, chat content disappears after CONTENT_EXPIRY_MS even in a live room. */
  contentExpiry: boolean;
  /** Attachment bytes this room currently holds, against its budget. */
  attachmentBytes: number;
  encryption: RoomEncryption;
  series: SeriesSnapshot;
  /** Null when the host has not set a turn limit. */
  turnLimitMs: TurnLimitMs | null;
  drawOffer: DrawOfferSnapshot | null;
  /**
   * Watchers asking to play, oldest first. Visible to everyone rather than to
   * the host alone: a room is a shared place, and hiding who has put their
   * hand up would make the host's choice look arbitrary to the people in it.
   */
  playRequests: PlayRequestSnapshot[];
  /**
   * This round's moves in order, which is what a replay is built from. Held in
   * the snapshot rather than reconstructed by the client so a player who joined
   * late or reconnected can still replay the round they just watched.
   */
  moves: Array<{ cell: number; mark: Mark }>;
}

/** Travels with a sealed body. The server stores it and forwards it, unread. */
export interface SealedEnvelope {
  /** Base64 96-bit AES-GCM nonce, unique to this message. */
  iv: string;
  /** Which key generation sealed it. */
  epoch: number;
}

/**
 * Whether this room's chat bodies are ciphertext, and which key generation is
 * current.
 *
 * Note what is absent: there is no key here, and no field from which one could
 * be derived. The epoch is a label both clients agree on, not a secret - each
 * derives generation `n` from the room secret it already holds, so rotation
 * needs no exchange and the server has nothing to leak.
 */
export interface RoomEncryption {
  enabled: boolean;
  epoch: number;
}

export interface ChatReactionSnapshot {
  reaction: MessageReaction;
  playerIds: string[];
}

interface ChatMessageBase {
  id: string;
  senderId: string;
  /**
   * Resolved by the server when the message is stored, not looked up by the
   * client (P13-09). With watchers in the conversation the sender may not be in
   * the player list at all - and a player who has since been seated out would
   * otherwise have their earlier messages lose their name.
   */
  senderName: string;
  senderRole: Capability;
  createdAt: number;
  /**
   * Server-assigned position in the room's single chat event stream. Messages
   * are ordered by this, never by `createdAt` and never by arrival order.
   */
  sequence: number;
  reactions: ChatReactionSnapshot[];
}

export type ChatMessageSnapshot =
  | (ChatMessageBase & { kind: 'text'; text: string; sealed?: SealedEnvelope })
  | (ChatMessageBase & { kind: 'sticker'; stickerId: StickerId })
  | (ChatMessageBase & {
      kind: 'image';
      sealed?: SealedEnvelope;
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
  /** The room or the process has no attachment memory left. */
  | 'MEMORY_BUDGET'
  | 'UPLOAD_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PROTOCOL_MISMATCH'
  /** This window is attached but another one holds the player slot. */
  | 'NOT_IN_CONTROL'
  /** The connection lacks the capability this command requires. */
  | 'FORBIDDEN'
  | 'ROOM_NOT_FULL'
  /** Seating someone cannot happen in the middle of a round. */
  | 'ROUND_IN_PROGRESS'
  /** The command is for a watcher and this connection is a player, or absent. */
  | 'NOT_WATCHING'
  /** A draw response arrived with no offer outstanding. */
  | 'NO_DRAW_OFFER'
  /** The match format cannot be changed once the series is under way. */
  | 'FORMAT_LOCKED'
  /** A sealed body was sent to a plain room, or a plain body to a sealed one. */
  | 'ENCRYPTION_MISMATCH'
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
      /** Whether *this* connection holds the player slot, not whether one exists. */
      hasControl: boolean;
      snapshot: RoomSnapshot;
      timing: RoomTiming;
      chat: ChatSnapshot;
    }
  | {
      /** A watcher's equivalent of session.ready: no token, no mark, no slot. */
      type: 'spectator.ready';
      requestId: string;
      roomCode: string;
      spectatorId: string;
      displayName: string;
      capability: 'spectator';
      snapshot: RoomSnapshot;
      timing: RoomTiming;
    }
  | {
      /**
       * Per-connection, never broadcast: control is a property of a socket, not
       * of the room. Sent when this window gains or loses the player slot.
       */
      type: 'session.control';
      hasControl: boolean;
      reason: 'GRANTED' | 'DISPLACED' | 'RESUMED' | 'RECLAIMED';
      connectionCount: number;
      ackRequestId?: string;
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
  | {
      /** Content that has aged out. Clients drop these ids and revoke their blobs. */
      type: 'chat.expired';
      messageIds: string[];
      sequence: number;
    }
  | {
      /**
       * Per-chunk acknowledgement. The sender learns how much actually landed,
       * so a stalled upload is visible rather than silently pending.
       */
      type: 'upload.progress';
      uploadId: string;
      received: number;
      expected: number;
    }
  | {
      /**
       * A turn that ran out. The board is unchanged and the turn has passed;
       * this exists so the player is told that rather than left wondering why
       * it is suddenly not their move.
       */
      type: 'turn.expired';
      playerId: string;
      round: number;
    }
  | {
      /** Acceptance shows up as a drawn board; a decline needs saying. */
      type: 'draw.declined';
      byPlayerId: string;
      ackRequestId?: string;
    }
  | { type: 'presence.pong'; sentAt: number; serverTime: number };
