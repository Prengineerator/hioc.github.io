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

interface AdvanceItem {
  id: string;
  given_on: string;
  amount_inr: number;
  note: string;
  /** Counted by a finalized month — cannot be removed until that month is reversed. */
  locked: boolean;
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
  /** Advance still owed going into this month (draft: before taking; finalized: frozen). */
  advanceOutstandingInr: number;
  /** Advance taken off (finalized lines only; a draft previews it via settle()). */
  advanceInr: number;
  advanceCarriedInr: number;
  advances: AdvanceItem[];
  advanceCarriedFromEarlierInr: number;
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
  return settle(l, c).net;
}

/**
 * Mirrors computePayrollLine's order: earned → ticked deductions (clamped at 0)
 * → advance = min(outstanding, what is left). A finalized line is read back.
 */
function settle(l: Line, c: Choice): { net: number; advance: number; carried: number } {
  if (l.finalized) {
    return { net: l.netPayInr, advance: l.advanceInr ?? 0, carried: l.advanceCarriedInr ?? 0 };
  }
  const taken =
    (c.late ? l.proposedDeductions.lateInr : 0) + (c.cash ? l.proposedDeductions.cashShortageInr : 0);
  const raw = l.netBeforeDeductionsInr - taken;
  const afterDeductions = taken > 0 && raw < 0 ? 0 : raw;
  const outstanding = l.advanceOutstandingInr ?? 0;
  const advance = Math.min(outstanding, Math.max(0, afterDeductions));
  return { net: afterDeductions - advance, advance, carried: outstanding - advance };
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
        advances: a.advances + settle(l, choiceFor(l.user_id)).advance,
        proposed: a.proposed + (l.finalized ? 0 : proposedTotal(l)),
        people: a.people + (l.unconfigured ? 0 : 1),
        finalized: a.finalized + (l.finalized ? 1 : 0),
      }),
      { net: 0, advances: 0, proposed: 0, people: 0, finalized: 0 },
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
      'Advance deducted',
      'Advance carried to next month',
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
        settle(l, c).advance,
        settle(l, c).carried,
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
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Finalized" value={`${totals.finalized} of ${data.lines.length}`} />
              <Stat label="People paid" value={String(totals.people)} />
              <Stat label="Deductions proposed" value={rupees(totals.proposed)} />
              <Stat label="Advances this month" value={rupees(totals.advances)} />
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
                  <td colSpan={8} className="px-3 py-3">
                    <Derivation line={l} />
                    {l.finalized ? (
                      <FinalizedPanel
                        line={l}
                        busy={busyUser === l.user_id}
                        error={rowError[l.user_id] ?? ''}
                        onReverse={(reason) => reverse(l, reason)}
                        onAdvanceChanged={load}
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
                        onAdvanceChanged={load}
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
                key: 'advance',
                header: 'Advance',
                filter: 'number',
                align: 'right',
                value: (l) => settle(l, choiceFor(l.user_id)).advance,
                cellClassName: 'whitespace-nowrap',
                render: (l) => {
                  const { advance, carried } = settle(l, choiceFor(l.user_id));
                  if (advance <= 0 && carried <= 0) return '—';
                  return (
                    <>
                      {advance > 0 ? <span className="text-red-700">−{rupees(advance)}</span> : '—'}
                      {carried > 0 ? (
                        <span className="block text-[11px] text-muted">{rupees(carried)} to next month</span>
                      ) : null}
                    </>
                  );
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
            {monthLabel(month)} · Earned = base + overtime + adjustments, before any deduction or
            advance.
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
  onAdvanceChanged,
}: {
  line: Line;
  month: string;
  choice: Choice;
  onChoice: (patch: Partial<Choice>) => void;
  busy: boolean;
  anyBusy: boolean;
  error: string;
  onFinalize: () => void;
  onAdvanceChanged: () => void;
}) {
  const { lateInr, cashShortageInr } = line.proposedDeductions;
  const taken = takenWith(line, choice);
  const { net, advance, carried } = settle(line, choice);
  const cannot = line.blocked
    ? 'Clear the unapproved days on the attendance sheet first.'
    : line.unconfigured
      ? 'Set a salary on the Team screen first.'
      : '';

  return (
    <>
    <AdvancesBox line={line} advance={advance} carried={carried} onChanged={onAdvanceChanged} />
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
        {taken > 0 ? ` − deductions ${rupees(taken)}` : ''}
        {advance > 0 ? ` − advance ${rupees(advance)}` : ''} = <strong>Net {rupees(net)}</strong>
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
    </>
  );
}

function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * The Advances box: what carried in, this month's advances (with Remove), an
 * Add form, and one line adding it up. After an add or remove the month is
 * reloaded so every number on the row follows.
 */
function AdvancesBox({
  line,
  advance,
  carried,
  onChanged,
}: {
  line: Line;
  advance: number;
  carried: number;
  onChanged: () => void;
}) {
  const today = istDateIso();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const monthTotal = line.advances.reduce((s, a) => s + a.amount_inr, 0);

  async function call(method: 'POST' | 'DELETE', payload: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/owner/payroll/advances', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setErr((await res.json().catch(() => ({}))).error ?? 'Could not save.');
        return false;
      }
      onChanged();
      return true;
    } catch {
      setErr('Could not save.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 1) {
      setErr('Enter the amount in whole rupees.');
      return;
    }
    const ok = await call('POST', { user_id: line.user_id, amount_inr: n, given_on: date, note });
    if (ok) {
      setAmount('');
      setNote('');
    }
  }

  return (
    <div className="mt-4 rounded-md border border-line bg-white p-3">
      <h3 className="text-sm font-bold text-charcoal">Advances</h3>
      {line.advanceCarriedFromEarlierInr > 0 ? (
        <p className="mt-1 text-sm text-charcoal">
          Carried from earlier <strong>{rupees(line.advanceCarriedFromEarlierInr)}</strong>
        </p>
      ) : null}
      {line.advances.length === 0 ? (
        <p className="mt-1 text-sm text-muted">No advances dated this month.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {line.advances.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-charcoal">
              <span className="w-14 shrink-0">{shortDate(a.given_on)}</span>
              <strong>{rupees(a.amount_inr)}</strong>
              <span className="min-w-0 flex-1 break-words text-muted">{a.note}</span>
              {line.finalized && !a.locked ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900">
                  comes off next month
                </span>
              ) : null}
              <button
                type="button"
                disabled={busy || a.locked}
                title={a.locked ? 'Already counted in a finalized month. Reverse that month first.' : undefined}
                onClick={() => void call('DELETE', { id: a.id })}
                className="rounded-md border border-red-700 px-2 py-0.5 text-xs font-bold text-red-700 disabled:opacity-40"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">
          Amount ₹
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-0.5 block w-28 rounded-md border border-[#ddd] px-2 py-1.5 text-sm text-charcoal"
          />
        </label>
        <label className="text-xs text-muted">
          Date
          <input
            type="date"
            max={today}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-0.5 block rounded-md border border-[#ddd] px-2 py-1.5 text-sm text-charcoal"
          />
        </label>
        <label className="min-w-[8rem] flex-1 text-xs text-muted">
          Note (optional)
          <input
            type="text"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. UPI, rent"
            className="mt-0.5 block w-full rounded-md border border-[#ddd] px-2 py-1.5 text-sm text-charcoal"
          />
        </label>
        <button
          type="button"
          disabled={busy || !amount}
          onClick={() => void add()}
          className="rounded-md bg-tan-dark px-4 py-1.5 text-sm font-bold text-cream disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Add advance'}
        </button>
      </div>
      {line.finalized ? (
        <p className="mt-2 text-xs text-muted">
          Advances added now come off the next month that isn&apos;t finalized yet.
        </p>
      ) : null}
      {err ? <p className="mt-2 text-sm text-red-700">{err}</p> : null}

      <p className="mt-3 text-sm text-charcoal">
        {line.finalized ? 'Advance owed when finalized' : 'Advance to take off'}{' '}
        {rupees(line.advanceOutstandingInr)}
        {' · '}taken this month {rupees(advance)} · to next month {rupees(carried)}
      </p>
    </div>
  );
}

function FinalizedPanel({
  line,
  busy,
  error,
  onReverse,
  onAdvanceChanged,
}: {
  line: Line;
  busy: boolean;
  error: string;
  onReverse: (reason: string) => void;
  onAdvanceChanged: () => void;
}) {
  const [reason, setReason] = useState('');
  const runId = line.run?.id ?? null;
  const { lateInr, cashShortageInr } = line.proposedDeductions;

  return (
    <>
    <AdvancesBox
      line={line}
      advance={line.advanceInr ?? 0}
      carried={line.advanceCarriedInr ?? 0}
      onChanged={onAdvanceChanged}
    />
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
        {line.advanceInr > 0 ? <li>Salary advance −{rupees(line.advanceInr)}</li> : null}
        {line.advanceCarriedInr > 0 ? <li>{rupees(line.advanceCarriedInr)} carried to next month</li> : null}
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
    </>
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
