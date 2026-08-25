'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, RoomSnapshot, ServerMessage } from '../../shared/protocol';
import { clearSession, loadSession, savePlayerName, saveSession, type StoredSession } from '../lib/session';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export interface Notice { tone: 'error' | 'info' | 'success'; text: string }

function requestId(): string {
  return crypto.randomUUID();
}

function getWebSocketUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
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

  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<StoredSession | null>(null);
  const snapshotVersionRef = useRef(-1);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);
  const connectRef = useRef<() => void>(() => undefined);
  const pendingRef = useRef<{ requestId: string; baseVersion: number } | null>(null);

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

  const handleMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'session.ready': {
        const nextSession: StoredSession = {
          roomCode: message.roomCode,
          playerToken: message.playerToken,
          playerId: message.playerId,
          mark: message.mark,
        };
        sessionRef.current = nextSession;
        setSession(nextSession);
        saveSession(nextSession);
        setLobbyBusy(false);
        acceptSnapshot(message.snapshot);
        return;
      }
      case 'game.snapshot':
        acceptSnapshot(message.snapshot);
        if (message.ackRequestId && pendingRef.current?.requestId === message.ackRequestId) {
          pendingRef.current = null;
          setPendingMove(false);
        }
        return;
      case 'command.rejected':
        if (!message.requestId || pendingRef.current?.requestId === message.requestId) {
          pendingRef.current = null;
          setPendingMove(false);
        }
        setLobbyBusy(false);
        setNotice({ tone: 'error', text: message.message });
        if (
          (message.code === 'INVALID_SESSION' || message.code === 'ROOM_NOT_FOUND') &&
          sessionRef.current
        ) {
          clearSession();
          sessionRef.current = null;
          snapshotVersionRef.current = -1;
          setSession(null);
          setSnapshot(null);
        }
        return;
      case 'server.notice':
        setNotice({ tone: 'info', text: message.message });
        clearSession();
        sessionRef.current = null;
        snapshotVersionRef.current = -1;
        setSession(null);
        setSnapshot(null);
        return;
      case 'server.hello':
      case 'presence.pong':
        return;
    }
  }, [acceptSnapshot]);

  useEffect(() => {
    stoppedRef.current = false;
    const stored = loadSession();
    sessionRef.current = stored;
    queueMicrotask(() => {
      if (!stoppedRef.current) setSession(stored);
    });

    const connect = () => {
      if (stoppedRef.current) return;
      if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) return;
      setConnection(reconnectAttemptRef.current ? 'reconnecting' : 'connecting');
      const socket = new WebSocket(getWebSocketUrl());
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
        try {
          handleMessage(JSON.parse(String(event.data)) as ServerMessage);
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
    };
  }, [handleMessage]);

  const send = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setNotice({ tone: 'error', text: 'Still reconnecting. Your command was not sent.' });
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const createRoom = useCallback((name: string) => {
    const cleanName = name.trim();
    if (!cleanName) {
      setNotice({ tone: 'error', text: 'Enter your name to create a room.' });
      return;
    }
    setLobbyBusy(true);
    savePlayerName(cleanName);
    if (!send({ type: 'room.create', requestId: requestId(), name: cleanName })) setLobbyBusy(false);
  }, [send]);

  const joinRoom = useCallback((roomCode: string, name: string) => {
    const cleanName = name.trim();
    const cleanCode = roomCode.trim().toUpperCase();
    if (!cleanName || cleanCode.length !== 6) {
      setNotice({ tone: 'error', text: !cleanName ? 'Enter your name to join.' : 'Room codes contain six characters.' });
      return;
    }
    setLobbyBusy(true);
    savePlayerName(cleanName);
    if (!send({ type: 'room.join', requestId: requestId(), roomCode: cleanCode, name: cleanName })) setLobbyBusy(false);
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

  return {
    connection,
    session,
    snapshot,
    notice,
    lobbyBusy,
    pendingMove,
    createRoom,
    joinRoom,
    move,
    voteRematch,
    dismissNotice: () => setNotice(null),
  };
}
