'use client';

// PAY-3 / PAY-4 / PAY-5 — review a month, finalize it ONE STAFFER AT A TIME,
// export it.
//
// The expandable derivation is not a nicety. An owner who cannot see where a
// number came from will re-check it by hand, and then the product has saved
// them nothing. Every row opens into the days that produced it — and, for a
// draft, into the deductions the rules propose, none of which is taken until
// the owner ticks it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { istDateIso } from '@/lib/api/date';
import { DataTable } from '@/components/ui/DataTable';

interface Segment {
  monthlySalaryInr: number;
  contractedHoursPerDay: number;
  daysInMonth: number;
  paidLeaves: number;
  payableDays: number;
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
  /** Payroll is finalized per staffer; a finalized line is a frozen snapshot. */
  finalized: boolean;
  run: { id: string; finalized_at: string | null } | null;
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
  /** Late-mark deduction actually taken (finalized lines only; 0 on a draft). */
  deductionsInr: number;
  /** Cash shortage actually taken (finalized lines only; 0 on a draft). */
  cashShortageInr: number;
  adjustmentsInr: number;
  adjustmentReason: string;
  /** What the rules would deduct — shown, never taken without the owner's tick. */
  proposedDeductions: { lateInr: number; cashShortageInr: number };
  appliedDeductions: { late: boolean; cashShortage: boolean };
  netBeforeDeductionsInr: number;
  deductionsClamped: boolean;
  netPayInr: number;
  unconfigured: boolean;
  blocked: boolean;
  segments: Segment[];
  days: DayInput[];
}

interface Month {
  month: string;
  lines: Line[];
  finalizedCount: number;
  blocked: boolean;
}

interface Choice {
  late: boolean;
  cash: boolean;
}

// SA-5 — mirrors lib/payroll/payslipEmail.ts's PayslipStatus.
interface PayslipStatus {
  userId: string;
  name: string;
  toEmail: string;
  status: 'sent' | 'failed' | 'skipped' | 'not_sent';
  detail: string;
  sentAt: string | null;
}

const NO_CHOICE: Choice = { late: false, cash: false };

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const hm = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

function currentMonth(): string {
  return istDateIso().slice(0, 7);
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Net pay with the ticked deductions taken. Mirrors settleDeductions in
 * lib/payroll/compute.ts exactly (whole rupees, clamped at 0), so the number
 * shown before finalizing is the number finalize freezes.
 */
function netWith(l: Line, c: Choice): number {
  if (l.finalized) return l.netPayInr;
  const taken =
    (c.late ? l.proposedDeductions.lateInr : 0) + (c.cash ? l.proposedDeductions.cashShortageInr : 0);
  const raw = l.netBeforeDeductionsInr - taken;
  return taken > 0 && raw < 0 ? 0 : raw;
}

function takenWith(l: Line, c: Choice): number {
  if (l.finalized) return l.deductionsInr + l.cashShortageInr;
  return (c.late ? l.proposedDeductions.lateInr : 0) + (c.cash ? l.proposedDeductions.cashShortageInr : 0);
}

function proposedTotal(l: Line): number {
  return l.proposedDeductions.lateInr + l.proposedDeductions.cashShortageInr;
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
  const [data, setData] = useState<Month | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

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

  // A new month starts with nothing ticked — deductions are never carried over.
  useEffect(() => {
    setChoices({});
    setRowError({});
    setExpanded(null);
  }, [month]);

  const choiceFor = useCallback((userId: string) => choices[userId] ?? NO_CHOICE, [choices]);

  function setChoice(userId: string, patch: Partial<Choice>) {
    setChoices((prev) => ({ ...prev, [userId]: { ...(prev[userId] ?? NO_CHOICE), ...patch } }));
  }

  const totals = useMemo(() => {
    if (!data) return null;
    return data.lines.reduce(
      (a, l) => ({
        net: a.net + netWith(l, choiceFor(l.user_id)),
        proposed: a.proposed + (l.finalized ? 0 : proposedTotal(l)),
        people: a.people + (l.unconfigured ? 0 : 1),
        finalized: a.finalized + (l.finalized ? 1 : 0),
      }),
      { net: 0, proposed: 0, people: 0, finalized: 0 },
    );
  }, [data, choiceFor]);

  async function finalize(l: Line) {
    const c = choiceFor(l.user_id);
    setBusyUser(l.user_id);
    setRowError((p) => ({ ...p, [l.user_id]: '' }));
    try {
      const res = await fetch('/api/owner/payroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, user_id: l.user_id, apply: { late: c.late, cash_shortage: c.cash } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError((p) => ({ ...p, [l.user_id]: (body.error as string) ?? 'Could not finalize.' }));
        return;
      }
      await load();
    } finally {
      setBusyUser(null);
    }
  }

  async function reverse(l: Line, reason: string) {
    setBusyUser(l.user_id);
    setRowError((p) => ({ ...p, [l.user_id]: '' }));
    try {
      const res = await fetch('/api/owner/payroll', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, user_id: l.user_id, reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError((p) => ({ ...p, [l.user_id]: (body.error as string) ?? 'Could not reverse.' }));
        return;
      }
      setChoice(l.user_id, NO_CHOICE);
      await load();
    } finally {
      setBusyUser(null);
    }
  }

  function exportCsv() {
    if (!data) return;
    const header = [
      'Name',
      'Status',
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
      'Adjustments',
      'Earned',
      'Late deduction (proposed)',
      'Late deducted',
      'Cash shortage (proposed)',
      'Cash shortage deducted',
      'Net pay',
    ];
    const rows = data.lines.map((l) => {
      const c = choiceFor(l.user_id);
      const late = l.finalized ? l.appliedDeductions.late : c.late && l.proposedDeductions.lateInr > 0;
      const cash = l.finalized
        ? l.appliedDeductions.cashShortage
        : c.cash && l.proposedDeductions.cashShortageInr > 0;
      return [
        l.name,
        l.finalized ? 'Finalized' : 'Draft',
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
        l.adjustmentsInr,
        l.netBeforeDeductionsInr,
        l.proposedDeductions.lateInr,
        late ? 'Yes' : 'No',
        l.proposedDeductions.cashShortageInr,
        cash ? 'Yes' : 'No',
        netWith(l, c),
      ];
    });
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
          {data ? (
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

      {data ? (
        <>
          <p className="mt-4 text-sm text-muted">
            Open a person to review their month, tick any deductions you want to take, and finalize
            them. Nothing is deducted unless you tick it. Each person is finalized on their own.
          </p>

          {data.blocked ? (
            <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Some people still have days that need approval on the attendance sheet. They can be
              reviewed but <strong>not finalized</strong> until those days are cleared — a payroll
              that included a guessed day would freeze the guess.
            </p>
          ) : null}

          {totals ? (
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Finalized" value={`${totals.finalized} of ${data.lines.length}`} />
              <Stat label="People paid" value={String(totals.people)} />
              <Stat label="Deductions proposed" value={rupees(totals.proposed)} />
              <Stat label="Total payout" value={rupees(totals.net)} strong />
            </div>
          ) : null}

          <DataTable
            className="mt-6"
            scrollClassName="rounded-md border border-line bg-white"
            rows={data.lines}
            rowKey={(l) => l.user_id}
            cellPadding="px-3 py-2"
            headerTextClassName="text-sm font-bold text-charcoal"
            onRowClick={(l) => setExpanded(expanded === l.user_id ? null : l.user_id)}
            renderRowAfter={(l) =>
              expanded === l.user_id ? (
                <tr className="border-b border-[#f0f0f0] bg-[#faf7f4]">
                  <td colSpan={7} className="px-3 py-3">
                    <Derivation line={l} />
                    {l.finalized ? (
                      <FinalizedPanel
                        line={l}
                        busy={busyUser === l.user_id}
                        error={rowError[l.user_id] ?? ''}
                        onReverse={(reason) => reverse(l, reason)}
                      />
                    ) : (
                      <DraftPanel
                        line={l}
                        month={month}
                        choice={choiceFor(l.user_id)}
                        onChoice={(patch) => setChoice(l.user_id, patch)}
                        busy={busyUser === l.user_id}
                        anyBusy={busyUser !== null}
                        error={rowError[l.user_id] ?? ''}
                        onFinalize={() => finalize(l)}
                      />
                    )}
                  </td>
                </tr>
              ) : null
            }
            columns={[
              {
                key: 'staff',
                header: 'Staff',
                filter: 'text',
                sticky: true,
                value: (l) => l.name,
                cellClassName: 'whitespace-nowrap',
                render: (l) => (
                  <>
                    <span className="font-bold text-charcoal">{l.name}</span>
                    {l.finalized ? (
                      <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-900">
                        finalized
                      </span>
                    ) : null}
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
                  </>
                ),
              },
              {
                // Sorts/filters on days present; the cell shows present/half/absent.
                key: 'pha',
                header: 'P/H/A',
                filter: 'number',
                align: 'right',
                value: (l) => l.daysPresent,
                cellClassName: 'text-muted',
                render: (l) => `${l.daysPresent}/${l.daysHalf}/${l.daysAbsent}`,
              },
              {
                // Filters in hours (decimal) — minutes are unreadable in a filter box.
                key: 'hours',
                header: 'Hours',
                filter: 'number',
                align: 'right',
                value: (l) => Math.round(l.workedMinutes / 6) / 10,
                render: (l) => hm(l.workedMinutes),
              },
              {
                key: 'ot',
                header: 'OT',
                filter: 'number',
                align: 'right',
                value: (l) => Math.round(l.otMinutes / 6) / 10,
                cellClassName: 'text-muted',
                render: (l) => (l.otMinutes ? hm(l.otMinutes) : '—'),
              },
              {
                key: 'earned',
                header: 'Earned',
                filter: 'number',
                align: 'right',
                value: (l) => l.netBeforeDeductionsInr,
                render: (l) => rupees(l.netBeforeDeductionsInr),
              },
              {
                key: 'deduct',
                header: 'Deductions',
                filter: 'number',
                align: 'right',
                value: (l) => takenWith(l, choiceFor(l.user_id)),
                cellClassName: 'whitespace-nowrap',
                render: (l) => {
                  const taken = takenWith(l, choiceFor(l.user_id));
                  const proposed = proposedTotal(l);
                  if (taken > 0) return <span className="text-red-700">−{rupees(taken)}</span>;
                  if (proposed > 0) {
                    return (
                      <span className="text-muted" title="Proposed — not deducted unless you tick it">
                        {rupees(proposed)} {l.finalized ? 'not taken' : 'proposed'}
                      </span>
                    );
                  }
                  return '—';
                },
              },
              {
                key: 'net',
                header: 'Net',
                filter: 'number',
                align: 'right',
                value: (l) => netWith(l, choiceFor(l.user_id)),
                cellClassName: 'font-bold text-charcoal',
                render: (l) => rupees(netWith(l, choiceFor(l.user_id))),
              },
            ]}
          />
          <p className="mt-2 text-xs text-muted">
            {monthLabel(month)} · Earned = base + overtime + adjustments, before any deduction.
          </p>
        </>
      ) : null}
    </div>
  );
}

function DraftPanel({
  line,
  month,
  choice,
  onChoice,
  busy,
  anyBusy,
  error,
  onFinalize,
}: {
  line: Line;
  month: string;
  choice: Choice;
  onChoice: (patch: Partial<Choice>) => void;
  busy: boolean;
  anyBusy: boolean;
  error: string;
  onFinalize: () => void;
}) {
  const { lateInr, cashShortageInr } = line.proposedDeductions;
  const taken = takenWith(line, choice);
  const net = netWith(line, choice);
  const cannot = line.blocked
    ? 'Clear the unapproved days on the attendance sheet first.'
    : line.unconfigured
      ? 'Set a salary on the Team screen first.'
      : '';

  return (
    <div className="mt-4 rounded-md border border-line bg-white p-3">
      <h3 className="text-sm font-bold text-charcoal">Deductions</h3>
      {lateInr === 0 && cashShortageInr === 0 ? (
        <p className="mt-1 text-sm text-muted">No deductions proposed this month.</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted">
            Proposed by the rules. Tick the ones you want to deduct — anything left unticked is not
            deducted.
          </p>
          <ul className="mt-2 space-y-2">
            {lateInr > 0 ? (
              <li>
                <label className="flex cursor-pointer items-start gap-2 text-sm text-charcoal">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={choice.late}
                    disabled={busy}
                    onChange={(e) => onChoice({ late: e.target.checked })}
                  />
                  <span>
                    Late marks — {line.lateMarks} late {line.lateMarks === 1 ? 'day' : 'days'}:{' '}
                    <strong>{rupees(lateInr)}</strong>
                  </span>
                </label>
              </li>
            ) : null}
            {cashShortageInr > 0 ? (
              <li>
                <label className="flex cursor-pointer items-start gap-2 text-sm text-charcoal">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={choice.cash}
                    disabled={busy}
                    onChange={(e) => onChoice({ cash: e.target.checked })}
                  />
                  <span>
                    Cash shortage (approved): <strong>{rupees(cashShortageInr)}</strong> ·{' '}
                    <a href="/owner/cash" className="underline">
                      review on Cash
                    </a>
                  </span>
                </label>
              </li>
            ) : null}
          </ul>
        </>
      )}

      <p className="mt-3 text-sm text-charcoal">
        Earned {rupees(line.netBeforeDeductionsInr)}
        {taken > 0 ? ` − deductions ${rupees(taken)}` : ''} = <strong>Net {rupees(net)}</strong>
        {taken > 0 && net === 0 ? (
          <span className="ml-1 text-amber-800">
            (deductions exceed this month&apos;s pay — net is held at ₹0 and the rest is not carried over)
          </span>
        ) : null}
      </p>

      <button
        type="button"
        disabled={anyBusy || Boolean(cannot)}
        onClick={onFinalize}
        className="mt-3 rounded-md bg-tan-dark px-4 py-2 text-sm font-bold text-cream disabled:opacity-50"
        title={cannot || undefined}
      >
        {busy ? 'Finalizing…' : `Finalize ${line.name} — ${rupees(net)}`}
      </button>
      {cannot ? <p className="mt-2 text-xs text-amber-800">{cannot}</p> : null}
      <p className="mt-2 text-xs text-muted">
        Freezes {line.name}&apos;s {monthLabel(month)} and emails their payslip. Their attendance for
        the month can&apos;t be edited afterwards without reversing. Other staff are not affected.
      </p>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </div>
  );
}

function FinalizedPanel({
  line,
  busy,
  error,
  onReverse,
}: {
  line: Line;
  busy: boolean;
  error: string;
  onReverse: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const runId = line.run?.id ?? null;
  const { lateInr, cashShortageInr } = line.proposedDeductions;

  return (
    <div className="mt-4 rounded-md border border-green-300 bg-white p-3">
      <h3 className="text-sm font-bold text-green-900">
        Finalized{line.run?.finalized_at ? ` ${payslipSentAtLabel(line.run.finalized_at)}` : ''}
      </h3>
      <p className="mt-1 text-xs text-muted">
        Frozen with the rules that produced it — later changes to attendance or pay rules will not
        alter it.
      </p>
      <ul className="mt-2 space-y-1 text-sm text-charcoal">
        {lateInr > 0 ? (
          <li>
            Late marks {rupees(lateInr)} — {line.appliedDeductions.late ? 'deducted' : 'not deducted'}
          </li>
        ) : null}
        {cashShortageInr > 0 ? (
          <li>
            Cash shortage {rupees(cashShortageInr)} —{' '}
            {line.appliedDeductions.cashShortage ? 'deducted' : 'not deducted'}
          </li>
        ) : null}
        {line.adjustmentsInr ? (
          <li>
            Adjustment {line.adjustmentsInr > 0 ? '+' : '−'}
            {rupees(Math.abs(line.adjustmentsInr))}
            {line.adjustmentReason ? ` — ${line.adjustmentReason}` : ''}
          </li>
        ) : null}
        <li>
          <strong>Net {rupees(line.netPayInr)}</strong>
        </li>
      </ul>

      {runId ? <PayslipRow runId={runId} /> : null}

      <div className="mt-4 border-t border-[#f0f0f0] pt-3">
        <label className="block text-xs font-bold text-charcoal" htmlFor={`reverse-${line.user_id}`}>
          Reverse {line.name}&apos;s payroll
        </label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            id={`reverse-${line.user_id}`}
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required)"
            className="min-w-0 flex-1 rounded-md border border-[#ddd] px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            disabled={busy || !reason.trim()}
            onClick={() => onReverse(reason.trim())}
            className="rounded-md border border-red-700 px-3 py-1.5 text-sm font-bold text-red-700 disabled:opacity-50"
          >
            {busy ? 'Reversing…' : 'Reverse'}
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">
          Unlocks their attendance for the month so it can be corrected and finalized again. The
          reversed payroll stays on record.
        </p>
      </div>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </div>
  );
}

function PayslipRow({ runId }: { runId: string }) {
  const [status, setStatus] = useState<PayslipStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed('');
    try {
      const res = await fetch(`/api/owner/payroll/payslips?runId=${encodeURIComponent(runId)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        setFailed((await res.json().catch(() => ({}))).error ?? 'Could not load payslip status.');
        return;
      }
      const body = await res.json();
      setStatus(Array.isArray(body.statuses) && body.statuses[0] ? body.statuses[0] : null);
    } catch {
      setFailed('Could not load payslip status.');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resend() {
    if (!status) return;
    setSending(true);
    try {
      const res = await fetch('/api/owner/payroll/payslips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, userId: status.userId }),
      });
      if (res.ok) await load();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-[#faf7f4] px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-bold text-charcoal">Payslip</p>
        {loading ? <p className="text-xs text-muted">Loading…</p> : null}
        {failed ? <p className="text-xs text-red-700">{failed}</p> : null}
        {!loading && !failed && status ? <PayslipStatusText p={status} /> : null}
      </div>
      {status ? (
        <button
          type="button"
          disabled={sending || !status.toEmail}
          onClick={resend}
          className="shrink-0 rounded-md border border-charcoal px-3 py-1 text-xs font-bold text-charcoal disabled:opacity-50"
        >
          {sending ? 'Sending…' : status.status === 'sent' ? 'Resend' : 'Send'}
        </button>
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
          {rupees(s.monthlySalaryInr)}/month over <strong>{s.payableDays}</strong> days ({s.daysInMonth}{' '}
          − {s.paidLeaves} paid leaves) × {s.contractedHoursPerDay}h = {hm(s.expectedMinutes)} expected ·{' '}
          {hm(s.paidMinutes)} paid
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

function payslipSentAtLabel(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function PayslipStatusText({ p }: { p: PayslipStatus }) {
  if (p.status === 'sent') {
    return <p className="text-xs text-green-700">Sent {payslipSentAtLabel(p.sentAt)}</p>;
  }
  if (p.status === 'failed') {
    return <p className="text-xs text-red-700">Failed{p.detail ? ` — ${p.detail}` : ''}</p>;
  }
  if (p.detail === 'migration not applied') {
    return <p className="text-xs text-muted">Staff accounts aren&apos;t set up yet.</p>;
  }
  if (!p.toEmail) {
    return (
      <p className="text-xs text-amber-700">
        No personal email —{' '}
        <a href="/owner/staff" className="underline">
          add one on the Team screen
        </a>
      </p>
    );
  }
  if (p.status === 'skipped') {
    return <p className="text-xs text-muted">Skipped{p.detail ? ` — ${p.detail}` : ''}</p>;
  }
  return <p className="text-xs text-muted">Not sent yet</p>;
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border border-line bg-white px-3 py-3">
      <p className="text-[11px] uppercase tracking-[0.15em] text-muted">{label}</p>
      <p className={`mt-1 ${strong ? 'text-xl font-bold' : 'text-lg'} text-charcoal`}>{value}</p>
    </div>
  );
}
