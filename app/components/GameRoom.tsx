'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  MessageReaction,
  QuickReaction,
  RoomSnapshot,
  RoomTiming,
  SeriesTarget,
  StickerId,
  TurnLimitMs,
} from '../../shared/protocol';
import { canPlay, type Speculation } from '../lib/speculation';
import { deriveArena } from '../../shared/identityArt';
import { REACTION_SIZE, reactionPath } from '../lib/reactionPath';
import type { Cell, Mark } from '../../shared/game';
import type { Capability } from '../../shared/protocol';
import type { ClientChatMessage, ConnectionState, QuickReactionPopup } from '../hooks/useGameSocket';
import { PlayerCard } from './PlayerCard';
import { GameBoard } from './GameBoard';
import { GameStatus } from './GameStatus';
import { Countdown } from './Countdown';
import { TurnClock } from './TurnClock';
import { MatchPanel } from './MatchPanel';
import { useGameSound } from '../hooks/useGameSound';
import { ChatPanel } from './ChatPanel';
import { InvitePanel } from './InvitePanel';
import type { ShareOutcome } from '../lib/invite';

interface GameRoomProps {
  snapshot: RoomSnapshot;
  timing: RoomTiming | null;
  /** The player id, or the spectator id when watching. */
  viewerId: string;
  /** Board orientation when this viewer holds no mark of their own. */
  fallbackMark: Mark;
  capability: Capability;
  onSpectatorChat(allowed: boolean): void;
  connection: ConnectionState;
  resyncing: boolean;
  speculation: Speculation | null;
  hasControl: boolean;
  onClaimControl(): void;
  onMove(cell: number): void;
  onRematch(): void;
  onFormat(format: { seriesTarget?: SeriesTarget; turnLimitMs?: TurnLimitMs | null }): void;
  onOfferDraw(): void;
  onRespondToDraw(accept: boolean): void;
  playSound: ReturnType<typeof useGameSound>['play'];
  chatMessages: ClientChatMessage[];
  typingPlayerId: string | null;
  quickReactions: QuickReactionPopup[];
  imagePreparing: boolean;
  onSendText(text: string): Promise<boolean>;
  onTyping(typing: boolean): void;
  onSticker(stickerId: StickerId): boolean;
  onQuickReaction(reaction: QuickReaction): boolean;
  onMessageReaction(messageId: string, reaction: MessageReaction): boolean;
  onImage(file: File): Promise<boolean>;
  onLeave(): void;
  inviteUrl: string | null;
  onShareInvite(): Promise<ShareOutcome>;
  /** A private room whose key this window does not hold. */
  needsKey: boolean;
}

export function GameRoom({
  snapshot,
  timing,
  viewerId,
  fallbackMark,
  capability,
  onSpectatorChat,
  connection,
  resyncing,
  speculation,
  hasControl,
  onClaimControl,
  onMove,
  onRematch,
  onFormat,
  onOfferDraw,
  onRespondToDraw,
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
  inviteUrl,
  onShareInvite,
  needsKey,
}: GameRoomProps) {
  const [chatOpen, setChatOpen] = useState(false);
  /** How many of the round's moves the replay has shown; null when idle. */
  const [replayStep, setReplayStep] = useState<number | null>(null);
  const [unread, setUnread] = useState(0);
  const previousRef = useRef<RoomSnapshot | null>(null);
  const lastChatIdRef = useRef<string | null>(null);
  const xPlayer = snapshot.players.find((player) => player.mark === 'X');
  const oPlayer = snapshot.players.find((player) => player.mark === 'O');
  const self = snapshot.players.find((player) => player.id === viewerId);
  // Every condition that gates acting lives in one pure function, shared with
  // the chaos simulation. `connected` alone is not enough: it flips the instant
  // the socket opens, while the board still holds whatever was true before the
  // drop; and an outstanding speculation must block a second move, or a player
  // could place two marks against a board the server has not confirmed.
  const watching = capability === 'spectator';
  const host = snapshot.players.find((player) => player.isHost);
  const isHost = host?.id === viewerId;
  const canMove = !watching && canPlay({
    connected: connection === 'connected',
    resyncing,
    hasControl,
    snapshot,
    mark: self?.mark,
    speculation,
  });
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
    if (!chatOpen && last.senderId !== viewerId) {
      const frame = requestAnimationFrame(() => setUnread((current) => current + 1));
      return () => cancelAnimationFrame(frame);
    }
  }, [chatMessages, chatOpen, viewerId]);

  /**
   * Replay is derived, not stored.
   *
   * The condition includes the phase, so a replay cannot outlive the round it
   * belongs to: if the room moves on - a rematch, or a reconnect that lands a
   * new board - the replay stops being true and the live board returns with
   * nothing to unwind. An effect that cleared the step would have had to race
   * the snapshot that invalidated it.
   */
  /**
   * Arena variation from both names, so the room belongs to the match rather
   * than to whoever opened it. Bounded hard in deriveArena: the brief is
   * subtle, and the tempting change later is to widen the ranges until two
   * rooms stop looking like one product.
   */
  const arena = useMemo(
    () => deriveArena(snapshot.players.map((player) => player.name)),
    [snapshot.players],
  );

  const replayable = snapshot.phase === 'game_over' || snapshot.phase === 'rematch_waiting';
  const replaying = replayable && replayStep !== null && replayStep <= snapshot.moves.length;
  const replayBoard = useMemo(() => {
    if (!replaying || replayStep === null) return null;
    const cells = Array<Cell>(9).fill(null);
    for (const move of snapshot.moves.slice(0, replayStep)) cells[move.cell] = move.mark;
    return cells;
  }, [replayStep, replaying, snapshot.moves]);

  useEffect(() => {
    if (!replaying || replayStep === null) return;
    // One timer per step rather than one interval for the whole replay: a
    // snapshot arriving mid-playback re-runs this effect, and a per-step timer
    // picks up from wherever the replay had reached.
    const last = replayStep >= snapshot.moves.length;
    const timer = setTimeout(() => {
      setReplayStep((current) => (current === null ? null : last ? null : current + 1));
    }, last ? 1_100 : 420);
    return () => clearTimeout(timer);
  }, [replaying, replayStep, snapshot.moves.length]);

  const chatToggleRef = useRef<HTMLButtonElement>(null);

  const closeChat = () => {
    setChatOpen(false);
    // Focus goes back to the button that opened the panel. Without this it
    // falls to the document and the next Tab starts from the top of the page.
    chatToggleRef.current?.focus();
  };

  const openChat = () => {
    setChatOpen(true);
    setUnread(0);
    // Focus moves into the composer on the next frame, so a keyboard user lands
    // where the panel is for rather than having to tab past the whole board to
    // reach it. Done here, from the gesture that opened the panel, rather than
    // in an effect inside it: the click also focuses this button, and that
    // default lands after React has committed - an effect focusing the composer
    // wins that race and then quietly loses it.
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('#private-chat .composer-input textarea')?.focus();
    });
  };

  return (
    <section
      className={`room-shell scene-${sceneState} ${chatOpen ? 'chat-open' : ''} ${hasControl ? '' : 'is-readonly'}`}
      style={{
        ['--arena-angle']: `${arena.angle}deg`,
        ['--arena-drift-x']: `${arena.driftX}%`,
        ['--arena-drift-y']: `${arena.driftY}%`,
        ['--arena-intensity']: String(arena.intensity),
        ['--arena-hue']: `${arena.hueShift}deg`,
      } as React.CSSProperties}
    >
      {watching && (
        // A watcher is told plainly what they are, rather than being handed a
        // board that silently refuses every click.
        <div className="room-banner spectator-banner" role="status">
          <span aria-hidden="true">◉</span>
          <p>
            <strong>You are watching this room.</strong>
            {snapshot.spectatorPolicy.chat
              ? ' The players have opened their conversation to watchers.'
              : ' The conversation between the players stays private.'}
          </p>
        </div>
      )}
      {!watching && isHost && snapshot.spectatorCount > 0 && (
        <div className="room-banner host-policy" role="group" aria-label="Spectator policy">
          <span aria-hidden="true">◉</span>
          <p>
            <strong>
              {snapshot.spectatorCount} {snapshot.spectatorCount === 1 ? 'person is' : 'people are'} watching.
            </strong>
            {snapshot.spectatorPolicy.chat
              ? ' They can see your conversation.'
              : ' Your conversation stays between the two of you.'}
          </p>
          <button className="claim-control" onClick={() => onSpectatorChat(!snapshot.spectatorPolicy.chat)}>
            {snapshot.spectatorPolicy.chat ? 'Make chat private' : 'Let them chat'}
          </button>
        </div>
      )}
      {!hasControl && !watching && (
        // Said in words, not implied by a dead board. The window is still fully
        // live - it just is not the one holding the slot (D-002).
        <div className="room-banner control-banner" role="status">
          <span aria-hidden="true">⌁</span>
          <p>
            <strong>Another window has control of this session.</strong>
            This view stays live, but moves and messages come from there.
          </p>
          <button className="claim-control" onClick={onClaimControl}>Take control here</button>
        </div>
      )}
      {needsKey && (
        // Said plainly, because the alternative is a chat panel full of blanks
        // and no explanation for why. The board is unaffected: the game state
        // was never encrypted, only what the players say to each other.
        <div className="room-banner key-banner" role="status">
          <span aria-hidden="true">⌁</span>
          <p>
            This is a private room and this window does not hold its key. The match plays normally; the
            conversation cannot be read here. Open the room from its invitation link to join it properly.
          </p>
        </div>
      )}
      <div className="arena-light light-x" aria-hidden="true" />
      <div className="arena-light light-o" aria-hidden="true" />
      <div className="room-stage">
        <div className="room-heading">
          <div>
              <span className="room-kicker">
              {snapshot.encryption.enabled ? 'END-TO-END ENCRYPTED' : 'PRIVATE SIGNAL'} · ROUND {String(snapshot.round).padStart(2, '0')}
            </span>
            <h1>Room <b>{snapshot.roomCode}</b></h1>
          </div>
          <div className="room-actions">
            {!watching && <button ref={chatToggleRef} className={`chat-toggle ${unread ? 'has-unread' : ''}`} onClick={openChat} aria-expanded={chatOpen} aria-controls="private-chat">
              <span aria-hidden="true">⌁</span>
              <span className="btn-label">Chat</span>
              {unread > 0 && <b aria-label={`${unread} unread messages`}>{unread}</b>}
            </button>}
            <InvitePanel
              roomCode={snapshot.roomCode}
              inviteUrl={inviteUrl}
              encrypted={snapshot.encryption.enabled}
              onShare={onShareInvite}
            />
            <button
              className="leave-room"
              onClick={() => { if (window.confirm('Leave this room? Your opponent keeps the room and can invite someone else.')) onLeave(); }}
              disabled={connection !== 'connected' || !hasControl}
              aria-label="Leave this room"
            >×</button>
          </div>
        </div>

        <MatchPanel
          snapshot={snapshot}
          viewerId={viewerId}
          canAct={!watching && hasControl && connection === 'connected'}
          onFormat={onFormat}
          onOfferDraw={onOfferDraw}
          onRespondToDraw={onRespondToDraw}
          onReplay={() => setReplayStep(0)}
          replaying={replaying}
        />

        <div className="arena">
          <div className="arena-axis" aria-hidden="true"><i /><span>SHARED PLANE</span><i /></div>
          <div className="player-x-area"><PlayerCard mark="X" player={xPlayer} isSelf={xPlayer?.id === viewerId} snapshot={snapshot} /></div>
          <div className="board-area">
            <div className="board-frame">
              <div className="board-meta"><span>01 / SERVER-AUTHORITATIVE</span><span>SYNC {String(snapshot.revision).padStart(3, '0')}</span></div>
              <GameBoard
                snapshot={snapshot}
                myMark={self?.mark ?? fallbackMark}
                interactive={canMove}
                speculation={speculation}
                replayBoard={replaying ? replayBoard : null}
                onMove={onMove}
              />
              {snapshot.phase === 'active' && snapshot.turnLimitMs !== null && timing?.turnMsRemaining != null && (
                <TurnClock
                  msRemaining={timing.turnMsRemaining}
                  revision={snapshot.revision}
                  limitMs={snapshot.turnLimitMs}
                  yourTurn={snapshot.turn === self?.mark}
                />
              )}
              {snapshot.phase === 'countdown' && timing?.countdownMsRemaining != null && (
                <Countdown msRemaining={timing.countdownMsRemaining} revision={snapshot.revision} />
              )}
              <div className="reaction-popups" aria-live="polite">
                {quickReactions.map((reaction) => {
                  const mark = snapshot.players.find((player) => player.id === reaction.senderId)?.mark ?? 'X';
                  const side = mark === 'X' ? 'x' : 'o';
                  // Positioned from the same function the geometry test proves
                  // clears the cells, rather than from a keyframe nobody can
                  // check (P10-06). CSS animates between the two endpoints.
                  const start = reactionPath(0.08, side);
                  const end = reactionPath(1, side);
                  return (
                    <span
                      key={reaction.id}
                      className={`reaction-popup reaction-${side} from-${side}`}
                      style={{
                        ['--from-x']: `${start.x * 100}%`,
                        ['--from-y']: `${start.y * 100}%`,
                        ['--to-x']: `${end.x * 100}%`,
                        ['--to-y']: `${end.y * 100}%`,
                        ['--glyph-size']: `${REACTION_SIZE * 100}%`,
                      } as React.CSSProperties}
                    >
                      {reaction.reaction}
                    </span>
                  );
                })}
              </div>
            </div>
            <GameStatus snapshot={snapshot} viewerId={viewerId} onRematch={onRematch} />
          </div>
          <div className="player-o-area"><PlayerCard mark="O" player={oPlayer} isSelf={oPlayer?.id === viewerId} snapshot={snapshot} /></div>
        </div>
      </div>
      <div id="private-chat">
        {!watching && <ChatPanel
          open={chatOpen}
          unread={unread}
          messages={chatMessages}
          players={snapshot.players}
          selfId={viewerId}
          connected={connection === 'connected'}
          typingPlayerId={typingPlayerId}
          imagePreparing={imagePreparing}
          onClose={closeChat}
          onSendText={onSendText}
          encrypted={snapshot.encryption.enabled}
          needsKey={needsKey}
          onTyping={onTyping}
          onSticker={onSticker}
          onQuickReaction={onQuickReaction}
          onMessageReaction={onMessageReaction}
          onImage={onImage}
        />}
      </div>
    </section>
  );
}
