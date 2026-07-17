'use client';

import { useEffect, useRef } from 'react';

// How often the reminder chime repeats while an order is unacknowledged.
const CHIME_INTERVAL_MS = 5000;

type AudioContextCtor = typeof AudioContext;

/** Plays a short, two-tone "ding" using the Web Audio API. Synth only — no audio asset. */
function playChime(ctx: AudioContext) {
  const now = ctx.currentTime;
  const tones = [
    { freq: 880, start: 0, duration: 0.15 },
    { freq: 1320, start: 0.15, duration: 0.15 },
  ];

  tones.forEach(({ freq, start, duration }) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = freq;

    const startTime = now + start;
    const endTime = startTime + duration;

    // Quick fade in/out so the tone is soft rather than a hard click.
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.2, startTime + 0.02);
    gain.gain.linearRampToValueAtTime(0, endTime);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(startTime);
    oscillator.stop(endTime + 0.02);
  });
}

/**
 * Banner + repeating audio chime shown while one or more newly-arrived orders
 * are sitting unacknowledged in "received" status. Clears itself automatically
 * once `count` drops to 0 (i.e. once the triggering orders have been advanced).
 */
export function NewOrderAlert({ count }: { count: number }) {
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (count <= 0) return undefined;

    const getContext = (): AudioContext | null => {
      try {
        if (!audioCtxRef.current) {
          const Ctor: AudioContextCtor | undefined =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: AudioContextCtor })
              .webkitAudioContext;
          if (!Ctor) return null;
          audioCtxRef.current = new Ctor();
        }
        return audioCtxRef.current;
      } catch {
        return null;
      }
    };

    const chime = () => {
      try {
        const ctx = getContext();
        if (!ctx) return;

        const run = () => {
          try {
            playChime(ctx);
          } catch {
            // Browser blocked/failed playback — fail silently.
          }
        };

        // Browsers may start contexts "suspended" until a user gesture has
        // occurred anywhere on the page; resume() can reject in that case.
        if (ctx.state === 'suspended') {
          ctx.resume().then(run).catch(() => {});
        } else {
          run();
        }
      } catch {
        // AudioContext unavailable/blocked entirely — never break the page.
      }
    };

    chime();
    const interval = setInterval(chime, CHIME_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [count]);

  // Release the audio context when the alert unmounts for good.
  useEffect(() => {
    return () => {
      try {
        audioCtxRef.current?.close().catch(() => {});
      } catch {
        // ignore
      }
    };
  }, []);

  if (count <= 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex items-center gap-2 rounded-md bg-charcoal px-4 py-2 text-sm font-bold text-cream shadow-sm"
    >
      <span aria-hidden="true">🔔</span>
      <span>
        {count} new order{count === 1 ? '' : 's'} waiting — tap &ldquo;Start
        Preparing&rdquo; to clear
      </span>
    </div>
  );
}
