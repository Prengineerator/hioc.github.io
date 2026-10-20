import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { loadGstComputation } from '@/lib/reports/exports/gstComputationServer';
import { buildGstWorkbook, gstWorkbookFileName, XLSX_CONTENT_TYPE } from '@/lib/reports/exports/gstWorkbook';
import { resolvePeriod } from '@/lib/reports/exports/period';

export const dynamic = 'force-dynamic';
// exceljs needs Node (streams, zlib), not the Edge runtime.
export const runtime = 'nodejs';

// GET /api/owner/reports/gst-workbook?month=YYYY-MM  (or &from=YYYY-MM-DD&to=YYYY-MM-DD)
// — owner only. The CA's Excel workbook for the period's GST: a summary with the
// tax to pay, one sheet per GSTR-1 table, the day-wise and invoice registers and
// a glossary (lib/reports/exports/gstWorkbook.ts). Same period rules and the same
// figures as the GST page (Owner → Reports → GST) and the GST CSV downloads.
export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  const url = new URL(request.url);
  const range = resolvePeriod(
    {
      month: url.searchParams.get('month'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    },
    istDateIso(),
  );
  if (!range.ok) return errorResponse(400, range.message);

  let workbook: Buffer;
  let fileName: string;
  try {
    const computation = await loadGstComputation(createAdminSupabaseClient(), range.from, range.to);
    workbook = await buildGstWorkbook(computation);
    fileName = gstWorkbookFileName(computation.business.gstin, range.from, range.to);
  } catch (err) {
    console.error('owner gst workbook failed', err);
    return errorResponse(500, 'Could not build the workbook');
  }

  return new NextResponse(new Uint8Array(workbook), {
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': String(workbook.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
