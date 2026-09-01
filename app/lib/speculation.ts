import type { Cell, Mark } from '../../shared/game';
import type { RoomSnapshot } from '../../shared/protocol';

/**
 * Optimistic move rendering, as pure functions.
 *
 * The client may show a mark the server has not yet confirmed, which is the one
 * place INV-2 ("no client ever displays a move the server rejected") can be
 * broken. Keeping the rules here rather than inside the socket hook means the
 * chaos simulation drives exactly the logic the browser runs - a hand-written
 * approximation would let the suite pass while production was wrong.
 *
 * The governing rule: speculation is always subordinate. The authoritative
 * board is the base, the pending cell is an overlay, and any newer revision
 * settles the question one way or the other.
 */

export interface Speculation {
  requestId: string;
  roomCode: string;
  cell: number;
  mark: Mark;
  /** The revision the move was sent against. */
  baseRevision: number;
}

/**
 * The board to render: the authoritative one with the pending cell overlaid.
 *
 * Never mutates the snapshot, and never overwrites a cell the server has
 * already filled - if the authority disagrees, the authority wins on the spot
 * rather than waiting for reconciliation.
 */
export function projectBoard(board: readonly Cell[], speculation: Speculation | null): Cell[] {
  if (!speculation) return [...board];
  if (board[speculation.cell] !== null) return [...board];
  const projected = [...board];
  projected[speculation.cell] = speculation.mark;
  return projected;
}

export type Reconciliation =
  /** No news yet: the snapshot is not newer than the move's base revision. */
  | 'pending'
  /** The move landed. The authoritative board already shows it. */
  | 'confirmed'
  /**
   * The room moved on without our move. It was rejected, or the cell went to
   * someone else. The overlay must come off and the player must be told.
   */
  | 'rejected';

/**
 * Decides the fate of a speculative move against an incoming snapshot.
 *
 * A revision may jump by more than one - our move plus the opponent's reply can
 * arrive together - so this asks what the board *shows*, not how far it moved.
 */
export function reconcile(speculation: Speculation, snapshot: RoomSnapshot): Reconciliation {
  // A different room entirely: whatever we were speculating about is gone.
  if (snapshot.roomCode !== speculation.roomCode) return 'rejected';
  if (snapshot.revision <= speculation.baseRevision) return 'pending';
  return snapshot.board[speculation.cell] === speculation.mark ? 'confirmed' : 'rejected';
}

/**
 * Whether the player may act, given what they can currently see.
 *
 * Speculation deliberately blocks further moves. Without that, a player could
 * place two marks in a row locally against a board the server has not confirmed,
 * and INV-1 would hold on the server while both players saw a playable board.
 */
export function canPlay(options: {
  connected: boolean;
  resyncing: boolean;
  hasControl: boolean;
  snapshot: RoomSnapshot | null;
  mark: Mark | undefined;
  speculation: Speculation | null;
}): boolean {
  const { connected, resyncing, hasControl, snapshot, mark, speculation } = options;
  return connected
    && !resyncing
    && hasControl
    && speculation === null
    && snapshot !== null
    && snapshot.phase === 'active'
    && snapshot.turn === mark;
}
