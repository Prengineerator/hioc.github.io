import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { isMissingColumnError } from '@/lib/api/postgrest';
import {
  includeGuestOrdersByPhone,
  mergeOrderRows,
  paginateOrderRows,
  type OrderIdRow,
} from '@/lib/account/history';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

// GET /api/account/history?page=1 — EVERY order that belongs to the caller,
// newest first (ACC-2, widened so a customer logging in sees orders placed
// before they had — or used — an account). An order belongs to the caller
// three ways:
//
//   1. orders.user_id = caller            — a web/app order placed while
//                                            logged in, or a guest order
//                                            already claimed (ACC-4).
//   2. orders.customer_user_id = caller   — a COUNTER order a staffer linked
//                                            by a verified-phone match
//                                            (VAL-2/D4-3, 2026-08-counter-
//                                            loyalty.sql); user_id stays null
//                                            for these by design.
//   3. orders.customer_phone = the CALLER's OWN verified phone, with
//      user_id still null                — an unclaimed guest order. Gated
//                                            on the CALLER's own
//                                            profiles.phone_verified, never
//                                            on the order's phone — see
//                                            lib/account/history.ts for why
//                                            that direction matters
//                                            (a stranger's phone typed at
//                                            checkout must never leak into
//                                            someone else's history).
//
// customer_user_id may not exist yet on a pending deploy — this degrades to
// (1) + (3) rather than failing the request, the same tolerance
// app/api/orders/route.ts and lib/loyalty/ledger.ts already apply to that
// column (see lib/api/postgrest.ts).
//
// Reads via the admin client (service role) after verifying the session
// server-side — `orders` has no customer self-read RLS policy (see
// supabase/phase2-migration.sql §9 notes) — scoped to these explicit filters,
// which are exactly the three rules above and nothing wider.
export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  const { searchParams } = new URL(request.url);
  const pageParam = parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

  const admin = createAdminSupabaseClient();

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('phone, phone_verified')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) {
    return errorResponse(500, 'Failed to load order history');
  }

  // Sources 1 + 2: everything linked to the account.
  let ownedRows: OrderIdRow[] = [];
  const linked = await admin
    .from('orders')
    .select('id, created_at')
    .or(`user_id.eq.${user.id},customer_user_id.eq.${user.id}`);
  if (linked.error) {
    if (!isMissingColumnError(linked.error)) {
      return errorResponse(500, 'Failed to load order history');
    }
    console.error(
      'account/history: orders.customer_user_id is missing — counter orders will not appear ' +
        'until this account is linked by the guest-claim path. Is supabase/2026-08-counter-loyalty.sql applied?',
    );
    const fallback = await admin.from('orders').select('id, created_at').eq('user_id', user.id);
    if (fallback.error) {
      return errorResponse(500, 'Failed to load order history');
    }
    ownedRows = (fallback.data ?? []) as OrderIdRow[];
  } else {
    ownedRows = (linked.data ?? []) as OrderIdRow[];
  }

  // Source 3: unclaimed guest orders — ONLY when the CALLER's own phone is
  // verified. Never widen this by an order's (unverified) customer_phone.
  let guestRows: OrderIdRow[] = [];
  const phoneVerified = includeGuestOrdersByPhone(profile);
  if (phoneVerified) {
    const guest = await admin
      .from('orders')
      .select('id, created_at')
      .eq('customer_phone', profile!.phone as string)
      .is('user_id', null);
    if (guest.error) {
      return errorResponse(500, 'Failed to load order history');
    }
    guestRows = (guest.data ?? []) as OrderIdRow[];
  }

  const merged = mergeOrderRows([ownedRows, guestRows]);
  const { items, total, hasMore } = paginateOrderRows(merged, page, PAGE_SIZE);

  if (items.length === 0) {
    return NextResponse.json({
      orders: [],
      page,
      pageSize: PAGE_SIZE,
      total,
      hasMore,
      phoneVerified,
    });
  }

  // Full rows (with items/addons) are only fetched for the current page's
  // ids — the lightweight id+created_at queries above may span the caller's
  // ENTIRE history, and there is no reason to pull every order's line items
  // just to work out which 10 are newest.
  const ids = items.map((row) => row.id);
  const { data, error } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .in('id', ids);

  if (error) {
    return errorResponse(500, 'Failed to load order history');
  }

  const byId = new Map<string, OrderRowWithItems>(
    (data ?? []).map((row) => [(row as OrderRowWithItems).id, row as OrderRowWithItems]),
  );
  // Re-applies the merged/sorted order — `.in()` does not preserve it.
  const orders = ids
    .map((id) => byId.get(id))
    .filter((row): row is OrderRowWithItems => Boolean(row))
    .map(toOrderResponse);

  return NextResponse.json({
    orders,
    page,
    pageSize: PAGE_SIZE,
    total,
    hasMore,
    phoneVerified,
  });
}
