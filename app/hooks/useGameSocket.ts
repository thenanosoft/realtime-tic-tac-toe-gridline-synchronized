'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_HISTORY_LIMIT,
  MAX_CHAT_TEXT_LENGTH,
  ROOM_IMAGE_MEMORY_LIMIT,
  type ChatMessageSnapshot,
  type ClientMessage,
  type MessageReaction,
  type QuickReaction,
  type RoomSnapshot,
  type ServerMessage,
  type StickerId,
} from '../../shared/protocol';
import { prepareChatImage, ImagePreparationError } from '../lib/images';
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
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lobbyBusy, setLobbyBusy] = useState(false);
  const [pendingMove, setPendingMove] = useState(false);
  const [chatMessages, setChatMessages] = useState<ClientChatMessage[]>([]);
  const [typingPlayerId, setTypingPlayerId] = useState<string | null>(null);
  const [quickReactions, setQuickReactions] = useState<QuickReactionPopup[]>([]);
  const [imagePreparing, setImagePreparing] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<StoredSession | null>(null);
  const snapshotVersionRef = useRef(-1);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);
  const connectRef = useRef<() => void>(() => undefined);
  const pendingRef = useRef<{ requestId: string; baseVersion: number } | null>(null);
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

  const replaceChat = useCallback((messages: ChatMessageSnapshot[]) => {
    for (const url of messageUrlsRef.current.values()) URL.revokeObjectURL(url);
    messageUrlsRef.current.clear();
    setChatMessages(messages.map(toClientMessage).filter((message): message is ClientChatMessage => Boolean(message)));
  }, [toClientMessage]);

  const appendChatMessage = useCallback((message: ChatMessageSnapshot) => {
    setChatMessages((current) => {
      if (current.some((candidate) => candidate.id === message.id)) return current;
      const nextMessage = toClientMessage(message);
      if (!nextMessage) return current;
      const next = [...current, nextMessage];
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

  const updateTyping = useCallback((playerId: string, isTyping: boolean, expiresAt: number | null) => {
    if (playerId === sessionRef.current?.playerId) return;
    const previousTimer = typingTimersRef.current.get(playerId);
    if (previousTimer) clearTimeout(previousTimer);
    typingTimersRef.current.delete(playerId);
    if (!isTyping || !expiresAt || expiresAt <= Date.now()) {
      setTypingPlayerId((current) => current === playerId ? null : current);
      return;
    }
    setTypingPlayerId(playerId);
    const timer = setTimeout(() => {
      typingTimersRef.current.delete(playerId);
      setTypingPlayerId((current) => current === playerId ? null : current);
    }, Math.max(0, expiresAt - Date.now()) + 50);
    typingTimersRef.current.set(playerId, timer);
  }, []);

  const acceptSnapshot = useCallback((incoming: RoomSnapshot) => {
    if (incoming.version < snapshotVersionRef.current) return;
    snapshotVersionRef.current = incoming.version;
    setSnapshot(incoming);
    const pending = pendingRef.current;
    if (pending && incoming.version > pending.baseVersion) {
      pendingRef.current = null;
      setPendingMove(false);
    }
  }, []);

  const endLocalSession = useCallback((message: string, tone: Notice['tone'] = 'info') => {
    clearSession();
    sessionRef.current = null;
    snapshotVersionRef.current = -1;
    pendingRef.current = null;
    setPendingMove(false);
    setLobbyBusy(false);
    setSession(null);
    setSnapshot(null);
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
        acceptSnapshot(message.snapshot);
        replaceChat(message.chat.messages);
        setTypingPlayerId(null);
        for (const typing of message.chat.typing) updateTyping(typing.playerId, true, typing.expiresAt);
        return;
      }
      case 'game.snapshot':
        acceptSnapshot(message.snapshot);
        if (message.ackRequestId && pendingRef.current?.requestId === message.ackRequestId) {
          pendingRef.current = null;
          setPendingMove(false);
        }
        return;
      case 'chat.message':
        appendChatMessage(message.message);
        return;
      case 'chat.typing':
        updateTyping(message.playerId, message.isTyping, message.expiresAt);
        return;
      case 'chat.message-reaction':
        setChatMessages((current) => current.map((chatMessage) => (
          chatMessage.id === message.messageId ? { ...chatMessage, reactions: message.reactions } : chatMessage
        )));
        return;
      case 'chat.quick-reaction': {
        const popup = { id: message.id, senderId: message.senderId, reaction: message.reaction, createdAt: message.createdAt };
        setQuickReactions((current) => [...current, popup].slice(-6));
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
      case 'server.hello':
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
      if (stoppedRef.current) return;
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
    socket.send(JSON.stringify(message));
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
    if (send({ type: 'game.move', requestId: id, cell, expectedVersion: snapshot.version })) {
      pendingRef.current = { requestId: id, baseVersion: snapshot.version };
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
