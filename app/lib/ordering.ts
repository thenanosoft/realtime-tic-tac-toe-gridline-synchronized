import type { ChatMessageSnapshot, RoomSnapshot } from '../../shared/protocol';

/**
 * The client's ordering rules, as pure functions.
 *
 * These live outside the socket hook so the headless chaos simulation can drive
 * the *same* logic the browser runs, rather than a hand-written approximation
 * of it. A divergence between the two would make the chaos suite worthless
 * exactly when it matters.
 */

export interface RevisionCursor {
  roomCode: string;
  revision: number;
}

/**
 * True when an incoming snapshot is strictly newer than what is already held.
 *
 * Scoped to the room code: a freshly created room legitimately starts at
 * revision 1, which a bare high-water mark would discard as stale after a long
 * previous session in another room (INV-4).
 */
export function shouldApplySnapshot(cursor: RevisionCursor | null, incoming: RoomSnapshot): boolean {
  if (!cursor) return true;
  if (cursor.roomCode !== incoming.roomCode) return true;
  return incoming.revision > cursor.revision;
}

/**
 * True when a state-overwriting chat event should be applied.
 *
 * Typing indicators and reaction sets *replace* state, so a late one would
 * resurrect something the sender has already cleared. Discarding is correct
 * here - unlike for messages, where it would lose data.
 */
export function shouldApplyOverwrite(lastSequence: number, sequence: number): boolean {
  return sequence > lastSequence;
}

/**
 * Places a message at the position its sequence names.
 *
 * Messages are never discarded for arriving late. A delayed message still
 * belongs in the transcript, so ordering here is an insert, not an append, and
 * duplicates are collapsed by id rather than by position.
 */
export function insertMessage<T extends { id: string; sequence: number }>(
  messages: readonly T[],
  incoming: T,
): T[] {
  if (messages.some((candidate) => candidate.id === incoming.id)) return messages as T[];
  const next = [...messages];
  // Scanning from the end is the common case: messages usually arrive in order,
  // and out-of-order ones are typically only a few places behind.
  let index = next.length;
  while (index > 0 && next[index - 1].sequence > incoming.sequence) index -= 1;
  next.splice(index, 0, incoming);
  return next;
}

/** Highest sequence observed across a chat snapshot, for cursor restoration. */
export function highestSequence(messages: readonly ChatMessageSnapshot[]): number {
  return messages.reduce((highest, message) => Math.max(highest, message.sequence), 0);
}
