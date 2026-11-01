// Owner → Reports → Overview: what sold — the best sellers and the category
// mix, each opening the full report on Items & custom for the same dates.
// Fed by lib/reports/salesExplorer.ts, so the numbers are Items & custom's.

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card, inr } from '@/components/owner/dashboard';
import type { ExplorerResult } from '@/lib/reports/salesExplorer';

export function WhatSold({ sold, from, to }: { sold: { items: ExplorerResult; categories: ExplorerResult }; from: string; to: string }) {
  const items = sold.items;
  const cats = sold.categories;
  const range = `from=${from}&to=${to}`;
  const maxItem = Math.max(...items.rows.map((r) => r.salesInr), 1);
  const linkCls = 'mt-3 inline-block text-sm font-bold text-charcoal underline';
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Top sellers">
        {items.rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">Nothing sold on these dates.</p>
        ) : (
          <ol className="flex flex-col gap-2 text-sm">
            {items.rows.map((r, i) => (
              <li key={r.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    <span className="mr-2 text-xs text-muted">{i + 1}</span>
                    <span className="font-bold text-charcoal">{r.label}</span>
                    <span className="ml-2 text-xs text-muted">× {r.qty.toLocaleString('en-IN')}</span>
                  </span>
                  <span className="font-mono tabular-nums text-charcoal">{inr(r.salesInr)}</span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#f2efe9]">
                  <div className="h-full bg-tan" style={{ width: `${(r.salesInr / maxItem) * 100}%` }} />
                </div>
              </li>
            ))}
          </ol>
        )}
        <Link href={`/owner/reports/sales?${range}`} className={linkCls}>
          All {items.rowCount} items, item-wise →
        </Link>
      </Card>

      <Card title="Sales by category">
        {cats.rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">Nothing sold on these dates.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {cats.rows.slice(0, 10).map((r) => (
              <li key={r.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate font-bold text-charcoal">{r.label}</span>
                  <span className="font-mono tabular-nums text-charcoal">
                    {inr(r.netInr)} <span className="text-xs text-muted">· {r.sharePct}%</span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#f2efe9]">
                  <div className="h-full bg-tan" style={{ width: `${r.sharePct}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">Net sales: what the bills came to, shared across their items.</p>
        <Link href={`/owner/reports/sales?${range}&rows=category`} className={linkCls}>
          Category-wise report →
        </Link>
      </Card>
    </div>
  );
}

