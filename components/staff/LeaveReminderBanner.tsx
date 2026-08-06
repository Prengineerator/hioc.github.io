'use client';

// LEAVE-4 — the in-app reminder.
//
// This is the leg that works today. The WhatsApp nudge needs a Meta-approved
// template and cannot ship in the first release, so the banner carries the
// whole job for now — and since staff open the orders board every shift, it
// reaches them in practice.
//
// Two audiences, two messages, one component: a staffer who has not planned,
// and an approver with requests waiting. Someone can be both.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { flags } from '@/lib/flags';

interface State {
  needsPlan: boolean;
  pendingToDecide: number;
  daysLeft: number;
  open: boolean;
}

const DISMISS_KEY = 'hioc.leave.nudgeDismissedOn';

function todayKey(): string {
  return new Date().toDateString();
}

export function LeaveReminderBanner() {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    if (!flags.attendance) return;
    if (window.localStorage.getItem(DISMISS_KEY) === todayKey()) return;

    let cancelled = false;
    void (async () => {
      try {
        const mineRes = await fetch('/api/leave', { cache: 'no-store' });
        if (!mineRes.ok || cancelled) return;
        const mine = await mineRes.json();
        if (!mine.week?.open) return;

        // 403 here simply means "not an approver", which is the common case —
        // it must not read as an error.
        let pending = 0;
        const teamRes = await fetch('/api/leave/team', { cache: 'no-store' });
        if (teamRes.ok) pending = (await teamRes.json()).pending ?? 0;

        if (cancelled) return;
        setState({
          needsPlan: (mine.requests ?? []).length === 0,
          pendingToDecide: pending,
          daysLeft: mine.week.daysLeft ?? 0,
          open: true,
        });
      } catch {
        /* a nudge that fails to load is not worth reporting */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state || (!state.needsPlan && state.pendingToDecide === 0)) return null;

  const urgent = state.daysLeft <= 1;

  return (
    <div
      className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm ${
        urgent
          ? 'border-red-300 bg-red-50 text-red-900'
          : 'border-amber-300 bg-amber-50 text-amber-900'
      }`}
    >
      <span>
        {state.needsPlan ? <strong>You haven&apos;t planned next week&apos;s day off. </strong> : null}
        {state.pendingToDecide > 0 ? (
          <strong>
            {state.pendingToDecide} leave{' '}
            {state.pendingToDecide === 1 ? 'request needs' : 'requests need'} your decision.{' '}
          </strong>
        ) : null}
        {state.daysLeft === 0
          ? 'Closes tonight.'
          : state.daysLeft === 1
            ? 'Closes tomorrow.'
            : `${state.daysLeft} days left.`}
      </span>
      <span className="flex items-center gap-3">
        <Link
          href="/staff/leave"
          className={`rounded-md px-3 py-1.5 text-xs font-bold ${
            urgent ? 'bg-red-900 text-red-50' : 'bg-amber-900 text-amber-50'
          }`}
        >
          Open leave plan
        </Link>
        <button
          type="button"
          onClick={() => {
            window.localStorage.setItem(DISMISS_KEY, todayKey());
            setState(null);
          }}
          className="text-xs underline"
        >
          Not now
        </button>
      </span>
    </div>
  );
}
