'use client';

import type { RoomSnapshot } from '../../shared/protocol';
import { LEVEL_PROFILES, SOLO_LEVELS } from '../../shared/solo';
import { useSoloGame } from '../hooks/useSoloGame';
import type { useGameSound } from '../hooks/useGameSound';
import { GameBoard } from './GameBoard';
import { IdentitySigil } from './IdentitySigil';
import { deriveIdentity } from '../../shared/identityArt';

interface SoloRoomProps {
  onLeave(): void;
  playSound: ReturnType<typeof useGameSound>['play'];
}

const PLAYER_ID = 'solo-player';
const COMPUTER_ID = 'solo-computer';

/**
 * The solo screen (P13-01 … P13-03).
 *
 * It renders the same `GameBoard` as a real match by handing it a snapshot it
 * builds itself. That is worth the small amount of assembly below: the board is
 * the piece with the keyboard handling, the winning-line geometry, the
 * optimistic-overlay contract and the accessible labels, and a second
 * implementation of it would drift from the first within a release.
 *
 * Nothing here touches the network. There is no room, no socket and no server
 * state for a game with one person in it.
 */
export function SoloRoom({ onLeave, playSound }: SoloRoomProps) {
  const { state, play, nextRound, setLevel } = useSoloGame();
  const profile = LEVEL_PROFILES[state.level];
  const computerMark = state.playerMark === 'X' ? 'O' : 'X';
  const identity = deriveIdentity('Gridline ' + profile.name);
  const complete = Boolean(state.game.winner || state.game.isDraw);

  // A snapshot shaped exactly like the server's, so the board does not need to
  // know which kind of game it is in.
  const snapshot: RoomSnapshot = {
    roomCode: 'SOLO',
    revision: 1,
    phase: complete ? 'game_over' : 'active',
    board: state.game.board,
    turn: state.game.turn,
    winner: state.game.winner,
    winningLine: state.game.winningLine,
    isDraw: state.game.isDraw,
    round: 1,
    players: [
      { id: PLAYER_ID, name: 'You', mark: state.playerMark, presence: 'online', connectionCount: 1, isHost: true, wantsRematch: false },
      { id: COMPUTER_ID, name: profile.name, mark: computerMark, presence: 'online', connectionCount: 1, isHost: false, wantsRematch: false },
    ],
    spectatorCount: 0,
    spectatorPolicy: { chat: false },
    contentExpiry: false,
    attachmentBytes: 0,
    encryption: { enabled: false, epoch: 0 },
    series: {
      target: 1,
      scores: [
        { playerId: PLAYER_ID, wins: state.record.won },
        { playerId: COMPUTER_ID, wins: state.record.lost },
      ],
      draws: state.record.drawn,
      decidedBy: null,
    },
    turnLimitMs: null,
    drawOffer: null,
    moves: [],
  };

  const headline = state.outcome === 'won'
    ? 'You beat ' + profile.name + '.'
    : state.outcome === 'lost'
      ? profile.name + ' took that one.'
      : state.outcome === 'drew'
        ? 'A draw.'
        : state.thinking
          ? profile.name + ' is thinking…'
          : 'Your move.';

  const handleMove = (cell: number) => {
    play(cell);
    playSound(state.playerMark === 'X' ? 'moveX' : 'moveO');
  };

  return (
    <section className="room-shell solo-shell">
      <div className="arena-light light-x" aria-hidden="true" />
      <div className="arena-light light-o" aria-hidden="true" />
      <div className="room-stage">
        <div className="room-heading">
          <div>
            <span className="room-kicker">SOLO · NOTHING LEAVES THIS DEVICE</span>
            <h1>Against <b>{profile.name}</b></h1>
          </div>
          <div className="room-actions">
            <button className="leave-room" onClick={onLeave} aria-label="Leave the solo game">×</button>
          </div>
        </div>

        <section className="match-panel" aria-label="Difficulty and record">
          <div className="series-line">
            <span className="series-label">LEVEL · {profile.name.toUpperCase()}</span>
            <ol className="series-scores">
              <li className="score-x"><b>W</b><span>{state.record.won}</span></li>
              <li className="score-draw"><b>=</b><span>{state.record.drawn}</span></li>
              <li className="score-o"><b>L</b><span>{state.record.lost}</span></li>
            </ol>
          </div>
          <div className="match-actions">
            {/* The ladder moves by itself on a result; this is for choosing
                directly, which also starts a fresh round rather than handing a
                half-played position to a different opponent. */}
            <fieldset className="level-picker">
              <legend className="sr-only">Difficulty</legend>
              {SOLO_LEVELS.map((level) => (
                <button
                  key={level}
                  className={state.level === level ? 'is-active' : ''}
                  onClick={() => setLevel(level)}
                  aria-pressed={state.level === level}
                  title={LEVEL_PROFILES[level].blurb}
                >
                  {LEVEL_PROFILES[level].name}
                </button>
              ))}
            </fieldset>
          </div>
        </section>

        <div className="arena solo-arena">
          <div className="board-area">
            <div className="board-frame">
              <div className="board-meta">
                <span>01 / ON THIS DEVICE</span>
                <span>{profile.blurb}</span>
              </div>
              <GameBoard
                snapshot={snapshot}
                myMark={state.playerMark}
                interactive={!complete && !state.thinking && state.game.turn === state.playerMark}
                speculation={null}
                onMove={handleMove}
              />
            </div>

            <section className={`game-status tone-${state.outcome ?? (state.thinking ? 'their-turn' : 'your-turn')}`} aria-live="polite" aria-atomic="true">
              <div className="status-signal" aria-hidden="true"><span /></div>
              <div className="status-copy">
                <small>{complete ? 'ROUND OVER' : state.thinking ? 'THINKING' : 'YOUR TURN'}</small>
                <strong>{headline}</strong>
                <p>
                  {complete
                    ? state.outcome === 'won'
                      ? 'The next round steps up a level.'
                      : state.outcome === 'lost'
                        ? 'The next round steps back down.'
                        : 'A draw holds the level.'
                    : profile.blurb}
                </p>
              </div>
              {complete && (
                <button className="rematch-button" onClick={nextRound}>
                  <span aria-hidden="true">↻</span>Next round
                </button>
              )}
            </section>
          </div>

          <aside className="solo-opponent">
            <article className="player-card player-o">
              <div className="player-card-top"><span className="player-slot">OPPONENT</span></div>
              <div className="identity-block">
                <IdentitySigil identity={identity} />
                <span className="identity-words">{profile.name}</span>
              </div>
              <h2>{profile.name}</h2>
              <p className="solo-blurb">{profile.blurb}</p>
            </article>
          </aside>
        </div>
      </div>
    </section>
  );
}
