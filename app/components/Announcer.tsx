'use client';

import type { ClientChatMessage } from '../hooks/useGameSocket';
import type { PresenceState, RoomSnapshot } from '../../shared/protocol';

interface AnnouncerProps {
  snapshot: RoomSnapshot | null;
  viewerId: string;
  lastMessage: ClientChatMessage | null;
  offline: boolean;
}

const CELL_NAMES = ['top left', 'top centre', 'top right', 'middle left', 'centre', 'middle right', 'bottom left', 'bottom centre', 'bottom right'];

const PRESENCE_WORDS: Record<PresenceState, string> = {
  online: 'is here',
  reconnecting: 'is reconnecting',
  offline: 'has lost their signal',
  expired: 'has left',
};

/**
 * What a screen reader is told, and how urgently (P11-02).
 *
 * Both regions are **derived from the snapshot during render**, with no state
 * and no effects. A live region announces when its text changes, so a pure
 * function of the authoritative state is all that is needed - and it cannot
 * drift from what is on screen, double-announce after a re-render, or announce
 * a state the room has already left.
 *
 * The split is deliberate and it is the whole design:
 *
 *   polite     whose turn it is, the move that was just placed, presence, an
 *              incoming message. Information you want, interrupting nothing.
 *   assertive  the result of a round, and losing the connection. Things that
 *              change what you can do, and that are useless if they arrive
 *              after you have tried to act.
 *
 * Anything more than that in assertive makes the game unusable with a screen
 * reader, because every announcement cancels the one before it.
 */
export function Announcer({ snapshot, viewerId, lastMessage, offline }: AnnouncerProps) {
  const self = snapshot?.players.find((player) => player.id === viewerId) ?? null;
  const opponent = snapshot?.players.find((player) => player.id !== viewerId) ?? null;

  const polite: string[] = [];
  const assertive: string[] = [];

  if (offline) {
    assertive.push('You are offline. Gridline needs a connection to play.');
  }

  if (snapshot) {
    const lastMove = snapshot.moves.at(-1);
    if (lastMove) {
      const who = lastMove.mark === self?.mark ? 'You' : (opponent?.name ?? 'Your opponent');
      polite.push(`${who} played ${CELL_NAMES[lastMove.cell]}.`);
    }

    if (snapshot.phase === 'active') {
      polite.push(snapshot.turn === self?.mark ? 'Your turn.' : 'Their turn.');
    } else if (snapshot.phase === 'countdown') {
      polite.push(`Round ${snapshot.round} is starting.`);
    } else if (snapshot.phase === 'paused') {
      polite.push('The match is paused while a player reconnects.');
    } else if (snapshot.phase === 'game_over' || snapshot.phase === 'rematch_waiting') {
      // The result goes in the assertive region: a player who has just lost
      // needs to know before they try to place another mark.
      if (snapshot.isDraw) assertive.push('The round is a draw.');
      else if (snapshot.winner) {
        assertive.push(snapshot.winner === self?.mark ? 'You won the round.' : 'You lost the round.');
      }
      if (snapshot.series.decidedBy) {
        assertive.push(snapshot.series.decidedBy === viewerId ? 'You took the series.' : 'They took the series.');
      }
    } else if (snapshot.phase === 'waiting') {
      polite.push('Waiting for an opponent to join.');
    }

    if (opponent && opponent.presence !== 'online') {
      polite.push(`${opponent.name} ${PRESENCE_WORDS[opponent.presence]}.`);
    }

    if (snapshot.drawOffer) {
      polite.push(snapshot.drawOffer.byPlayerId === viewerId
        ? 'Your draw offer is waiting for an answer.'
        : 'Your opponent has offered a draw.');
    }
  }

  if (lastMessage && lastMessage.senderId !== viewerId) {
    const sender = snapshot?.players.find((player) => player.id === lastMessage.senderId)?.name ?? 'Your opponent';
    // The message body is deliberately not read out. In an encrypted room the
    // text may be unreadable here anyway, and announcing the content of every
    // message over a live game is more interruption than it is worth.
    const kind = lastMessage.undecryptable
      ? 'sent a message this window cannot read'
      : lastMessage.kind === 'image'
        ? 'shared an image'
        : lastMessage.kind === 'sticker'
          ? 'sent a sticker'
          : 'sent a message';
    polite.push(`${sender} ${kind}.`);
  }

  return (
    <>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{polite.join(' ')}</p>
      <p className="sr-only" aria-live="assertive" aria-atomic="true">{assertive.join(' ')}</p>
    </>
  );
}
