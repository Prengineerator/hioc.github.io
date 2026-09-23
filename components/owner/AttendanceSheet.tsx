'use client';

// SHEET-1 / SHEET-2 — the owner's month grid and the correction panel.
//
// Design stance: the owner should be able to spot a problem WITHOUT clicking.
// So each cell carries its state in a glyph and a colour, and the things that
// need a human — needs-approval, integrity flags, manual entries — are the ones
// that stand out. Hours are secondary; exceptions are the point.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AttendanceSession } from '@/lib/types';
import type { DayRollup } from '@/lib/attendance/day';

interface Row {
  user_id: string;
  name: string;
  role: string;
  configured: boolean;
  days: DayRollup[];
  totals: {
    present: number;
    half: number;
    absent: number;
    off: number;
    paidLeave: number;
    needsApproval: number;
    lateMarks: number;
    workedMinutes: number;
    otMinutes: number;
  };
}

interface SheetResponse {
  month: string;
  dates: string[];
  rows: Row[];
  needsApprovalTotal: number;
}

function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** One glyph per day state — the whole grid is readable without a legend lookup. */
function cellGlyph(d: DayRollup): { text: string; className: string; title: string } {
  if (d.status === 'not_employed') return { text: '', className: 'text-[#ddd]', title: 'Not employed' };
  if (d.needsApproval)
    return {
      text: '!',
      className: 'bg-amber-100 text-amber-900 font-bold',
      title: `Needs approval — ${hm(d.rawMinutes)} recorded but not confirmed`,
    };
  if (d.status === 'weekly_off') return { text: 'O', className: 'text-muted', title: 'Weekly off' };
  if (d.status === 'paid_leave') return { text: 'PL', className: 'bg-blue-50 text-blue-800', title: 'Paid leave' };
  if (d.status === 'unpaid_leave') return { text: 'UL', className: 'text-muted', title: 'Unpaid leave' };
  if (d.status === 'absent') return { text: 'A', className: 'bg-red-50 text-red-700', title: 'Absent' };
  if (d.status === 'half_day')
    return { text: 'H', className: 'bg-orange-50 text-orange-800', title: `Half day — ${hm(d.workedMinutes)}` };
  const hours = Math.round(d.workedMinutes / 60);
  return {
    text: String(hours),
    className: d.isLate ? 'bg-yellow-50 text-yellow-900' : 'text-charcoal',
    title: `${hm(d.workedMinutes)}${d.isLate ? ` · late by ${d.lateMinutes}m` : ''}${
      d.otMinutes ? ` · OT ${hm(d.otMinutes)}` : ''
    }`,
  };
}

export function AttendanceSheet() {
  const [month, setMonth] = useState(currentMonth);
  const [data, setData] = useState<SheetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyNeedsApproval, setOnlyNeedsApproval] = useState(false);
  const [selected, setSelected] = useState<{ row: Row; day: DayRollup } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/owner/attendance?month=${month}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body.error as string) ?? 'Could not load the attendance sheet.');
        setData(null);
        return;
      }
      setData((await res.json()) as SheetResponse);
    } catch {
      setError('Could not load the attendance sheet.');
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    return onlyNeedsApproval ? data.rows.filter((r) => r.totals.needsApproval > 0) : data.rows;
  }, [data, onlyNeedsApproval]);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-charcoal">Attendance</h1>
        <div className="flex items-center gap-3">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-md border border-[#ddd] px-3 py-2 text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-charcoal">
            <input
              type="checkbox"
              checked={onlyNeedsApproval}
              onChange={(e) => setOnlyNeedsApproval(e.target.checked)}
            />
            Needs approval only
          </label>
        </div>
      </div>

      {data && data.needsApprovalTotal > 0 ? (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>{data.needsApprovalTotal}</strong>{' '}
          {data.needsApprovalTotal === 1 ? 'day is' : 'days are'} waiting on you — usually a missed
          clock-out. These count as <strong>zero hours</strong> until you approve or correct them,
          and payroll can&apos;t be finalized while any remain.
        </p>
      ) : null}

      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      {loading ? <p className="mt-6 text-sm text-muted">Loading…</p> : null}

      {data && !loading ? (
        <div className="mt-6 overflow-x-auto rounded-md border border-[#e5e5e5] bg-white">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[#e5e5e5]">
                <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-bold text-charcoal">
                  Staff
                </th>
                {data.dates.map((d) => (
                  <th key={d} className="px-1 py-2 text-center text-[11px] font-normal text-muted">
                    {Number(d.slice(-2))}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-bold text-charcoal">Hours</th>
                <th className="px-3 py-2 text-right font-bold text-charcoal">OT</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.user_id} className="border-b border-[#f0f0f0]">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-2">
                    <span className="font-bold text-charcoal">{row.name}</span>
                    {!row.configured ? (
                      <span
                        className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700"
                        title="No salary or shift on record — payroll cannot compute for this person"
                      >
                        not set up
                      </span>
                    ) : null}
                  </td>
                  {row.days.map((d) => {
                    const g = cellGlyph(d);
                    return (
                      <td key={d.date} className="px-0.5 py-1 text-center">
                        <button
                          type="button"
                          title={g.title}
                          onClick={() => setSelected({ row, day: d })}
                          className={`h-7 w-7 rounded text-[11px] ${g.className} hover:ring-1 hover:ring-tan`}
                        >
                          {g.text}
                        </button>
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap px-3 py-2 text-right text-charcoal">
                    {hm(row.totals.workedMinutes)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-muted">
                    {row.totals.otMinutes ? hm(row.totals.otMinutes) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-muted">
        Numbers are hours worked · <strong>H</strong> half day · <strong>A</strong> absent ·{' '}
        <strong>O</strong> weekly off · <strong>PL</strong> paid leave · <strong>!</strong> needs
        approval · yellow = late arrival
      </p>

      {selected ? (
        <DayPanel
          row={selected.row}
          day={selected.day}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function DayPanel({
  row,
  day,
  onClose,
  onChanged,
}: {
  row: Row;
  day: DayRollup;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [sessions, setSessions] = useState<AttendanceSession[] | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          `/api/owner/attendance/day?user_id=${row.user_id}&date=${day.date}`,
          { cache: 'no-store' },
        );
        if (res.ok) setSessions((await res.json()).sessions as AttendanceSession[]);
      } catch {
        /* the rollup above is still shown */
      }
    })();
  }, [row.user_id, day.date]);

  async function act(sessionId: string, action: 'approve' | 'void') {
    if (!reason.trim()) {
      setError('A reason is required — this changes what someone gets paid.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/owner/attendance/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, action, reason: reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body.error as string) ?? 'Could not save that change.');
        return;
      }
      onChanged();
    } catch {
      setError('Network problem — try again.');
    } finally {
      setBusy(false);
    }
  }

  const istTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata',
    });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center">
      <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-t-lg bg-white p-5 sm:rounded-lg">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-charcoal">{row.name}</h2>
            <p className="text-sm text-muted">{day.date}</p>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-muted underline">
            Close
          </button>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted">Status</dt>
          <dd className="text-charcoal">{day.status.replace('_', ' ')}</dd>
          <dt className="text-muted">Counted hours</dt>
          <dd className="text-charcoal">{hm(day.workedMinutes)}</dd>
          {day.rawMinutes !== day.workedMinutes ? (
            <>
              <dt className="text-muted">Recorded (uncounted)</dt>
              <dd className="text-charcoal">{hm(day.rawMinutes)}</dd>
            </>
          ) : null}
          {day.autoBreakMinutes ? (
            <>
              <dt className="text-muted">Break deducted</dt>
              <dd className="text-charcoal">{day.autoBreakMinutes}m</dd>
            </>
          ) : null}
          {day.isLate ? (
            <>
              <dt className="text-muted">Late by</dt>
              <dd className="text-charcoal">{day.lateMinutes}m</dd>
            </>
          ) : null}
          {day.flags.length ? (
            <>
              <dt className="text-muted">Flags</dt>
              <dd className="text-charcoal">{day.flags.join(', ')}</dd>
            </>
          ) : null}
        </dl>

        <h3 className="mt-5 text-sm font-bold uppercase tracking-[0.15em] text-muted">Punches</h3>
        {sessions === null ? (
          <p className="mt-2 text-sm text-muted">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No punches recorded.</p>
        ) : (
          <ul className="mt-2 space-y-3">
            {sessions.map((s) => (
              <li key={s.id} className="rounded-md border border-[#e5e5e5] p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-charcoal">
                    {istTime(s.clock_in_at)} → {s.clock_out_at ? istTime(s.clock_out_at) : 'still open'}
                  </span>
                  <span className="text-xs text-muted">{s.status.replace('_', ' ')}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
                  {s.source === 'manual' ? (
                    <span className="rounded bg-[#f0ece7] px-1.5 py-0.5">manual entry</span>
                  ) : null}
                  {s.clock_in_distance_m !== null ? (
                    <span>in: {Math.round(Number(s.clock_in_distance_m))} m away</span>
                  ) : null}
                  {s.clock_out_distance_m !== null ? (
                    <span>out: {Math.round(Number(s.clock_out_distance_m))} m away</span>
                  ) : null}
                  {s.clock_in_lat !== null ? (
                    <a
                      className="text-tan underline"
                      href={`https://www.google.com/maps?q=${s.clock_in_lat},${s.clock_in_lng}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      map
                    </a>
                  ) : null}
                  {(s.flags ?? []).map((f) => (
                    <span key={f} className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-900">
                      {f.replace('_', ' ')}
                    </span>
                  ))}
                </div>
                {s.status === 'auto_closed' && !s.approved_at ? (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => act(s.id, 'approve')}
                      className="rounded-md bg-tan px-3 py-1.5 text-xs font-bold text-cream disabled:opacity-50"
                    >
                      Approve as-is
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => act(s.id, 'void')}
                      className="rounded-md border border-[#ddd] px-3 py-1.5 text-xs disabled:opacity-50"
                    >
                      Void
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <label className="mt-4 block text-sm">
          <span className="font-bold text-charcoal">Reason</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. confirmed with Ravi, left at 7pm"
            className="mt-1 w-full rounded-md border border-[#ddd] px-3 py-2"
          />
          <span className="mt-1 block text-xs text-muted">
            Required for every change, and kept on the record permanently.
          </span>
        </label>

        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      </div>
    </div>
  );
}
