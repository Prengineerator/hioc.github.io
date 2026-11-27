// Loyalty points ledger (FND-4). Ledger model: a user's balance is ALWAYS the
// sum of their loyalty_transactions rows — never a free-floating counter.
// loyalty_accounts.points_balance is maintained as a best-effort cache for
// fast reads (updated right after every ledger insert here), but every
// balance read in this file recomputes from the ledger itself, so the cache
// drifting never produces a wrong answer — only a slower one if it's stale.
//
// Shop orders: the shop's ledger rows carry shop_order_id instead of order_id and
// land in the same account. See the "Shop orders (E5)" block further down.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { loyaltyUserIdFor } from '@/lib/loyalty/beneficiary';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { expiryCutoff, pointsToExpire, type ExpiryRow } from '@/lib/loyalty/expiry';
import { expiryDateFor } from '@/lib/marketing/points';
import { LOYALTY_UNIT, beaniesLabel } from '@/lib/loyalty/brand';
import type { LoyaltyConfig, LoyaltyTransaction } from '@/lib/types';
import { spendOfferOnBill } from '@/lib/orders/offers';

/**
 * The earn formula, factored out so `earnForOrder` (the actual ledger write)
 * and `getStaffPrintOrder` (PRN-8: projecting "points earned" on a receipt
 * printed at payment/settle, before the order reaches 'completed' and
 * actually earns) can't drift on how many points an order is worth. Floors
 * down, same as the ledger write — a projected receipt total must match the
 * real ledger entry once it's posted.
 */
export function computeEarnedPoints(amountInr: number, config: LoyaltyConfig): number {
  return Math.floor(amountInr * config.points_per_inr);
}

export async function getLoyaltyConfig(): Promise<LoyaltyConfig | null> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('loyalty_config')
    .select('*')
    .eq('is_singleton', true)
    .maybeSingle();

  if (error) {
    console.error('getLoyaltyConfig: lookup failed', error);
    return null;
  }
  return (data as LoyaltyConfig) ?? null;
}

export async function getBalance(userId: string): Promise<number> {
  if (!userId) return 0;
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('loyalty_transactions')
    .select('points')
    .eq('user_id', userId);

  if (error) {
    console.error('getBalance: lookup failed', error);
    return 0;
  }
  return (data ?? []).reduce((sum, row) => sum + (row.points as number), 0);
}

/** Recent ledger entries for a user, newest first — powers the Rewards page. */
export async function getRecentTransactions(
  userId: string,
  limit = 20,
): Promise<LoyaltyTransaction[]> {
  if (!userId) return [];
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('loyalty_transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('getRecentTransactions: lookup failed', error);
    return [];
  }
  return (data ?? []) as LoyaltyTransaction[];
}

export interface RedeemQuote {
  ok: boolean;
  points: number; // points that would be spent
  discountInr: number; // ₹ discount they convert to
  reason?: string;
}

/**
 * Quotes redeeming `points` against a `subtotalInr` bill (validates min/max/%).
 *
 * `knownBalance` lets a caller that has ALREADY fetched this user's balance a
 * moment ago (POST /api/orders/quote, which returns it separately in the same
 * response) hand it over instead of paying for a second identical
 * `loyalty_transactions` scan. Omit it and this fetches the balance itself,
 * exactly as before — every other call site is unaffected.
 */
export async function quoteRedemption(
  userId: string,
  points: number,
  subtotalInr: number,
  knownBalance?: number,
): Promise<RedeemQuote> {
  if (!userId) {
    return { ok: false, points: 0, discountInr: 0, reason: `Log in to redeem ${LOYALTY_UNIT.many}` };
  }
  if (!Number.isInteger(points) || points <= 0) {
    return { ok: false, points: 0, discountInr: 0, reason: `Enter a valid number of ${LOYALTY_UNIT.many} to redeem` };
  }
  if (!Number.isFinite(subtotalInr) || subtotalInr <= 0) {
    return { ok: false, points: 0, discountInr: 0, reason: 'Your cart is empty' };
  }

  const config = await getLoyaltyConfig();
  if (!config) {
    return { ok: false, points: 0, discountInr: 0, reason: 'Loyalty program is not configured' };
  }

  if (points < config.min_redeem_points) {
    return {
      ok: false,
      points: 0,
      discountInr: 0,
      reason: `Minimum ${beaniesLabel(config.min_redeem_points)} required to redeem`,
    };
  }

  const balance = knownBalance ?? (await getBalance(userId));
  if (points > balance) {
    return { ok: false, points: 0, discountInr: 0, reason: `You only have ${beaniesLabel(balance)} available` };
  }

  const discountInr = Math.floor(points * config.inr_per_point);
  const maxDiscountInr = Math.floor((subtotalInr * config.max_redeem_pct) / 100);
  if (discountInr > maxDiscountInr) {
    return {
      ok: false,
      points: 0,
      discountInr: 0,
      reason: `Redeeming ${LOYALTY_UNIT.many} is capped at ${config.max_redeem_pct}% of the bill (₹${maxDiscountInr})`,
    };
  }
  if (discountInr <= 0) {
    return { ok: false, points: 0, discountInr: 0, reason: 'Redemption value is too small' };
  }

  return { ok: true, points, discountInr };
}

/** Recomputes a user's ledger sum and writes it to the loyalty_accounts cache. */
async function syncAccountCache(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  userId: string,
): Promise<void> {
  const { data, error } = await admin.from('loyalty_transactions').select('points').eq('user_id', userId);
  if (error) {
    console.error('syncAccountCache: lookup failed', error);
    return;
  }
  const balance = (data ?? []).reduce((sum, row) => sum + (row.points as number), 0);
  const { error: upsertError } = await admin
    .from('loyalty_accounts')
    .upsert({ user_id: userId, points_balance: balance, updated_at: new Date().toISOString() });
  if (upsertError) {
    console.error('syncAccountCache: upsert failed', upsertError);
  }
}

type Admin = ReturnType<typeof createAdminSupabaseClient>;

interface LoyaltyOrder {
  /** customer_user_id ?? user_id — see lib/loyalty/beneficiary.ts. */
  loyaltyUserId: string | null;
  status: string;
  payment_status: string;
  total_inr: number | null;
  subtotal_inr: number | null;
  order_number: number;
}

const LOYALTY_ORDER_FIELDS = 'user_id, status, payment_status, total_inr, subtotal_inr, order_number';

/**
 * The single door every ledger operation goes through to find out whose account
 * an order belongs to (VAL-2). Earn, redeem and reverse all call this rather
 * than reading a user column themselves, so the rule cannot drift between them.
 *
 * Degrades to the pre-VAL-2 answer if `customer_user_id` isn't there yet: a web
 * order must keep earning while the migration is pending. Counter linkage is
 * simply absent until it lands, and the log says exactly that.
 */
async function loadOrderForLoyalty(admin: Admin, orderId: string): Promise<LoyaltyOrder | null> {
  const linked = await admin
    .from('orders')
    .select(`${LOYALTY_ORDER_FIELDS}, customer_user_id`)
    .eq('id', orderId)
    .maybeSingle();

  let row = linked.data as Record<string, unknown> | null;

  if (linked.error) {
    // Only a missing column is survivable here; anything else is a real failure.
    if (!isMissingColumnError(linked.error)) {
      console.error('loadOrderForLoyalty: lookup failed', linked.error);
      return null;
    }
    console.error(
      'orders.customer_user_id is missing — counter orders will neither earn nor reverse. ' +
        'Is supabase/2026-08-counter-loyalty.sql applied?',
    );
    const fallback = await admin
      .from('orders')
      .select(LOYALTY_ORDER_FIELDS)
      .eq('id', orderId)
      .maybeSingle();
    if (fallback.error) {
      console.error('loadOrderForLoyalty: fallback lookup failed', fallback.error);
      return null;
    }
    row = fallback.data as Record<string, unknown> | null;
  }

  if (!row) return null;

  return {
    loyaltyUserId: loyaltyUserIdFor(row as { user_id?: string | null; customer_user_id?: string | null }),
    status: row.status as string,
    payment_status: row.payment_status as string,
    total_inr: (row.total_inr as number | null) ?? null,
    subtotal_inr: (row.subtotal_inr as number | null) ?? null,
    order_number: row.order_number as number,
  };
}

/**
 * Whether the order's bill carries a spend offer (spendOfferOnBill). Read on its
 * own so the account lookup above keeps its own fallback. A database without
 * the columns (2026-11-spend-offers.sql) has no spend offers; any other failed
 * read is logged and treated as none, so an ordinary order still earns.
 */
async function hasSpendOfferOnBill(admin: Admin, orderId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('orders')
    .select('offer_name, offer_discount_inr')
    .eq('id', orderId)
    .maybeSingle();
  if (error) {
    if (!isMissingColumnError(error)) console.error('earnForOrder: offer lookup failed', error);
    return false;
  }
  return data ? spendOfferOnBill(data as { offer_name?: string | null; offer_discount_inr?: number | null }) : false;
}

/**
 * Earns points for a completed, paid order (idempotent per order). No Beanies on a bill with a spend offer.
 * Returns the Beanies it credited just now: 0 when nothing was credited (no account, not paid,
 * spend offer, already earned, or a failure). The WhatsApp Beanies update fires only on > 0.
 */
export async function earnForOrder(orderId: string): Promise<number> {
  if (!orderId) return 0;
  const admin = createAdminSupabaseClient();

  const order = await loadOrderForLoyalty(admin, orderId);
  // An order with no account behind it (anonymous walk-in, unclaimed guest)
  // never earns; only completed + paid orders earn. A counter order linked by
  // phone (VAL-2) reaches this point exactly like a web order does.
  if (!order || !order.loyaltyUserId || order.status !== 'completed' || order.payment_status !== 'paid') {
    return 0;
  }

  // A bill with a spend offer on it ("spend ₹1099, get the jar at ₹49") earns
  // no Beanies: that offer can't be combined with them (lib/orders/offers.ts).
  if (await hasSpendOfferOnBill(admin, orderId)) return 0;

  // Idempotency: never double-earn for the same order.
  const { data: existing, error: existingError } = await admin
    .from('loyalty_transactions')
    .select('id')
    .eq('order_id', orderId)
    .eq('type', 'earn')
    .maybeSingle();
  if (existingError) {
    console.error('earnForOrder: idempotency check failed', existingError);
    return 0;
  }
  if (existing) return 0;

  const config = await getLoyaltyConfig();
  if (!config) return 0;

  const amountInr = order.total_inr ?? order.subtotal_inr ?? 0;
  const points = computeEarnedPoints(amountInr, config);
  if (points <= 0) return 0;

  const { error: insertError } = await admin.from('loyalty_transactions').insert({
    user_id: order.loyaltyUserId,
    order_id: orderId,
    type: 'earn',
    points,
    note: `Earned on order #${formatOrderNumber(order.order_number)}`,
  });
  if (insertError) {
    console.error('earnForOrder: insert failed', insertError);
    return 0;
  }

  await syncAccountCache(admin, order.loyaltyUserId);
  return points;
}

/**
 * Records a redemption (called when an order using points is created).
 *
 * Takes no user: the beneficiary is resolved from the ORDER, by the same helper
 * earn and reverse use. A caller-supplied id would be one more place a client's
 * word could decide whose points get spent, and it would let this operation
 * disagree with the other two about the same order.
 */
export async function redeemForOrder(
  orderId: string,
  points: number,
  discountInr: number,
): Promise<void> {
  if (!orderId || !Number.isInteger(points) || points <= 0) return;
  const admin = createAdminSupabaseClient();

  // Idempotency: never double-redeem for the same order.
  const { data: existing, error: existingError } = await admin
    .from('loyalty_transactions')
    .select('id')
    .eq('order_id', orderId)
    .eq('type', 'redeem')
    .maybeSingle();
  if (existingError) {
    console.error('redeemForOrder: idempotency check failed', existingError);
    return;
  }
  if (existing) return;

  const order = await loadOrderForLoyalty(admin, orderId);
  if (!order?.loyaltyUserId) {
    console.error('redeemForOrder: no account behind this order — nothing to debit', orderId);
    return;
  }
  const orderLabel = formatOrderNumber(order.order_number);

  const { error: insertError } = await admin.from('loyalty_transactions').insert({
    user_id: order.loyaltyUserId,
    order_id: orderId,
    type: 'redeem',
    points: -points,
    note: `Redeemed for ₹${discountInr} discount on order #${orderLabel}`,
  });
  if (insertError) {
    console.error('redeemForOrder: insert failed', insertError);
    return;
  }

  await syncAccountCache(admin, order.loyaltyUserId);
}

/** Reverses earned/redeemed points for a refunded/cancelled order. */
export async function reverseForOrder(orderId: string): Promise<void> {
  if (!orderId) return;
  const admin = createAdminSupabaseClient();

  const { data: rows, error: fetchError } = await admin
    .from('loyalty_transactions')
    .select('id, user_id, type, points')
    .eq('order_id', orderId)
    .in('type', ['earn', 'redeem']);

  if (fetchError) {
    console.error('reverseForOrder: lookup failed', fetchError);
    return;
  }
  if (!rows || rows.length === 0) return;

  // Idempotency: never double-reverse the same order.
  const { data: existingReverse, error: existingError } = await admin
    .from('loyalty_transactions')
    .select('id')
    .eq('order_id', orderId)
    .eq('type', 'reverse')
    .maybeSingle();
  if (existingError) {
    console.error('reverseForOrder: idempotency check failed', existingError);
    return;
  }
  if (existingReverse) return;

  // Same resolution as earn and redeem, so a counter order reverses into the
  // account it earned in. The ledger row's own user is the fallback for an order
  // that can no longer answer (deleted, or its account removed) — the points
  // demonstrably went there, so that is where they come back from.
  const order = await loadOrderForLoyalty(admin, orderId);
  const userId = order?.loyaltyUserId ?? (rows[0].user_id as string | null);
  if (!userId) return;

  const netPoints = rows.reduce((sum, row) => sum + (row.points as number), 0);
  if (netPoints === 0) return;

  const { error: insertError } = await admin.from('loyalty_transactions').insert({
    user_id: userId,
    order_id: orderId,
    type: 'reverse',
    points: -netPoints,
    note: 'Reversed — order refunded/cancelled',
  });
  if (insertError) {
    console.error('reverseForOrder: insert failed', insertError);
    return;
  }

  await syncAccountCache(admin, userId);
}

// ---------------------------------------------------------------------------
// Shop orders (E5). Same ledger, same loyalty_accounts cache, but the rows are
// keyed by shop_order_id (never order_id; a CHECK forbids both). Differences
// from the café: earn waits for 'delivered', the base excludes shipping, the
// spend-offer exclusion does not apply, and Beanies are RESERVED at checkout
// through the reserve_shop_beanies RPC so the balance check and the insert are
// one atomic step. Every function here logs and returns a fallback; none throws.
// ---------------------------------------------------------------------------

/** Goods paid on a shop order: total − shipping (Beanies spent are already out of the total). Pure. */
export function shopEarnBaseInr(order: { total_inr: number; shipping_inr: number }): number {
  const base = (Number(order.total_inr) || 0) - (Number(order.shipping_inr) || 0);
  return Math.max(0, base);
}

export type ShopReserveResult = 'reserved' | 'already_reserved' | 'insufficient' | 'error';

const UNIQUE_VIOLATION = '23505';

/** Reserves Beanies at checkout (a 'redeem' row on the pending shop order), atomically in SQL. */
export async function redeemForShopOrder(
  shopOrderId: string,
  userId: string,
  points: number,
  discountInr: number,
  orderRef: string,
): Promise<ShopReserveResult> {
  if (!shopOrderId || !userId || !Number.isInteger(points) || points <= 0) return 'error';
  try {
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin.rpc('reserve_shop_beanies', {
      p_user_id: userId,
      p_shop_order_id: shopOrderId,
      p_points: points,
      p_note: `Used ${beaniesLabel(points)} for ₹${discountInr} off shop order ${orderRef}`,
    });
    if (error) {
      // Includes a missing function (42883 / PGRST202): the caller refuses Beanies and re-quotes.
      console.error('redeemForShopOrder: reserve failed', error);
      return 'error';
    }
    if (data === 'reserved') {
      await syncAccountCache(admin, userId);
      return 'reserved';
    }
    if (data === 'already_reserved' || data === 'insufficient') return data;
    console.error('redeemForShopOrder: unexpected reserve result', data);
    return 'error';
  } catch (err) {
    console.error('redeemForShopOrder: failed', err);
    return 'error';
  }
}

/** Earns once a shop order is delivered and has an account. Returns points written (0 = nothing to do). Idempotent. */
export async function earnForShopOrder(shopOrderId: string): Promise<number> {
  if (!shopOrderId) return 0;
  try {
    const admin = createAdminSupabaseClient();
    const { data: order, error: orderError } = await admin
      .from('shop_orders')
      .select('id, status, user_id, total_inr, shipping_inr, order_number')
      .eq('id', shopOrderId)
      .maybeSingle();
    if (orderError) {
      console.error('earnForShopOrder: order lookup failed', orderError);
      return 0;
    }
    const o = order as {
      status: string;
      user_id: string | null;
      total_inr: number;
      shipping_inr: number;
      order_number: number | string;
    } | null;
    if (!o || o.status !== 'delivered' || !o.user_id) return 0;

    // Already earned, or already reversed (a reversed order must not earn later).
    const { data: existing, error: existingError } = await admin
      .from('loyalty_transactions')
      .select('id, type')
      .eq('shop_order_id', shopOrderId)
      .in('type', ['earn', 'reverse']);
    if (existingError) {
      console.error('earnForShopOrder: idempotency check failed', existingError);
      return 0;
    }
    if (existing && existing.length > 0) return 0;

    const config = await getLoyaltyConfig();
    if (!config) return 0;

    const points = computeEarnedPoints(shopEarnBaseInr(o), config);
    if (points <= 0) return 0;

    const { error: insertError } = await admin.from('loyalty_transactions').insert({
      user_id: o.user_id,
      shop_order_id: shopOrderId,
      order_id: null,
      type: 'earn',
      points,
      note: `Earned on shop order HIOC-S${o.order_number}`,
    });
    if (insertError) {
      // Another path (refresh, owner button, sweep) earned first: not an error.
      if ((insertError as { code?: string }).code !== UNIQUE_VIOLATION) {
        console.error('earnForShopOrder: insert failed', insertError);
      }
      return 0;
    }

    await syncAccountCache(admin, o.user_id);
    return points;
  } catch (err) {
    console.error('earnForShopOrder: failed', err);
    return 0;
  }
}

/**
 * Returns what a shop order moved (earn and redeem) in ONE 'reverse' row.
 * Returns the net points given back to the customer (positive when spent
 * Beanies come back, negative when an earn is taken back), 0 when nothing to do. Idempotent.
 */
export async function reverseForShopOrder(shopOrderId: string, reason: string): Promise<number> {
  if (!shopOrderId) return 0;
  try {
    const admin = createAdminSupabaseClient();
    const { data: rows, error: fetchError } = await admin
      .from('loyalty_transactions')
      .select('id, user_id, type, points')
      .eq('shop_order_id', shopOrderId)
      .in('type', ['earn', 'redeem']);
    if (fetchError) {
      console.error('reverseForShopOrder: lookup failed', fetchError);
      return 0;
    }
    if (!rows || rows.length === 0) return 0;

    const { data: existingReverse, error: existingError } = await admin
      .from('loyalty_transactions')
      .select('id')
      .eq('shop_order_id', shopOrderId)
      .eq('type', 'reverse')
      .maybeSingle();
    if (existingError) {
      console.error('reverseForShopOrder: idempotency check failed', existingError);
      return 0;
    }
    if (existingReverse) return 0;

    const userId = rows[0].user_id as string | null;
    if (!userId) return 0;
    const net = rows.reduce((sum, row) => sum + (row.points as number), 0);
    if (net === 0) return 0;

    // The order number is only for the customer-facing note; its absence is fine.
    const { data: orderRow } = await admin
      .from('shop_orders')
      .select('order_number')
      .eq('id', shopOrderId)
      .maybeSingle();
    const orderNumber = (orderRow as { order_number?: number | string } | null)?.order_number;
    const suffix = orderNumber != null ? ` (shop order HIOC-S${orderNumber})` : '';

    const { error: insertError } = await admin.from('loyalty_transactions').insert({
      user_id: userId,
      shop_order_id: shopOrderId,
      order_id: null,
      type: 'reverse',
      points: -net,
      note: `Returned — ${reason}${suffix}`,
    });
    if (insertError) {
      if ((insertError as { code?: string }).code !== UNIQUE_VIOLATION) {
        console.error('reverseForShopOrder: insert failed', insertError);
      }
      return 0;
    }

    await syncAccountCache(admin, userId);
    return -net;
  } catch (err) {
    console.error('reverseForShopOrder: failed', err);
    return 0;
  }
}

const LEDGER_PAGE_SIZE = 1000;

export interface BeaniesStatement {
  /** Ledger balance (never below zero). */
  balance: number;
  /** Whole rupees the balance is worth (balance x inr_per_point, floored like a redemption). */
  valueInr: number;
  /** When the oldest unspent Beanies expire (FIFO, lib/loyalty/expiry.ts rules); null = never / nothing unspent. */
  expiresAt: Date | null;
}

/**
 * What the customer's Beanies look like right now, for the WhatsApp account update.
 * Reads the ledger (so call it after the earn row is written). Pure reads; returns
 * null, never throws, when anything can't be read: better no message than a wrong one.
 */
export async function getBeaniesStatement(userId: string): Promise<BeaniesStatement | null> {
  if (!userId) return null;
  try {
    const config = await getLoyaltyConfig();
    if (!config) return null;
    const admin = createAdminSupabaseClient();
    const rows: ExpiryRow[] = [];
    for (let from = 0; ; from += LEDGER_PAGE_SIZE) {
      const { data, error } = await admin
        .from('loyalty_transactions')
        .select('points, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + LEDGER_PAGE_SIZE - 1);
      if (error) {
        console.error('getBeaniesStatement: ledger lookup failed', error);
        return null;
      }
      for (const row of data ?? []) rows.push({ points: row.points as number, created_at: row.created_at as string });
      if (!data || data.length < LEDGER_PAGE_SIZE) break;
    }
    const balance = Math.max(0, Math.floor(rows.reduce((sum, r) => sum + r.points, 0)));
    const valueInr = Math.floor(balance * (Number(config.inr_per_point) || 0));
    return { balance, valueInr, expiresAt: expiryDateFor(rows, config.points_expiry_days) };
  } catch (err) {
    console.error('getBeaniesStatement: failed', err);
    return null;
  }
}
const EXPIRE_INSERT_CHUNK = 500;

/**
 * Writes off points older than `points_expiry_days` as 'expire' ledger rows
 * (FIFO rule in lib/loyalty/expiry.ts). Idempotent: a re-run finds the earlier
 * expire rows already counted as spent and writes nothing.
 */
export async function expireLoyaltyPoints(now = new Date()): Promise<{ users: number; points: number }> {
  const none = { users: 0, points: 0 };
  const config = await getLoyaltyConfig();
  if (!config) return none;
  const cutoff = expiryCutoff(now, config.points_expiry_days);
  if (!cutoff) return none;

  const admin = createAdminSupabaseClient();

  // Page explicitly: PostgREST silently caps a single response (default 1000
  // rows). Order is total (created_at, id) so pages can't overlap or skip.
  const byUser = new Map<string, ExpiryRow[]>();
  for (let from = 0; ; from += LEDGER_PAGE_SIZE) {
    const { data, error } = await admin
      .from('loyalty_transactions')
      .select('user_id, points, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_PAGE_SIZE - 1);
    if (error) {
      // Abort rather than compute from a partial ledger: missing debits would
      // make us expire points the customer already spent.
      console.error('expireLoyaltyPoints: ledger lookup failed', error);
      return none;
    }
    for (const row of data ?? []) {
      const rows = byUser.get(row.user_id as string) ?? [];
      rows.push({ points: row.points as number, created_at: row.created_at as string });
      byUser.set(row.user_id as string, rows);
    }
    if (!data || data.length < LEDGER_PAGE_SIZE) break;
  }

  const inserts: { user_id: string; order_id: null; type: 'expire'; points: number; note: string }[] = [];
  for (const [userId, rows] of byUser) {
    const expiring = pointsToExpire(rows, cutoff);
    if (expiring <= 0) continue;
    inserts.push({
      user_id: userId,
      order_id: null,
      type: 'expire',
      points: -expiring,
      note: `Expired — ${LOYALTY_UNIT.many} older than ${config.points_expiry_days} days`,
    });
  }

  let users = 0;
  let points = 0;
  for (let i = 0; i < inserts.length; i += EXPIRE_INSERT_CHUNK) {
    const chunk = inserts.slice(i, i + EXPIRE_INSERT_CHUNK);
    const { error } = await admin.from('loyalty_transactions').insert(chunk);
    if (error) {
      // Keep going: the next run recomputes from the ledger, so a failed chunk
      // is retried automatically.
      console.error('expireLoyaltyPoints: insert failed', error);
      continue;
    }
    users += chunk.length;
    points += chunk.reduce((sum, row) => sum - row.points, 0);
    for (const row of chunk) await syncAccountCache(admin, row.user_id);
  }

  return { users, points };
}
