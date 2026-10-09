import { getWinner, type Cell, type Mark } from './game';

/**
 * The computer opponent (P13-01 … P13-03).
 *
 * Four levels that play differently, rather than one engine behind a dial. A
 * single strong engine with a "mistake chance" produces an opponent that plays
 * perfectly and then throws the game away at random, which reads as a cheat
 * rather than as a weaker player. These make their decisions in different
 * terms: the casual one does not look ahead at all, the keen one looks exactly
 * one move ahead, and only the top two search.
 *
 * It all runs in the browser. A solo game has no second person in it, so it has
 * no business opening a room, holding a socket, or putting a board on a server.
 */
export const SOLO_LEVELS = ['casual', 'keen', 'sharp', 'flawless'] as const;
export type SoloLevel = (typeof SOLO_LEVELS)[number];

export interface LevelProfile {
  id: SoloLevel;
  name: string;
  /** Said to the player, so the ladder means something while climbing it. */
  blurb: string;
}

export const LEVEL_PROFILES: Record<SoloLevel, LevelProfile> = {
  casual: { id: 'casual', name: 'Casual', blurb: 'Plays by instinct. Will miss things.' },
  keen: { id: 'keen', name: 'Keen', blurb: 'Takes a win, blocks a loss, and no further.' },
  sharp: { id: 'sharp', name: 'Sharp', blurb: 'Thinks it through, and occasionally slips.' },
  flawless: { id: 'flawless', name: 'Flawless', blurb: 'Cannot be beaten. A draw is a win.' },
};

export const WINNING_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

export function openCells(board: readonly Cell[]): number[] {
  const open: number[] = [];
  for (let index = 0; index < board.length; index += 1) if (!board[index]) open.push(index);
  return open;
}

const other = (mark: Mark): Mark => (mark === 'X' ? 'O' : 'X');

/** The cell that completes a line for `mark`, if there is one. */
function completingCell(board: readonly Cell[], mark: Mark): number | null {
  for (const line of WINNING_LINES) {
    const marks = line.map((cell) => board[cell]);
    const owned = marks.filter((value) => value === mark).length;
    const empty = marks.filter((value) => value === null).length;
    if (owned === 2 && empty === 1) return line[marks.indexOf(null)];
  }
  return null;
}

/**
 * Exact minimax, depth-aware.
 *
 * Depth is in the score so the engine prefers a win *sooner* and a loss
 * *later*. Without it every win scores the same, and the engine will happily
 * take a win in five moves over the same win in one - which looks, from the
 * other side of the board, like it is toying with you.
 */
function score(board: Cell[], toPlay: Mark, perspective: Mark, depth: number): number {
  const winner = getWinner(board);
  if (winner === perspective) return 10 - depth;
  if (winner) return depth - 10;
  const open = openCells(board);
  if (!open.length) return 0;

  let best = toPlay === perspective ? -Infinity : Infinity;
  for (const cell of open) {
    board[cell] = toPlay;
    const value = score(board, other(toPlay), perspective, depth + 1);
    board[cell] = null;
    best = toPlay === perspective ? Math.max(best, value) : Math.min(best, value);
  }
  return best;
}

/** Every move that shares the best achievable score, in board order. */
export function bestMoves(board: readonly Cell[], mark: Mark): number[] {
  const working = [...board];
  let best = -Infinity;
  let moves: number[] = [];
  for (const cell of openCells(working)) {
    working[cell] = mark;
    const value = score(working, other(mark), mark, 1);
    working[cell] = null;
    if (value > best) {
      best = value;
      moves = [cell];
    } else if (value === best) {
      moves.push(cell);
    }
  }
  return moves;
}

export interface SoloDecision {
  cell: number;
  /** Why it played there, for the test to read and the UI to ignore. */
  reason: 'win' | 'block' | 'search' | 'slip' | 'instinct';
}

/**
 * Picks the computer's move.
 *
 * `random` is injected rather than taken from `Math.random`, so a level that is
 * supposed to be imperfect can be tested for *how* it is imperfect instead of
 * only being watched.
 */
export function chooseMove(
  board: readonly Cell[],
  mark: Mark,
  level: SoloLevel,
  random: () => number = Math.random,
): SoloDecision {
  const open = openCells(board);
  if (!open.length) throw new Error('No cell is open.');
  const pick = (cells: number[]) => cells[Math.min(cells.length - 1, Math.floor(random() * cells.length))];

  if (level === 'casual') {
    // No lookahead at all. It will walk past its own winning move, which is
    // what makes it beatable by someone who has just learned the game.
    return { cell: pick(open), reason: 'instinct' };
  }

  const winning = completingCell(board, mark);
  if (winning !== null) return { cell: winning, reason: 'win' };
  const blocking = completingCell(board, other(mark));
  if (blocking !== null) return { cell: blocking, reason: 'block' };

  if (level === 'keen') return { cell: pick(open), reason: 'instinct' };

  if (level === 'sharp') {
    // One slip in five, and the slip is a *plausible* move - the best of what
    // is left after discarding the strongest - rather than a random cell. A
    // player who is losing should feel they were outplayed, not pitied.
    const best = bestMoves(board, mark);
    if (random() < 0.2) {
      const rest = open.filter((cell) => !best.includes(cell));
      if (rest.length) return { cell: pick(rest), reason: 'slip' };
    }
    return { cell: pick(best), reason: 'search' };
  }

  return { cell: pick(bestMoves(board, mark)), reason: 'search' };
}

/** Where a win or a loss moves the player next (P13-03). */
export function nextLevel(level: SoloLevel, outcome: 'won' | 'lost' | 'drew'): SoloLevel {
  const index = SOLO_LEVELS.indexOf(level);
  if (outcome === 'won') return SOLO_LEVELS[Math.min(SOLO_LEVELS.length - 1, index + 1)];
  // A draw holds the line: against the top level it is the best result there
  // is, and demoting someone for achieving it would be absurd.
  if (outcome === 'drew') return level;
  return SOLO_LEVELS[Math.max(0, index - 1)];
}
