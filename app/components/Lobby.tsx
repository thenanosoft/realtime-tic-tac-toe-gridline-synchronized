'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ConnectionState } from '../hooks/useGameSocket';

interface LobbyProps {
  connection: ConnectionState;
  busy: boolean;
  /** Set when a join was refused because the room already has two players. */
  fullRoomCode: string | null;
  onCreate(options?: { encrypted?: boolean }): void;
  onJoin(code: string): void;
  onSpectate(code: string): void;
}

export function Lobby({ connection, busy, fullRoomCode, onCreate, onJoin, onSpectate }: LobbyProps) {
  const [code, setCode] = useState('');
  // On by default. A room that is private only when you remember to ask is a
  // room that is usually not private.
  const [encrypted, setEncrypted] = useState(true);
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
          <button className="primary-action" onClick={() => onCreate({ encrypted })} disabled={unavailable}>
            <span>{busy ? 'Opening your room…' : 'Open a private room'}</span><b aria-hidden="true">↗</b>
          </button>
          <label className="encryption-choice">
            <input
              type="checkbox"
              checked={encrypted}
              onChange={(event) => setEncrypted(event.target.checked)}
              disabled={unavailable}
            />
            <span>
              <strong>Encrypt the conversation</strong>
              <small>
                The key is generated here and travels only in the invitation link. Chat and images are sealed
                before they leave this browser, so the server relays what it cannot read.
              </small>
            </span>
          </label>
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
        {fullRoomCode && (
          // A full room is not a dead end. Offered rather than done automatically:
          // watching is a different thing from playing and should be chosen.
          <p className="spectate-offer">
            <span aria-hidden="true">◉</span>
            Room <b>{fullRoomCode}</b> already has two players.
            <button onClick={() => onSpectate(fullRoomCode)} disabled={unavailable}>Watch instead</button>
          </p>
        )}
        <p className="code-note">
          <span aria-hidden="true">⌁</span>
          A room code is enough to play. An encrypted room also needs its invitation link, which
          carries the key - without it the match works and the conversation stays sealed.
        </p>
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
