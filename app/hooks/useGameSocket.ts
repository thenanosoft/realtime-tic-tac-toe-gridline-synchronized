'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_HISTORY_LIMIT,
  MAX_CHAT_TEXT_LENGTH,
  PROTOCOL_VERSION,
  ROOM_IMAGE_MEMORY_LIMIT,
  type ChatMessageSnapshot,
  type ChatSnapshot,
  type ClientMessage,
  type MessageReaction,
  type QuickReaction,
  type RoomSnapshot,
  type RoomTiming,
  type ServerMessage,
  type StickerId,
} from '../../shared/protocol';
import { prepareChatImage, ImagePreparationError } from '../lib/images';
import { evaluateServerHello } from '../lib/protocolCompatibility';
import { clearSession, loadSession, saveSession, type StoredSession } from '../lib/session';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export interface Notice { tone: 'error' | 'info' | 'success'; text: string }

type ServerImageMessage = Extract<ChatMessageSnapshot, { kind: 'image' }>;
export type ClientChatMessage =
  | Exclude<ChatMessageSnapshot, { kind: 'image' }>
  | (Omit<ServerImageMessage, 'data'> & { objectUrl: string });

export interface QuickReactionPopup {
  id: string;
  senderId: string;
  reaction: QuickReaction;
  createdAt: number;
}

function requestId(): string {
  return crypto.randomUUID();
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
  const [pendingMove, setPendingMove] = useState(false);
  const [chatMessages, setChatMessages] = useState<ClientChatMessage[]>([]);
  const [typingPlayerId, setTypingPlayerId] = useState<string | null>(null);
  const [quickReactions, setQuickReactions] = useState<QuickReactionPopup[]>([]);
  const [imagePreparing, setImagePreparing] = useState(false);

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
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);
  const connectRef = useRef<() => void>(() => undefined);
  const pendingRef = useRef<{ requestId: string; baseRevision: number } | null>(null);
  const messageUrlsRef = useRef(new Map<string, string>());
  const typingTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reactionTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const uploadGenerationRef = useRef(0);

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
  }, []);

  const toClientMessage = useCallback((message: ChatMessageSnapshot): ClientChatMessage | null => {
    if (message.kind !== 'image') return message;
    try {
      const binary = atob(message.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: message.mime }));
      messageUrlsRef.current.set(message.id, objectUrl);
      const { data: _discarded, ...metadata } = message;
      void _discarded;
      return { ...metadata, objectUrl };
    } catch {
      setNotice({ tone: 'error', text: 'A shared image could not be displayed safely.' });
      return null;
    }
  }, []);

  const replaceChat = useCallback((chat: ChatSnapshot) => {
    for (const url of messageUrlsRef.current.values()) URL.revokeObjectURL(url);
    messageUrlsRef.current.clear();
    chatSequenceRef.current = chat.sequence;
    typingSequenceRef.current.clear();
    reactionSequenceRef.current.clear();
    setChatMessages(
      [...chat.messages]
        .sort((a, b) => a.sequence - b.sequence)
        .map(toClientMessage)
        .filter((message): message is ClientChatMessage => Boolean(message)),
    );
  }, [toClientMessage]);

  const appendChatMessage = useCallback((message: ChatMessageSnapshot) => {
    // Messages are never dropped for being late - only ever placed. A delayed
    // message still belongs in the transcript, at the position its sequence
    // says, which is why ordering here is an insert rather than an append.
    chatSequenceRef.current = Math.max(chatSequenceRef.current, message.sequence);
    setChatMessages((current) => {
      if (current.some((candidate) => candidate.id === message.id)) return current;
      const nextMessage = toClientMessage(message);
      if (!nextMessage) return current;
      const next = [...current, nextMessage].sort((a, b) => a.sequence - b.sequence);
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
    const lastSequence = typingSequenceRef.current.get(playerId) ?? 0;
    if (sequence <= lastSequence) return;
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

  const acceptSnapshot = useCallback((incoming: RoomSnapshot, incomingTiming: RoomTiming) => {
    // Never apply an update that is not strictly newer than what we hold. A
    // reconnect can deliver a resume snapshot and a live broadcast out of order,
    // and without this an older board would overwrite a newer one (INV-4).
    const current = revisionRef.current;
    if (current && current.roomCode === incoming.roomCode && incoming.revision <= current.revision) return;
    revisionRef.current = { roomCode: incoming.roomCode, revision: incoming.revision };
    setSnapshot(incoming);
    setTiming(incomingTiming);
    const pending = pendingRef.current;
    if (pending && incoming.revision > pending.baseRevision) {
      pendingRef.current = null;
      setPendingMove(false);
    }
  }, []);

  const endLocalSession = useCallback((message: string, tone: Notice['tone'] = 'info') => {
    clearSession();
    sessionRef.current = null;
    revisionRef.current = null;
    pendingRef.current = null;
    setPendingMove(false);
    setLobbyBusy(false);
    setSession(null);
    setSnapshot(null);
    setTiming(null);
    clearPrivateState();
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
        setSession(nextSession);
        saveSession(nextSession);
        setLobbyBusy(false);
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
        if (message.ackRequestId && pendingRef.current?.requestId === message.ackRequestId) {
          pendingRef.current = null;
          setPendingMove(false);
        }
        return;
      case 'chat.message':
        appendChatMessage(message.message);
        return;
      case 'chat.typing':
        updateTyping(message.playerId, message.isTyping, message.msRemaining, message.sequence);
        return;
      case 'chat.message-reaction': {
        // Reaction sets overwrite per message, so staleness is tracked per
        // message rather than against the room-wide stream.
        const lastSequence = reactionSequenceRef.current.get(message.messageId) ?? 0;
        if (message.sequence <= lastSequence) return;
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
      case 'command.rejected':
        if (!message.requestId || pendingRef.current?.requestId === message.requestId) {
          pendingRef.current = null;
          setPendingMove(false);
        }
        setLobbyBusy(false);
        setNotice({ tone: 'error', text: message.message });
        if ((message.code === 'INVALID_SESSION' || message.code === 'ROOM_NOT_FOUND') && sessionRef.current) {
          endLocalSession(message.message, 'error');
        }
        return;
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
      case 'presence.pong':
        return;
    }
  }, [acceptSnapshot, appendChatMessage, endLocalSession, replaceChat, updateTyping]);

  useEffect(() => {
    stoppedRef.current = false;
    const messageUrls = messageUrlsRef.current;
    const typingTimers = typingTimersRef.current;
    const reactionTimers = reactionTimersRef.current;
    const stored = loadSession();
    sessionRef.current = stored;
    queueMicrotask(() => {
      if (!stoppedRef.current) setSession(stored);
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
      const socket = new WebSocket(webSocketUrl);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        reconnectAttemptRef.current = 0;
        setConnection('connected');
        setNotice((current) => current?.tone === 'error' ? current : null);
        if (sessionRef.current) {
          socket.send(JSON.stringify({
            type: 'session.resume',
            requestId: requestId(),
            roomCode: sessionRef.current.roomCode,
            playerToken: sessionRef.current.playerToken,
          } satisfies ClientMessage));
        }
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'presence.ping', sentAt: Date.now() } satisfies ClientMessage));
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
        pendingRef.current = null;
        setPendingMove(false);
        const delay = Math.min(8_000, 500 * 2 ** reconnectAttemptRef.current) + Math.random() * 250;
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = setTimeout(() => connectRef.current(), delay);
      });

      socket.addEventListener('error', () => {
        // Browsers intentionally hide WebSocket details; close drives retry state.
      });
    };

    connectRef.current = connect;
    connect();
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
    socket.send(JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION }));
    return true;
  }, []);

  const createRoom = useCallback(() => {
    setLobbyBusy(true);
    if (!send({ type: 'room.create', requestId: requestId() })) setLobbyBusy(false);
  }, [send]);

  const joinRoom = useCallback((roomCode: string) => {
    const cleanCode = roomCode.trim().toUpperCase();
    if (cleanCode.length !== 6) {
      setNotice({ tone: 'error', text: 'Room codes contain six characters.' });
      return;
    }
    setLobbyBusy(true);
    if (!send({ type: 'room.join', requestId: requestId(), roomCode: cleanCode })) setLobbyBusy(false);
  }, [send]);

  const move = useCallback((cell: number) => {
    if (!snapshot || pendingRef.current) return;
    const id = requestId();
    if (send({ type: 'game.move', requestId: id, cell, expectedRevision: snapshot.revision })) {
      pendingRef.current = { requestId: id, baseRevision: snapshot.revision };
      setPendingMove(true);
      setTimeout(() => {
        if (pendingRef.current?.requestId === id) {
          pendingRef.current = null;
          setPendingMove(false);
          setNotice({ tone: 'error', text: 'The server did not confirm that move. The board was not changed.' });
        }
      }, 5_000);
    }
  }, [send, snapshot]);

  const voteRematch = useCallback(() => {
    send({ type: 'rematch.vote', requestId: requestId() });
  }, [send]);

  const sendChatMessage = useCallback((text: string): boolean => {
    const normalized = text.trim();
    if (!normalized) return false;
    if (normalized.length > MAX_CHAT_TEXT_LENGTH) {
      setNotice({ tone: 'error', text: `Messages can contain up to ${MAX_CHAT_TEXT_LENGTH} characters.` });
      return false;
    }
    return send({ type: 'chat.message', requestId: requestId(), text: normalized });
  }, [send]);

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
      return send({ type: 'chat.image', requestId: requestId(), ...prepared });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof ImagePreparationError ? error.message : 'The image could not be prepared.',
      });
      return false;
    } finally {
      if (generation === uploadGenerationRef.current) setImagePreparing(false);
    }
  }, [send]);

  const leaveRoom = useCallback(() => {
    send({ type: 'room.leave', requestId: requestId() });
  }, [send]);

  return {
    connection,
    session,
    snapshot,
    timing,
    notice,
    lobbyBusy,
    pendingMove,
    chatMessages,
    typingPlayerId,
    quickReactions,
    imagePreparing,
    createRoom,
    joinRoom,
    move,
    voteRematch,
    sendChatMessage,
    setTyping,
    sendSticker,
    sendQuickReaction,
    toggleMessageReaction,
    sendImage,
    leaveRoom,
    dismissNotice: () => setNotice(null),
  };
}
