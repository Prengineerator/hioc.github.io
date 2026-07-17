import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// GET /api/orders/[id] — public. Single-row lookup only (the opaque uuid in
// the URL IS the access control) — this route must never expose a listing
// capability. Uses the service-role client since anon has no orders select
// policy (see supabase/schema.sql).
export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return errorResponse(500, 'Failed to load order');
  }
  if (!data) {
    return notFound();
  }

  return NextResponse.json({ order: toOrderResponse(data as OrderRowWithItems) });
}
