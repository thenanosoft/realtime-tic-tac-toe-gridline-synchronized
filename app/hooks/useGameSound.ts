'use client';

import { useCallback, useEffect, useState } from 'react';

type SoundName = 'moveX' | 'moveO' | 'start' | 'win' | 'draw';
const MUTE_KEY = 'gridline.muted';

export function useGameSound() {
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setMuted(localStorage.getItem(MUTE_KEY) === 'true');
    });
    return () => { active = false; };
  }, []);

  const play = useCallback((sound: SoundName) => {
    if (muted || typeof window === 'undefined') return;
    const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const now = context.currentTime;
    const notes = sound === 'win' ? [392, 523, 659] : sound === 'start' ? [330, 440] : [sound === 'moveX' ? 240 : sound === 'moveO' ? 360 : 210];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = sound === 'moveX' ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now + index * .07);
      gain.gain.linearRampToValueAtTime(.035, now + index * .07 + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, now + index * .07 + .16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + index * .07);
      oscillator.stop(now + index * .07 + .18);
    });
    setTimeout(() => void context.close(), 600);
  }, [muted]);

  const toggleMuted = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      localStorage.setItem(MUTE_KEY, String(next));
      return next;
    });
  }, []);

  return { muted, toggleMuted, play };
}
