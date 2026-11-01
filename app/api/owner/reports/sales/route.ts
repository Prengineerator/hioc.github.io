import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { toCsv } from '@/lib/reports/csv';
import { exportFileName, resolvePeriod } from '@/lib/reports/exports/period';
import { loadOrderDataset } from '@/lib/reports/exports/orderDataServer';
import { explorerCsv, parseExplorerQuery, previousPeriod, runExplorer } from '@/lib/reports/salesExplorer';

export const dynamic = 'force-dynamic';

// GET /api/owner/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD&<setup> — owner
// only. The Items & custom report (Owner → Reports) as a CSV: exactly the rows,
// columns, filters and comparison on screen, from the same query string the
// page reads (lib/reports/salesExplorer.ts parseExplorerQuery).
export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  const url = new URL(request.url);
  const range = resolvePeriod({ from: url.searchParams.get('from'), to: url.searchParams.get('to') }, istDateIso());
  if (!range.ok) return errorResponse(400, range.message);

  // Repeated keys (category=…&category=…) as lists, the way the page gets them.
  const params: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams) {
    const cur = params[k];
    params[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  const query = parseExplorerQuery(params);

  let csv: string;
  try {
    const admin = createAdminSupabaseClient();
    const before = previousPeriod(range.from, range.to);
    const [ds, prevDs] = await Promise.all([
      loadOrderDataset(admin, range.from, range.to),
      query.compare ? loadOrderDataset(admin, before.from, before.to) : Promise.resolve(null),
    ]);
    csv = toCsv(explorerCsv(runExplorer(ds, query, prevDs)));
  } catch (err) {
    console.error('owner sales report export failed', err);
    return errorResponse(500, 'Could not build the report');
  }

  const name = query.split ? `sales-${query.rows}-by-${query.split}` : `sales-by-${query.rows}`;
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFileName(name, range.from, range.to)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
