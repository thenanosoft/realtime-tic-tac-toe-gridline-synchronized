/**
 * Where a reaction travels (P10-05, P10-06).
 *
 * A reaction arrives from the opponent, so it should come *from* them - from
 * their side of the arena, moving toward the board. The constraint is that it
 * must never cover a cell a player might be about to click, and "it looked
 * fine" is not a way to establish that.
 *
 * So the path is arithmetic rather than a CSS keyframe. Coordinates are in
 * board widths with the board occupying 0..1 on both axes, and the exported
 * bound is checked by a test across the whole path for both sides. A keyframe
 * would have been fewer lines and unprovable.
 */

/** Clear space kept between the glyph and the board edge, in board widths. */
export const BOARD_CLEARANCE = 0.06;
/** The glyph box, also in board widths. Its full extent must stay clear. */
export const REACTION_SIZE = 0.16;

export interface ReactionPoint {
  /** Left edge of the glyph box, in board widths from the board's left edge. */
  x: number;
  /** Top edge of the glyph box, in board widths from the board's top edge. */
  y: number;
  scale: number;
  opacity: number;
}

/**
 * The glyph position at `progress` from 0 to 1.
 *
 * X is the interesting axis: it starts well outside the board, beside the
 * player card, and closes only to the clearance line. It never reaches the
 * board, which is what makes the overlap question answerable rather than
 * a matter of taste.
 */
export function reactionPath(progress: number, side: 'x' | 'o'): ReactionPoint {
  const t = Math.max(0, Math.min(1, progress));
  // Eased so it slows as it arrives rather than stopping dead at the margin.
  const eased = 1 - (1 - t) * (1 - t);

  const far = 0.52;
  // A hair more than the minimum, so the clearance is a margin rather than an
  // exact equality that a floating-point rounding could cross.
  const near = BOARD_CLEARANCE + REACTION_SIZE / 2 + 0.01;
  const distance = far - (far - near) * eased;

  // Left of the board for X, right of it for O, mirrored exactly - the glyph
  // box is placed by its left edge, so the right side subtracts its width.
  const x = side === 'x'
    ? -(distance + REACTION_SIZE / 2)
    : 1 + distance - REACTION_SIZE / 2;

  return {
    x,
    // Drifts upward as it travels, so two reactions in quick succession do not
    // land on top of each other.
    y: 0.58 - 0.34 * eased,
    scale: 0.72 + 0.46 * Math.sin(Math.PI * t),
    // Fades at both ends: a reaction that vanished abruptly reads as a glitch.
    opacity: Math.min(1, Math.sin(Math.PI * t) * 1.9),
  };
}

/** True when the glyph box at this point is entirely clear of the 3x3 region. */
export function clearsBoard(point: ReactionPoint): boolean {
  const left = point.x;
  const right = point.x + REACTION_SIZE;
  return right <= -BOARD_CLEARANCE || left >= 1 + BOARD_CLEARANCE;
}
