'use client';

import {
  SERIES_TARGETS,
  TURN_LIMITS_MS,
  type RoomSnapshot,
  type SeriesTarget,
  type TurnLimitMs,
} from '../../shared/protocol';

interface MatchPanelProps {
  snapshot: RoomSnapshot;
  viewerId: string;
  /** False for a spectator, and for a window that does not hold the slot. */
  canAct: boolean;
  onFormat(format: { seriesTarget?: SeriesTarget; turnLimitMs?: TurnLimitMs | null }): void;
  onOfferDraw(): void;
  onRespondToDraw(accept: boolean): void;
  onReplay(): void;
  replaying: boolean;
}

/**
 * The series, the format and the draw offer.
 *
 * Everything shown here is read from the snapshot, never computed locally. The
 * score in particular: a client that counted its own wins would disagree with
 * the server the first time a round ended during a reconnect, and the version
 * the player believes would be the wrong one.
 */
export function MatchPanel({
  snapshot,
  viewerId,
  canAct,
  onFormat,
  onOfferDraw,
  onRespondToDraw,
  onReplay,
  replaying,
}: MatchPanelProps) {
  const self = snapshot.players.find((player) => player.id === viewerId);
  const isHost = Boolean(self?.isHost);
  const played = snapshot.series.draws + snapshot.series.scores.reduce((total, score) => total + score.wins, 0);
  // The same rule the server enforces, and no stricter: open until a round has
  // been decided. A control that disappeared when the round began would leave
  // the host unable to do something the server would have allowed.
  const formatOpen = isHost && canAct && played === 0;
  const outstanding = snapshot.drawOffer;
  const mine = outstanding?.byPlayerId === viewerId;
  const complete = snapshot.phase === 'game_over' || snapshot.phase === 'rematch_waiting';
  const threshold = Math.ceil(snapshot.series.target / 2);

  return (
    <section className="match-panel" aria-label="Match format and score">
      <div className="series-line">
        <span className="series-label">
          {snapshot.series.target === 1 ? 'SINGLE GAME' : `BEST OF ${snapshot.series.target}`}
          {snapshot.series.target > 1 && <small> · FIRST TO {threshold}</small>}
        </span>
        <ol className="series-scores">
          {snapshot.series.scores.map((score) => {
            const player = snapshot.players.find((candidate) => candidate.id === score.playerId);
            return (
              <li key={score.playerId} className={`score-${player?.mark.toLowerCase() ?? 'x'}`}>
                <b>{player?.mark ?? '?'}</b>
                <span>{score.wins}</span>
              </li>
            );
          })}
          {snapshot.series.draws > 0 && <li className="score-draw"><b>=</b><span>{snapshot.series.draws}</span></li>}
        </ol>
      </div>

      {snapshot.series.decidedBy && (
        <p className="series-decided" role="status">
          {snapshot.series.decidedBy === viewerId ? 'You took the series.' : 'They took the series.'}
          {' '}A rematch starts a new one.
        </p>
      )}

      {formatOpen && (
        <div className="format-controls">
          <fieldset>
            <legend>Series</legend>
            {SERIES_TARGETS.map((target) => (
              <button
                key={target}
                className={snapshot.series.target === target ? 'is-active' : ''}
                onClick={() => onFormat({ seriesTarget: target })}
                aria-pressed={snapshot.series.target === target}
              >
                {target === 1 ? 'Single' : `Best of ${target}`}
              </button>
            ))}
          </fieldset>
          <fieldset>
            <legend>Turn limit</legend>
            <button
              className={snapshot.turnLimitMs === null ? 'is-active' : ''}
              onClick={() => onFormat({ turnLimitMs: null })}
              aria-pressed={snapshot.turnLimitMs === null}
            >
              None
            </button>
            {TURN_LIMITS_MS.map((limit) => (
              <button
                key={limit}
                className={snapshot.turnLimitMs === limit ? 'is-active' : ''}
                onClick={() => onFormat({ turnLimitMs: limit })}
                aria-pressed={snapshot.turnLimitMs === limit}
              >
                {limit / 1000}s
              </button>
            ))}
          </fieldset>
        </div>
      )}

      {snapshot.phase === 'active' && canAct && !outstanding && (
        <button className="draw-offer" onClick={onOfferDraw}>Offer a draw</button>
      )}
      {outstanding && mine && (
        <p className="draw-pending" role="status">Draw offered. Waiting for their answer.</p>
      )}
      {outstanding && !mine && canAct && (
        <div className="draw-response" role="group" aria-label="Answer the draw offer">
          <p>They offered a draw.</p>
          <button className="draw-accept" onClick={() => onRespondToDraw(true)}>Accept</button>
          <button className="draw-decline" onClick={() => onRespondToDraw(false)}>Keep playing</button>
        </div>
      )}

      {complete && snapshot.moves.length > 0 && (
        <button className="replay-button" onClick={onReplay} disabled={replaying}>
          <span aria-hidden="true">▷</span>
          {replaying ? 'Replaying…' : `Replay ${snapshot.moves.length} moves`}
        </button>
      )}
    </section>
  );
}
