'use client';

// PIN-2 — the lock/switch screen: tiles for each active staff member with a
// PIN set, tap → 4-digit PIN pad, success → operator unlocked.
//
// Used two ways by app/staff/layout.tsx / StaffPinOverlay:
//  - `fullScreen` (no session at all yet — middleware.ts let a session-less,
//    enrolled-device request through for exactly this): fills the whole
//    viewport, no header, nothing behind it.
//  - overlay (default): a fixed layer over an already-rendered page, so an
//    in-progress cart underneath survives a re-lock (spec E5 — the cart is
//    client state and this never unmounts it).
//
// GET /api/device/operator (tiles) and POST (verify) are both reachable with
// no session at all — see that route's own comment for why that is the one
// deliberate exception to "a device cookie must never authorise anything".

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const PIN_LENGTH = 4;

interface Operator {
  id: string;
  name: string;
}

export function LockScreen({
  deviceName,
  fullScreen,
  onUnlocked,
}: {
  deviceName: string;
  fullScreen?: boolean;
  /** Called (in addition to router.refresh()) right after a successful
   * unlock, for a caller that wants to update local state immediately
   * rather than wait on the refresh round trip. */
  onUnlocked?: (operatorName: string) => void;
}) {
  const router = useRouter();
  const [operators, setOperators] = useState<Operator[] | null>(null);
  const [selected, setSelected] = useState<Operator | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/device/operator', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setOperators((data.operators as Operator[] | undefined) ?? []);
      })
      .catch(() => {
        if (!cancelled) setOperators([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(nextPin: string, operator: Operator) {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/device/operator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: operator.id, pin: nextPin }),
      });
      if (res.ok) {
        onUnlocked?.(operator.name);
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError((data.error as string | undefined) ?? 'Could not unlock');
      setPin('');
    } catch {
      setError('Network error — try again');
      setPin('');
    } finally {
      setSubmitting(false);
    }
  }

  function tapDigit(digit: string) {
    if (submitting || !selected) return;
    const next = (pin + digit).slice(0, PIN_LENGTH);
    setPin(next);
    if (next.length === PIN_LENGTH) void submit(next, selected);
  }

  function backspace() {
    setPin((p) => p.slice(0, -1));
  }

  function pickOperator(op: Operator) {
    setSelected(op);
    setPin('');
    setError('');
  }

  const containerClass =
    'fixed inset-0 z-50 flex flex-col items-center justify-center px-4 py-8 ' +
    (fullScreen ? 'bg-charcoal' : 'bg-charcoal/95 backdrop-blur-sm');

  return (
    <div className={containerClass} role="dialog" aria-modal="true" aria-label={`Unlock ${deviceName}`}>
      <div className="w-full max-w-sm">
        <p className="text-center text-xs font-bold uppercase tracking-wide text-cream/50">{deviceName}</p>

        {!selected ? (
          <>
            <h1 className="mt-2 text-center text-xl font-bold text-cream">Who&apos;s on the till?</h1>
            {operators === null ? (
              <p className="mt-6 text-center text-sm text-cream/60">Loading…</p>
            ) : operators.length === 0 ? (
              <p className="mt-6 text-center text-sm text-cream/60">
                No one has a PIN set yet — ask the owner to set one under Owner → Staff.
              </p>
            ) : (
              <div className="mt-6 grid grid-cols-2 gap-3">
                {operators.map((op) => (
                  <button
                    key={op.id}
                    type="button"
                    onClick={() => pickOperator(op)}
                    className="flex min-h-[72px] flex-col items-center justify-center gap-2 rounded-lg border border-cream/15 bg-cream/5 px-3 py-4 text-cream transition-colors hover:bg-cream/10"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-tan text-base font-bold text-charcoal">
                      {op.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="truncate text-sm font-bold">{op.name}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="mt-8 text-center text-xs text-cream/40">
              Not on this list?{' '}
              <a href="/staff/login" className="font-bold text-tan underline underline-offset-2">
                Sign in the classic way
              </a>
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-center text-xl font-bold text-cream">{selected.name}</h1>
            <p className="mt-1 text-center text-sm text-cream/60">Enter your PIN</p>

            <div className="mt-5 flex justify-center gap-3">
              {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                <span
                  key={i}
                  className={
                    'h-3.5 w-3.5 rounded-full border ' +
                    (i < pin.length ? 'border-tan bg-tan' : 'border-cream/30 bg-transparent')
                  }
                />
              ))}
            </div>

            {error ? (
              <p role="alert" className="mt-3 text-center text-sm font-bold text-red-300">
                {error}
              </p>
            ) : null}

            <div className="mt-6 grid grid-cols-3 gap-3">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button
                  key={d}
                  type="button"
                  disabled={submitting}
                  onClick={() => tapDigit(d)}
                  className="min-h-[56px] min-w-[56px] rounded-lg bg-cream/10 font-mono text-2xl tabular-nums text-cream transition-colors hover:bg-cream/20 disabled:opacity-50"
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setSelected(null)}
                disabled={submitting}
                className="min-h-[56px] rounded-lg text-sm font-bold text-cream/70 transition-colors hover:text-cream disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => tapDigit('0')}
                className="min-h-[56px] min-w-[56px] rounded-lg bg-cream/10 font-mono text-2xl tabular-nums text-cream transition-colors hover:bg-cream/20 disabled:opacity-50"
              >
                0
              </button>
              <button
                type="button"
                onClick={backspace}
                disabled={submitting || pin.length === 0}
                aria-label="Backspace"
                className="min-h-[56px] rounded-lg text-lg font-bold text-cream/70 transition-colors hover:text-cream disabled:opacity-30"
              >
                ⌫
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
