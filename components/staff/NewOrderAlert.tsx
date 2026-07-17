'use client';

import { useEffect, useRef } from 'react';

// How often the reminder chime repeats while an order is unacknowledged.
const CHIME_INTERVAL_MS = 5000;

type AudioContextCtor = typeof AudioContext;

/**
 * Plays a loud, urgent alarm designed to be heard over cafe noise. Uses
 * square-wave pulses (rich in harmonics, so they cut through ambient sound far
 * better than a soft sine tone) at high gain, in an alternating four-pulse
 * "nee-naw" pattern (~0.9s). Synth only — no audio asset.
 */
function playChime(ctx: AudioContext) {
  const now = ctx.currentTime;
  const pulses = [
    { freq: 988, start: 0.0, duration: 0.2 },
    { freq: 1319, start: 0.22, duration: 0.2 },
    { freq: 988, start: 0.44, duration: 0.2 },
    { freq: 1319, start: 0.66, duration: 0.26 },
  ];

  for (const { freq, start, duration } of pulses) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    // Square wave + high sustain = maximum audibility. A dedicated peak limiter
    // isn't needed since the pulses don't overlap in time.
    oscillator.type = 'square';
    oscillator.frequency.value = freq;

    const startTime = now + start;
    const endTime = startTime + duration;

    // Fast attack to a loud sustain, quick release — loud but click-free.
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.55, startTime + 0.015);
    gain.gain.setValueAtTime(0.55, endTime - 0.03);
    gain.gain.linearRampToValueAtTime(0, endTime);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(startTime);
    oscillator.stop(endTime + 0.02);
  }
}

/**
 * Banner + repeating audio chime shown while one or more newly-arrived orders
 * are sitting unacknowledged in "received" status. Clears itself automatically
 * once `count` drops to 0 (i.e. once the triggering orders have been advanced).
 */
export function NewOrderAlert({ count }: { count: number }) {
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Previous count, so we chime on a NEW arrival (count goes up) but stay quiet
  // when the count drops because staff accepted/cleared one of several orders.
  const prevCountRef = useRef(0);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    prevCountRef.current = count;
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

    // Only sound immediately when a new order actually arrived; accepting one
    // of several pending orders (a count decrease) must not trigger a buzz.
    if (count > prevCount) chime();
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
        {count} new order{count === 1 ? '' : 's'} waiting — Accept or Reject to clear
      </span>
    </div>
  );
}
