'use client';

// PAY-3 / PAY-4 / PAY-5 — review a month, finalize it, export it.
//
// The expandable derivation is not a nicety. An owner who cannot see where a
// number came from will re-check it by hand, and then the product has saved
// them nothing. Every row opens into the days that produced it.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

interface Segment {
  monthlySalaryInr: number;
  contractedHoursPerDay: number;
  workingDays: number;
  expectedMinutes: number;
  paidMinutes: number;
  otMinutes: number;
  lateMarks: number;
}

interface DayInput {
  date: string;
  status: string;
  workedMinutes: number;
  otMinutes: number;
  isLate: boolean;
}

interface Line {
  user_id: string;
  name: string;
  daysPresent: number;
  daysHalf: number;
  daysAbsent: number;
  daysOff: number;
  daysPaidLeave: number;
  daysNeedingApproval: number;
  workedMinutes: number;
  otMinutes: number;
  lateMarks: number;
  basePayInr: number;
  otPayInr: number;
  deductionsInr: number;
  adjustmentsInr: number;
  netPayInr: number;
  unconfigured: boolean;
  blocked: boolean;
  segments: Segment[];
  days: DayInput[];
}

interface Draft {
  month: string;
  finalized: false;
  lines: Line[];
  blocked: boolean;
}

interface Finalized {
  month: string;
  finalized: true;
  run: { id: string; finalized_at: string; period_start: string; period_end: string };
  lines: Record<string, unknown>[];
}

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const hm = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Escapes a CSV cell, including the leading characters Excel treats as formulas. */
function csvCell(value: string | number): string {
  const s = String(value);
  // A staff name is attacker-influenced text that lands in the owner's Excel.
  const guarded = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function PayrollScreen() {
  const [month, setMonth] = useState(currentMonth);
  const [data, setData] = useState<Draft | Finalized | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/owner/payroll?month=${month}`, { cache: 'no-store' });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Could not load payroll.');
        setData(null);
        return;
      }
      setData(await res.json());
    } catch {
      setError('Could not load payroll.');
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  const draft = data && !data.finalized ? (data as Draft) : null;

  const totals = useMemo(() => {
    if (!draft) return null;
    return draft.lines.reduce(
      (a, l) => ({
        net: a.net + l.netPayInr,
        base: a.base + l.basePayInr,
        ot: a.ot + l.otPayInr,
        people: a.people + (l.unconfigured ? 0 : 1),
      }),
      { net: 0, base: 0, ot: 0, people: 0 },
    );
  }, [draft]);

  async function finalize() {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/owner/payroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body.error as string) ?? 'Could not finalize.');
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!draft) return;
    const header = [
      'Name',
      'Days present',
      'Half days',
      'Absent',
      'Weekly off',
      'Paid leave',
      'Hours worked',
      'OT hours',
      'Late marks',
      'Base pay',
      'OT pay',
      'Deductions',
      'Adjustments',
      'Net pay',
    ];
    const rows = draft.lines.map((l) => [
      l.name,
      l.daysPresent,
      l.daysHalf,
      l.daysAbsent,
      l.daysOff,
      l.daysPaidLeave,
      (l.workedMinutes / 60).toFixed(2),
      (l.otMinutes / 60).toFixed(2),
      l.lateMarks,
      l.basePayInr,
      l.otPayInr,
      l.deductionsInr,
      l.adjustmentsInr,
      l.netPayInr,
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-charcoal">Payroll</h1>
        <div className="flex items-center gap-3">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-md border border-[#ddd] px-3 py-2 text-sm"
          />
          {draft ? (
            <button
              type="button"
              onClick={exportCsv}
              className="rounded-md border border-charcoal px-4 py-2 text-sm font-bold text-charcoal"
            >
              Export CSV
            </button>
          ) : null}
        </div>
      </div>

      {loading ? <p className="mt-6 text-sm text-muted">Loading…</p> : null}
      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}

      {data?.finalized ? (
        <div className="mt-6 rounded-md border border-green-300 bg-green-50 p-4 text-sm text-green-900">
          <strong>Finalized.</strong> These figures are frozen with the rules that produced them —
          later changes to attendance or pay rules will not alter them.
        </div>
      ) : null}

      {draft ? (
        <>
          {draft.blocked ? (
            <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Some days still need approval on the attendance sheet. Payroll can be reviewed but
              <strong> not finalized</strong> until they&apos;re cleared — a run that included a
              guessed day would freeze the guess.
            </p>
          ) : null}

          {totals ? (
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="People" value={String(totals.people)} />
              <Stat label="Base" value={rupees(totals.base)} />
              <Stat label="Overtime" value={rupees(totals.ot)} />
              <Stat label="Total payout" value={rupees(totals.net)} strong />
            </div>
          ) : null}

          <div className="mt-6 overflow-x-auto rounded-md border border-[#e5e5e5] bg-white">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#e5e5e5] text-left">
                  <th className="px-3 py-2 font-bold text-charcoal">Staff</th>
                  <th className="px-3 py-2 text-right font-bold text-charcoal">P/H/A</th>
                  <th className="px-3 py-2 text-right font-bold text-charcoal">Hours</th>
                  <th className="px-3 py-2 text-right font-bold text-charcoal">OT</th>
                  <th className="px-3 py-2 text-right font-bold text-charcoal">Base</th>
                  <th className="px-3 py-2 text-right font-bold text-charcoal">Deduct</th>
                  <th className="px-3 py-2 text-right font-bold text-charcoal">Net</th>
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((l) => (
                  // Fragment carries the key — a bare <> in a list drops it and
                  // React re-creates every row on each render.
                  <Fragment key={l.user_id}>
                    <tr
                      className="cursor-pointer border-b border-[#f0f0f0] hover:bg-[#faf7f4]"
                      onClick={() => setExpanded(expanded === l.user_id ? null : l.user_id)}
                    >
                      <td className="px-3 py-2">
                        <span className="font-bold text-charcoal">{l.name}</span>
                        {l.unconfigured ? (
                          <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">
                            no salary set
                          </span>
                        ) : null}
                        {l.blocked ? (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900">
                            {l.daysNeedingApproval} unapproved
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right text-muted">
                        {l.daysPresent}/{l.daysHalf}/{l.daysAbsent}
                      </td>
                      <td className="px-3 py-2 text-right">{hm(l.workedMinutes)}</td>
                      <td className="px-3 py-2 text-right text-muted">
                        {l.otMinutes ? hm(l.otMinutes) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">{rupees(l.basePayInr)}</td>
                      <td className="px-3 py-2 text-right text-muted">
                        {l.deductionsInr ? `−${rupees(l.deductionsInr)}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-charcoal">
                        {rupees(l.netPayInr)}
                      </td>
                    </tr>
                    {expanded === l.user_id ? (
                      <tr className="border-b border-[#f0f0f0] bg-[#faf7f4]">
                        <td colSpan={7} className="px-3 py-3">
                          <Derivation line={l} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            disabled={busy || draft.blocked}
            onClick={finalize}
            className="mt-6 rounded-md bg-tan px-5 py-3 text-sm font-bold text-cream disabled:opacity-50"
            title={draft.blocked ? 'Clear the unapproved days first' : undefined}
          >
            {busy ? 'Finalizing…' : 'Finalize this month'}
          </button>
          <p className="mt-2 text-xs text-muted">
            Finalizing freezes these numbers and the rules behind them. Attendance for the month
            can&apos;t be edited afterwards without reversing the run.
          </p>
        </>
      ) : null}
    </div>
  );
}

function Derivation({ line }: { line: Line }) {
  const worked = line.days.filter((d) => d.status !== 'not_employed');
  return (
    <div>
      {line.segments.map((s, i) => (
        <p key={i} className="text-sm text-charcoal">
          {rupees(s.monthlySalaryInr)}/month over <strong>{s.workingDays}</strong> working days ×{' '}
          {s.contractedHoursPerDay}h = {hm(s.expectedMinutes)} expected · {hm(s.paidMinutes)} paid
          {s.otMinutes ? ` · ${hm(s.otMinutes)} OT` : ''}
          {s.lateMarks ? ` · ${s.lateMarks} late` : ''}
        </p>
      ))}
      <div className="mt-2 flex flex-wrap gap-1">
        {worked.map((d) => (
          <span
            key={d.date}
            title={`${d.date} · ${d.status} · ${hm(d.workedMinutes)}${d.isLate ? ' · late' : ''}`}
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              d.status === 'present'
                ? 'bg-white text-charcoal'
                : d.status === 'half_day'
                  ? 'bg-orange-100 text-orange-900'
                  : d.status === 'absent'
                    ? 'bg-red-100 text-red-800'
                    : d.status === 'needs_approval'
                      ? 'bg-amber-200 text-amber-900'
                      : 'bg-[#eee] text-muted'
            }`}
          >
            {Number(d.date.slice(-2))}
          </span>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border border-[#e5e5e5] bg-white px-3 py-3">
      <p className="text-[11px] uppercase tracking-[0.15em] text-muted">{label}</p>
      <p className={`mt-1 ${strong ? 'text-xl font-bold' : 'text-lg'} text-charcoal`}>{value}</p>
    </div>
  );
}
