import { describe, expect, it } from 'vitest';
import { applyMove, createInitialGame, getWinningCombination, getWinner, isDraw } from '../shared/game';

describe('pure game engine', () => {
  it('applies a valid move without mutating the previous state', () => {
    const initial = createInitialGame();
    const next = applyMove(initial, 'X', 4);
    expect(initial.board[4]).toBeNull();
    expect(next.board[4]).toBe('X');
    expect(next.turn).toBe('O');
  });

  it('rejects an occupied cell', () => {
    const afterX = applyMove(createInitialGame(), 'X', 4);
    expect(() => applyMove(afterX, 'O', 4)).toThrowError(/already taken/i);
  });

  it('finds a horizontal victory', () => {
    const board = ['X', 'X', 'X', null, 'O', null, 'O', null, null] as const;
    expect(getWinner(board)).toBe('X');
    expect(getWinningCombination(board)).toEqual([0, 1, 2]);
  });

  it('finds a vertical victory', () => {
    const board = ['O', 'X', null, 'O', 'X', null, 'O', null, 'X'] as const;
    expect(getWinner(board)).toBe('O');
    expect(getWinningCombination(board)).toEqual([0, 3, 6]);
  });

  it('finds both diagonal victories', () => {
    expect(getWinningCombination(['X', 'O', null, null, 'X', 'O', null, null, 'X'])).toEqual([0, 4, 8]);
    expect(getWinningCombination([null, null, 'O', null, 'O', 'X', 'O', 'X', 'X'])).toEqual([2, 4, 6]);
  });

  it('recognizes a draw', () => {
    const board = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'] as const;
    expect(isDraw(board)).toBe(true);
    expect(getWinner(board)).toBeNull();
  });

  it('rejects a move after completion', () => {
    let game = createInitialGame();
    game = applyMove(game, 'X', 0);
    game = applyMove(game, 'O', 3);
    game = applyMove(game, 'X', 1);
    game = applyMove(game, 'O', 4);
    game = applyMove(game, 'X', 2);
    expect(game.winner).toBe('X');
    expect(() => applyMove(game, 'O', 8)).toThrowError(/already finished/i);
  });

  it('rejects wrong-turn and out-of-range moves', () => {
    const game = createInitialGame();
    expect(() => applyMove(game, 'O', 0)).toThrowError(/your turn/i);
    expect(() => applyMove(game, 'X', 99)).toThrowError(/between 0 and 8/i);
    expect(() => applyMove(game, 'X', -1)).toThrowError(/between 0 and 8/i);
  });
});
