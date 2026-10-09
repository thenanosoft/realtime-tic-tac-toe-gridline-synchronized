'use client';

import type { RoomSnapshot } from '../../shared/protocol';

interface AudiencePanelProps {
  snapshot: RoomSnapshot;
  viewerId: string;
  watching: boolean;
  isHost: boolean;
  /** False while this window does not hold the slot, or is disconnected. */
  canAct: boolean;
  onAskToPlay(wants: boolean): void;
  onSeat(spectatorId: string): void;
}

/**
 * The audience, and the queue to join it on the board (P13-06 … P13-08).
 *
 * Who has put their hand up is shown to everyone, not just to the host. A room
 * is a shared place: hiding the queue would make the host's choice look
 * arbitrary to the people waiting in it, and there is nothing private about
 * having asked to play.
 */
export function AudiencePanel({
  snapshot,
  viewerId,
  watching,
  isHost,
  canAct,
  onAskToPlay,
  onSeat,
}: AudiencePanelProps) {
  const requests = snapshot.playRequests;
  const mine = requests.some((request) => request.spectatorId === viewerId);
  const betweenRounds = snapshot.phase !== 'active' && snapshot.phase !== 'countdown';
  const watchers = snapshot.spectatorCount;

  if (!watching && !watchers && !requests.length) return null;

  return (
    <section className="audience-panel" aria-label="Watchers">
      <div className="audience-count">
        <span aria-hidden="true">◉</span>
        <strong>{watchers}</strong>
        <small>{watchers === 1 ? 'watching' : 'watching'}</small>
      </div>

      {watching && (
        <button
          className={`ask-to-play ${mine ? 'is-waiting' : ''}`}
          onClick={() => onAskToPlay(!mine)}
          aria-pressed={mine}
        >
          {mine ? 'Waiting for a seat — cancel' : 'Ask to play'}
        </button>
      )}

      {requests.length > 0 && (
        <ol className="play-queue">
          {requests.map((request, index) => (
            <li key={request.spectatorId}>
              <span className="queue-position" aria-hidden="true">{index + 1}</span>
              <span className="queue-name">
                {request.spectatorId === viewerId ? 'You' : request.name}
              </span>
              {isHost && (
                <button
                  className="seat-watcher"
                  onClick={() => onSeat(request.spectatorId)}
                  // Between rounds only, and shown as disabled rather than
                  // hidden so the host can see the option exists and why it is
                  // not available yet.
                  disabled={!canAct || !betweenRounds}
                  title={betweenRounds ? undefined : 'You can change the players between rounds'}
                >
                  Give the seat
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {isHost && !requests.length && watchers > 0 && (
        <p className="audience-hint">Nobody has asked to play yet.</p>
      )}
    </section>
  );
}
