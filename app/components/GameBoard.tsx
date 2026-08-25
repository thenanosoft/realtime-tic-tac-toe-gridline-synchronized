'use client';

import type { KeyboardEvent } from 'react';
import type { Mark } from '../../shared/game';
import type { RoomSnapshot } from '../../shared/protocol';

interface GameBoardProps {
  snapshot: RoomSnapshot;
  myMark: Mark;
  interactive: boolean;
  onMove(cell: number): void;
}

export function GameBoard({ snapshot, myMark, interactive, onMove }: GameBoardProps) {
  const winningKey = snapshot.winningLine?.join('-');

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      if (interactive && !snapshot.board[index]) onMove(index);
      return;
    }
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    let next = index + offset;
    if (event.key === 'ArrowLeft' && index % 3 === 0) next = index + 2;
    if (event.key === 'ArrowRight' && index % 3 === 2) next = index - 2;
    if (event.key === 'ArrowUp' && index < 3) next = index + 6;
    if (event.key === 'ArrowDown' && index > 5) next = index - 6;
    document.querySelector<HTMLButtonElement>(`[data-cell="${next}"]`)?.focus();
  };

  return (
    <div className={`game-board ${interactive ? 'is-interactive' : ''} ${snapshot.winner ? 'has-winner' : ''}`} role="grid" aria-label="Tic-Tac-Toe board">
      {snapshot.board.map((mark, index) => {
        const winning = snapshot.winningLine?.includes(index);
        const dimmed = Boolean(snapshot.winningLine && !winning);
        const row = Math.floor(index / 3) + 1;
        const column = index % 3 + 1;
        return (
          <button
            key={index}
            type="button"
            role="gridcell"
            data-cell={index}
            className={`game-cell ${mark ? `filled mark-${mark.toLowerCase()}` : ''} ${winning ? 'winning' : ''} ${dimmed ? 'dimmed' : ''}`}
            disabled={!interactive || Boolean(mark)}
            onClick={() => onMove(index)}
            onKeyDown={(event) => handleKey(event, index)}
            aria-label={mark ? `Row ${row}, column ${column}: ${mark}` : `Row ${row}, column ${column}: empty${interactive ? `. Place ${myMark}` : ''}`}
          >
            {mark === 'X' && <span className="drawn-x" aria-hidden="true"><i /><i /></span>}
            {mark === 'O' && <span className="drawn-o" aria-hidden="true" />}
          </button>
        );
      })}
      {winningKey && <span className={`winning-line line-${winningKey}`} aria-hidden="true" />}
    </div>
  );
}
