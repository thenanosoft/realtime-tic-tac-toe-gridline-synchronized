'use client';

import { useEffect, useRef, useState } from 'react';
import type { MessageReaction, QuickReaction, RoomSnapshot, RoomTiming, StickerId } from '../../shared/protocol';
import type { StoredSession } from '../lib/session';
import type { ClientChatMessage, ConnectionState, QuickReactionPopup } from '../hooks/useGameSocket';
import { PlayerCard } from './PlayerCard';
import { GameBoard } from './GameBoard';
import { GameStatus } from './GameStatus';
import { Countdown } from './Countdown';
import { useGameSound } from '../hooks/useGameSound';
import { ChatPanel } from './ChatPanel';

interface GameRoomProps {
  snapshot: RoomSnapshot;
  timing: RoomTiming | null;
  session: StoredSession;
  connection: ConnectionState;
  pendingMove: boolean;
  resyncing: boolean;
  hasControl: boolean;
  onClaimControl(): void;
  onMove(cell: number): void;
  onRematch(): void;
  playSound: ReturnType<typeof useGameSound>['play'];
  chatMessages: ClientChatMessage[];
  typingPlayerId: string | null;
  quickReactions: QuickReactionPopup[];
  imagePreparing: boolean;
  onSendText(text: string): boolean;
  onTyping(typing: boolean): void;
  onSticker(stickerId: StickerId): boolean;
  onQuickReaction(reaction: QuickReaction): boolean;
  onMessageReaction(messageId: string, reaction: MessageReaction): boolean;
  onImage(file: File): Promise<boolean>;
  onLeave(): void;
}

export function GameRoom({
  snapshot,
  timing,
  session,
  connection,
  pendingMove,
  resyncing,
  hasControl,
  onClaimControl,
  onMove,
  onRematch,
  playSound,
  chatMessages,
  typingPlayerId,
  quickReactions,
  imagePreparing,
  onSendText,
  onTyping,
  onSticker,
  onQuickReaction,
  onMessageReaction,
  onImage,
  onLeave,
}: GameRoomProps) {
  const [copied, setCopied] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const previousRef = useRef<RoomSnapshot | null>(null);
  const lastChatIdRef = useRef<string | null>(null);
  const xPlayer = snapshot.players.find((player) => player.mark === 'X');
  const oPlayer = snapshot.players.find((player) => player.mark === 'O');
  const self = snapshot.players.find((player) => player.id === session.playerId);
  // `connection === 'connected'` alone is not sufficient: it flips the instant
  // the socket opens, while the board still holds whatever was true before the
  // drop. Until the server confirms the resumed session, this snapshot is stale.
  const canMove = connection === 'connected'
    && !resyncing
    && hasControl
    && snapshot.phase === 'active'
    && snapshot.turn === self?.mark
    && !pendingMove;
  const sceneState = snapshot.winner
    ? `winner-${snapshot.winner.toLowerCase()}`
    : snapshot.isDraw
      ? 'balanced'
      : snapshot.phase === 'active'
        ? `turn-${snapshot.turn.toLowerCase()}`
        : snapshot.phase;

  useEffect(() => {
    const previous = previousRef.current;
    if (previous) {
      const previousCount = previous.board.filter(Boolean).length;
      const currentCount = snapshot.board.filter(Boolean).length;
      if (currentCount > previousCount) {
        const placed = snapshot.board.find((cell, index) => cell && !previous.board[index]);
        playSound(placed === 'X' ? 'moveX' : 'moveO');
      }
      if (previous.phase === 'countdown' && snapshot.phase === 'active') playSound('start');
      if (previous.phase !== 'game_over' && snapshot.phase === 'game_over') {
        playSound(snapshot.winner === self?.mark ? 'win' : 'draw');
      }
    }
    previousRef.current = snapshot;
  }, [playSound, self?.mark, snapshot]);

  useEffect(() => {
    if (!window.matchMedia('(min-width: 1121px)').matches) return;
    const frame = requestAnimationFrame(() => setChatOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const last = chatMessages.at(-1);
    if (!last) return;
    if (lastChatIdRef.current === null) {
      lastChatIdRef.current = last.id;
      return;
    }
    if (last.id === lastChatIdRef.current) return;
    lastChatIdRef.current = last.id;
    if (!chatOpen && last.senderId !== session.playerId) {
      const frame = requestAnimationFrame(() => setUnread((current) => current + 1));
      return () => cancelAnimationFrame(frame);
    }
  }, [chatMessages, chatOpen, session.playerId]);

  const openChat = () => {
    setChatOpen(true);
    setUnread(0);
  };

  const copyCode = async () => {
    const invite = new URL(window.location.href);
    invite.searchParams.set('room', snapshot.roomCode);
    const invitation = invite.toString();
    try {
      await navigator.clipboard.writeText(invitation);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    } catch {
      const input = document.createElement('input');
      input.value = invitation;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    }
  };

  return (
    <section className={`room-shell scene-${sceneState} ${chatOpen ? 'chat-open' : ''} ${hasControl ? '' : 'is-readonly'}`}>
      {!hasControl && (
        // Said in words, not implied by a dead board. The window is still fully
        // live - it just is not the one holding the slot (D-002).
        <div className="control-banner" role="status">
          <span aria-hidden="true">⌁</span>
          <p>
            <strong>Another window has control of this session.</strong>
            This view stays live, but moves and messages come from there.
          </p>
          <button className="claim-control" onClick={onClaimControl}>Take control here</button>
        </div>
      )}
      <div className="arena-light light-x" aria-hidden="true" />
      <div className="arena-light light-o" aria-hidden="true" />
      <div className="room-stage">
        <div className="room-heading">
          <div>
            <span className="room-kicker">PRIVATE SIGNAL · ROUND {String(snapshot.round).padStart(2, '0')}</span>
            <h1>Room <b>{snapshot.roomCode}</b></h1>
          </div>
          <div className="room-actions">
            <button className={`chat-toggle ${unread ? 'has-unread' : ''}`} onClick={openChat} aria-expanded={chatOpen} aria-controls="private-chat">
              <span aria-hidden="true">⌁</span>
              <span className="btn-label">Chat</span>
              {unread > 0 && <b aria-label={`${unread} unread messages`}>{unread}</b>}
            </button>
            <button className={`copy-room ${copied ? 'copied' : ''}`} onClick={copyCode} aria-label={`Copy invitation link for room ${snapshot.roomCode}`}>
              <span className="copy-icon" aria-hidden="true" />{copied ? 'Copied' : 'Copy invite'}
            </button>
            <button
              className="leave-room"
              onClick={() => { if (window.confirm('Leave this room? Your opponent keeps the room and can invite someone else.')) onLeave(); }}
              disabled={connection !== 'connected' || !hasControl}
              aria-label="Leave this room"
            >×</button>
          </div>
        </div>

        <div className="arena">
          <div className="arena-axis" aria-hidden="true"><i /><span>SHARED PLANE</span><i /></div>
          <div className="player-x-area"><PlayerCard mark="X" player={xPlayer} isSelf={xPlayer?.id === session.playerId} snapshot={snapshot} /></div>
          <div className="board-area">
            <div className="board-frame">
              <div className="board-meta"><span>01 / SERVER-AUTHORITATIVE</span><span>SYNC {String(snapshot.revision).padStart(3, '0')}</span></div>
              <GameBoard snapshot={snapshot} myMark={self?.mark ?? session.mark} interactive={canMove} onMove={onMove} />
              {snapshot.phase === 'countdown' && timing?.countdownMsRemaining != null && (
                <Countdown msRemaining={timing.countdownMsRemaining} revision={snapshot.revision} />
              )}
              {pendingMove && <div className="move-pending"><span /> Confirming move</div>}
              <div className="reaction-popups" aria-live="polite">
                {quickReactions.map((reaction) => {
                  const mark = snapshot.players.find((player) => player.id === reaction.senderId)?.mark ?? 'X';
                  return <span key={reaction.id} className={`reaction-popup reaction-${mark.toLowerCase()}`}>{reaction.reaction}</span>;
                })}
              </div>
            </div>
            <GameStatus snapshot={snapshot} session={session} onRematch={onRematch} />
          </div>
          <div className="player-o-area"><PlayerCard mark="O" player={oPlayer} isSelf={oPlayer?.id === session.playerId} snapshot={snapshot} /></div>
        </div>
      </div>
      <div id="private-chat">
        <ChatPanel
          open={chatOpen}
          unread={unread}
          messages={chatMessages}
          players={snapshot.players}
          selfId={session.playerId}
          connected={connection === 'connected'}
          typingPlayerId={typingPlayerId}
          imagePreparing={imagePreparing}
          onClose={() => setChatOpen(false)}
          onSendText={onSendText}
          onTyping={onTyping}
          onSticker={onSticker}
          onQuickReaction={onQuickReaction}
          onMessageReaction={onMessageReaction}
          onImage={onImage}
        />
      </div>
    </section>
  );
}
