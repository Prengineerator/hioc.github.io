'use client';

// Cash day open/close cockpit (OPS-2, STF-045). One GET /api/cash-days drives
// the whole surface:
//  - No open day  → the day-OPEN form: count the float into the denomination
//    grid, see the live total, open the day.
//  - Open day     → the day-SUMMARY (opening float, cash settles, cash refunds,
//    expected) + the day-CLOSE form: count the drawer, see expected vs counted
//    and a live over/short, add notes (required on any variance), sign off.
//  - Always       → recent closure history with an over/short trend.
//
// Money is server-authoritative: the grid totals and the over/short shown here
// are a live MIRROR; POST/PATCH recompute every stored figure server-side.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CashDayDenomGrid } from '@/components/staff/CashDayDenomGrid';
import { Spinner } from '@/components/ui/Spinner';
import { denomsTotalInr, overShortInr } from '@/lib/cash/denoms';
import type { CashDay, CashDenoms } from '@/lib/types';

interface OpenSummary {
  opening_total_inr: number;
  cash_settles_inr: number;
  cash_refunds_inr: number;
  cash_settle_count: number;
  expected_cash_inr: number;
}

const EMPTY_DENOMS: CashDenoms = {};

export function CashDayManager() {
  const [loading, setLoading] = useState(true);
  const [openDay, setOpenDay] = useState<CashDay | null>(null);
  const [openSummary, setOpenSummary] = useState<OpenSummary | null>(null);
  const [history, setHistory] = useState<CashDay[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const [openingDenoms, setOpeningDenoms] = useState<CashDenoms>(EMPTY_DENOMS);
  const [closingDenoms, setClosingDenoms] = useState<CashDenoms>(EMPTY_DENOMS);
  const [notes, setNotes] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/cash-days', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setOpenDay(data.open_day ?? null);
      setOpenSummary(data.open_summary ?? null);
      setHistory(data.history ?? []);
    } catch {
      /* keep last-known-good */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openTheDay = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/cash-days', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opening_denoms: openingDenoms }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error ?? 'Could not open the cash day.');
      } else {
        showToast(`Cash day opened with a ₹${denomsTotalInr(openingDenoms)} float.`);
        setOpeningDenoms(EMPTY_DENOMS);
        await load();
      }
    } catch {
      showToast('Could not open the cash day — please try again.');
    } finally {
      setBusy(false);
    }
  }, [openingDenoms, load]);

  const countedInr = useMemo(() => denomsTotalInr(closingDenoms), [closingDenoms]);
  const expectedInr = openSummary?.expected_cash_inr ?? 0;
  const variance = overShortInr(countedInr, expectedInr);
  const varianceUnexplained = variance !== 0 && !notes.trim();

  const closeTheDay = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/cash-days', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ closing_denoms: closingDenoms, notes: notes.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error ?? 'Could not close the cash day.');
      } else {
        showToast('Cash day closed and signed off.');
        setClosingDenoms(EMPTY_DENOMS);
        setNotes('');
        await load();
      }
    } catch {
      showToast('Could not close the cash day — please try again.');
    } finally {
      setBusy(false);
    }
  }, [closingDenoms, notes, load]);

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Spinner label="Loading cash day…" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-charcoal">Cash drawer</h1>
        <p className="text-sm text-muted">
          {openDay
            ? `Open since ${formatWhen(openDay.opened_at)} · float ₹${openDay.opening_total_inr}`
            : 'Count the opening float to start the day.'}
        </p>
      </div>

      {openDay ? (
        <>
          <CashSummary openDay={openDay} summary={openSummary} countedInr={countedInr} variance={variance} />

          <section className="mt-6">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-charcoal">
              Count the drawer to close
            </h2>
            <CashDayDenomGrid denoms={closingDenoms} onChange={setClosingDenoms} disabled={busy} />

            <div className="mt-4 rounded-md border border-[#e5e5e5] bg-cream p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Expected in drawer</span>
                <span className="font-bold tabular-nums text-charcoal">₹{expectedInr}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-sm">
                <span className="text-muted">Counted</span>
                <span className="font-bold tabular-nums text-charcoal">₹{countedInr}</span>
              </div>
              <div className="mt-1 flex items-center justify-between border-t border-[#e5e5e5] pt-2 text-sm">
                <span className="font-bold text-charcoal">Over / short</span>
                <OverShort variance={variance} />
              </div>
            </div>

            <label className="mt-3 block text-sm">
              <span className="text-charcoal">
                Notes {variance !== 0 ? <span className="text-red-600">(required — explain the variance)</span> : <span className="text-muted">(optional)</span>}
              </span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                disabled={busy}
                placeholder={variance !== 0 ? 'e.g. two ₹200 notes stuck together, recount pending' : 'Any handover notes…'}
                className="mt-1 w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-sm focus:border-tan focus:outline-none disabled:bg-[#f6efe9]"
              />
            </label>

            <button
              type="button"
              onClick={closeTheDay}
              disabled={busy || varianceUnexplained}
              className="mt-3 w-full rounded-md bg-charcoal px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Closing…' : varianceUnexplained ? 'Add a note to close' : 'Count & close the day'}
            </button>
          </section>
        </>
      ) : (
        <section>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-charcoal">
            Opening float
          </h2>
          <CashDayDenomGrid denoms={openingDenoms} onChange={setOpeningDenoms} disabled={busy} />
          <button
            type="button"
            onClick={openTheDay}
            disabled={busy || denomsTotalInr(openingDenoms) === 0}
            className="mt-3 w-full rounded-md bg-tan px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Opening…' : `Open the day with ₹${denomsTotalInr(openingDenoms)}`}
          </button>
        </section>
      )}

      <ClosureHistory history={history} />

      {toast ? (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-charcoal px-4 py-2 text-sm text-cream shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function CashSummary({
  openDay,
  summary,
  countedInr,
  variance,
}: {
  openDay: CashDay;
  summary: OpenSummary | null;
  countedInr: number;
  variance: number;
}) {
  const rows: [string, string][] = [
    ['Opening float', `₹${openDay.opening_total_inr}`],
    ['Cash settles' + (summary ? ` (${summary.cash_settle_count})` : ''), `+ ₹${summary?.cash_settles_inr ?? 0}`],
    ['Cash refunds', `− ₹${summary?.cash_refunds_inr ?? 0}`],
    ['Expected in drawer', `₹${summary?.expected_cash_inr ?? openDay.opening_total_inr}`],
  ];
  return (
    <div className="rounded-md border border-tan bg-[#f6efe9] p-4">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-charcoal">Day so far</h2>
      <dl className="flex flex-col gap-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between text-sm">
            <dt className="text-muted">{label}</dt>
            <dd className="font-bold tabular-nums text-charcoal">{value}</dd>
          </div>
        ))}
        {countedInr > 0 ? (
          <div className="flex items-center justify-between border-t border-tan/40 pt-1 text-sm">
            <dt className="font-bold text-charcoal">Live over / short</dt>
            <dd>
              <OverShort variance={variance} />
            </dd>
          </div>
        ) : null}
      </dl>
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
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-charcoal">
        Recent closures
      </h2>
      <div className="overflow-x-auto rounded-md border border-[#e5e5e5]">
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr className="border-b border-[#e5e5e5] text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2 font-bold">Date</th>
              <th className="px-3 py-2 text-right font-bold">Expected</th>
              <th className="px-3 py-2 text-right font-bold">Counted</th>
              <th className="px-3 py-2 text-right font-bold">Over / short</th>
            </tr>
          </thead>
          <tbody>
            {history.map((d) => (
              <tr key={d.id} className="border-b border-[#f0ece6] last:border-b-0">
                <td className="px-3 py-2 font-medium text-charcoal">{d.business_date}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">₹{d.expected_cash_inr}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">₹{d.counted_total_inr}</td>
                <td className="px-3 py-2 text-right">
                  <OverShort variance={d.over_short_inr} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata',
    });
  } catch {
    return '';
  }
}
