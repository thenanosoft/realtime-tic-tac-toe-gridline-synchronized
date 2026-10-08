'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_HISTORY_LIMIT,
  MAX_CHAT_TEXT_LENGTH,
  PROTOCOL_VERSION,
  ROOM_IMAGE_MEMORY_LIMIT,
  UPLOAD_CHUNK_BYTES,
  type ChatMessageSnapshot,
  type ChatSnapshot,
  type ClientMessage,
  type MessageReaction,
  type QuickReaction,
  type RoomSnapshot,
  type RoomTiming,
  type SealedEnvelope,
  type SeriesTarget,
  type ServerMessage,
  type StickerId,
  type TurnLimitMs,
} from '../../shared/protocol';
import { inspectImage } from '../../shared/imageFormat';
import {
  deriveRoomKey,
  fromBase64,
  generateRoomSecret,
  openBytes,
  openText,
  sealBytes,
  sealText,
} from '../lib/crypto';
import { buildInviteUrl, readInvite, shareInvite, type ShareOutcome } from '../lib/invite';
import { prepareChatImage, ImagePreparationError } from '../lib/images';
import { evaluateServerHello } from '../lib/protocolCompatibility';
import { insertMessage, shouldApplyOverwrite, shouldApplySnapshot } from '../lib/ordering';
import { reconcile, type Speculation } from '../lib/speculation';
import { clearSession, loadSession, saveSession, type StoredSession } from '../lib/session';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export interface Notice { tone: 'error' | 'info' | 'success'; text: string }

type ServerImageMessage = Extract<ChatMessageSnapshot, { kind: 'image' }>;
/**
 * A message this client could not open keeps its place in the transcript.
 *
 * Dropping it would be worse than showing it: the sequence numbers would gain a
 * hole, and a player whose key is wrong would see a conversation that looks
 * complete while half of it is missing. A visible "cannot be read here" is the
 * honest rendering.
 */
type MaybeSealed<T> = T & { undecryptable?: boolean };
export type ClientChatMessage =
  | MaybeSealed<Exclude<ChatMessageSnapshot, { kind: 'image' }>>
  | MaybeSealed<Omit<ServerImageMessage, 'data'> & { objectUrl: string }>;

export interface QuickReactionPopup {
  id: string;
  senderId: string;
  reaction: QuickReaction;
  createdAt: number;
}

function requestId(): string {
  return crypto.randomUUID();
}

/**
 * The single place an outbound frame is serialised.
 *
 * Every command must carry the protocol version. Two paths write to the socket -
 * the `send` helper and the resume issued directly from the open handler - and
 * when those stamped independently the resume silently went out unversioned.
 * The server read that as protocol 1 and refused it, which broke every
 * reconnect. One function, no second path.
 */
function encode(message: ClientMessage): string {
  return JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION });
}

function getWebSocketUrl(): string | null {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  if (window.location.protocol === 'https:' && window.location.hostname.endsWith('.github.io')) return null;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (window.location.port === '3000' || window.location.port === '5173') {
    return `${protocol}//${window.location.hostname}:3001/ws`;
  }
  return `${protocol}//${window.location.host}/ws`;
}

export function useGameSocket() {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [session, setSession] = useState<StoredSession | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [timing, setTiming] = useState<RoomTiming | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lobbyBusy, setLobbyBusy] = useState(false);
  const [fullRoomCode, setFullRoomCode] = useState<string | null>(null);
  /**
   * The move this client is showing but the server has not confirmed.
   *
   * Held in state rather than a ref because the board renders from it. It is
   * cleared the instant the authority speaks - see `settleSpeculation`.
   */
  const [speculation, setSpeculation] = useState<Speculation | null>(null);

  /**
   * True from the moment a socket reopens with a session to resume until the
   * server confirms it. The snapshot held across a reconnect is stale by
   * definition, and presenting it as playable lets both players see an
   * interactive board at once - a violation of INV-1 that the chaos suite
   * surfaced. Marking "connected" on socket open alone is not enough.
   */
  const [resyncing, setResyncing] = useState(false);
  /**
   * Whether *this* window holds the player slot.
   *
   * Opening the same session elsewhere no longer disconnects this one - it stays
   * attached as a read-only view and can claim the slot back (D-002). Starts
   * true so a fresh session is playable before any control message arrives.
   */
  /**
   * Watching rather than playing. Deliberately not folded into `session`: a
   * spectator holds no token and cannot resume, so giving it a session shape
   * would invite code to treat it as one.
   */
  const [spectator, setSpectator] = useState<{ roomCode: string; spectatorId: string; displayName: string } | null>(null);
  const [hasControl, setHasControl] = useState(true);
  const [controlReason, setControlReason] = useState<'GRANTED' | 'DISPLACED' | 'RESUMED' | 'RECLAIMED' | null>(null);
  const [chatMessages, setChatMessages] = useState<ClientChatMessage[]>([]);
  const [typingPlayerId, setTypingPlayerId] = useState<string | null>(null);
  const [quickReactions, setQuickReactions] = useState<QuickReactionPopup[]>([]);
  const [imagePreparing, setImagePreparing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ uploadId: string; received: number; expected: number } | null>(null);
  /**
   * The room secret, held in memory and in the URL fragment and nowhere else.
   *
   * Not in sessionStorage: the fragment already survives a reload, so storing a
   * second copy would only widen the number of places the key can be read from.
   */
  const [roomSecret, setRoomSecret] = useState<string | null>(null);
  /** A private room whose key this window does not hold. */
  const [needsKey, setNeedsKey] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<StoredSession | null>(null);
  // Scoped to the room. A new room legitimately restarts at revision 1, which a
  // bare high-water mark would discard as stale after a long previous session.
  const revisionRef = useRef<{ roomCode: string; revision: number } | null>(null);
  // Chat ordering state. One monotonic stream per room, plus per-subject guards
  // for the events that overwrite state rather than append to it.
  const chatSequenceRef = useRef(0);
  const typingSequenceRef = useRef(new Map<string, number>());
  const reactionSequenceRef = useRef(new Map<string, number>());
  const protocolBlockedRef = useRef(false);
  const lastJoinAttemptRef = useRef<string | null>(null);
  const chaosFactoryRef = useRef<((url: string) => WebSocket) | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);
  const connectRef = useRef<() => void>(() => undefined);

  const speculationRef = useRef<Speculation | null>(null);
  const messageUrlsRef = useRef(new Map<string, string>());
  const typingTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reactionTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const uploadGenerationRef = useRef(0);
  const activeUploadRef = useRef<string | null>(null);
  const secretRef = useRef<string | null>(null);
  /**
   * Exactly one key generation is ever held.
   *
   * This single slot is what makes rotation mean anything: deriving the next
   * generation overwrites the previous CryptoKey, and since derived keys are
   * non-extractable there is no copy of it anywhere else to find (P8-05).
   */
  const keyRef = useRef<{ epoch: number; key: CryptoKey } | null>(null);
  const encryptionRef = useRef<{ enabled: boolean; epoch: number }>({ enabled: false, epoch: 0 });
  const roomCodeRef = useRef<string | null>(null);
  /** A secret generated for a room.create that has not been acknowledged yet. */
  const pendingSecretRef = useRef<string | null>(null);
  const pendingInviteRef = useRef<string | null>(null);

  const roomKey = useCallback(async (epoch: number): Promise<CryptoKey | null> => {
    const secret = secretRef.current;
    const roomCode = roomCodeRef.current;
    if (!secret || !roomCode) return null;
    const held = keyRef.current;
    if (held && held.epoch === epoch) return held.key;
    const key = await deriveRoomKey(secret, roomCode, epoch);
    keyRef.current = { epoch, key };
    return key;
  }, []);

  const revokeMessageUrl = useCallback((messageId: string) => {
    const url = messageUrlsRef.current.get(messageId);
    if (url) URL.revokeObjectURL(url);
    messageUrlsRef.current.delete(messageId);
  }, []);

  const clearPrivateState = useCallback(() => {
    uploadGenerationRef.current += 1;
    chatSequenceRef.current = 0;
    typingSequenceRef.current.clear();
    reactionSequenceRef.current.clear();
    for (const url of messageUrlsRef.current.values()) URL.revokeObjectURL(url);
    messageUrlsRef.current.clear();
    for (const timer of typingTimersRef.current.values()) clearTimeout(timer);
    typingTimersRef.current.clear();
    for (const timer of reactionTimersRef.current.values()) clearTimeout(timer);
    reactionTimersRef.current.clear();
    setChatMessages([]);
    setTypingPlayerId(null);
    setQuickReactions([]);
    setImagePreparing(false);
    setUploadProgress(null);
    activeUploadRef.current = null;
  }, []);

  const toClientMessage = useCallback(async (message: ChatMessageSnapshot): Promise<ClientChatMessage | null> => {
    if (message.kind === 'sticker') return message;
    if (message.kind === 'text') {
      if (!message.sealed) return message;
      const key = await roomKey(message.sealed.epoch);
      if (!key) return { ...message, text: '', undecryptable: true };
      try {
        // The envelope is dropped once the body is open, so nothing downstream
        // can mistake a decrypted message for one still needing a key.
        return { ...message, text: await openText(key, message.text, message.sealed.iv), sealed: undefined };
      } catch {
        return { ...message, text: '', undecryptable: true };
      }
    }

    const { data, sealed, ...metadata } = message;
    let bytes: Uint8Array;
    if (sealed) {
      const key = await roomKey(sealed.epoch);
      if (!key) return { ...metadata, objectUrl: '', undecryptable: true };
      try {
        bytes = await openBytes(key, data, sealed.iv);
      } catch {
        return { ...metadata, objectUrl: '', undecryptable: true };
      }
    } else {
      try {
        bytes = fromBase64(data);
      } catch {
        setNotice({ tone: 'error', text: 'A shared image could not be displayed safely.' });
        return null;
      }
    }

    // The format check runs here, not on the server, and for sealed and plain
    // attachments alike. A server that cannot read ciphertext cannot sniff a
    // magic number either, so this is the only place the claim "this is a PNG
    // of these dimensions" can still be checked against the actual bytes.
    const inspected = inspectImage(bytes);
    if (
      !inspected
      || inspected.mime !== metadata.mime
      || inspected.width !== metadata.width
      || inspected.height !== metadata.height
      || bytes.byteLength !== metadata.byteLength
    ) {
      return { ...metadata, objectUrl: '', undecryptable: true };
    }
    const objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: metadata.mime }));
    messageUrlsRef.current.set(message.id, objectUrl);
    return { ...metadata, objectUrl };
  }, [roomKey]);

  const replaceChat = useCallback((chat: ChatSnapshot) => {
    for (const url of messageUrlsRef.current.values()) URL.revokeObjectURL(url);
    messageUrlsRef.current.clear();
    chatSequenceRef.current = chat.sequence;
    typingSequenceRef.current.clear();
    reactionSequenceRef.current.clear();
    setChatMessages([]);
    // Decryption is asynchronous, so the transcript is rebuilt off the event
    // loop. Ordering survives because messages are placed by sequence rather
    // than by arrival - the same rule that already handled a late message.
    void (async () => {
      const decrypted = await Promise.all(
        [...chat.messages].sort((a, b) => a.sequence - b.sequence).map(toClientMessage),
      );
      setChatMessages(decrypted.filter((message): message is ClientChatMessage => Boolean(message)));
    })();
  }, [toClientMessage]);

  const appendChatMessage = useCallback(async (message: ChatMessageSnapshot) => {
    // Messages are never dropped for being late - only ever placed. A delayed
    // message still belongs in the transcript, at the position its sequence
    // says, which is why ordering here is an insert rather than an append.
    chatSequenceRef.current = Math.max(chatSequenceRef.current, message.sequence);
    const nextMessage = await toClientMessage(message);
    setChatMessages((current) => {
      if (current.some((candidate) => candidate.id === message.id)) return current;
      if (!nextMessage) return current;
      const next = insertMessage(current, nextMessage);
      let imageBytes = next.reduce((total, candidate) => (
        total + (candidate.kind === 'image' ? candidate.byteLength : 0)
      ), 0);
      while (next.length > CHAT_HISTORY_LIMIT || imageBytes > ROOM_IMAGE_MEMORY_LIMIT) {
        const removed = next.shift();
        if (!removed) break;
        if (removed.kind === 'image') {
          imageBytes -= removed.byteLength;
          revokeMessageUrl(removed.id);
        }
      }
      return next;
    });
  }, [revokeMessageUrl, toClientMessage]);

  const updateTyping = useCallback((playerId: string, isTyping: boolean, msRemaining: number | null, sequence: number) => {
    if (playerId === sessionRef.current?.playerId) return;
    // Typing overwrites state rather than appending to it, so a late event must
    // be discarded outright: applying it would resurrect an indicator the sender
    // has already cleared (INV-4).
    if (!shouldApplyOverwrite(typingSequenceRef.current.get(playerId) ?? 0, sequence)) return;
    typingSequenceRef.current.set(playerId, sequence);
    chatSequenceRef.current = Math.max(chatSequenceRef.current, sequence);

    const previousTimer = typingTimersRef.current.get(playerId);
    if (previousTimer) clearTimeout(previousTimer);
    typingTimersRef.current.delete(playerId);
    if (!isTyping || msRemaining === null || msRemaining <= 0) {
      setTypingPlayerId((current) => current === playerId ? null : current);
      return;
    }
    setTypingPlayerId(playerId);
    const timer = setTimeout(() => {
      typingTimersRef.current.delete(playerId);
      setTypingPlayerId((current) => current === playerId ? null : current);
    }, msRemaining + 50);
    typingTimersRef.current.set(playerId, timer);
  }, []);

  /**
   * Removes the overlay and, when the move did not land, says so.
   *
   * Kept in one place so there is exactly one path by which a speculative mark
   * can disappear - INV-2 is a statement about this function.
   */
  const settleSpeculation = useCallback((outcome: 'confirmed' | 'rejected', reason?: string) => {
    if (!speculationRef.current) return;
    speculationRef.current = null;
    setSpeculation(null);
    if (outcome === 'rejected') {
      setNotice({ tone: 'error', text: reason ?? 'That move did not land. The board has been restored.' });
    }
  }, []);

  const acceptSnapshot = useCallback((incoming: RoomSnapshot, incomingTiming: RoomTiming) => {
    // Never apply an update that is not strictly newer than what we hold. A
    // reconnect can deliver a resume snapshot and a live broadcast out of order,
    // and without this an older board would overwrite a newer one (INV-4).
    if (!shouldApplySnapshot(revisionRef.current, incoming)) return;
    revisionRef.current = { roomCode: incoming.roomCode, revision: incoming.revision };
    roomCodeRef.current = incoming.roomCode;
    encryptionRef.current = incoming.encryption;
    setSnapshot(incoming);
    setTiming(incomingTiming);
    // Derived ahead of the first message rather than on demand, so a rotation
    // does not show up as a transcript that decrypts one message late.
    if (incoming.encryption.enabled) void roomKey(incoming.encryption.epoch);
    setNeedsKey(incoming.encryption.enabled && !secretRef.current);

    // The authority has spoken: the overlay is resolved before anything renders,
    // so a rejected mark is never painted alongside a newer board.
    const outstanding = speculationRef.current;
    if (outstanding) {
      const verdict = reconcile(outstanding, incoming);
      if (verdict === 'confirmed') settleSpeculation('confirmed');
      else if (verdict === 'rejected') {
        settleSpeculation('rejected', 'That square was taken first. The board has been restored.');
      }
    }
  }, [roomKey, settleSpeculation]);

  const endLocalSession = useCallback((message: string, tone: Notice['tone'] = 'info') => {
    clearSession();
    sessionRef.current = null;
    revisionRef.current = null;
    setLobbyBusy(false);
    speculationRef.current = null;
    setSpeculation(null);
    setSpectator(null);
    setSession(null);
    setSnapshot(null);
    setTiming(null);
    setResyncing(false);
    setHasControl(true);
    setControlReason(null);
    clearPrivateState();
    // The room is gone, so the key is destroyed and the fragment goes with it.
    // Leaving a dead secret in the address bar buys nothing and keeps it alive
    // in history, in screenshots, and in whatever gets pasted next.
    secretRef.current = null;
    keyRef.current = null;
    roomCodeRef.current = null;
    encryptionRef.current = { enabled: false, epoch: 0 };
    setRoomSecret(null);
    setNeedsKey(false);
    if (typeof window !== 'undefined' && window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setNotice({ tone, text: message });
  }, [clearPrivateState]);

  const handleMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'session.ready': {
        const nextSession: StoredSession = {
          roomCode: message.roomCode,
          playerToken: message.playerToken,
          playerId: message.playerId,
          displayName: message.displayName,
          mark: message.mark,
        };
        sessionRef.current = nextSession;
        roomCodeRef.current = message.roomCode;
        if (pendingSecretRef.current) {
          secretRef.current = pendingSecretRef.current;
          setRoomSecret(pendingSecretRef.current);
          pendingSecretRef.current = null;
        }
        if (secretRef.current && typeof window !== 'undefined') {
          // The invitation becomes the address bar, so a reload still has the
          // key and the player can copy the link from the browser if the share
          // sheet and the clipboard both fail.
          window.history.replaceState(
            null,
            '',
            buildInviteUrl(window.location.href, { roomCode: message.roomCode, secret: secretRef.current }),
          );
        }
        setSession(nextSession);
        saveSession(nextSession);
        setLobbyBusy(false);
        setResyncing(false);
        setHasControl(message.hasControl);
        setControlReason(null);
        acceptSnapshot(message.snapshot, message.timing);
        replaceChat(message.chat);
        setTypingPlayerId(null);
        for (const typing of message.chat.typing) {
          updateTyping(typing.playerId, true, typing.msRemaining, typing.sequence);
        }
        return;
      }
      case 'game.snapshot':
        acceptSnapshot(message.snapshot, message.timing);
        return;
      case 'spectator.ready': {
        setLobbyBusy(false);
        setSpectator({ roomCode: message.roomCode, spectatorId: message.spectatorId, displayName: message.displayName });
        acceptSnapshot(message.snapshot, message.timing);
        return;
      }
      case 'session.control':
        setHasControl(message.hasControl);
        setControlReason(message.reason);
        // A window that just lost the slot may have had a move in flight. It will
        // never be acknowledged now, so release the board rather than leaving it
        // stuck behind a pending command.
        if (!message.hasControl) {
          // A window that no longer holds the slot must not keep showing a mark
          // it can never get confirmed.
          settleSpeculation('rejected', 'Another window took control before that move landed.');
        }
        return;
      case 'chat.message':
        void appendChatMessage(message.message);
        return;
      case 'chat.expired': {
        // Revoked, not just unlinked. Leaving the blob alive would keep the
        // bytes in this browser long after the server released them, which is
        // exactly where an ephemerality claim would quietly become false.
        const ids = new Set(message.messageIds);
        for (const id of ids) revokeMessageUrl(id);
        setChatMessages((current) => current.filter((candidate) => !ids.has(candidate.id)));
        return;
      }
      case 'upload.progress':
        setUploadProgress(
          message.received >= message.expected
            ? null
            : { uploadId: message.uploadId, received: message.received, expected: message.expected },
        );
        return;
      case 'chat.typing':
        updateTyping(message.playerId, message.isTyping, message.msRemaining, message.sequence);
        return;
      case 'chat.message-reaction': {
        // Reaction sets overwrite per message, so staleness is tracked per
        // message rather than against the room-wide stream.
        if (!shouldApplyOverwrite(reactionSequenceRef.current.get(message.messageId) ?? 0, message.sequence)) return;
        reactionSequenceRef.current.set(message.messageId, message.sequence);
        chatSequenceRef.current = Math.max(chatSequenceRef.current, message.sequence);
        setChatMessages((current) => current.map((chatMessage) => (
          chatMessage.id === message.messageId ? { ...chatMessage, reactions: message.reactions } : chatMessage
        )));
        return;
      }
      case 'chat.quick-reaction': {
        chatSequenceRef.current = Math.max(chatSequenceRef.current, message.sequence);
        const popup = { id: message.id, senderId: message.senderId, reaction: message.reaction, createdAt: message.createdAt };
        setQuickReactions((current) => (
          current.some((candidate) => candidate.id === message.id) ? current : [...current, popup].slice(-6)
        ));
        const timer = setTimeout(() => {
          reactionTimersRef.current.delete(message.id);
          setQuickReactions((current) => current.filter((candidate) => candidate.id !== message.id));
        }, 1_000);
        reactionTimersRef.current.set(message.id, timer);
        return;
      }
      case 'command.rejected': {
        setLobbyBusy(false);
        setResyncing(false);
        // A full room is not an error to a would-be watcher: remember the code so
        // the lobby can offer to spectate instead of just saying no.
        if (message.code === 'ROOM_FULL') setFullRoomCode(lastJoinAttemptRef.current);
        // A rejection of the speculative move rolls it back and carries the
        // server's own reason, which is more useful than a generic one. Routed
        // through settleSpeculation so the notice is not raised twice.
        const outstanding = speculationRef.current;
        if (outstanding && message.requestId === outstanding.requestId) {
          settleSpeculation('rejected', message.message);
        } else {
          setNotice({ tone: 'error', text: message.message });
        }
        if ((message.code === 'INVALID_SESSION' || message.code === 'ROOM_NOT_FOUND') && sessionRef.current) {
          endLocalSession(message.message, 'error');
        }
        return;
      }
      case 'session.ended':
        endLocalSession(message.message);
        return;
      case 'server.notice':
        endLocalSession(message.message);
        return;
      case 'server.hello': {
        const verdict = evaluateServerHello(message);
        if (verdict.kind === 'compatible') return;
        if (verdict.kind === 'unsupported-client') {
          // Reconnecting cannot resolve a version mismatch, so stop retrying
          // rather than looping against a server that will never accept us.
          protocolBlockedRef.current = true;
          setConnection('disconnected');
          setNotice({ tone: 'error', text: verdict.message });
          socketRef.current?.close(1000, 'Protocol too old');
          return;
        }
        setNotice({ tone: 'info', text: verdict.message });
        return;
      }
      case 'turn.expired': {
        // Said out loud. The board does not change when a turn runs out, so
        // without this the turn would simply have moved for no visible reason.
        const who = message.playerId === sessionRef.current?.playerId ? 'Your' : 'Their';
        setNotice({ tone: 'info', text: who + ' turn ran out. The move passed to the other side.' });
        return;
      }
      case 'draw.declined':
        setNotice({
          tone: 'info',
          text: message.byPlayerId === sessionRef.current?.playerId
            ? 'You declined the draw. The round continues.'
            : 'They declined the draw. The round continues.',
        });
        return;
      case 'presence.pong':
        return;
    }
  }, [acceptSnapshot, appendChatMessage, endLocalSession, replaceChat, revokeMessageUrl, settleSpeculation, updateTyping]);

  useEffect(() => {
    stoppedRef.current = false;
    const messageUrls = messageUrlsRef.current;
    const typingTimers = typingTimersRef.current;
    const reactionTimers = reactionTimersRef.current;
    const stored = loadSession();
    sessionRef.current = stored;
    // Read before the socket opens, so the key is in hand by the time the first
    // snapshot arrives. A fragment is attacker-supplied text like any other, so
    // readInvite rejects anything that is not shaped like a code and a key.
    const invited = typeof window === 'undefined' ? null : readInvite(window.location.hash);
    if (invited) {
      secretRef.current = invited.secret;
      if (!stored) pendingInviteRef.current = invited.roomCode;
    }
    // Deferred for the same reason the stored session is: setting state in the
    // body of an effect cascades a render before the first one has settled.
    queueMicrotask(() => {
      if (stoppedRef.current) return;
      setSession(stored);
      if (invited) setRoomSecret(invited.secret);
    });

    const connect = () => {
      if (stoppedRef.current || protocolBlockedRef.current) return;
      if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) return;
      setConnection(reconnectAttemptRef.current ? 'reconnecting' : 'connecting');
      const webSocketUrl = getWebSocketUrl();
      if (!webSocketUrl) {
        setConnection('disconnected');
        setNotice({ tone: 'info', text: 'The production realtime endpoint has not been configured yet.' });
        return;
      }
      const socket = chaosFactoryRef.current
        ? chaosFactoryRef.current(webSocketUrl)
        : new WebSocket(webSocketUrl);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        reconnectAttemptRef.current = 0;
        setConnection('connected');
        setNotice((current) => current?.tone === 'error' ? current : null);
        if (sessionRef.current) {
          setResyncing(true);
          socket.send(encode({
            type: 'session.resume',
            requestId: requestId(),
            roomCode: sessionRef.current.roomCode,
            playerToken: sessionRef.current.playerToken,
          }));
        }
        // An invite is acted on once. Re-joining on every reconnect would fight
        // the resume path, which is the mechanism that actually belongs here.
        const invited = pendingInviteRef.current;
        if (!sessionRef.current && invited) {
          pendingInviteRef.current = null;
          lastJoinAttemptRef.current = invited;
          setLobbyBusy(true);
          socket.send(encode({ type: 'room.join', requestId: requestId(), roomCode: invited }));
        }
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(encode({ type: 'presence.ping', sentAt: Date.now() }));
          }
        }, 20_000);
      });

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          setNotice({ tone: 'error', text: 'The server sent an unsupported binary response.' });
          return;
        }
        try {
          handleMessage(JSON.parse(event.data) as ServerMessage);
        } catch {
          setNotice({ tone: 'error', text: 'The server sent an unreadable response.' });
        }
      });

      socket.addEventListener('close', (event) => {
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
        if (socketRef.current === socket) socketRef.current = null;
        if (stoppedRef.current) return;
        if (protocolBlockedRef.current) return;
        if (event.code === 4001) {
          setConnection('disconnected');
          setNotice({ tone: 'info', text: 'This session was resumed in another window.' });
          return;
        }
        setConnection('reconnecting');
        // The speculative mark is deliberately left standing across a drop. The
        // move may well have reached the server, and the resume snapshot will
        // settle it correctly either way; clearing it here would flicker a mark
        // off and straight back on for every brief reconnect. If the socket
        // never comes back, the five-second timeout takes it off.
        const delay = Math.min(8_000, 500 * 2 ** reconnectAttemptRef.current) + Math.random() * 250;
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = setTimeout(() => connectRef.current(), delay);
      });

      socket.addEventListener('error', () => {
        // Browsers intentionally hide WebSocket details; close drives retry state.
      });
    };

    connectRef.current = connect;

    // The NODE_ENV comparison is inlined at build time, so in a production build
    // this whole branch becomes `if (false && ...)` and the minifier removes it
    // along with the dynamic import - which is how the chaos transport is kept
    // out of the shipped bundle rather than merely disabled inside it. Keeping
    // the condition at the call site matters: behind a helper function the
    // minifier cannot prove the branch is dead, and the chunk survives.
    if (
      process.env.NODE_ENV !== 'production'
      && typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('chaos') === '1'
    ) {
      void import('../lib/chaos')
        .then(({ createChaosSocket, readChaosOptions }) => {
          const options = readChaosOptions(window.location.search);
          if (options) chaosFactoryRef.current = (url) => createChaosSocket(url, options);
        })
        .catch(() => undefined)
        .finally(() => connect());
    } else {
      connect();
    }
    return () => {
      stoppedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      socketRef.current?.close(1000, 'Page closed');
      socketRef.current = null;
      for (const url of messageUrls.values()) URL.revokeObjectURL(url);
      messageUrls.clear();
      for (const timer of typingTimers.values()) clearTimeout(timer);
      typingTimers.clear();
      for (const timer of reactionTimers.values()) clearTimeout(timer);
      reactionTimers.clear();
    };
  }, [handleMessage]);

  const send = useCallback((message: ClientMessage, quiet = false): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (!quiet) setNotice({ tone: 'error', text: 'Still reconnecting. Your command was not sent.' });
      return false;
    }
    // Every command is stamped, not just the handshake, so the protocol is
    // self-describing frame by frame rather than only at connection time.
    socket.send(encode(message));
    return true;
  }, []);

  const createRoom = useCallback((options: { encrypted?: boolean } = {}) => {
    setLobbyBusy(true);
    // Generated here, before the room exists, and never sent. The server is
    // told only that bodies will be sealed (P8-01).
    const secret = options.encrypted ? generateRoomSecret() : null;
    pendingSecretRef.current = secret;
    if (!send({ type: 'room.create', requestId: requestId(), encrypted: Boolean(secret) })) {
      pendingSecretRef.current = null;
      setLobbyBusy(false);
    }
  }, [send]);

  const joinRoom = useCallback((roomCode: string) => {
    const cleanCode = roomCode.trim().toUpperCase();
    if (cleanCode.length !== 6) {
      setNotice({ tone: 'error', text: 'Room codes contain six characters.' });
      return;
    }
    setLobbyBusy(true);
    lastJoinAttemptRef.current = cleanCode;
    setFullRoomCode(null);
    if (!send({ type: 'room.join', requestId: requestId(), roomCode: cleanCode })) setLobbyBusy(false);
  }, [send]);

  const move = useCallback((cell: number) => {
    if (!snapshot || speculationRef.current) return;
    // The mark comes from the snapshot, not the stored session: a rematch swaps
    // marks without reissuing session.ready, so the stored one goes stale.
    const mark = snapshot.players.find((player) => player.id === sessionRef.current?.playerId)?.mark;
    if (!mark) return;

    const id = requestId();
    // Sent before anything is shown. `send` is synchronous, so this costs no
    // perceptible time, and it means a failed send never leaves a mark on the
    // board with nothing in flight to resolve it.
    if (!send({ type: 'game.move', requestId: id, cell, expectedRevision: snapshot.revision })) return;

    const optimistic: Speculation = {
      requestId: id,
      roomCode: snapshot.roomCode,
      cell,
      mark,
      baseRevision: snapshot.revision,
    };
    speculationRef.current = optimistic;
    setSpeculation(optimistic);
    // If the server never answers at all - a dropped frame, a dead socket - the
    // overlay must still come off. Silence is not confirmation.
    setTimeout(() => {
      if (speculationRef.current?.requestId === id) {
        settleSpeculation('rejected', 'The server did not confirm that move. The board has been restored.');
      }
    }, 5_000);
  }, [send, settleSpeculation, snapshot]);

  const voteRematch = useCallback(() => {
    send({ type: 'rematch.vote', requestId: requestId() });
  }, [send]);

  const setMatchFormat = useCallback((format: { seriesTarget?: SeriesTarget; turnLimitMs?: TurnLimitMs | null }) => {
    send({ type: 'room.format', requestId: requestId(), ...format });
  }, [send]);

  const offerDraw = useCallback(() => {
    send({ type: 'draw.offer', requestId: requestId() });
  }, [send]);

  const respondToDraw = useCallback((accept: boolean) => {
    send({ type: 'draw.respond', requestId: requestId(), accept });
  }, [send]);

  const claimControl = useCallback(() => {
    send({ type: 'session.claim', requestId: requestId() });
  }, [send]);

  const spectateRoom = useCallback((roomCode: string) => {
    const clean = roomCode.trim().toUpperCase();
    if (clean.length !== 6) return;
    setLobbyBusy(true);
    if (!send({ type: 'room.spectate', requestId: requestId(), roomCode: clean })) setLobbyBusy(false);
  }, [send]);

  const setSpectatorChat = useCallback((allowed: boolean) => {
    send({ type: 'room.policy', requestId: requestId(), spectatorChat: allowed });
  }, [send]);

  const sendChatMessage = useCallback(async (text: string): Promise<boolean> => {
    const normalized = text.trim();
    if (!normalized) return false;
    // The plaintext bound is applied here because after sealing nobody can
    // measure it - the server sees only ciphertext, and a ciphertext limit
    // would be a limit on the wrong number.
    if (normalized.length > MAX_CHAT_TEXT_LENGTH) {
      setNotice({ tone: 'error', text: `Messages can contain up to ${MAX_CHAT_TEXT_LENGTH} characters.` });
      return false;
    }
    const encryption = encryptionRef.current;
    if (!encryption.enabled) {
      return send({ type: 'chat.message', requestId: requestId(), text: normalized });
    }
    const key = await roomKey(encryption.epoch);
    if (!key) {
      setNotice({ tone: 'error', text: 'This private room needs its invite link before you can send messages.' });
      return false;
    }
    const { body, iv } = await sealText(key, normalized);
    return send({
      type: 'chat.message',
      requestId: requestId(),
      text: body,
      sealed: { iv, epoch: encryption.epoch },
    });
  }, [roomKey, send]);

  const setTyping = useCallback((typing: boolean) => {
    send({ type: 'chat.typing', typing }, true);
  }, [send]);

  const sendSticker = useCallback((stickerId: StickerId) => {
    return send({ type: 'chat.sticker', requestId: requestId(), stickerId });
  }, [send]);

  const sendQuickReaction = useCallback((reaction: QuickReaction) => {
    return send({ type: 'chat.quick-reaction', requestId: requestId(), reaction });
  }, [send]);

  const toggleMessageReaction = useCallback((messageId: string, reaction: MessageReaction) => {
    return send({ type: 'chat.message-reaction', requestId: requestId(), messageId, reaction });
  }, [send]);

  const sendImage = useCallback(async (file: File): Promise<boolean> => {
    const generation = ++uploadGenerationRef.current;
    const playerId = sessionRef.current?.playerId;
    setImagePreparing(true);
    try {
      const prepared = await prepareChatImage(file);
      if (generation !== uploadGenerationRef.current || playerId !== sessionRef.current?.playerId) return false;

      // Bounded frames rather than one giant payload: a 1.5MB image used to go
      // out as a single WebSocket message, which the server had to accept whole
      // before it could judge it.
      const uploadId = crypto.randomUUID();
      // Sealed before chunking, not per chunk: one authentication tag over the
      // whole image means a truncated or reordered upload fails to open rather
      // than decrypting into a partial picture.
      const encryption = encryptionRef.current;
      let payload = prepared.data;
      let sealed: SealedEnvelope | undefined;
      if (encryption.enabled) {
        const key = await roomKey(encryption.epoch);
        if (!key) {
          setNotice({ tone: 'error', text: 'This private room needs its invite link before you can share an image.' });
          return false;
        }
        const result = await sealBytes(key, fromBase64(prepared.data));
        payload = result.body;
        sealed = { iv: result.iv, epoch: encryption.epoch };
      }
      const chunkCount = Math.max(1, Math.ceil(payload.length / UPLOAD_CHUNK_BYTES));
      activeUploadRef.current = uploadId;
      const opened = send({
        type: 'chat.image.begin',
        requestId: requestId(),
        uploadId,
        mime: prepared.mime,
        width: prepared.width,
        height: prepared.height,
        byteLength: prepared.byteLength,
        chunks: chunkCount,
        sealed,
      });
      if (!opened) {
        activeUploadRef.current = null;
        return false;
      }
      for (let index = 0; index < chunkCount; index += 1) {
        // A cancel between chunks stops the send immediately rather than
        // finishing the upload and discarding it afterwards.
        if (activeUploadRef.current !== uploadId) return false;
        const slice = payload.slice(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES);
        if (!send({ type: 'chat.image.chunk', uploadId, index, data: slice })) {
          activeUploadRef.current = null;
          return false;
        }
      }
      activeUploadRef.current = null;
      return true;
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof ImagePreparationError ? error.message : 'The image could not be prepared.',
      });
      return false;
    } finally {
      if (generation === uploadGenerationRef.current) setImagePreparing(false);
    }
  }, [roomKey, send]);

  const cancelUpload = useCallback(() => {
    const uploadId = activeUploadRef.current;
    activeUploadRef.current = null;
    uploadGenerationRef.current += 1;
    setUploadProgress(null);
    setImagePreparing(false);
    if (uploadId) send({ type: 'chat.image.cancel', uploadId }, true);
  }, [send]);

  const leaveRoom = useCallback(() => {
    send({ type: 'room.leave', requestId: requestId() });
  }, [send]);

  const roomCode = session?.roomCode ?? spectator?.roomCode ?? null;
  const inviteUrl = roomCode && typeof window !== 'undefined'
    ? buildInviteUrl(window.location.href, { roomCode, secret: roomSecret })
    : null;

  const shareInviteLink = useCallback(async (): Promise<ShareOutcome> => {
    if (!inviteUrl) return 'manual';
    return shareInvite(inviteUrl, {
      // Capability detection rather than user-agent sniffing, and the invite URL
      // is handed over untouched: a share target that re-encodes it is exactly
      // how a fragment gets lost.
      share: typeof navigator !== 'undefined' && typeof navigator.share === 'function'
        ? (data) => navigator.share(data)
        : undefined,
      copy: typeof navigator !== 'undefined' && navigator.clipboard
        ? (text) => navigator.clipboard.writeText(text)
        : undefined,
    });
  }, [inviteUrl]);

  return {
    connection,
    session,
    snapshot,
    timing,
    spectator,
    spectateRoom,
    setSpectatorChat,
    speculation,
    resyncing,
    hasControl,
    controlReason,
    claimControl,
    notice,
    lobbyBusy,
    fullRoomCode,
    chatMessages,
    typingPlayerId,
    quickReactions,
    imagePreparing,
    uploadProgress,
    cancelUpload,
    createRoom,
    joinRoom,
    move,
    voteRematch,
    setMatchFormat,
    offerDraw,
    respondToDraw,
    sendChatMessage,
    setTyping,
    sendSticker,
    sendQuickReaction,
    toggleMessageReaction,
    sendImage,
    leaveRoom,
    encrypted: snapshot?.encryption.enabled ?? false,
    keyEpoch: snapshot?.encryption.epoch ?? 0,
    needsKey,
    inviteUrl,
    shareInviteLink,
    dismissNotice: () => setNotice(null),
  };
}
