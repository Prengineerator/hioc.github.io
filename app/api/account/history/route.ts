import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { isMissingColumnError } from '@/lib/api/postgrest';
import {
  filterChannelRows,
  includeGuestOrdersByPhone,
  isActiveOrderStatus,
  isValidHistoryChannel,
  isValidHistoryStatusFilter,
  verifiedEmailOf,
  mergeChannelRows,
  mergeOrderRows,
  paginateOrderRows,
  type ChannelRow,
  type HistoryStatusFilter,
  type OrderStatusRow,
} from '@/lib/account/history';
import type { AccountHistoryItem, AccountHistoryResponse, HistoryChannelFilter } from '@/lib/account/historyTypes';
import { isMissingShopSchema, toShopOrderRow } from '@/lib/shop/server';
import { isActiveShopStatus, toShopHistoryOrder } from '@/lib/shop/status';
import type { ShopHistoryOrder, ShopOrderStatus } from '@/lib/shop/types';
import { latestLegacyBillsForPhone } from '@/lib/legacy/history';
import type { LegacyCustomerOrderResponse } from '@/lib/api/customerOrders';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

// Unpaid and lapsed shop orders are not orders the customer made: never listed.
const HIDDEN_SHOP_STATUSES = '(payment_pending,expired)';

// GET /api/account/history?page=1 — EVERY order that belongs to the caller,
// newest first, across BOTH channels: the café (`orders`) and the shop
// (`shop_orders`). ACC-2 widened it so a customer logging in sees orders
// placed before they had — or used — an account; SV2-08 added the shop.
//
// CAFÉ sources — an `orders` row belongs to the caller four ways:
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
//   4. orders.customer_email = the CALLER's OWN verified login email, with
//      user_id still null                — the same rule as (3) for a guest
//                                            who gave an email at checkout
//                                            and later logs in with it (or
//                                            adds it to a phone login).
//
// SHOP sources — a `shop_orders` row belongs to the caller three ways, with
// the same trust direction as the café (the caller's proof, never the
// order's):
//
//   S1. shop_orders.user_id = caller      — an order placed while logged in,
//                                            or a guest order already
//                                            claimed (lib/account/claim.ts).
//   S2. shop_orders.phone = the CALLER's  — an unclaimed guest order, gated
//       VERIFIED profile phone, with        on profiles.phone_verified. Both
//       user_id still null                  sides are E.164.
//   S3. shop_orders.email = the CALLER's  — the same rule for a guest who
//       verified login email, with          gave an email. Shop emails are
//       user_id still null                  lower-cased (normalizeEmail), so
//                                            the match is exact.
//
// EVERY shop query excludes payment_pending and expired orders (see
// HIDDEN_SHOP_STATUSES): an unpaid or lapsed checkout is not an order the
// customer made, so it is never listed.
//
// Optional `channel=all|cafe|shop` (default `all`; any other value returns
// 400). `cafe` skips every shop query and `shop` skips every café query, so
// a channel-specific caller pays only for the table it shows.
//
// Degradation: customer_user_id may not exist yet on a pending deploy — the
// café side degrades to (1) + (3) + (4) rather than failing the request, the same
// tolerance app/api/orders/route.ts and lib/loyalty/ledger.ts already apply to
// that column (see lib/api/postgrest.ts). Likewise a missing shop schema
// (isMissingShopSchema, the shop migration not yet applied) yields NO shop
// rows instead of an error, so the café history keeps working.
//
// Reads via the admin client (service role) after verifying the session
// server-side — `orders` has no customer self-read RLS policy (see
// supabase/phase2-migration.sql §9 notes), and shop_orders is read the same
// way — scoped to these explicit filters: the four café sources (1-4) and the
// three shop sources (S1-S3) above, and nothing wider.
//
// Merge and pagination: the matching ids from both tables are merged
// (mergeChannelRows: newest first, stable tie-break), THEN filtered by
// `channel` and `status`, THEN paginated, so `total`/`hasMore` describe the
// filtered list across both tables, not one table or the caller's whole
// history. Full rows are fetched only for the current page's ids and put
// back in page order.
//
// Optional `status=active|past` (account orders page Active/Past tabs, ACC-2
// usability pass) narrows the result to non-terminal or terminal orders
// respectively (lib/account/history.ts's isActiveOrderStatus for the café,
// isActiveShopStatus for the shop — the same partition the state machine and
// the order-tracking pages use). Applied to the MERGED id list, before
// pagination.
//
// Response shape: `items[]` is the page's orders from both channels in page
// order, each tagged with its channel. `orders[]` holds ONLY the café items'
// orders and is kept for existing callers that predate the shop; with the
// default channel=all, a caller that renders only `orders[]` will see fewer
// rows than the page size once the customer has shop orders — such callers
// should render `items[]` or pass `channel=cafe`.
export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  const { searchParams } = new URL(request.url);
  const pageParam = parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

  const statusParam = searchParams.get('status');
  let statusFilter: HistoryStatusFilter | null = null;
  if (statusParam !== null) {
    if (!isValidHistoryStatusFilter(statusParam)) {
      return errorResponse(400, 'status must be "active" or "past"');
    }
    statusFilter = statusParam;
  }

  const channelParam = searchParams.get('channel');
  let channel: HistoryChannelFilter = 'all';
  if (channelParam !== null) {
    if (!isValidHistoryChannel(channelParam)) {
      return errorResponse(400, 'channel must be "all", "cafe" or "shop"');
    }
    channel = channelParam;
  }
  const wantCafe = channel !== 'shop';
  const wantShop = channel !== 'cafe';

  const admin = createAdminSupabaseClient();

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('phone, phone_verified')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) {
    return errorResponse(500, 'Failed to load order history');
  }

  const phoneVerified = includeGuestOrdersByPhone(profile);
  const verifiedEmail = verifiedEmailOf(user);

  let ownedRows: OrderStatusRow[] = [];
  let guestRows: OrderStatusRow[] = [];
  let emailRows: OrderStatusRow[] = [];
  if (wantCafe) {
    // Sources 1 + 2: everything linked to the account. `status` is pulled
    // alongside id/created_at so the Active/Past filter below can be applied
    // without a second round trip.
    const linked = await admin
      .from('orders')
      .select('id, created_at, status')
      .or(`user_id.eq.${user.id},customer_user_id.eq.${user.id}`);
    if (linked.error) {
      if (!isMissingColumnError(linked.error)) {
        return errorResponse(500, 'Failed to load order history');
      }
      console.error(
        'account/history: orders.customer_user_id is missing — counter orders will not appear ' +
          'until this account is linked by the guest-claim path. Is supabase/2026-08-counter-loyalty.sql applied?',
      );
      const fallback = await admin.from('orders').select('id, created_at, status').eq('user_id', user.id);
      if (fallback.error) {
        return errorResponse(500, 'Failed to load order history');
      }
      ownedRows = (fallback.data ?? []) as OrderStatusRow[];
    } else {
      ownedRows = (linked.data ?? []) as OrderStatusRow[];
    }

    // Source 3: unclaimed guest orders — ONLY when the CALLER's own phone is
    // verified. Never widen this by an order's (unverified) customer_phone.
    if (phoneVerified) {
      const guest = await admin
        .from('orders')
        .select('id, created_at, status')
        .eq('customer_phone', profile!.phone as string)
        .is('user_id', null);
      if (guest.error) {
        return errorResponse(500, 'Failed to load order history');
      }
      guestRows = (guest.data ?? []) as OrderStatusRow[];
    }

    // Source 4: unclaimed guest orders placed with the caller's verified login
    // email. Same trust direction as source 3 — never an order's own email.
    if (verifiedEmail) {
      const byEmail = await admin
        .from('orders')
        .select('id, created_at, status')
        .eq('customer_email', verifiedEmail)
        .is('user_id', null);
      if (byEmail.error) {
        // orders.customer_email arrives with 2026-07-order-email.sql; without
        // it there is simply nothing to match by email — not a failed history.
        if (!isMissingColumnError(byEmail.error)) {
          return errorResponse(500, 'Failed to load order history');
        }
      } else {
        emailRows = (byEmail.data ?? []) as OrderStatusRow[];
      }
    }
  }

  // Shop id rows (skipped for channel=cafe).
  const shopSources: ChannelRow[][] = [];
  if (wantShop) {
    type ShopIdRow = { id: string; created_at: string; status: ShopOrderStatus };
    const toRows = (data: unknown): ChannelRow[] =>
      ((data ?? []) as ShopIdRow[]).map((r) => ({
        id: r.id,
        created_at: r.created_at,
        channel: 'shop' as const,
        active: isActiveShopStatus(r.status),
      }));
    const shopQuery = () =>
      admin.from('shop_orders').select('id, created_at, status').not('status', 'in', HIDDEN_SHOP_STATUSES);

    const linked = await shopQuery().eq('user_id', user.id);
    if (linked.error && !isMissingShopSchema(linked.error)) {
      return errorResponse(500, 'Failed to load order history');
    }
    if (!linked.error) {
      shopSources.push(toRows(linked.data));
      if (phoneVerified) {
        const byPhone = await shopQuery().eq('phone', profile!.phone as string).is('user_id', null);
        if (byPhone.error) return errorResponse(500, 'Failed to load order history');
        shopSources.push(toRows(byPhone.data));
      }
      if (verifiedEmail) {
        const byEmail = await shopQuery().eq('email', verifiedEmail).is('user_id', null);
        if (byEmail.error) return errorResponse(500, 'Failed to load order history');
        shopSources.push(toRows(byEmail.data));
      }
    }
  }

  const cafeRows: ChannelRow[] = mergeOrderRows([ownedRows, guestRows, emailRows]).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    channel: 'cafe' as const,
    active: isActiveOrderStatus(r.status),
  }));
  const merged = filterChannelRows(mergeChannelRows([cafeRows, ...shopSources]), channel, statusFilter);
  const { items: pageRows, total, hasMore } = paginateOrderRows(merged, page, PAGE_SIZE);

  // Fetch Petpooja orders if the phone is verified — the same trust check as
  // guest orders by phone (source 3 in the route's design doc above).
  let petpoojaOrders: LegacyCustomerOrderResponse[] = [];
  if (phoneVerified && profile?.phone) {
    petpoojaOrders = await latestLegacyBillsForPhone(admin, profile.phone, 50);
  }

  const base = { page, pageSize: PAGE_SIZE, total, hasMore, phoneVerified, status: statusFilter, channel };
  if (pageRows.length === 0) {
    const empty: AccountHistoryResponse = { ...base, orders: [], items: [], petpooja_orders: petpoojaOrders };
    return NextResponse.json(empty);
  }

  // Full rows (with items/addons) are only fetched for the current page's
  // ids — the lightweight id+created_at queries above may span the caller's
  // ENTIRE history, and there is no reason to pull every order's line items
  // just to work out which 10 are newest.
  const cafeIds = pageRows.filter((r) => r.channel === 'cafe').map((r) => r.id);
  const shopIds = pageRows.filter((r) => r.channel === 'shop').map((r) => r.id);

  const cafeById = new Map<string, OrderRowWithItems>();
  if (cafeIds.length > 0) {
    const { data, error } = await admin
      .from('orders')
      .select('*, order_items(*, order_item_addons(*))')
      .in('id', cafeIds);
    if (error) {
      return errorResponse(500, 'Failed to load order history');
    }
    for (const row of data ?? []) cafeById.set((row as OrderRowWithItems).id, row as OrderRowWithItems);
  }

  const shopById = new Map<string, ShopHistoryOrder>();
  if (shopIds.length > 0) {
    const { data, error } = await admin.from('shop_orders').select('*').in('id', shopIds);
    if (error) {
      return errorResponse(500, 'Failed to load order history');
    }
    for (const row of data ?? []) {
      const shaped = toShopHistoryOrder(toShopOrderRow(row as Record<string, unknown>));
      shopById.set(shaped.id, shaped);
    }
  }

  // Re-applies the merged/sorted order — `.in()` does not preserve it.
  const items: AccountHistoryItem[] = [];
  for (const r of pageRows) {
    if (r.channel === 'cafe') {
      const row = cafeById.get(r.id);
      if (row) items.push({ channel: 'cafe', id: r.id, created_at: r.created_at, order: toOrderResponse(row) });
    } else {
      const order = shopById.get(r.id);
      if (order) items.push({ channel: 'shop', id: r.id, created_at: r.created_at, order });
    }
  }
  const orders = items.flatMap((i) => (i.channel === 'cafe' ? [i.order] : []));

  const body: AccountHistoryResponse = { ...base, orders, items, petpooja_orders: petpoojaOrders };
  return NextResponse.json(body);
}
