import { describe, expect, it } from 'vitest';
import { canPlay, projectBoard, reconcile, type Speculation } from '../app/lib/speculation';
import type { Cell, Mark } from '../shared/game';
import type { RoomSnapshot } from '../shared/protocol';

/**
 * Optimistic rendering rules (Phase 5).
 *
 * These are the functions that decide whether a client may show a mark the
 * server has not confirmed, so they are the one place INV-2 can be broken.
 */

const board = (cells: string): Cell[] =>
  cells.split('').map((character) => (character === '.' ? null : (character as Mark)));

const snapshot = (overrides: Partial<RoomSnapshot> = {}): RoomSnapshot => ({
  roomCode: 'ABC123',
  revision: 10,
  phase: 'active',
  board: board('.........'),
  turn: 'X',
  winner: null,
  winningLine: null,
  isDraw: false,
  round: 1,
  players: [],
  ...overrides,
});

const speculation = (overrides: Partial<Speculation> = {}): Speculation => ({
  requestId: 'req-1',
  roomCode: 'ABC123',
  cell: 4,
  mark: 'X',
  baseRevision: 10,
  ...overrides,
});

describe('projectBoard (P5-01)', () => {
  it('returns the authoritative board untouched when nothing is pending', () => {
    const authoritative = board('X.O......');
    expect(projectBoard(authoritative, null)).toEqual(authoritative);
  });

  it('overlays the pending mark on an empty square', () => {
    expect(projectBoard(board('.........'), speculation())).toEqual(board('....X....'));
  });

  it('never mutates the board it was given', () => {
    const authoritative = board('.........');
    const copy = [...authoritative];
    projectBoard(authoritative, speculation());
    expect(authoritative).toEqual(copy);
  });

  it('yields to the server when the square is already taken', () => {
    // The authority wins on the spot rather than waiting for reconciliation:
    // showing our mark over someone else's would be a visible contradiction.
    const authoritative = board('....O....');
    expect(projectBoard(authoritative, speculation({ cell: 4, mark: 'X' }))).toEqual(authoritative);
  });
});

describe('reconcile (P5-02, P5-03)', () => {
  it('waits while the snapshot is no newer than the move', () => {
    expect(reconcile(speculation({ baseRevision: 10 }), snapshot({ revision: 10 }))).toBe('pending');
    expect(reconcile(speculation({ baseRevision: 10 }), snapshot({ revision: 9 }))).toBe('pending');
  });

  it('confirms when the newer board carries our mark', () => {
    const result = reconcile(speculation({ cell: 4, mark: 'X' }), snapshot({ revision: 11, board: board('....X....') }));
    expect(result).toBe('confirmed');
  });

  it('confirms even when the revision jumped past our move', () => {
    // Our move and the opponent's reply can arrive together, so this asks what
    // the board shows rather than how far the revision moved.
    const result = reconcile(
      speculation({ cell: 4, mark: 'X', baseRevision: 10 }),
      snapshot({ revision: 14, board: board('O...X....') }),
    );
    expect(result).toBe('confirmed');
  });

  it('rejects when the room moved on without our mark', () => {
    const result = reconcile(speculation({ cell: 4, mark: 'X' }), snapshot({ revision: 11, board: board('X........') }));
    expect(result).toBe('rejected');
  });

  it('rejects when someone else took the square', () => {
    const result = reconcile(speculation({ cell: 4, mark: 'X' }), snapshot({ revision: 11, board: board('....O....') }));
    expect(result).toBe('rejected');
  });

  it('rejects anything left over from another room', () => {
    const result = reconcile(speculation({ roomCode: 'OLDROOM' }), snapshot({ revision: 11 }));
    expect(result).toBe('rejected');
  });

  it('never reports pending once the board disagrees at a newer revision', () => {
    // The property that matters: past the base revision there is always a
    // verdict, so an overlay can never be left outstanding indefinitely.
    for (let revision = 11; revision < 20; revision += 1) {
      for (const cells of ['.........', 'X........', '....O....', '....X....']) {
        const verdict = reconcile(speculation(), snapshot({ revision, board: board(cells) }));
        expect(verdict).not.toBe('pending');
      }
    }
  });
});

describe('canPlay (P5-05, INV-1)', () => {
  const base = {
    connected: true,
    resyncing: false,
    hasControl: true,
    snapshot: snapshot({ turn: 'X' }),
    mark: 'X' as Mark,
    speculation: null,
  };

  it('allows a move when everything lines up', () => {
    expect(canPlay(base)).toBe(true);
  });

  it('blocks a second move while one is still in flight', () => {
    // Without this a player could place two marks in a row against a board the
    // server has not confirmed, and both sides would show a playable board.
    expect(canPlay({ ...base, speculation: speculation() })).toBe(false);
  });

  it('blocks while disconnected, resyncing, or without the slot', () => {
    expect(canPlay({ ...base, connected: false })).toBe(false);
    expect(canPlay({ ...base, resyncing: true })).toBe(false);
    expect(canPlay({ ...base, hasControl: false })).toBe(false);
  });

  it('blocks when it is not our turn or the match is not active', () => {
    expect(canPlay({ ...base, mark: 'O' })).toBe(false);
    expect(canPlay({ ...base, snapshot: snapshot({ turn: 'X', phase: 'paused' }) })).toBe(false);
    expect(canPlay({ ...base, snapshot: null })).toBe(false);
    expect(canPlay({ ...base, mark: undefined })).toBe(false);
  });

  it('never lets both marks act on the same snapshot', () => {
    // The enforceable form of INV-1, checked directly: for any board state, at
    // most one of the two players may be able to move.
    for (const turn of ['X', 'O'] as const) {
      for (const phase of ['waiting', 'countdown', 'active', 'paused', 'game_over'] as const) {
        const state = snapshot({ turn, phase });
        const actors = (['X', 'O'] as const).filter((mark) =>
          canPlay({ ...base, snapshot: state, mark, speculation: null }));
        expect(actors.length).toBeLessThanOrEqual(1);
      }
    }
  });
});
