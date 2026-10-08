'use client';

import { useEffect, useState } from 'react';

interface TurnClockProps {
  /** Milliseconds left as measured by the server when the snapshot was cut. */
  msRemaining: number;
  /** Restarts the local clock whenever a newer authoritative snapshot arrives. */
  revision: number;
  limitMs: number;
  yourTurn: boolean;
}

/**
 * Shows the turn limit. It does not enforce it.
 *
 * The distinction is the whole point of P9-04. This component reads
 * `performance.now()`, which is monotonic, and counts down from a duration the
 * server measured - so a wrong device clock cannot shift it. But even a
 * perfectly accurate render here decides nothing: the server holds the deadline
 * and passes the turn itself. A backgrounded tab whose timers are throttled
 * will simply find the turn already gone when it wakes, which is the correct
 * outcome and the one a client-side timer could never guarantee.
 */
export function TurnClock({ msRemaining, revision, limitMs, yourTurn }: TurnClockProps) {
  const [remaining, setRemaining] = useState(msRemaining);

  useEffect(() => {
    const origin = performance.now();
    const tick = () => setRemaining(Math.max(0, msRemaining - (performance.now() - origin)));
    tick();
    const timer = setInterval(tick, 120);
    return () => clearInterval(timer);
  }, [msRemaining, revision]);

  const seconds = Math.ceil(remaining / 1000);
  const fraction = Math.max(0, Math.min(1, remaining / limitMs));
  const urgent = remaining <= 5_000;

  return (
    <div
      className={`turn-clock ${urgent ? 'is-urgent' : ''} ${yourTurn ? 'is-yours' : ''}`}
      // Polite, and only counting down the viewer's own turn: a screen reader
      // announcing every second of the opponent's turn would be unusable.
      aria-live={yourTurn && urgent ? 'assertive' : 'off'}
      aria-label={yourTurn ? `${seconds} seconds left in your turn` : `${seconds} seconds left in their turn`}
    >
      <span className="turn-clock-track" aria-hidden="true">
        <i style={{ transform: `scaleX(${fraction})` }} />
      </span>
      <strong>{seconds}<small>s</small></strong>
    </div>
  );
}
