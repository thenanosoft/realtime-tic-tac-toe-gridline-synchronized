export type Mark = 'X' | 'O';
export type Cell = Mark | null;

export interface EngineState {
  board: Cell[];
  turn: Mark;
  winner: Mark | null;
  winningLine: number[] | null;
  isDraw: boolean;
}

export type GameRuleErrorCode =
  | 'INVALID_CELL'
  | 'CELL_OCCUPIED'
  | 'WRONG_TURN'
  | 'GAME_COMPLETE';

export class GameRuleError extends Error {
  constructor(
    public readonly code: GameRuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GameRuleError';
  }
}

export const WINNING_COMBINATIONS = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;

export function createInitialGame(): EngineState {
  return {
    board: Array<Cell>(9).fill(null),
    turn: 'X',
    winner: null,
    winningLine: null,
    isDraw: false,
  };
}

export function getWinningCombination(board: readonly Cell[]): number[] | null {
  for (const combination of WINNING_COMBINATIONS) {
    const [a, b, c] = combination;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return [...combination];
    }
  }
  return null;
}

export function getWinner(board: readonly Cell[]): Mark | null {
  const line = getWinningCombination(board);
  return line ? board[line[0]] : null;
}

export function isDraw(board: readonly Cell[]): boolean {
  return board.length === 9 && board.every(Boolean) && !getWinner(board);
}

export function applyMove(
  state: Readonly<EngineState>,
  actor: Mark,
  cell: number,
): EngineState {
  if (state.winner || state.isDraw) {
    throw new GameRuleError('GAME_COMPLETE', 'This match has already finished.');
  }
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
    throw new GameRuleError('INVALID_CELL', 'Choose a cell between 0 and 8.');
  }
  if (actor !== state.turn) {
    throw new GameRuleError('WRONG_TURN', 'Wait for your turn.');
  }
  if (state.board[cell]) {
    throw new GameRuleError('CELL_OCCUPIED', 'That cell is already taken.');
  }

  const board = [...state.board];
  board[cell] = actor;
  const winningLine = getWinningCombination(board);
  const winner = winningLine ? actor : null;
  const draw = !winner && isDraw(board);

  return {
    board,
    turn: winner || draw ? state.turn : actor === 'X' ? 'O' : 'X',
    winner,
    winningLine,
    isDraw: draw,
  };
}
