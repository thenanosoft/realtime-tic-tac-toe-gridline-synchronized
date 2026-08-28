'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ConnectionState } from '../hooks/useGameSocket';

interface LobbyProps {
  connection: ConnectionState;
  busy: boolean;
  onCreate(): void;
  onJoin(code: string): void;
}

export function Lobby({ connection, busy, onCreate, onJoin }: LobbyProps) {
  const [code, setCode] = useState('');
  const unavailable = connection !== 'connected' || busy;

  useEffect(() => {
    const invitedRoom = new URLSearchParams(window.location.search).get('room');
    if (!invitedRoom) return;
    const frame = requestAnimationFrame(() => setCode(invitedRoom.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)));
    return () => cancelAnimationFrame(frame);
  }, []);

  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    onJoin(code);
  };

  return (
    <section className="lobby-layout">
      <div className="hero-copy">
        <p className="kicker"><span /> ONE ROOM · TWO MINDS</p>
        <h1>Meet me<br /><em>at the center.</em></h1>
        <p className="lede">A private, real-time duel reduced to its purest form. No profiles. No noise. Just nine decisions between you and someone you know.</p>

        <div className="lobby-card">
          <div className="identity-note"><span aria-hidden="true">✦</span><div><small>TEMPORARY IDENTITY</small><strong>A friendly player name is assigned when you enter.</strong></div></div>
          <button className="primary-action" onClick={onCreate} disabled={unavailable}>
            <span>{busy ? 'Opening your room…' : 'Open a private room'}</span><b aria-hidden="true">↗</b>
          </button>
          <div className="divider"><span>OR ENTER A ROOM</span></div>
          <form className="join-row" onSubmit={submitJoin}>
            <label>
              <span className="sr-only">Six-character room code</span>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                placeholder="ROOM CODE"
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
              />
            </label>
            <button className="join-button" disabled={unavailable}>Join</button>
          </form>
        </div>
        <p className="privacy-note"><span aria-hidden="true">⌁</span> No account · Ephemeral chat · Just this session</p>
      </div>

      <div className="game-teaser" aria-label="Preview of a Gridline match">
        <div className="teaser-orbit orbit-one" aria-hidden="true" />
        <div className="teaser-orbit orbit-two" aria-hidden="true" />
        <div className="teaser-topline"><span><i /> LIVE SIGNAL</span><span className="room-code">ROOM · H7K29P</span></div>
        <div className="teaser-player-row">
          <article className="player-mini active x-player">
            <b aria-hidden="true"><i /><i /></b><div><span className="player-label">PLAYER X · ACTIVE</span><strong>CosmicOtter</strong></div>
          </article>
          <span className="versus"><i />VS<i /></span>
          <article className="player-mini o-player">
            <div><span className="player-label">PLAYER O · LIVE</span><strong>SwiftFalcon</strong></div><b aria-hidden="true" />
          </article>
        </div>
        <div className="teaser-board">
          {['X', '', 'O', '', 'X', '', 'O', '', ''].map((value, index) => (
            <span className={`teaser-cell ${value ? `has-${value.toLowerCase()}` : ''}`} key={index}>
              {value === 'X' && <i className="teaser-x" aria-hidden="true"><b /><b /></i>}
              {value === 'O' && <i className="teaser-o" aria-hidden="true" />}
            </span>
          ))}
        </div>
        <div className="turn-preview"><span className="turn-pulse" /><div><small>YOUR TURN</small><strong>The shared plane is listening.</strong></div><span className="turn-count">04<span>s</span></span></div>
      </div>
    </section>
  );
}
