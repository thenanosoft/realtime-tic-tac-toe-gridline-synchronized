'use client';

import { useEffect, useState } from 'react';

export function Countdown({ endsAt }: { endsAt: number }) {
  const [value, setValue] = useState(() => Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
  useEffect(() => {
    const calculate = () => Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    const timer = setInterval(() => setValue(calculate()), 100);
    return () => clearInterval(timer);
  }, [endsAt]);
  return (
    <div className="countdown-overlay" aria-live="assertive" aria-label={`Match starts in ${value || 'now'}`}>
      <small>ROUND STARTING</small>
      <strong key={value}>{value || 'PLAY'}</strong>
    </div>
  );
}
