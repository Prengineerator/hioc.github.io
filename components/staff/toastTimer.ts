// A screen's one toast line and the timer that clears it. The staff screens
// used to start a bare setTimeout per toast and never clear it: a toast shown
// within the last one's lifetime was wiped early by the OLD timer, and a timer
// still pending when the screen unmounted fired into a component that was gone.
// One timer per screen: a new toast replaces the pending one, and `dispose`
// (on unmount) cancels it.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ToastTimer {
  /** Show `message`, clearing it after `ms` — replacing any toast still showing. */
  show(message: string, ms: number): void;
  /** Cancel the pending clear (the screen is going away). */
  dispose(): void;
}

/** Pure controller (timers injected), so the replace/dispose rules are unit-tested. */
export function createToastTimer(
  set: (message: string) => void,
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): ToastTimer {
  let pending: unknown = null;
  let disposed = false;
  const stop = () => {
    if (pending !== null) cancel(pending);
    pending = null;
  };
  return {
    show(message, ms) {
      if (disposed) return;
      stop();
      set(message);
      pending = schedule(() => {
        pending = null;
        set('');
      }, ms);
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}

/**
 * `[toast, showToast]` for a component; the timer is cancelled on unmount (and
 * a toast asked for after that — a request answering late — schedules nothing).
 * Made in the effect, so a development double-mount gets a live one back.
 */
export function useToastTimer(defaultMs: number): [string, (message: string, ms?: number) => void] {
  const [toast, setToast] = useState('');
  const timer = useRef<ToastTimer | null>(null);
  useEffect(() => {
    const t = createToastTimer(setToast);
    timer.current = t;
    return () => {
      t.dispose();
      if (timer.current === t) timer.current = null;
    };
  }, []);
  const show = useCallback(
    (message: string, ms?: number) => timer.current?.show(message, ms ?? defaultMs),
    [defaultMs],
  );
  return [toast, show];
}
