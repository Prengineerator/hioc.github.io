import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { parseRange, reportCsv } from '@/lib/reports/reconcile';
import { loadReport } from '@/lib/reports/reconcileServer';

export const dynamic = 'force-dynamic';

// GET /api/owner/reports?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv] — owner
// only. The reconciliation report for a range of IST days (owner → Reports):
// JSON, or a CSV with one row per day and a TOTAL row for the accountant.
export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), istDateIso());
  if (!range.ok) return errorResponse(400, range.message);

  let report;
  try {
    report = await loadReport(createAdminSupabaseClient(), range.from, range.to);
  } catch (err) {
    console.error('owner reports: load failed', err);
    return errorResponse(500, 'Could not build the report');
  }

  if (url.searchParams.get('format') === 'csv') {
    const name = range.from === range.to ? range.from : `${range.from}_to_${range.to}`;
    return new NextResponse(reportCsv(report), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="hioc-report-${name}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  return NextResponse.json({ report });
}
