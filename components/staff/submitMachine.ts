// One submit at a time — the state machine behind every staff form and dialog
// that sends money or a bill change (settle, balance, pass adjust, cash in/out,
// expenses). It used to be a `submitting` boolean beside an `error` string,
// guarded by React state alone: two taps inside one frame both read
// `submitting === false` and both sent.
//
//   idle ──submit──▶ submitting ──succeeded──▶ done ──reset──▶ idle
//     ▲                 │   │
//     │                 │   └──stale──▶ stale (the order moved on: look again)
//     └──edit── error ◀─┘failed
//                 └──submit──▶ submitting
//   idle | error ──gone──▶ gone   (settled/cancelled elsewhere; only Close)
//
// `submitting` is the single in-flight state: `submit` is refused from it (and
// from `done`, so a dialog that has finished can't send twice while it closes).
// A request in flight is never interrupted by `gone` — its own answer decides.
//
// Pure reducer + a tiny hook whose `send` applies the event to a ref
// synchronously, so the guard holds even before React re-renders.

import { useCallback, useRef, useState } from 'react';

export const SUBMIT_PHASES = ['idle', 'submitting', 'done', 'error', 'stale', 'gone'] as const;
export type SubmitPhase = (typeof SUBMIT_PHASES)[number];

export type SubmitState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'done' }
  | { phase: 'error'; message: string }
  | { phase: 'stale'; message: string }
  | { phase: 'gone'; message: string };

export type SubmitEvent =
  | { type: 'submit' }
  | { type: 'succeeded' }
  | { type: 'failed'; message: string }
  | { type: 'stale'; message: string }
  | { type: 'gone'; message: string }
  /** The staffer changed the form: an old error no longer applies. */
  | { type: 'edit' }
  /** Ready for the next entry (a form that stays open after a success). */
  | { type: 'reset' };

/** Which phase each event leads to, from each phase. Anything not listed is refused. */
export const SUBMIT_TRANSITIONS: Readonly<Record<SubmitPhase, Partial<Record<SubmitEvent['type'], SubmitPhase>>>> = {
  idle: { submit: 'submitting', gone: 'gone', edit: 'idle', reset: 'idle' },
  submitting: { succeeded: 'done', failed: 'error', stale: 'stale' },
  done: { reset: 'idle' },
  error: { submit: 'submitting', edit: 'idle', gone: 'gone', reset: 'idle' },
  // The order changed under the request: the screen refetches it; the next tap
  // is a deliberate one, on what the staffer now sees.
  stale: { submit: 'submitting', edit: 'idle', gone: 'gone', reset: 'idle' },
  gone: {},
};

export const INITIAL_SUBMIT_STATE: SubmitState = { phase: 'idle' };

/** The next state, or the same object when the event is refused. */
export function submitReducer(state: SubmitState, event: SubmitEvent): SubmitState {
  const to = SUBMIT_TRANSITIONS[state.phase][event.type];
  if (!to) return state;
  switch (to) {
    case 'error':
      return { phase: 'error', message: (event as { message: string }).message };
    case 'stale':
      return { phase: 'stale', message: (event as { message: string }).message };
    case 'gone':
      return { phase: 'gone', message: (event as { message: string }).message };
    case 'idle':
      return state.phase === 'idle' ? state : { phase: 'idle' };
    default:
      return { phase: to };
  }
}

export function isSubmitting(state: SubmitState): boolean {
  return state.phase === 'submitting';
}

/** A submit would be accepted now. */
export function canSubmit(state: SubmitState): boolean {
  return SUBMIT_TRANSITIONS[state.phase].submit !== undefined;
}

/** The line to show under the form, if any. */
export function submitMessage(state: SubmitState): string | null {
  return state.phase === 'error' || state.phase === 'stale' || state.phase === 'gone' ? state.message : null;
}

/**
 * Any pure reducer as a hook whose `send` applies the event to a ref at once
 * and returns whether it was accepted (the reducer returned a new object). The
 * in-flight guard is then just `if (!send({ type: 'submit' })) return;` — it
 * holds for a second tap in the same frame, before React has re-rendered.
 */
export function useMachine<S, E>(reducer: (state: S, event: E) => S, initial: S | (() => S)) {
  const [state, setState] = useState<S>(initial);
  const ref = useRef<S>(state);
  const send = useCallback(
    (event: E): boolean => {
      const next = reducer(ref.current, event);
      if (Object.is(next, ref.current)) return false;
      ref.current = next;
      setState(next);
      return true;
    },
    [reducer],
  );
  return { state, send };
}

/** The submit machine as a hook (see useMachine). */
export function useSubmitMachine(initial: SubmitState = INITIAL_SUBMIT_STATE) {
  return useMachine(submitReducer, initial);
}
