'use client';

// ATT-3 — the nudge.
//
// The single biggest failure mode for attendance is not fraud, it is simply
// forgetting. This banner costs almost nothing and addresses the whole of it.
//
// It deliberately does NOT block anything. Gating the POS on being clocked in
// is tempting and wrong: the first time GPS misbehaves it would stop service at
// the counter, and a product that stops service gets switched off.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { flags } from '@/lib/flags';

const DISMISS_KEY = 'hioc.attendance.nudgeDismissedOn';

function todayKey(): string {
  // Local date is fine here — this only controls a banner, and re-appearing a
  // few hours early or late has no consequence worth an IST conversion.
  return new Date().toDateString();
}

export function NotClockedInBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!flags.attendance) return;
    if (window.localStorage.getItem(DISMISS_KEY) === todayKey()) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/attendance/me', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        // Only nudge people who actually punch. An owner without an employment
        // record should not be nagged about a shift they do not work.
        if (!data.open && data.configured) setShow(true);
      } catch {
        /* a nudge that fails to load is not worth reporting */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <span>You&apos;re not clocked in.</span>
      <span className="flex items-center gap-3">
        <Link
          href="/staff/attendance"
          className="rounded-md bg-amber-900 px-3 py-1.5 text-xs font-bold text-amber-50"
        >
          Clock in
        </Link>
        <button
          type="button"
          onClick={() => {
            window.localStorage.setItem(DISMISS_KEY, todayKey());
            setShow(false);
          }}
          className="text-xs underline"
          aria-label="Dismiss for today"
        >
          Not now
        </button>
      </span>
    </div>
  );
}
