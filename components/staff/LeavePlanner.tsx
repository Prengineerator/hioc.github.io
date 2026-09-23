'use client';

// LEAVE-3 — one page, two audiences.
//
// Every staffer plans their own week here. Someone with `leave_approve` also
// sees the team grid below it. Keeping both on one screen matters: a manager is
// also a person who takes days off, and sending them to a different page to do
// their own planning would guarantee they forget.

import { useCallback, useEffect, useState } from 'react';
import type { LeaveRequest } from '@/lib/types';

interface WeekInfo {
  weekStart: string;
  weekEnd: string;
  requestableDates: string[];
  labels: string[];
  deadline: string;
  daysLeft: number;
  open: boolean;
}

interface MineResponse {
  week: WeekInfo;
  requests: LeaveRequest[];
  maxPerWeek: number;
}

interface TeamRow {
  user_id: string;
  name: string;
  role: string;
  requests: LeaveRequest[];
  hasPlanned: boolean;
}

interface TeamResponse {
  week: WeekInfo;
  rows: TeamRow[];
  perDay: { date: string; label: string; approved: number; requested: number }[];
  teamSize: number;
  pending: number;
  notPlanned: number;
}

function deadlineText(week: WeekInfo): string {
  if (!week.open) return 'Planning for this week has closed.';
  if (week.daysLeft === 0) return 'Closes tonight.';
  if (week.daysLeft === 1) return 'Closes tomorrow (Saturday).';
  return `Closes Saturday — ${week.daysLeft} days left.`;
}

export function LeavePlanner({ canApprove }: { canApprove: boolean }) {
  const [mine, setMine] = useState<MineResponse | null>(null);
  const [team, setTeam] = useState<TeamResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const [mineRes, teamRes] = await Promise.all([
        fetch('/api/leave', { cache: 'no-store' }),
        canApprove ? fetch('/api/leave/team', { cache: 'no-store' }) : Promise.resolve(null),
      ]);
      if (mineRes.ok) setMine((await mineRes.json()) as MineResponse);
      if (teamRes && teamRes.ok) setTeam((await teamRes.json()) as TeamResponse);
    } catch {
      setError('Could not load the leave plan.');
    } finally {
      setLoading(false);
    }
  }, [canApprove]);

  useEffect(() => {
    void load();
  }, [load]);

  async function request(date: string) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leave_date: date, reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body.error as string) ?? 'Could not save that.');
        return;
      }
      setReason('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(date: string) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/leave', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leave_date: date }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body.error as string) ?? 'Could not withdraw that.');
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="mx-auto max-w-3xl px-4 py-16 text-muted">Loading…</div>;
  if (!mine) return <div className="mx-auto max-w-3xl px-4 py-16 text-red-700">{error || 'Unavailable.'}</div>;

  const byDate = new Map(mine.requests.map((r) => [r.leave_date, r]));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-charcoal">Next week&apos;s leave</h1>
      <p className="mt-1 text-sm text-muted">
        Week of {mine.week.requestableDates[0]} · {deadlineText(mine.week)}
      </p>

      <section className="mt-6 rounded-md border border-[#e5e5e5] bg-white p-5">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted">My days off</h2>
        <p className="mt-2 text-sm text-muted">
          Pick the day you&apos;d like off. Your manager approves it before the week starts.
          Weekends aren&apos;t available.
        </p>

        <div className="mt-4 grid grid-cols-5 gap-2">
          {mine.week.requestableDates.map((date, i) => {
            const req = byDate.get(date);
            const status = req?.status;
            const tone =
              status === 'approved'
                ? 'border-green-500 bg-green-50 text-green-900'
                : status === 'requested'
                  ? 'border-amber-400 bg-amber-50 text-amber-900'
                  : status === 'declined'
                    ? 'border-red-300 bg-red-50 text-red-800'
                    : 'border-[#ddd] bg-white text-charcoal';
            return (
              <button
                key={date}
                type="button"
                disabled={busy || !mine.week.open || status === 'approved'}
                onClick={() => (req && status !== 'declined' ? withdraw(date) : request(date))}
                className={`rounded-md border px-2 py-3 text-center text-sm transition-colors disabled:opacity-60 ${tone}`}
              >
                <span className="block font-bold">{mine.week.labels[i].split(' ')[0]}</span>
                <span className="block text-xs">{mine.week.labels[i].split(' ').slice(1).join(' ')}</span>
                {status ? <span className="mt-1 block text-[10px] uppercase">{status}</span> : null}
              </button>
            );
          })}
        </div>

        {mine.week.open ? (
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional) — helps your manager decide"
            className="mt-3 w-full rounded-md border border-[#ddd] px-3 py-2 text-sm"
          />
        ) : null}

        {mine.requests.some((r) => r.status === 'declined') ? (
          <div className="mt-3 space-y-1">
            {mine.requests
              .filter((r) => r.status === 'declined')
              .map((r) => (
                <p key={r.id} className="text-sm text-red-800">
                  {r.leave_date} declined{r.decision_note ? ` — ${r.decision_note}` : ''}. Tap
                  another day to ask again.
                </p>
              ))}
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      </section>

      {canApprove && team ? (
        <TeamPanel team={team} onChanged={load} />
      ) : null}
    </div>
  );
}

function TeamPanel({ team, onChanged }: { team: TeamResponse; onChanged: () => void }) {
  const [busyId, setBusyId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  async function decide(id: string, action: 'approve' | 'decline') {
    setBusyId(id);
    setError('');
    try {
      const res = await fetch('/api/leave/team', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, note }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body.error as string) ?? 'Could not save that decision.');
        return;
      }
      setNote('');
      onChanged();
    } finally {
      setBusyId('');
    }
  }

  return (
    <section className="mt-8 rounded-md border border-[#e5e5e5] bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted">The team</h2>

      {team.pending > 0 || team.notPlanned > 0 ? (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {team.pending > 0 ? (
            <>
              <strong>{team.pending}</strong> {team.pending === 1 ? 'request is' : 'requests are'}{' '}
              waiting on you.{' '}
            </>
          ) : null}
          {team.notPlanned > 0 ? (
            <>
              <strong>{team.notPlanned}</strong> of {team.teamSize} haven&apos;t planned yet.
            </>
          ) : null}
        </p>
      ) : (
        <p className="mt-2 text-sm text-green-700">Everything for next week is decided.</p>
      )}

      {/* Coverage at a glance — the number that makes this screen worth opening. */}
      <div className="mt-4 grid grid-cols-5 gap-2 text-center text-xs">
        {team.perDay.map((d) => {
          const off = d.approved + d.requested;
          const heavy = team.teamSize > 0 && off >= Math.ceil(team.teamSize / 2);
          return (
            <div
              key={d.date}
              className={`rounded-md border px-2 py-2 ${
                heavy ? 'border-red-300 bg-red-50 text-red-800' : 'border-[#eee] text-muted'
              }`}
              title={`${d.approved} approved, ${d.requested} pending`}
            >
              <span className="block font-bold text-charcoal">{d.label.split(' ')[0]}</span>
              <span className="block">{off} off</span>
            </div>
          );
        })}
      </div>

      <ul className="mt-4 divide-y divide-[#f0f0f0]">
        {team.rows.map((row) => (
          <li key={row.user_id} className="py-3">
            <div className="flex items-center justify-between">
              <span className="font-bold text-charcoal">{row.name}</span>
              {!row.hasPlanned ? (
                <span className="text-xs text-muted">nothing planned</span>
              ) : null}
            </div>
            {row.requests.map((r) => (
              <div key={r.id} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-charcoal">{r.leave_date}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] ${
                    r.status === 'approved'
                      ? 'bg-green-100 text-green-900'
                      : r.status === 'declined'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-amber-100 text-amber-900'
                  }`}
                >
                  {r.status}
                </span>
                {r.reason ? <span className="text-xs text-muted">“{r.reason}”</span> : null}
                {r.status !== 'approved' ? (
                  <button
                    type="button"
                    disabled={busyId === r.id}
                    onClick={() => decide(r.id, 'approve')}
                    className="rounded-md bg-tan px-2.5 py-1 text-xs font-bold text-cream disabled:opacity-50"
                  >
                    Approve
                  </button>
                ) : null}
                {r.status !== 'declined' ? (
                  <button
                    type="button"
                    disabled={busyId === r.id}
                    onClick={() => decide(r.id, 'decline')}
                    className="rounded-md border border-[#ddd] px-2.5 py-1 text-xs disabled:opacity-50"
                  >
                    Decline
                  </button>
                ) : null}
              </div>
            ))}
          </li>
        ))}
      </ul>

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note — required when declining, and the staffer sees it"
        className="mt-4 w-full rounded-md border border-[#ddd] px-3 py-2 text-sm"
      />

      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
    </section>
  );
}
