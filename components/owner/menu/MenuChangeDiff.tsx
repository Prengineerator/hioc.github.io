'use client';

// The before → after reading of one menu change request (card body). A pure
// view of buildRequestDiff (menuDiff.ts): an edit shows each changed field as
// "was → now", a new item shows the values it will start with, and a delete
// shows what is about to go. Changes are marked with words and strike-through
// as well as colour.

import { useMemo } from 'react';
import type { MenuItemChangeRequest } from '@/lib/menu/changeRequestTypes';
import {
  buildRequestDiff,
  formatPrice,
  type AddonDiff,
  type DiffMode,
  type DiffRow,
  type VariantDiffRow,
} from './menuDiff';

export function MenuChangeDiff({
  request,
  addonNames,
}: {
  request: MenuItemChangeRequest;
  /** Add-on group id → display name. */
  addonNames: Record<string, string>;
}) {
  const diff = useMemo(() => buildRequestDiff(request, addonNames), [request, addonNames]);

  if (diff.rows.length === 0) {
    return <p className="text-sm text-muted">No details were recorded for this request.</p>;
  }

  return (
    <dl className="divide-y divide-line rounded-md border border-line bg-surface/40">
      {diff.rows.map((row) => (
        <div key={row.key} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-xs font-bold uppercase tracking-wide text-muted sm:pt-1">{row.label}</dt>
          <dd className="min-w-0 text-charcoal">
            <RowValue row={row} mode={diff.mode} perKg={diff.perKg} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RowValue({
  row,
  mode,
  perKg,
}: {
  row: DiffRow;
  mode: DiffMode;
  perKg: { before: boolean; after: boolean };
}) {
  switch (row.type) {
    case 'text':
      return <TextValue before={row.before} after={row.after} mode={mode} />;
    case 'image':
      return <ImageValue before={row.before} after={row.after} mode={mode} />;
    case 'variants':
      return <VariantsTable rows={row.rows} mode={mode} perKg={perKg} />;
    case 'addons':
      return <AddonChips diff={row.diff} mode={mode} />;
  }
}

const WAS = 'rounded bg-red-50 px-1.5 py-0.5 text-red-800 line-through decoration-red-400';
const NOW = 'rounded bg-green-50 px-1.5 py-0.5 font-bold text-green-900';

function TextValue({ before, after, mode }: { before: string | null; after: string | null; mode: DiffMode }) {
  if (mode === 'diff') {
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
  return <span className="whitespace-pre-wrap break-words">{mode === 'proposed' ? after : before}</span>;
}

function Thumb({ url }: { url: string | null }) {
  return url ? (
    // Supabase Storage public URL, like the item table: a plain <img>.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="h-14 w-14 rounded-md border border-line object-cover" />
  ) : (
    <span className="flex h-14 w-14 items-center justify-center rounded-md border border-dashed border-line text-[11px] text-muted">
      No photo
    </span>
  );
}

function ImageValue({ before, after, mode }: { before: string | null; after: string | null; mode: DiffMode }) {
  if (mode === 'diff') {
    return (
      <span className="flex flex-wrap items-center gap-3">
        <span className="flex flex-col items-start gap-1">
          <Thumb url={before || null} />
          <span className="text-[11px] text-muted">Before</span>
        </span>
        <span aria-hidden="true" className="text-muted">
          →
        </span>
        <span className="flex flex-col items-start gap-1">
          <Thumb url={after || null} />
          <span className="text-[11px] font-bold text-green-900">After</span>
        </span>
      </span>
    );
  }
  return <Thumb url={(mode === 'proposed' ? after : before) || null} />;
}

const ROW_TINT: Record<VariantDiffRow['status'], string> = {
  same: '',
  changed: 'bg-amber-50',
  added: 'bg-green-50',
  removed: 'bg-red-50',
};

function VariantsTable({
  rows,
  mode,
  perKg,
}: {
  rows: VariantDiffRow[];
  mode: DiffMode;
  perKg: { before: boolean; after: boolean };
}) {
  if (rows.length === 0) return <span className="text-muted">None</span>;
  const diff = mode === 'diff';
  return (
    <div className="overflow-x-auto">
      <table className="w-full max-w-md text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th scope="col" className="py-1 pr-3 font-semibold">
              {perKg.after || perKg.before ? 'Option' : 'Size'}
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
                {perKg.after || perKg.before ? 'Price per kg' : 'Price'}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.label}:${i}`} className={diff ? ROW_TINT[r.status] : ''}>
              <th scope="row" className="py-1.5 pl-1.5 pr-3 text-left font-semibold text-charcoal">
                {r.label}
                {diff && r.status === 'added' ? <Tag tone="good">New</Tag> : null}
                {diff && r.status === 'removed' ? <Tag tone="bad">Removed</Tag> : null}
              </th>
              {diff ? (
                <>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted">
                    {r.before === null ? '—' : formatPrice(r.before, perKg.before)}
                  </td>
                  <td
                    className={
                      'py-1.5 pl-3 pr-1.5 text-right font-mono tabular-nums ' +
                      (r.status === 'changed' || r.status === 'added' ? 'font-bold text-charcoal' : 'text-charcoal')
                    }
                  >
                    {r.after === null ? '—' : formatPrice(r.after, perKg.after)}
                  </td>
                </>
              ) : (
                <td className="py-1.5 pl-3 pr-1.5 text-right font-mono tabular-nums text-charcoal">
                  {formatPrice((mode === 'proposed' ? r.after : r.before) ?? 0, mode === 'proposed' ? perKg.after : perKg.before)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tag({ tone, children }: { tone: 'good' | 'bad'; children: string }) {
  return (
    <span
      className={
        'ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ' +
        (tone === 'good' ? 'bg-green-100 text-green-900' : 'bg-red-100 text-red-800')
      }
    >
      {children}
    </span>
  );
}

function AddonChips({ diff, mode }: { diff: AddonDiff; mode: DiffMode }) {
  const chip = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold';
  if (mode !== 'diff') {
    const all = [...diff.kept, ...diff.added, ...diff.removed];
    if (all.length === 0) return <span className="text-muted">None</span>;
    return (
      <ul className="flex flex-wrap gap-1.5">
        {all.map((name, i) => (
          <li key={`${name}:${i}`} className={`${chip} bg-[#f2efe9] text-charcoal`}>
            {name}
          </li>
        ))}
      </ul>
    );
  }
  if (diff.kept.length + diff.added.length + diff.removed.length === 0) {
    return <span className="text-muted">None</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {diff.kept.map((name, i) => (
        <li key={`k:${name}:${i}`} className={`${chip} bg-[#f2efe9] text-charcoal`}>
          {name}
        </li>
      ))}
      {diff.added.map((name, i) => (
        <li key={`a:${name}:${i}`} className={`${chip} bg-green-100 text-green-900`}>
          <span aria-hidden="true">+&nbsp;</span>
          <span className="sr-only">Added: </span>
          {name}
        </li>
      ))}
      {diff.removed.map((name, i) => (
        <li key={`r:${name}:${i}`} className={`${chip} bg-red-100 text-red-800`}>
          <span aria-hidden="true">−&nbsp;</span>
          <span className="sr-only">Removed: </span>
          <span className="line-through">{name}</span>
        </li>
      ))}
    </ul>
  );
}
