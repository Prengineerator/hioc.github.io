import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { toCsv } from '@/lib/reports/csv';
import { exportFileName, resolvePeriod } from '@/lib/reports/exports/period';
import { findReport } from '@/lib/reports/exports/registry';

export const dynamic = 'force-dynamic';

// GET /api/owner/reports/export?report=<key>&from=YYYY-MM-DD&to=YYYY-MM-DD
// (or &month=YYYY-MM) — owner only. One downloadable sheet of Owner → Reports →
// Downloads (GST filing pack, sales, cash, staff, loyalty) as a CSV for the
// accountant. The keys and what each sheet holds: lib/reports/exports/registry.ts.
export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  const url = new URL(request.url);
  const def = findReport(url.searchParams.get('report'));
  if (!def) return errorResponse(404, 'Unknown report');

  const range = resolvePeriod(
    {
      month: url.searchParams.get('month'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    },
    istDateIso(),
  );
  if (!range.ok) return errorResponse(400, range.message);

  let csv: string;
  try {
    csv = toCsv(await def.load(createAdminSupabaseClient(), range.from, range.to));
  } catch (err) {
    console.error(`owner report export: ${def.key} failed`, err);
    return errorResponse(500, 'Could not build the report');
  }

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFileName(def.key, range.from, range.to)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
