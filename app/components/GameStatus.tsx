import type { StoredSession } from '../lib/session';
import type { RoomSnapshot } from '../../shared/protocol';

export function GameStatus({ snapshot, session, onRematch }: { snapshot: RoomSnapshot; session: StoredSession; onRematch(): void }) {
  const self = snapshot.players.find((player) => player.id === session.playerId);
  const opponent = snapshot.players.find((player) => player.id !== session.playerId);
  const yourTurn = snapshot.phase === 'active' && snapshot.turn === self?.mark;
  const complete = snapshot.phase === 'game_over' || snapshot.phase === 'rematch_waiting';

  let eyebrow = 'MATCH STATUS';
  let title = 'The other side is open.';
  let detail = 'Share the room signal to invite your opponent.';
  let tone = 'waiting';

  if (snapshot.phase === 'countdown') {
    eyebrow = 'SIGNAL FOUND'; title = 'Two minds connected.'; detail = `Round ${snapshot.round} is about to begin.`; tone = 'starting';
  } else if (snapshot.phase === 'paused') {
    eyebrow = 'MATCH SUSPENDED'; title = opponent?.connected ? 'Connection interrupted' : 'Their signal went quiet.'; detail = 'The board is held exactly as it was.'; tone = 'offline';
  } else if (snapshot.phase === 'active') {
    eyebrow = yourTurn ? 'YOUR TURN' : 'THEIR TURN'; title = yourTurn ? 'The plane is yours.' : 'The room is listening to them.'; detail = yourTurn ? 'Choose an open coordinate.' : 'Your side will return when their move lands.'; tone = yourTurn ? 'your-turn' : 'their-turn';
  } else if (complete) {
    if (snapshot.isDraw) {
      eyebrow = 'DRAW'; title = 'Perfectly balanced.'; detail = 'Nine decisions. Nothing between you.'; tone = 'draw';
    } else if (snapshot.winner === self?.mark) {
      eyebrow = 'YOU WON'; title = 'The line is yours.'; detail = 'A clean signal through the noise.'; tone = 'victory';
    } else {
      eyebrow = 'OPPONENT WON'; title = 'Their line held.'; detail = 'The board is ready when you are.'; tone = 'defeat';
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
