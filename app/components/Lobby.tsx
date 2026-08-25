'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ConnectionState } from '../hooks/useGameSocket';
import { loadPlayerName } from '../lib/session';

interface LobbyProps {
  connection: ConnectionState;
  busy: boolean;
  onCreate(name: string): void;
  onJoin(code: string, name: string): void;
}

export function Lobby({ connection, busy, onCreate, onJoin }: LobbyProps) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const unavailable = connection !== 'connected' || busy;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setName(loadPlayerName());
    });
    return () => { active = false; };
  }, []);

  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    onJoin(code, name);
  };

  return (
    <section className="lobby-layout">
      <div className="hero-copy">
        <p className="kicker">ONE ROOM · TWO PLAYERS</p>
        <h1>Outthink them.<br /><em>One move at a time.</em></h1>
        <p className="lede">A fast, beautifully synchronized duel. Create a private room and invite someone you know.</p>

        <div className="lobby-card">
          <label className="field-label" htmlFor="player-name">YOUR NAME</label>
          <input
            id="player-name"
            className="name-input"
            value={name}
            onChange={(event) => setName(event.target.value.slice(0, 24))}
            placeholder="How should we call you?"
            autoComplete="nickname"
          />
          <button className="primary-action" onClick={() => onCreate(name)} disabled={unavailable}>
            <span>{busy ? 'Creating your room…' : 'Create a room'}</span><b aria-hidden="true">↗</b>
          </button>
          <div className="divider"><span>OR JOIN A MATCH</span></div>
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
        <p className="privacy-note"><span aria-hidden="true">⌁</span> No account required · Rooms expire automatically</p>
      </div>

      <div className="game-teaser" aria-label="Preview of a Gridline match">
        <div className="teaser-topline"><span>LIVE MATCH</span><span className="room-code">ROOM · H7K29P</span></div>
        <div className="teaser-player-row">
          <article className="player-mini active x-player">
            <div><span className="player-label">PLAYER X</span><strong>You</strong></div><b>X</b>
          </article>
          <span className="versus">VS</span>
          <article className="player-mini o-player">
            <b>O</b><div><span className="player-label">PLAYER O</span><strong>Farhan</strong></div>
          </article>
        </div>
        <div className="teaser-board">
          {['X', '', 'O', '', 'X', '', 'O', '', ''].map((value, index) => (
            <span className={`teaser-cell ${value ? `has-${value.toLowerCase()}` : ''}`} key={index}>{value}</span>
          ))}
        </div>
        <div className="turn-preview"><span className="turn-pulse" /><div><small>YOUR TURN</small><strong>Choose your next move</strong></div><span className="turn-count">04<span>s</span></span></div>
      </div>
    </section>
  );
}
