'use client';

// Cash day cockpit: Open → Close → Handover (OPS-2, STF-045; reworked
// 2026-09-29 so the day matches the cash sales). One GET /api/cash-days drives
// the whole surface:
//  - No open day  → the day-OPEN form: count the float by denomination, compare
//    it with the float left at the last close (Match column + total difference,
//    a reason for any difference), confirm with the time, open.
//  - Open day     → the live SUMMARY (float, cash sales since open with an
//    expandable list, refunds, cash in/out, expected cash now; UPI/card for
//    information) + the CLOSE form: count the drawer, see expected vs counted,
//    a reason for any variance, then the HANDOVER (float left for tomorrow by
//    denomination; cash taken out is computed). Closing is blocked while orders
//    since opening are unpaid (a manager can override with a reason).
//  - Always       → a manager can reopen the last day if it was closed by
//    mistake, and recent closures are listed.
//  - A day left open past 3:00 am has ENDED (lib/cash/autoEnd.ts): its figures
//    stop there and anyone can count and close it. The counter is locked until
//    it is closed and today is opened (components/staff/CashDayGate.tsx, which
//    renders this screen and is told when the day changes via onDayChange).
//
// Money is server-authoritative: every total shown here is a live MIRROR (the
// same lib/cash/day.ts rules the route enforces); POST/PATCH recompute every
// stored figure server-side.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CashCountSheet } from '@/components/staff/CashCountSheet';
import { CashDayDenomGrid } from '@/components/staff/CashDayDenomGrid';
import { Spinner } from '@/components/ui/Spinner';
import type { CashCountResult } from '@/lib/cash/counts';
import { capDenoms, cashReasonProblem, evaluateClose, evaluateOpen, zeroCountNeedsConfirm } from '@/lib/cash/day';
import { denomsTotalInr } from '@/lib/cash/denoms';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { CashDay, CashDenoms } from '@/lib/types';

interface OpenSummary {
  opening_total_inr: number;
  cash_sales_inr: number;
  cash_sales_count: number;
  cash_refunds_inr: number;
  cash_in_inr: number;
  cash_out_inr: number;
  // Optional: absent before supabase/2026-10-cash-expenses.sql. Already INSIDE
  // cash_out_inr — shown as an "of which" line, never subtracted again.
  expenses_inr?: number;
  upi_inr: number;
  card_inr: number;
  online_inr: number;
  // Optional: absent from a server that predates the dining-app tenders.
  swiggy_dineout_inr?: number;
  zomato_district_inr?: number;
  expected_cash_inr: number;
  as_of: string;
}

interface CashSaleRow {
  order_id: string;
  order_number: number | null;
  at: string;
  amount_inr: number;
}

interface UnpaidInfo {
  count: number;
  orders: { id: string; order_number: number; total_inr: number; created_at: string }[];
}

interface FloatLeft {
  denoms: CashDenoms;
  total_inr: number;
  business_date: string | null;
  closed_at: string | null;
}

interface ReopenableDay {
  id: string;
  business_date: string;
  closed_at: string | null;
}

interface CashDayData {
  openDay: CashDay | null;
  openSummary: OpenSummary | null;
  cashSales: CashSaleRow[];
  unpaid: UnpaidInfo;
  floatLeft: FloatLeft | null;
  reopenableDay: ReopenableDay | null;
  canOverrideUnpaid: boolean;
  /** The open day passed its 3 am end without being closed. */
  overdue: boolean;
  /** When the open day ends on its own. */
  endsAt: string | null;
  history: CashDay[];
}

const EMPTY_DATA: CashDayData = {
  openDay: null,
  openSummary: null,
  cashSales: [],
  unpaid: { count: 0, orders: [] },
  floatLeft: null,
  reopenableDay: null,
  canOverrideUnpaid: false,
  overdue: false,
  endsAt: null,
  history: [],
};

const EMPTY_DENOMS: CashDenoms = {};
const REFRESH_MS = 30_000;

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

export function CashDayManager({ onDayChange }: { onDayChange?: () => void } = {}) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<CashDayData>(EMPTY_DATA);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  // CC-3 — a manual mid-shift count, any staffer, any time (distinct from the
  // day open/close counts above). POST /api/cash-counts {denoms}.
  const [manualSheetOpen, setManualSheetOpen] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState('');

  const showToast = (msg: string, ms = 4500) => {
    setToast(msg);
    setTimeout(() => setToast(''), ms);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/cash-days', { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();
      setData({
        openDay: d.open_day ?? null,
        openSummary: d.open_summary ?? null,
        cashSales: d.cash_sales ?? [],
        unpaid: d.unpaid ?? EMPTY_DATA.unpaid,
        floatLeft: d.float_left ?? null,
        reopenableDay: d.reopenable_day ?? null,
        canOverrideUnpaid: Boolean(d.can_override_unpaid),
        overdue: Boolean(d.open_day_overdue),
        endsAt: d.open_day_ends_at ?? null,
        history: d.history ?? [],
      });
    } catch {
      /* keep last-known-good */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The open day's figures move as sales are taken; keep them fresh without
  // touching the forms (their state lives in the child components).
  const dayIsOpen = data.openDay !== null;
  useEffect(() => {
    if (!dayIsOpen) return;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [dayIsOpen, load]);

  const openTheDay = useCallback(
    async (openingDenoms: CashDenoms, openReason: string): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await fetch('/api/cash-days', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opening_denoms: openingDenoms, open_reason: openReason }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(body.error ?? 'Could not open the cash day.');
          return false;
        }
        showToast(`Cash day opened with a ${inr(denomsTotalInr(openingDenoms))} float.`);
        await load();
        onDayChange?.();
        return true;
      } catch {
        showToast('Could not open the cash day — please try again.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onDayChange],
  );

  const closeTheDay = useCallback(
    async (payload: Record<string, unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await fetch('/api/cash-days', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(body.error ?? 'Could not close the cash day.');
          await load(); // e.g. the unpaid count changed
          return false;
        }
        showToast(
          body.handover_warning ??
            `Cash day closed. ${inr(body.summary?.handover_inr ?? 0)} taken out, ${inr(body.summary?.float_left_total_inr ?? 0)} left for tomorrow.`,
          body.handover_warning ? 12000 : 5000,
        );
        await load();
        onDayChange?.();
        return true;
      } catch {
        showToast('Could not close the cash day — please try again.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onDayChange],
  );

  const reopenTheDay = useCallback(
    async (id: string, reason: string): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await fetch('/api/cash-days/reopen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, reason }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(body.error ?? 'Could not reopen the cash day.');
          return false;
        }
        showToast('Cash day reopened.');
        await load();
        onDayChange?.();
        return true;
      } catch {
        showToast('Could not reopen the cash day — please try again.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onDayChange],
  );

  const manualCount = useCallback(
    async (denoms: CashDenoms) => {
      setManualBusy(true);
      setManualError('');
      try {
        const res = await fetch('/api/cash-counts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ denoms }),
        });
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        if (!res.ok) {
          setManualError((body.error as string) ?? 'Could not record that count.');
          return;
        }
        setManualSheetOpen(false);
        const result = (body.cashCount ?? body.count) as CashCountResult | undefined;
        if (result) {
          const variance = result.varianceInr;
          const varianceText =
            result.shortageInr > 0
              ? ` — short by ₹${result.shortageInr}, sent to the owner`
              : variance !== null && variance > 0
                ? ` — over by ₹${variance}`
                : variance === 0
                  ? ' — ties out'
                  : '';
          showToast(`Counted ₹${result.countedTotalInr ?? denomsTotalInr(denoms)}${varianceText}.`);
        } else {
          showToast(`Counted ₹${denomsTotalInr(denoms)}.`);
        }
        await load();
      } catch {
        setManualError('Network problem — please try again.');
      } finally {
        setManualBusy(false);
      }
    },
    [load],
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Spinner label="Loading cash day…" />
      </div>
    );
  }

  const { openDay } = data;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Cash drawer</h1>
          <p className="text-sm text-muted">
            {openDay
              ? `Open since ${formatDayTime(openDay.opened_at)} · float ${inr(openDay.opening_total_inr)}`
              : 'Count the opening float to start the day.'}
          </p>
          {openDay && data.overdue && data.endsAt ? (
            <p className="mt-1 text-sm font-bold text-red-700">
              Never closed — it ended on its own at {formatDayTime(data.endsAt)}. Count the drawer to close it.
            </p>
          ) : null}
        </div>
        {/* CC-3 — a spot count any time, independent of open/close (a mid-shift
            handover, a manager's spot-check). Visible to every staffer. */}
        <button
          type="button"
          onClick={() => setManualSheetOpen(true)}
          className="min-h-[44px] shrink-0 rounded-md border border-charcoal px-4 py-2 text-sm font-bold text-charcoal transition-colors hover:bg-charcoal hover:text-cream"
        >
          Count now
        </button>
      </div>

      {openDay && data.openSummary ? (
        <>
          <DaySummary
            openDay={openDay}
            summary={data.openSummary}
            sales={data.cashSales}
            endedAt={data.overdue ? data.endsAt : null}
          />
          <CloseForm
            openDay={openDay}
            summary={data.openSummary}
            unpaid={data.unpaid}
            canOverrideUnpaid={data.canOverrideUnpaid}
            busy={busy}
            onClose={closeTheDay}
          />
        </>
      ) : (
        <>
          <OpenForm floatLeft={data.floatLeft} busy={busy} onOpen={openTheDay} />
          {data.reopenableDay ? (
            <ReopenCard day={data.reopenableDay} busy={busy} onReopen={reopenTheDay} />
          ) : null}
        </>
      )}

      <ClosureHistory history={data.history} />

      {toast ? (
        <div
          className="fixed left-1/2 z-50 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md bg-charcoal px-4 py-2 text-sm text-cream shadow-lg"
          style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {toast}
        </div>
      ) : null}

      <CashCountSheet
        open={manualSheetOpen}
        title="Count the cash drawer"
        subtitle="Manual count"
        busy={manualBusy}
        error={manualError}
        onClose={() => {
          if (manualBusy) return;
          setManualSheetOpen(false);
          setManualError('');
        }}
        onConfirm={manualCount}
      />
    </div>
  );
}

// ── Open ─────────────────────────────────────────────────────────────────────

function OpenForm({
  floatLeft,
  busy,
  onOpen,
}: {
  floatLeft: FloatLeft | null;
  busy: boolean;
  onOpen: (denoms: CashDenoms, reason: string) => Promise<boolean>;
}) {
  const [denoms, setDenoms] = useState<CashDenoms>(EMPTY_DENOMS);
  const [reason, setReason] = useState('');
  // The confirm step shows the time the day will be opened at.
  const [confirmAt, setConfirmAt] = useState<Date | null>(null);

  const counted = denomsTotalInr(denoms);
  const evaluation = evaluateOpen({ countedInr: counted, floatLeftInr: floatLeft?.total_inr ?? null, reason });
  const diff = evaluation.differenceInr;
  const needsReason = diff !== null && diff !== 0;

  return (
    <section>
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-charcoal">Opening float</h2>
      <p className="mb-3 text-sm text-muted">
        {floatLeft
          ? `The last close left ${inr(floatLeft.total_inr)} in the drawer${
              floatLeft.closed_at ? ` (${formatDayTime(floatLeft.closed_at)})` : ''
            }. Count what is there now — the Match column shows any difference.`
          : 'No float was recorded at the last close, so there is nothing to compare with. Count the float.'}
      </p>

      <CashDayDenomGrid
        denoms={denoms}
        onChange={(next) => {
          setDenoms(next);
          setConfirmAt(null);
        }}
        disabled={busy}
        expected={floatLeft?.denoms}
        expectedLabel="Float left"
        totalLabel="Float counted"
      />

      {needsReason ? (
        <label className="mt-3 block text-sm">
          <span className="text-charcoal">
            Why is the float {diff! > 0 ? 'more' : 'less'} by {inr(Math.abs(diff!))}?{' '}
            <span className="text-red-600">(required)</span>
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="e.g. owner added ₹500 for change"
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm focus:border-tan focus:outline-none disabled:bg-surface"
          />
        </label>
      ) : null}

      {confirmAt ? (
        <div className="mt-3 rounded-md border border-tan bg-surface p-4">
          <p className="text-sm font-bold text-charcoal">
            Open cash day at {formatTime(confirmAt.toISOString())} with {inr(counted)} float?
          </p>
          {needsReason ? (
            <p className="mt-1 text-xs text-muted">
              Difference from the float left: {diff! > 0 ? '+' : '−'}
              {inr(Math.abs(diff!))} — {reason.trim()}
            </p>
          ) : null}
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={() => setConfirmAt(null)}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-md border border-[#ddd] px-4 py-3 text-sm font-bold text-charcoal disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              onClick={async () => {
                const ok = await onOpen(denoms, reason.trim());
                if (ok) {
                  setDenoms(EMPTY_DENOMS);
                  setReason('');
                  setConfirmAt(null);
                }
              }}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-md bg-tan-dark px-4 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-darker disabled:opacity-50"
            >
              {busy ? 'Opening…' : 'Yes, open the day'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmAt(new Date())}
          disabled={busy || Boolean(evaluation.problem)}
          className="mt-3 min-h-[44px] w-full rounded-md bg-tan-dark px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-50"
        >
          {evaluation.problem ? 'Add a reason to continue' : `Open the day with ${inr(counted)}`}
        </button>
      )}
    </section>
  );
}

// ── During the day ───────────────────────────────────────────────────────────

function DaySummary({
  openDay,
  summary,
  sales,
  endedAt,
}: {
  openDay: CashDay;
  summary: OpenSummary;
  sales: CashSaleRow[];
  /** Set when the day ended on its own: its figures stop there. */
  endedAt: string | null;
}) {
  const [showSales, setShowSales] = useState(false);
  // Expenses are money spent; every other cash out went to the owner.
  const expensesInr = Math.min(summary.expenses_inr ?? 0, summary.cash_out_inr);
  const rows: [string, string][] = [
    ['Opening float', inr(summary.opening_total_inr)],
    [`Cash sales (${summary.cash_sales_count})`, `+ ${inr(summary.cash_sales_inr)}`],
    ['Cash refunds', `− ${inr(summary.cash_refunds_inr)}`],
    ['Cash in', `+ ${inr(summary.cash_in_inr)}`],
    ['Expenses', `− ${inr(expensesInr)}`],
    ['Cash out to owner', `− ${inr(summary.cash_out_inr - expensesInr)}`],
  ];
  return (
    <div className="rounded-md border border-tan bg-surface p-4">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-charcoal">
        {endedAt ? 'The day' : 'Day so far'}{' '}
        <span className="font-normal normal-case text-muted">
          · {endedAt ? `${formatDayTime(openDay.opened_at)} to ${formatDayTime(endedAt)}` : `since ${formatDayTime(openDay.opened_at)}`}
        </span>
      </h2>
      <dl className="flex flex-col gap-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between text-sm">
            <dt className="text-muted">{label}</dt>
            <dd className="font-bold tabular-nums text-charcoal">{value}</dd>
          </div>
        ))}
        <div className="mt-1 flex items-center justify-between border-t border-tan/40 pt-2 text-base">
          <dt className="font-bold text-charcoal">{endedAt ? 'Expected cash in the drawer' : 'Expected cash now'}</dt>
          <dd className="font-bold tabular-nums text-charcoal">{inr(summary.expected_cash_inr)}</dd>
        </div>
      </dl>

      {sales.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowSales((v) => !v)}
            aria-expanded={showSales}
            className="min-h-[44px] w-full rounded-md border border-tan/50 bg-white px-3 text-left text-sm font-bold text-charcoal"
          >
            {showSales ? 'Hide' : 'Show'} the {sales.length} cash sale{sales.length === 1 ? '' : 's'}
          </button>
          {showSales ? (
            <ul className="mt-2 divide-y divide-[#f0ece6] rounded-md border border-line bg-white text-sm">
              {sales.map((s) => (
                <li key={s.order_id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-charcoal">
                    {s.order_number !== null ? formatOrderNumber(s.order_number) : 'Order'}
                    <span className="ml-2 text-xs text-muted">{formatTime(s.at)}</span>
                  </span>
                  <span className="font-bold tabular-nums text-charcoal">{inr(s.amount_inr)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-xs text-muted">
        Received this shift, not in the drawer: UPI {inr(summary.upi_inr)} · Card {inr(summary.card_inr)}
        {summary.online_inr > 0 ? ` · Online ${inr(summary.online_inr)}` : ''}
        {summary.swiggy_dineout_inr ? ` · Swiggy Dineout ${inr(summary.swiggy_dineout_inr)}` : ''}
        {summary.zomato_district_inr ? ` · Zomato District ${inr(summary.zomato_district_inr)}` : ''}
      </p>
    </div>
  );
}

// ── Close + handover ─────────────────────────────────────────────────────────

function CloseForm({
  openDay,
  summary,
  unpaid,
  canOverrideUnpaid,
  busy,
  onClose,
}: {
  openDay: CashDay;
  summary: OpenSummary;
  unpaid: UnpaidInfo;
  canOverrideUnpaid: boolean;
  busy: boolean;
  onClose: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [closingDenoms, setClosingDenoms] = useState<CashDenoms>(EMPTY_DENOMS);
  // null until the staffer touches the float grid: it is then prefilled with the
  // day's opening float, capped at what was counted.
  const [floatEdited, setFloatEdited] = useState<CashDenoms | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [notes, setNotes] = useState('');
  const [confirmZero, setConfirmZero] = useState(false);
  const [overrideOn, setOverrideOn] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [confirming, setConfirming] = useState(false);

  const floatLeft = useMemo(
    () => capDenoms(floatEdited ?? openDay.opening_denoms, closingDenoms),
    [floatEdited, openDay.opening_denoms, closingDenoms],
  );

  const evaluation = evaluateClose({
    openingTotalInr: summary.opening_total_inr,
    flows: {
      cashSalesInr: summary.cash_sales_inr,
      cashRefundsInr: summary.cash_refunds_inr,
      cashInInr: summary.cash_in_inr,
      cashOutInr: summary.cash_out_inr,
    },
    closingDenoms,
    floatLeftDenoms: floatLeft,
    closeReason,
    confirmZeroCount: confirmZero,
    unpaidCount: unpaid.count,
    isManager: canOverrideUnpaid,
    unpaidOverrideReason: overrideOn ? overrideReason : '',
  });
  const { countedInr, expectedInr, varianceInr } = evaluation;
  const needsZeroConfirm = zeroCountNeedsConfirm(countedInr, expectedInr);
  const blocked = evaluation.problems.length > 0;

  const submit = async () => {
    const ok = await onClose({
      closing_denoms: closingDenoms,
      float_left_denoms: floatLeft,
      close_reason: closeReason.trim(),
      notes: notes.trim(),
      confirm_zero_count: confirmZero,
      unpaid_override_reason: overrideOn ? overrideReason.trim() : '',
    });
    if (ok) {
      setClosingDenoms(EMPTY_DENOMS);
      setFloatEdited(null);
      setCloseReason('');
      setNotes('');
      setConfirmZero(false);
      setOverrideOn(false);
      setOverrideReason('');
      setConfirming(false);
    } else {
      setConfirming(false);
    }
  };

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-charcoal">1. Count the drawer to close</h2>

      {unpaid.count > 0 ? (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-bold">
            {unpaid.count} unpaid order{unpaid.count === 1 ? '' : 's'} since the day opened
          </p>
          <p className="mt-0.5">Settle {unpaid.count === 1 ? 'it' : 'them'} before closing, or their cash will land after the count.</p>
          <ul className="mt-1 text-xs">
            {unpaid.orders.slice(0, 5).map((o) => (
              <li key={o.id}>
                {formatOrderNumber(o.order_number)} · {inr(o.total_inr)} · {formatTime(o.created_at)}
              </li>
            ))}
            {unpaid.count > 5 ? <li>…and {unpaid.count - 5} more</li> : null}
          </ul>
          <Link
            href="/staff/settle"
            className="mt-2 inline-flex min-h-[44px] items-center rounded-md bg-red-700 px-4 text-sm font-bold text-white"
          >
            Go to Settle
          </Link>
          {canOverrideUnpaid ? (
            <div className="mt-3 border-t border-red-200 pt-3">
              <label className="flex min-h-[44px] items-center gap-2 text-sm font-bold">
                <input
                  type="checkbox"
                  checked={overrideOn}
                  onChange={(e) => setOverrideOn(e.target.checked)}
                  className="h-5 w-5"
                />
                Close anyway (manager override)
              </label>
              {overrideOn ? (
                <textarea
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  rows={2}
                  placeholder="Why close with unpaid orders?"
                  className="mt-1 w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm text-charcoal focus:outline-none"
                />
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-xs">Only a manager or owner can close the day with unpaid orders.</p>
          )}
        </div>
      ) : null}

      <CashDayDenomGrid
        denoms={closingDenoms}
        onChange={(next) => {
          setClosingDenoms(next);
          setConfirming(false);
        }}
        disabled={busy}
      />

      <div className="mt-4 rounded-md border border-line bg-cream p-3">
        <Line label="Expected in drawer" value={inr(expectedInr)} />
        <Line label="Counted" value={inr(countedInr)} />
        <div className="mt-1 flex items-center justify-between border-t border-line pt-2 text-sm">
          <span className="font-bold text-charcoal">Over / short</span>
          <OverShort variance={varianceInr} />
        </div>
      </div>

      {needsZeroConfirm ? (
        <label className="mt-3 flex min-h-[44px] items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <input
            type="checkbox"
            checked={confirmZero}
            onChange={(e) => setConfirmZero(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0"
          />
          <span>
            <b>You counted ₹0 but {inr(expectedInr)} is expected.</b> Tick to confirm the drawer really is empty.
          </span>
        </label>
      ) : null}

      {varianceInr !== 0 ? (
        <label className="mt-3 block text-sm">
          <span className="text-charcoal">
            Why is the drawer {varianceInr > 0 ? 'over' : 'short'} by {inr(Math.abs(varianceInr))}?{' '}
            <span className="text-red-600">(required)</span>
          </span>
          <textarea
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="e.g. two ₹200 notes stuck together, recount pending"
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm focus:border-tan focus:outline-none disabled:bg-surface"
          />
        </label>
      ) : null}

      <h2 className="mb-1 mt-6 text-sm font-bold uppercase tracking-wide text-charcoal">2. Handover</h2>
      <p className="mb-2 text-sm text-muted">
        Enter the float that stays in the drawer for tomorrow. Everything else counted is cash taken out to the
        owner or bank.
      </p>
      <CashDayDenomGrid
        denoms={floatLeft}
        onChange={setFloatEdited}
        disabled={busy || countedInr === 0}
        max={closingDenoms}
        totalLabel="Float left"
      />
      <div className="mt-3 rounded-md border border-line bg-cream p-3">
        <Line label="Counted" value={inr(countedInr)} />
        <Line label="Float left for tomorrow" value={`− ${inr(evaluation.floatLeftInr)}`} />
        <div className="mt-1 flex items-center justify-between border-t border-line pt-2 text-sm">
          <span className="font-bold text-charcoal">Cash taken out</span>
          <span className="text-lg font-bold tabular-nums text-charcoal">{inr(evaluation.takenOutInr)}</span>
        </div>
      </div>

      <label className="mt-3 block text-sm">
        <span className="text-charcoal">
          Notes <span className="text-muted">(optional)</span>
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          disabled={busy}
          placeholder="Any handover notes…"
          className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm focus:border-tan focus:outline-none disabled:bg-surface"
        />
      </label>

      {blocked ? (
        <ul className="mt-3 list-disc pl-5 text-xs text-red-700">
          {evaluation.problems.map((p) => (
            <li key={p.code}>{p.message}</li>
          ))}
        </ul>
      ) : null}

      {confirming && !blocked ? (
        <div className="mt-3 rounded-md border border-tan bg-surface p-4">
          <p className="text-sm font-bold text-charcoal">Close the cash day?</p>
          <dl className="mt-2 flex flex-col gap-1 text-sm">
            <Line label="Expected" value={inr(expectedInr)} />
            <Line label="Counted" value={inr(countedInr)} />
            <div className="flex items-center justify-between">
              <dt className="text-muted">Over / short</dt>
              <dd>
                <OverShort variance={varianceInr} />
              </dd>
            </div>
            <Line label="Cash taken out" value={inr(evaluation.takenOutInr)} />
            <Line label="Float left for tomorrow" value={inr(evaluation.floatLeftInr)} />
          </dl>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-md border border-[#ddd] px-4 py-3 text-sm font-bold text-charcoal disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-md bg-charcoal px-4 py-3 text-sm font-bold text-cream transition-colors hover:bg-black disabled:opacity-50"
            >
              {busy ? 'Closing…' : 'Yes, close the day'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy || blocked}
          className="mt-3 min-h-[44px] w-full rounded-md bg-charcoal px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
        >
          {blocked ? 'Finish the steps above to close' : 'Review & close the day'}
        </button>
      )}
    </section>
  );
}

// ── Reopen ───────────────────────────────────────────────────────────────────

function ReopenCard({
  day,
  busy,
  onReopen,
}: {
  day: ReopenableDay;
  busy: boolean;
  onReopen: (id: string, reason: string) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const problem = cashReasonProblem(reason, 'reopening the day');
  return (
    <section className="mt-6 rounded-md border border-line bg-cream p-4">
      <h2 className="text-sm font-bold uppercase tracking-wide text-charcoal">Closed by mistake?</h2>
      <p className="mt-1 text-sm text-muted">
        The last day ({day.business_date}
        {day.closed_at ? `, closed ${formatDayTime(day.closed_at)}` : ''}) can be reopened by a manager. Cash already
        taken out at that close stays recorded as taken out.
      </p>
      {asking ? (
        <div className="mt-3">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="Why is the day being reopened?"
            className="w-full rounded-md border border-line px-3 py-2 text-sm focus:border-tan focus:outline-none"
          />
          <div className="mt-2 flex gap-3">
            <button
              type="button"
              onClick={() => setAsking(false)}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-md border border-[#ddd] px-4 text-sm font-bold text-charcoal"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                if (await onReopen(day.id, reason.trim())) {
                  setAsking(false);
                  setReason('');
                }
              }}
              disabled={busy || Boolean(problem)}
              className="min-h-[44px] flex-1 rounded-md bg-charcoal px-4 text-sm font-bold text-cream disabled:opacity-50"
            >
              {busy ? 'Reopening…' : 'Reopen the day'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="mt-3 min-h-[44px] rounded-md border border-charcoal px-4 text-sm font-bold text-charcoal hover:bg-charcoal hover:text-cream"
        >
          Reopen the last day…
        </button>
      )}
    </section>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-bold tabular-nums text-charcoal">{value}</span>
    </div>
  );
}

function OverShort({ variance }: { variance: number }) {
  if (variance === 0) {
    return <span className="font-bold tabular-nums text-[#2f6b38]">₹0 · ties out</span>;
  }
  const over = variance > 0;
  return (
    <span className={'font-bold tabular-nums ' + (over ? 'text-[#2f6b38]' : 'text-red-600')}>
      {over ? '+' : '−'}₹{Math.abs(variance)} · {over ? 'over' : 'short'}
    </span>
  );
}

function ClosureHistory({ history }: { history: CashDay[] }) {
  if (history.length === 0) return null;
  const money = (n: number | null) => (n === null || n === undefined ? '—' : inr(n));
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-charcoal">Recent closures</h2>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2 font-bold">Date</th>
              <th className="px-3 py-2 text-right font-bold">Cash sales</th>
              <th className="px-3 py-2 text-right font-bold">Expected</th>
              <th className="px-3 py-2 text-right font-bold">Counted</th>
              <th className="px-3 py-2 text-right font-bold">Over / short</th>
              <th className="px-3 py-2 text-right font-bold">Taken out</th>
              <th className="px-3 py-2 text-right font-bold">Float left</th>
            </tr>
          </thead>
          <tbody>
            {history.map((d) => (
              <tr key={d.id} className="border-b border-[#f0ece6] last:border-b-0">
                <td className="px-3 py-2 font-medium text-charcoal">{d.business_date}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{money(d.cash_sales_inr)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{money(d.expected_cash_inr)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{money(d.counted_total_inr)}</td>
                <td className="px-3 py-2 text-right">
                  <OverShort variance={d.over_short_inr} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{money(d.handover_inr)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{money(d.float_left_total_inr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata',
    });
  } catch {
    return '';
  }
}

// "Mon 28 Sep, 11:40 pm" — the café runs past midnight, so a bare time is
// ambiguous about which day it belongs to.
function formatDayTime(iso: string): string {
  try {
    const d = new Date(iso);
    const day = d.toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'Asia/Kolkata',
    });
    return `${day}, ${formatTime(iso)}`;
  } catch {
    return '';
  }
}
