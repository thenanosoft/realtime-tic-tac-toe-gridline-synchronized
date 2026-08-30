'use client';

import { useEffect, useState } from 'react';

interface CountdownProps {
  /** Milliseconds remaining as measured by the server when the snapshot was cut. */
  msRemaining: number;
  /** Restarts the local timer whenever a newer authoritative snapshot arrives. */
  revision: number;
}

/**
 * Counts down from a server-measured duration rather than an absolute deadline.
 *
 * The only clock this component reads is `performance.now()`, which is monotonic
 * and unaffected by system clock changes or NTP steps. A player whose device
 * clock is wrong by hours therefore still sees the correct countdown, and no
 * client clock participates in any server-enforced timing (INV-11).
 */
export function Countdown({ msRemaining, revision }: CountdownProps) {
  const [value, setValue] = useState(() => Math.max(0, Math.ceil(msRemaining / 1000)));

  useEffect(() => {
    const origin = performance.now();
    const tick = () => {
      const elapsed = performance.now() - origin;
      setValue(Math.max(0, Math.ceil((msRemaining - elapsed) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [msRemaining, revision]);

  return (
    <div className="countdown-overlay" aria-live="assertive" aria-label={`Match starts in ${value || 'now'}`}>
      <small>ROUND STARTING</small>
      <strong key={value}>{value || 'PLAY'}</strong>
    </div>
  );
}
