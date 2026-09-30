'use client';

// The HIOC Ritual numbers (docs/COFFEE-PASS-SPEC.md CP-D19, CP-D21): what was sold,
// refunded, served and lapsed in a range of IST days, plus the live totals (active
// passes, cups outstanding, and the LIABILITY: what the cafe still owes in cups at
// what customers paid). GET /api/owner/passes/summary does the math
// (lib/passes/summary.ts); lib/passes/ownerUi.ts words the cards.
//
// It loads on its own, so a failed summary never hides the plans below it. While a
// new range loads the last numbers stay on screen (dimmed) rather than collapsing
// to a skeleton, so the page does not jump.

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { istDateIso } from '@/lib/api/date';
import type { PassProgramSummary } from '@/lib/passes/summary';
import {
  cupsLeftLabel,
  checkCustomRange,
  formatCount,
  formatIstDay,
  formatRupees,
  formatValidTill,
  passStateLabel,
  passStateTone,
  passValidTillIso,
  presetRange,
  summaryCards,
  summaryQuery,
  SUMMARY_PRESETS,
  type DateRange,
  type SummaryPreset,
} from '@/lib/passes/ownerUi';
import { callOwnerApi } from './api';
import { InlineError, Section, StatTile } from './shared';

type Recent = PassProgramSummary['recent'][number];

const RECENT_COLUMNS: DataTableColumn<Recent>[] = [
  {
    key: 'holder',
    header: 'Holder',
    filter: 'none',
    sortable: true,
    value: (r) => r.holder_name,
    cellClassName: 'font-semibold text-charcoal',
  },
  {
    key: 'phone',
    header: 'Phone',
    filter: 'none',
    sortable: false,
    value: (r) => r.holder_phone_masked,
    cellClassName: 'font-mono tabular-nums text-muted',
  },
  { key: 'plan', header: 'Plan', filter: 'none', sortable: true, value: (r) => r.plan_name, cellClassName: 'text-charcoal' },
  {
    key: 'bought',
    header: 'Bought',
    filter: 'none',
    sortable: true,
    value: (r) => r.created_at,
    render: (r) => formatIstDay(r.created_at),
    cellClassName: 'whitespace-nowrap text-charcoal',
  },
  {
    key: 'left',
    header: 'Cups left',
    filter: 'none',
    sortable: true,
    align: 'right',
    value: (r) => r.drinks_remaining,
    render: (r) => cupsLeftLabel(r.drinks_remaining, r.drinks_total),
    cellClassName: 'whitespace-nowrap font-mono tabular-nums text-charcoal',
  },
  {
    key: 'till',
    header: 'Valid till',
    filter: 'none',
    sortable: true,
    value: (r) => passValidTillIso(r.expires_at),
    render: (r) => formatValidTill(r.expires_at),
    cellClassName: 'whitespace-nowrap text-charcoal',
  },
  {
    key: 'state',
    header: 'State',
    filter: 'none',
    sortable: true,
    value: (r) => passStateLabel(r.state),
    render: (r) => <Badge variant={passStateTone(r.state)}>{passStateLabel(r.state)}</Badge>,
  },
];

export function SummarySection() {
  const [today, setToday] = useState<string | null>(null);
  const [preset, setPreset] = useState<SummaryPreset>('30d');
  const [range, setRange] = useState<DateRange | null>(null);
  const [custom, setCustom] = useState<DateRange>({ from: '', to: '' });
  const [customError, setCustomError] = useState('');
  const [data, setData] = useState<PassProgramSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloads, setReloads] = useState(0);

  // "Today" is read once, on the client, after mount: the server render never
  // depends on the clock, so there is nothing to mismatch at hydration.
  useEffect(() => {
    const t = istDateIso();
    setToday(t);
    setRange(presetRange('30d', t));
  }, []);

  const from = range?.from;
  const to = range?.to;
  useEffect(() => {
    if (!from || !to) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    callOwnerApi<PassProgramSummary>(`/api/owner/passes/summary?${summaryQuery({ from, to })}`, { signal: controller.signal }).then(
      (res) => {
        if (controller.signal.aborted) return;
        if (res.ok) setData(res.data);
        else setError(res.error);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [from, to, reloads]);

  const choose = (next: SummaryPreset) => {
    if (!today) return;
    setPreset(next);
    setCustomError('');
    if (next === 'custom') {
      // Start the custom boxes from what is on screen, so the owner adjusts rather than starts over.
      setCustom({ from: range?.from ?? today, to: range?.to ?? today });
    } else {
      setRange(presetRange(next, today));
    }
  };

  const applyCustom = () => {
    if (!today) return;
    const checked = checkCustomRange(custom.from, custom.to, today);
    if (!checked.ok) {
      setCustomError(checked.message);
      return;
    }
    setCustomError('');
    setRange(checked.range);
  };

  const cards = useMemo(() => (data ? summaryCards(data) : []), [data]);

  return (
    <Section
      title="Summary"
      description={
        range
          ? `${formatIstDay(`${range.from}T06:00:00Z`)}${range.from === range.to ? '' : ` – ${formatIstDay(`${range.to}T06:00:00Z`)}`}. Active Rituals, cups outstanding and liability are live totals; everything else follows these dates.`
          : undefined
      }
      actions={
        <div role="group" aria-label="Date range" className="flex flex-wrap gap-2">
          {SUMMARY_PRESETS.map((p) => {
            const on = preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                disabled={!today}
                onClick={() => choose(p.id)}
                className={`min-h-[44px] rounded-full border px-4 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan disabled:opacity-50 ${
                  on ? 'border-charcoal bg-charcoal text-cream' : 'border-line bg-white text-charcoal hover:border-charcoal'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      }
    >
      {preset === 'custom' && today ? (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Input
              label="From"
              type="date"
              value={custom.from}
              max={today}
              onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
            />
          </div>
          <div className="w-44">
            <Input
              label="To"
              type="date"
              value={custom.to}
              max={today}
              onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
            />
          </div>
          <Button onClick={applyCustom}>Show</Button>
          {customError ? (
            <p role="alert" className="basis-full text-sm font-semibold text-red-700">
              {customError}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <InlineError message={error} onRetry={() => setReloads((n) => n + 1)} />
      ) : !data ? (
        <div aria-busy="true" aria-label="Loading the summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className={`h-24 ${i === 4 ? 'lg:col-span-2' : ''}`} />
          ))}
        </div>
      ) : (
        <div aria-busy={loading} className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {cards.map((c) => (
              <div key={c.id} className={c.emphasis ? 'col-span-2' : ''}>
                <StatTile label={c.label} value={c.value} sub={c.sub} emphasis={c.emphasis} />
              </div>
            ))}
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div>
              <h3 className="mb-2 text-sm font-bold text-charcoal">Sold by plan</h3>
              {data.sold_by_plan.length === 0 ? (
                <p className="rounded-md border border-line bg-white px-4 py-6 text-center text-sm text-muted">
                  Nothing sold in these dates.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[280px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                        <th scope="col" className="py-1.5 pr-3">Plan</th>
                        <th scope="col" className="py-1.5 pr-3 text-right">Sold</th>
                        <th scope="col" className="py-1.5 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sold_by_plan.map((p) => (
                        <tr key={p.plan_name} className="border-t border-line">
                          <td className="py-2 pr-3 font-semibold text-charcoal">{p.plan_name}</td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums text-charcoal">{formatCount(p.count)}</td>
                          <td className="py-2 text-right font-mono tabular-nums text-charcoal">{formatRupees(p.inr)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-bold text-charcoal">Recent Rituals</h3>
              {data.recent.length === 0 ? (
                <EmptyState heading="No Rituals sold yet" body="They will show up here as soon as one is bought online or at the counter." />
              ) : (
                <DataTable
                  rows={data.recent}
                  columns={RECENT_COLUMNS}
                  rowKey={(r) => r.id}
                  minWidth={680}
                  cellPadding="py-2 pr-3"
                  headerTextClassName="text-[10px] font-semibold uppercase tracking-wide text-muted"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
