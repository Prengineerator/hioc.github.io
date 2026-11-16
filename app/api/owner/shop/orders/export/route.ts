import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { istDateIso } from '@/lib/api/date';
import { toCsv } from '@/lib/reports/csv';
import { shopOrdersCsvTable } from '@/lib/shop/owner';
import { toShopOrderRow } from '@/lib/shop/server';

export const dynamic = 'force-dynamic';

// GET /api/owner/shop/orders/export — owner only. Every shop order that was
// paid (cancelled ones too, with their refund) as a CSV for the accountant.
// Shop sales are kept out of the café's Reports and GST (they are goods
// shipped, not café service), so this sheet is where they are counted.
export async function GET() {
  if (!(await getOwnerUser())) return unauthorized();
  const { data, error } = await createAdminSupabaseClient()
    .from('shop_orders')
    .select('*')
    .neq('status', 'payment_pending')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) {
    console.error('owner shop export failed', error);
    return errorResponse(500, 'Could not build the sheet just now — please try again.');
  }
  const rows = (data ?? []).map((r) => toShopOrderRow(r as Record<string, unknown>));
  return new NextResponse(toCsv(shopOrdersCsvTable(rows)), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="hioc-shop-orders-${istDateIso()}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
