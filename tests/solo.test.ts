import { describe, expect, it } from 'vitest';
import { getWinner, type Cell, type Mark } from '../shared/game';
import { LEVEL_PROFILES, SOLO_LEVELS, bestMoves, chooseMove, nextLevel, openCells } from '../shared/solo';

/**
 * The computer opponent (P13-01 … P13-03, P13-10).
 *
 * The headline claim is that the top level cannot be beaten, and that is the
 * kind of claim worth proving exhaustively rather than by playing it a few
 * times: the test below plays *every* game a human could play against it.
 */

const empty = (): Cell[] => Array<Cell>(9).fill(null);
const board = (cells: string): Cell[] =>
  cells.split('').map((character) => (character === '.' ? null : (character as Mark)));

describe('the flawless level cannot be beaten (P13-02)', () => {
  /**
   * Walks the whole game tree of human choices.
   *
   * The computer's reply is deterministic here - `random` returns 0, so it
   * takes the first of its equally-best moves - which is what makes the sweep
   * finite and the result exact rather than a sample.
   */
  const playOut = (cells: Cell[], human: Mark, computer: Mark, toPlay: Mark): 'human' | 'computer' | 'draw' => {
    const winner = getWinner(cells);
    if (winner) return winner === human ? 'human' : 'computer';
    const open = openCells(cells);
    if (!open.length) return 'draw';

    if (toPlay === computer) {
      const { cell } = chooseMove(cells, computer, 'flawless', () => 0);
      const next = [...cells];
      next[cell] = computer;
      return playOut(next, human, computer, human);
    }

    // The human tries everything. A single human win anywhere in this tree
    // falsifies the claim.
    let best: 'human' | 'computer' | 'draw' = 'computer';
    for (const cell of open) {
      const next = [...cells];
      next[cell] = human;
      const outcome = playOut(next, human, computer, computer);
      if (outcome === 'human') return 'human';
      if (outcome === 'draw') best = 'draw';
    }
    return best;
  };

  it('never loses when the human moves first', () => {
    expect(playOut(empty(), 'X', 'O', 'X')).not.toBe('human');
  });

  it('never loses when it moves first', () => {
    expect(playOut(empty(), 'O', 'X', 'X')).not.toBe('human');
  });

  it('takes a win rather than prolonging the game', () => {
    // Depth is part of the score, so a win now beats the same win later. An
    // engine without that happily plays a longer win, which from the other
    // side of the board looks like being toyed with.
    const decision = chooseMove(board('XX.OO...X'), 'X', 'flawless', () => 0);
    expect(decision.cell).toBe(2);
    expect(decision.reason).toBe('win');
  });

  it('blocks rather than building its own line', () => {
    expect(chooseMove(board('OO.X..X..'), 'X', 'flawless', () => 0).cell).toBe(2);
  });

  it('agrees with its own search about which moves are best', () => {
    const position = board('X...O....');
    const best = bestMoves(position, 'X');
    expect(best.length).toBeGreaterThan(0);
    for (const cell of best) expect(position[cell]).toBe(null);
    // Picking from the best set is the only thing the top level does.
    expect(best).toContain(chooseMove(position, 'X', 'flawless', () => 0).cell);
  });
});

describe('the lower levels are weaker in specific ways (P13-02)', () => {
  it('casual does not look ahead at all', () => {
    // Offered a win on a plate, it may well play elsewhere. That is the level:
    // beatable by someone who has just learned the game.
    const position = board('XX.OO....');
    const choices = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      choices.add(chooseMove(position, 'X', 'casual', () => i / 40).cell);
    }
    expect(choices.size).toBeGreaterThan(1);
    for (const cell of choices) expect(position[cell]).toBe(null);
  });

  it('keen takes the win in front of it and blocks the loss in front of it', () => {
    expect(chooseMove(board('XX.OO....'), 'X', 'keen', () => 0)).toEqual({ cell: 2, reason: 'win' });
    expect(chooseMove(board('OO.X.....'), 'X', 'keen', () => 0)).toEqual({ cell: 2, reason: 'block' });
  });

  it('keen sees exactly one move ahead and no further', () => {
    // A fork is two moves away, so it does not see it. This is the difference
    // between keen and sharp, stated as a test rather than as a comment.
    const position = board('X...O...X');
    const decision = chooseMove(position, 'X', 'keen', () => 0);
    expect(decision.reason).toBe('instinct');
  });

  it('sharp slips about one time in five, and plausibly', () => {
    // A position where the moves genuinely differ: three of the six open cells
    // hold the draw and the rest lose. In a position where every move is equal
    // there is nothing to slip *into*, and the engine correctly just searches.
    const position = board('XO...X...');
    const best = bestMoves(position, 'X');
    expect(best.length).toBeLessThan(openCells(position).length);
    // Below the threshold it searches; above it, it plays something else that
    // is still a legal, reasonable-looking move rather than a random cell.
    expect(chooseMove(position, 'X', 'sharp', () => 0.9).reason).toBe('search');
    const slip = chooseMove(position, 'X', 'sharp', () => 0.05);
    expect(slip.reason).toBe('slip');
    expect(best).not.toContain(slip.cell);
    expect(position[slip.cell]).toBe(null);
  });

  it('never plays an occupied cell, at any level', () => {
    const position = board('XO.XO....');
    for (const level of SOLO_LEVELS) {
      for (let i = 0; i < 20; i += 1) {
        const { cell } = chooseMove(position, 'X', level, () => i / 20);
        expect(position[cell], level + ' played an occupied cell').toBe(null);
      }
    }
  });

  it('refuses to move on a full board rather than returning nonsense', () => {
    expect(() => chooseMove(board('XOXXOOOXX'), 'X', 'flawless')).toThrow(/open/i);
  });
});

describe('the ladder (P13-03)', () => {
  it('rises on a win and falls on a loss', () => {
    expect(nextLevel('casual', 'won')).toBe('keen');
    expect(nextLevel('keen', 'won')).toBe('sharp');
    expect(nextLevel('sharp', 'won')).toBe('flawless');
    expect(nextLevel('keen', 'lost')).toBe('casual');
  });

  it('holds at a draw, because against the top level a draw is the best there is', () => {
    for (const level of SOLO_LEVELS) expect(nextLevel(level, 'drew')).toBe(level);
  });

  it('stops at both ends rather than running off the scale', () => {
    expect(nextLevel('flawless', 'won')).toBe('flawless');
    expect(nextLevel('casual', 'lost')).toBe('casual');
  });

  it('gives every level a name and a description', () => {
    // The ladder is only motivating if the player can see what they just beat.
    for (const level of SOLO_LEVELS) {
      expect(LEVEL_PROFILES[level].name).toMatch(/^[A-Z]/);
      expect(LEVEL_PROFILES[level].blurb.length).toBeGreaterThan(10);
    }
  });
});
