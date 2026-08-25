import type { Mark } from '../../shared/game';
import type { PlayerSnapshot, RoomSnapshot } from '../../shared/protocol';

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
  const stateLabel = !player
    ? 'Waiting to join'
    : !player.connected
      ? 'Reconnecting'
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
      <div className="card-shine" aria-hidden="true" />
      <div className="player-card-top">
        <span className="player-slot">PLAYER {mark}</span>
        {isSelf && <span className="you-tag">YOU</span>}
      </div>
      <div className={`player-emblem emblem-${mark.toLowerCase()}`} aria-hidden="true">{mark}</div>
      <h2>{player?.name ?? 'Waiting…'}</h2>
      <div className={`presence ${player?.connected ? 'online' : 'offline'}`}>
        <span aria-hidden="true" />
        {player?.connected ? 'Connected' : player ? 'Connection lost' : 'Not connected'}
      </div>
      <div className="player-state"><i aria-hidden="true" />{stateLabel}</div>
    </article>
  );
}
