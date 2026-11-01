// Owner → Reports → Items & custom: item-wise sales on screen, and any other
// cut of the sales the owner wants — rows by item, size, category, day,
// weekday, hour, staff, channel, order type, payment or table; an optional
// second dimension as a grid; filters; sort; top N; the period before; ready-
// made reports to start from; and the owner's own saved setups. Every number
// comes from the same dataset as the CSV downloads (lib/reports/salesExplorer.ts),
// and "Download CSV" writes exactly what is on screen. The screen itself is
// components/owner/reports/SalesReportView.tsx; this page loads its data.

import { istDateDaysAgo, istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { SalesReportView } from '@/components/owner/reports/SalesReportView';
import { parseRange } from '@/lib/reports/reconcile';
import { loadOrderDataset } from '@/lib/reports/exports/orderDataServer';
import {
  filterOptions,
  parseExplorerQuery,
  previousPeriod,
  runExplorer,
  type ExplorerResult,
  type FilterOptions,
} from '@/lib/reports/salesExplorer';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;

export default async function OwnerSalesReportPage({ searchParams }: { searchParams: SP }) {
  const today = istDateIso();
  const asked = Boolean(searchParams.from || searchParams.to);
  // Opens on the last 7 days: one day is too thin to say what sells.
  const range = asked ? parseRange(searchParams.from, searchParams.to, today) : parseRange(istDateDaysAgo(6), today, today);
  const from = range.ok ? range.from : istDateDaysAgo(6);
  const to = range.ok ? range.to : today;
  const query = parseExplorerQuery(searchParams);

  const admin = createAdminSupabaseClient();
  const before = previousPeriod(from, to);
  let result: ExplorerResult | null = null;
  let options: FilterOptions | null = null;
  let loadError = '';
  try {
    const [ds, prevDs] = await Promise.all([
      loadOrderDataset(admin, from, to),
      query.compare ? loadOrderDataset(admin, before.from, before.to) : Promise.resolve(null),
    ]);
    result = runExplorer(ds, query, prevDs);
    options = filterOptions(ds, query.filters);
  } catch (err) {
    console.error('owner sales report: load failed', err);
    loadError = 'The report could not be built. Please try again.';
  }

  return (
    <SalesReportView
      today={today}
      from={from}
      to={to}
      rangeMessage={range.ok ? null : range.message}
      query={query}
      result={result}
      options={options}
      loadError={loadError}
      before={before}
    />
  );
}
