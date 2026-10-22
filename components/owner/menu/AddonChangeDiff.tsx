'use client';

// The before → after reading of one add-on group request (card body), the
// add-on sibling of MenuChangeDiff. A pure view of buildAddonRequestDiff
// (menuDiff.ts): a new group shows its name, choice rule and options; an edit
// shows only what changes, with each option's old and new name and price.
// Changes are marked with words and strike-through as well as colour.

import { useMemo } from 'react';
import type { AddonGroupChangeRequest } from '@/lib/menu/changeRequestTypes';
import { buildAddonRequestDiff, formatPrice, type AddonOptionDiffRow } from './menuDiff';

const WAS = 'rounded bg-red-50 px-1.5 py-0.5 text-red-800 line-through decoration-red-400';
const NOW = 'rounded bg-green-50 px-1.5 py-0.5 font-bold text-green-900';

export function AddonChangeDiff({ request }: { request: AddonGroupChangeRequest }) {
  const diff = useMemo(() => buildAddonRequestDiff(request), [request]);
  const rows: { key: string; label: string; value: React.ReactNode }[] = [];
  if (diff.name) rows.push({ key: 'name', label: 'Name', value: <Change before={diff.name.before} after={diff.name.after} /> });
  if (diff.rule) rows.push({ key: 'rule', label: 'Choice rule', value: <Change before={diff.rule.before} after={diff.rule.after} /> });
  if (diff.options) {
    rows.push({ key: 'options', label: 'Options & prices', value: <OptionsTable rows={diff.options} diff={diff.mode === 'diff'} /> });
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted">No details were recorded for this request.</p>;
  }

  return (
    <dl className="divide-y divide-line rounded-md border border-line bg-surface/40">
      {rows.map((row) => (
        <div key={row.key} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-xs font-bold uppercase tracking-wide text-muted sm:pt-1">{row.label}</dt>
          <dd className="min-w-0 text-charcoal">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Change({ before, after }: { before: string | null; after: string }) {
  if (before === null) return <span className="whitespace-pre-wrap break-words">{after}</span>;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className={`${WAS} whitespace-pre-wrap break-words`}>
        <span className="sr-only">Was: </span>
        {before}
      </span>
      <span aria-hidden="true" className="text-muted">
        →
      </span>
      <span className={`${NOW} whitespace-pre-wrap break-words`}>
        <span className="sr-only">Now: </span>
        {after}
      </span>
    </span>
  );
}

const ROW_TINT: Record<AddonOptionDiffRow['status'], string> = {
  same: '',
  changed: 'bg-amber-50',
  added: 'bg-green-50',
};

function OptionsTable({ rows, diff }: { rows: AddonOptionDiffRow[]; diff: boolean }) {
  if (rows.length === 0) return <span className="text-muted">None</span>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full max-w-md text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th scope="col" className="py-1 pr-3 font-semibold">
              Option
            </th>
            {diff ? (
              <>
                <th scope="col" className="px-3 py-1 text-right font-semibold">
                  Before
                </th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">
                  After
                </th>
              </>
            ) : (
              <th scope="col" className="py-1 pl-3 text-right font-semibold">
                Price
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const renamed = r.before !== null && r.before.name !== r.after.name;
            const repriced = r.before !== null && r.before.price_inr !== r.after.price_inr;
            return (
              <tr key={r.key} className={diff ? ROW_TINT[r.status] : ''}>
                <th scope="row" className="py-1.5 pl-1.5 pr-3 text-left font-semibold text-charcoal">
                  {diff && renamed ? (
                    <>
                      <span className="font-normal text-red-800 line-through decoration-red-400">
                        <span className="sr-only">Was: </span>
                        {r.before?.name}
                      </span>{' '}
                      <span aria-hidden="true" className="font-normal text-muted">
                        →
                      </span>{' '}
                    </>
                  ) : null}
                  {r.after.name}
                  {diff && r.status === 'added' ? (
                    <span className="ml-2 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-900">
                      New
                    </span>
                  ) : null}
                </th>
                {diff ? (
                  <>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted">
                      {r.before === null ? '—' : addonPrice(r.before.price_inr)}
                    </td>
                    <td
                      className={
                        'py-1.5 pl-3 pr-1.5 text-right font-mono tabular-nums text-charcoal ' +
                        (repriced || r.status === 'added' ? 'font-bold' : '')
                      }
                    >
                      {addonPrice(r.after.price_inr)}
                    </td>
                  </>
                ) : (
                  <td className="py-1.5 pl-3 pr-1.5 text-right font-mono tabular-nums text-charcoal">
                    {addonPrice(r.after.price_inr)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** An add-on price as the menu shows it: "+₹40", or "Free". */
function addonPrice(priceInr: number): string {
  return priceInr > 0 ? `+${formatPrice(priceInr)}` : 'Free';
}
