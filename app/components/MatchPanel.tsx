'use client';

import { useState } from 'react';
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
 *
 * **The panel is one row, always.** Its contents change constantly - the format
 * controls close after the first round is decided, the draw button only exists
 * during a round, the replay only after one - and in the first version each of
 * those changed the panel's height and pushed the board down with it. That is
 * precisely the defect Phase 1 was opened to fix (S1-A, P1-01): the board must
 * not move while it is being played. So the format controls live in a popover
 * that is laid out over the arena rather than above it, the decided note is a
 * phrase inside the score line rather than a row of its own, and every control
 * in the row is the same height.
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
  const [formatOpen, setFormatOpen] = useState(false);
  const self = snapshot.players.find((player) => player.id === viewerId);
  const isHost = Boolean(self?.isHost);
  const played = snapshot.series.draws + snapshot.series.scores.reduce((total, score) => total + score.wins, 0);
  // The same rule the server enforces, and no stricter: open until a round has
  // been decided.
  const formatAllowed = isHost && canAct && played === 0;
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
        {snapshot.series.decidedBy && (
          <span className="series-decided" role="status">
            {snapshot.series.decidedBy === viewerId ? 'Series yours' : 'Series theirs'}
          </span>
        )}
      </div>

      <div className="match-actions">
        {isHost && !snapshot.drawOffer && (
          <button
            className={`format-toggle ${formatOpen ? 'is-open' : ''}`}
            onClick={() => setFormatOpen((current) => !current)}
            disabled={!formatAllowed}
            aria-expanded={formatOpen}
            // Present but disabled once a round has been decided, rather than
            // gone: a control that vanishes leaves the host wondering whether
            // they imagined it.
            title={formatAllowed ? undefined : 'The format is set once a round has been decided'}
          >
            <span aria-hidden="true">≡</span>
            <span className="btn-label">Format</span>
          </button>
        )}

        {snapshot.phase === 'active' && canAct && !outstanding && (
          <button className="draw-offer" onClick={onOfferDraw}>Offer a draw</button>
        )}
        {outstanding && mine && <span className="draw-pending" role="status">Draw offered…</span>}
        {outstanding && !mine && canAct && (
          <span className="draw-response" role="group" aria-label="Answer the draw offer">
            <span className="draw-prompt">Draw?</span>
            <button className="draw-accept" onClick={() => onRespondToDraw(true)}>Accept</button>
            <button className="draw-decline" onClick={() => onRespondToDraw(false)}>Keep playing</button>
          </span>
        )}

        {complete && snapshot.moves.length > 0 && (
          <button className="replay-button" onClick={onReplay} disabled={replaying}>
            <span aria-hidden="true">▷</span>
            <span className="btn-label">{replaying ? 'Replaying…' : 'Replay'}</span>
          </button>
        )}
      </div>

      {formatOpen && formatAllowed && (
        // Absolutely positioned, so opening it cannot move the board. The panel
        // keeps its height whatever is inside this.
        <div className="format-popover" role="group" aria-label="Match format">
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
    </section>
  );
}
