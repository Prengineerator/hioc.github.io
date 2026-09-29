'use client';

// The cash day log (GET /api/cash-days/log): one card per day — opened (who,
// when), the float and any difference from what the last close left (+ the
// reason), cash sales / refunds / cash in / out, expected vs counted (+ the
// reason), the handover (taken out, float left), closed (who, when), and every
// reopen. Cards, not a table, for the same reason as the count log: this does
// not fit fixed columns at 360px. A day with no handover figures was closed
// before the handover feature and shows dashes.

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import type { OwnerCashDayRow } from './types';
import { formatWhen, rupees } from './types';

const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : rupees(n));

function VarianceText({ value }: { value: number }) {
  if (value === 0) return <span className="font-bold text-green-700">Ties out</span>;
  return (
    <span className={'font-bold ' + (value < 0 ? 'text-red-700' : 'text-green-700')}>
      {value < 0 ? '−' : '+'}
      {rupees(Math.abs(value))} {value < 0 ? 'short' : 'over'}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-sm">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="text-right text-charcoal">{children}</dd>
    </div>
  );
}

function DayCard({ day }: { day: OwnerCashDayRow }) {
  const isOpen = day.status === 'open';
  const closeReason = day.close_reason || day.notes; // days closed before close_reason kept it in notes
  const hasHandover = day.handover_inr !== null;
  return (
    <details className="group rounded-md border border-line">
      <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
        <span className="min-w-0">
          <span className="font-bold text-charcoal">{day.business_date}</span>
          <span
            className={
              'ml-2 rounded px-1.5 py-0.5 text-[11px] font-bold uppercase ' +
              (isOpen ? 'bg-green-100 text-green-800' : 'bg-surface text-muted')
            }
          >
            {isOpen ? (day.live ? 'Open now' : 'Open') : 'Closed'}
          </span>
          {day.reopen_log.length > 0 ? (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold uppercase text-amber-900">
              Reopened {day.reopen_log.length}×
            </span>
          ) : null}
        </span>
        <span className="text-right text-sm text-charcoal">
          {money(day.cash_sales_inr)} cash sales
          {!isOpen ? (
            <>
              {' · '}
              <VarianceText value={day.over_short_inr} />
            </>
          ) : null}
        </span>
      </summary>

      <dl className="divide-y divide-line border-t border-line px-3 py-2">
        <Row label="Opened">
          {formatWhen(day.opened_at)} · {day.opened_by_name ?? '—'}
        </Row>
        <Row label="Float">
          {rupees(day.opening_total_inr)}
          {day.open_variance_inr !== null && day.open_expected_total_inr !== null ? (
            day.open_variance_inr === 0 ? (
              <span className="block text-xs text-green-700">Matched the {rupees(day.open_expected_total_inr)} left</span>
            ) : (
              <span className="block text-xs text-red-700">
                {day.open_variance_inr < 0 ? '−' : '+'}
                {rupees(Math.abs(day.open_variance_inr))} vs the {rupees(day.open_expected_total_inr)} left
                {day.open_reason ? ` — ${day.open_reason}` : ''}
              </span>
            )
          ) : (
            <span className="block text-xs text-muted">Nothing to compare with</span>
          )}
        </Row>
        <Row label="Cash sales">
          {money(day.cash_sales_inr)}
          {day.cash_sales_count !== null ? <span className="text-xs text-muted"> ({day.cash_sales_count})</span> : null}
        </Row>
        <Row label="Cash refunds">{money(day.cash_refunds_inr)}</Row>
        <Row label="Cash in / out">
          {money(day.cash_in_inr)} / {money(day.cash_out_inr)}
        </Row>
        <Row label="UPI / card (not in drawer)">
          {money(day.upi_inr)} / {money(day.card_inr)}
        </Row>
        {day.swiggy_dineout_inr || day.zomato_district_inr ? (
          <Row label="Swiggy Dineout / Zomato District (not in drawer)">
            {money(day.swiggy_dineout_inr)} / {money(day.zomato_district_inr)}
          </Row>
        ) : null}
        <Row label="Expected">{money(day.expected_cash_inr)}</Row>
        {!isOpen ? (
          <>
            <Row label="Counted">{money(day.counted_total_inr)}</Row>
            <Row label="Over / short">
              <VarianceText value={day.over_short_inr} />
              {closeReason ? <span className="block text-xs text-muted">{closeReason}</span> : null}
            </Row>
            <Row label="Cash taken out">{hasHandover ? money(day.handover_inr) : '—'}</Row>
            <Row label="Float left">{hasHandover ? money(day.float_left_total_inr) : '—'}</Row>
            {day.unpaid_override_reason ? (
              <Row label="Closed with unpaid orders">
                {day.unpaid_count_at_close ?? ''} — {day.unpaid_override_reason}
              </Row>
            ) : null}
            <Row label="Closed">
              {day.closed_at ? formatWhen(day.closed_at) : '—'} · {day.closed_by_name ?? '—'}
            </Row>
          </>
        ) : null}
        {day.reopen_log.map((e, i) => (
          <Row key={`${e.at}-${i}`} label="Reopened">
            {formatWhen(e.at)} · {e.by_name ?? '—'}
            <span className="block text-xs text-muted">
              {e.reason}
              {e.prev_counted_inr !== null ? ` (undid a close that counted ${rupees(e.prev_counted_inr)})` : ''}
            </span>
          </Row>
        ))}
      </dl>
    </details>
  );
}

export function CashDayLog() {
  const [days, setDays] = useState<OwnerCashDayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/cash-days/log', { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? 'Could not load the cash days.');
          return;
        }
        setDays((body.days ?? []) as OwnerCashDayRow[]);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the cash days.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Cash days</h2>
      <p className="mt-1 text-xs text-muted">
        Open → close → handover: the float in, the day&apos;s cash, what the drawer held, and what left it.
      </p>
      {error ? (
        <p className="mt-3 text-sm text-red-700">{error}</p>
      ) : days === null ? (
        <p className="mt-3 text-sm text-muted">Loading…</p>
      ) : days.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No cash days yet.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {days.map((d) => (
            <DayCard key={d.id} day={d} />
          ))}
        </div>
      )}
    </Card>
  );
}
