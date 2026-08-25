import type { StoredSession } from '../lib/session';
import type { RoomSnapshot } from '../../shared/protocol';

export function GameStatus({ snapshot, session, onRematch }: { snapshot: RoomSnapshot; session: StoredSession; onRematch(): void }) {
  const self = snapshot.players.find((player) => player.id === session.playerId);
  const opponent = snapshot.players.find((player) => player.id !== session.playerId);
  const yourTurn = snapshot.phase === 'active' && snapshot.turn === self?.mark;
  const complete = snapshot.phase === 'game_over' || snapshot.phase === 'rematch_waiting';

  let eyebrow = 'MATCH STATUS';
  let title = 'Waiting for opponent…';
  let detail = 'Share the room code to begin.';
  let tone = 'waiting';

  if (snapshot.phase === 'countdown') {
    eyebrow = 'GET READY'; title = 'Match starting'; detail = `Round ${snapshot.round} is about to begin.`; tone = 'starting';
  } else if (snapshot.phase === 'paused') {
    eyebrow = 'MATCH PAUSED'; title = opponent?.connected ? 'Connection interrupted' : 'Opponent disconnected'; detail = 'Waiting for reconnection. Their place is being held.'; tone = 'offline';
  } else if (snapshot.phase === 'active') {
    eyebrow = yourTurn ? 'YOUR TURN' : 'OPPONENT’S TURN'; title = yourTurn ? 'Make your move' : 'Opponent is thinking'; detail = yourTurn ? 'The board is yours.' : 'The board unlocks when the server confirms their move.'; tone = yourTurn ? 'your-turn' : 'their-turn';
  } else if (complete) {
    if (snapshot.isDraw) {
      eyebrow = 'DRAW'; title = 'Perfectly matched.'; detail = 'Good match. Run it back?'; tone = 'draw';
    } else if (snapshot.winner === self?.mark) {
      eyebrow = 'VICTORY'; title = 'You won.'; detail = 'That line was all yours.'; tone = 'victory';
    } else {
      eyebrow = 'MATCH OVER'; title = 'Opponent won.'; detail = 'Close one. There’s always a rematch.'; tone = 'defeat';
    }
  }

  const selfVoted = Boolean(self?.wantsRematch);
  const opponentVoted = Boolean(opponent?.wantsRematch);
  const rematchLabel = selfVoted ? 'Rematch requested' : opponentVoted ? 'Accept rematch' : 'Rematch';

  return (
    <section className={`game-status tone-${tone}`} aria-live="polite" aria-atomic="true">
      <div className="status-signal" aria-hidden="true"><span /></div>
      <div className="status-copy">
        <small>{eyebrow}</small>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {complete && (
        <button className="rematch-button" onClick={onRematch} disabled={selfVoted || !opponent?.connected}>
          <span aria-hidden="true">↻</span>{rematchLabel}
        </button>
      )}
    </section>
  );
}
