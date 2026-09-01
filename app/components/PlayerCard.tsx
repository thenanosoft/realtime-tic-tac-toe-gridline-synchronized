import type { Mark } from '../../shared/game';
import type { PlayerSnapshot, PresenceState, RoomSnapshot } from '../../shared/protocol';

interface PlayerCardProps {
  mark: Mark;
  player?: PlayerSnapshot;
  isSelf: boolean;
  snapshot: RoomSnapshot;
}

export function PlayerCard({ mark, player, isSelf, snapshot }: PlayerCardProps) {
  const active = snapshot.phase === 'active' && snapshot.turn === mark;
  const won = snapshot.winner === mark;
  const lost = Boolean(snapshot.winner && snapshot.winner !== mark);
  // Presence is rendered, never derived. The server owns the state machine, so
  // a client that guessed from a boolean would disagree with it under latency.
  const presenceLabel: Record<PresenceState, string> = {
    online: 'Signal live',
    reconnecting: 'Reconnecting…',
    offline: 'Signal lost',
    expired: 'Session expired',
  };
  const online = player?.presence === 'online';
  const stateLabel = !player
    ? 'Waiting to join'
    : player.presence === 'reconnecting'
      ? 'Reconnecting'
      : player.presence !== 'online'
        ? 'Away'
        : won
        ? 'Winner'
        : lost
          ? 'Good game'
          : active
            ? isSelf ? 'Your turn' : 'Playing'
            : snapshot.phase === 'active'
              ? 'Waiting'
              : 'Ready';

  return (
    <article className={`player-card player-${mark.toLowerCase()} ${active ? 'is-active' : ''} ${won ? 'is-winner' : ''} ${lost ? 'is-loser' : ''}`}>
      <div className="presence-rail" aria-hidden="true"><i /><i /><i /></div>
      <div className="player-card-top">
        <span className="player-slot">PLAYER {mark} / {String(mark === 'X' ? 1 : 2).padStart(2, '0')}</span>
        {isSelf && <span className="you-tag">YOU</span>}
      </div>
      <div className={`player-emblem emblem-${mark.toLowerCase()}`} aria-hidden="true">
        {mark === 'X' ? <span className="emblem-drawn-x"><i /><i /></span> : <span className="emblem-drawn-o" />}
      </div>
      <h2>{player?.name ?? 'Waiting…'}</h2>
      <div className={`presence presence-${player?.presence ?? 'waiting'} ${online ? 'online' : 'offline'}`}>
        <span aria-hidden="true" />
        {player ? presenceLabel[player.presence] : 'Open invitation'}
        {player && player.connectionCount > 1 && (
          <b className="window-count" title="This player has more than one window open">
            {player.connectionCount} windows
          </b>
        )}
      </div>
      <div className="player-state"><i aria-hidden="true" />{stateLabel}</div>
    </article>
  );
}
