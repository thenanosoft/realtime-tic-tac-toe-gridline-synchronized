'use client';

import { useEffect, useRef, useState } from 'react';
import type { RoomSnapshot } from '../../shared/protocol';
import type { StoredSession } from '../lib/session';
import type { ConnectionState } from '../hooks/useGameSocket';
import { PlayerCard } from './PlayerCard';
import { GameBoard } from './GameBoard';
import { GameStatus } from './GameStatus';
import { Countdown } from './Countdown';
import { useGameSound } from '../hooks/useGameSound';

interface GameRoomProps {
  snapshot: RoomSnapshot;
  session: StoredSession;
  connection: ConnectionState;
  pendingMove: boolean;
  onMove(cell: number): void;
  onRematch(): void;
  playSound: ReturnType<typeof useGameSound>['play'];
}

export function GameRoom({ snapshot, session, connection, pendingMove, onMove, onRematch, playSound }: GameRoomProps) {
  const [copied, setCopied] = useState(false);
  const previousRef = useRef<RoomSnapshot | null>(null);
  const xPlayer = snapshot.players.find((player) => player.mark === 'X');
  const oPlayer = snapshot.players.find((player) => player.mark === 'O');
  const self = snapshot.players.find((player) => player.id === session.playerId);
  const canMove = connection === 'connected' && snapshot.phase === 'active' && snapshot.turn === self?.mark && !pendingMove;
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

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(snapshot.roomCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    } catch {
      const input = document.createElement('input');
      input.value = snapshot.roomCode;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    }
  };

  return (
    <section className={`room-shell scene-${sceneState}`}>
      <div className="arena-light light-x" aria-hidden="true" />
      <div className="arena-light light-o" aria-hidden="true" />
      <div className="room-heading">
        <div>
          <span className="room-kicker">PRIVATE SIGNAL · ROUND {String(snapshot.round).padStart(2, '0')}</span>
          <h1>Room <b>{snapshot.roomCode}</b></h1>
        </div>
        <button className={`copy-room ${copied ? 'copied' : ''}`} onClick={copyCode} aria-label={`Copy room code ${snapshot.roomCode}`}>
          <span className="copy-icon" aria-hidden="true" />{copied ? 'Copied' : 'Copy invite'}
        </button>
      </div>

      <div className="arena">
        <div className="arena-axis" aria-hidden="true"><i /><span>SHARED PLANE</span><i /></div>
        <div className="player-x-area"><PlayerCard mark="X" player={xPlayer} isSelf={xPlayer?.id === session.playerId} snapshot={snapshot} /></div>
        <div className="board-area">
          <div className="board-frame">
            <div className="board-meta"><span>01 / SERVER-AUTHORITATIVE</span><span>SYNC {String(snapshot.version).padStart(3, '0')}</span></div>
            <GameBoard snapshot={snapshot} myMark={self?.mark ?? session.mark} interactive={canMove} onMove={onMove} />
            {snapshot.phase === 'countdown' && snapshot.countdownEndsAt && <Countdown endsAt={snapshot.countdownEndsAt} />}
            {pendingMove && <div className="move-pending"><span /> Confirming move</div>}
          </div>
          <GameStatus snapshot={snapshot} session={session} onRematch={onRematch} />
        </div>
        <div className="player-o-area"><PlayerCard mark="O" player={oPlayer} isSelf={oPlayer?.id === session.playerId} snapshot={snapshot} /></div>
      </div>
    </section>
  );
}
