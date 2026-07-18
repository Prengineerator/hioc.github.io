import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

// GET /api/account/history?page=1 — the caller's own orders, newest first
// (ACC-2). Reads via the admin client (service role) after verifying the
// session server-side — `orders` has no customer self-read RLS policy in
// Phase 2 (see supabase/phase2-migration.sql §9 notes), so this route is the
// access path, scoped to `user_id = caller` explicitly below.
export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  const { searchParams } = new URL(request.url);
  const pageParam = parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const admin = createAdminSupabaseClient();
  const { data, error, count } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))', { count: 'exact' })
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    return errorResponse(500, 'Failed to load order history');
  }

  const orders = (data ?? []).map((row) => toOrderResponse(row as OrderRowWithItems));
  const total = count ?? orders.length;

  return NextResponse.json({
    orders,
    page,
    pageSize: PAGE_SIZE,
    total,
    hasMore: from + orders.length < total,
  });
}
