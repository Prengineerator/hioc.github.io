// Loyalty points ledger (FND-4). Ledger model: a user's balance is ALWAYS the
// sum of their loyalty_transactions rows — never a free-floating counter.
// loyalty_accounts.points_balance is maintained as a best-effort cache for
// fast reads (updated right after every ledger insert here), but every
// balance read in this file recomputes from the ledger itself, so the cache
// drifting never produces a wrong answer — only a slower one if it's stale.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { loyaltyUserIdFor } from '@/lib/loyalty/beneficiary';
import { isMissingColumnError } from '@/lib/api/postgrest';
import type { LoyaltyConfig, LoyaltyTransaction } from '@/lib/types';

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

/** Quotes redeeming `points` against a `subtotalInr` bill (validates min/max/%). */
export async function quoteRedemption(
  userId: string,
  points: number,
  subtotalInr: number,
): Promise<RedeemQuote> {
  if (!userId) {
    return { ok: false, points: 0, discountInr: 0, reason: 'Log in to redeem points' };
  }
  if (!Number.isInteger(points) || points <= 0) {
    return { ok: false, points: 0, discountInr: 0, reason: 'Enter a valid number of points to redeem' };
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
      reason: `Minimum ${config.min_redeem_points} points required to redeem`,
    };
  }

  const balance = await getBalance(userId);
  if (points > balance) {
    return { ok: false, points: 0, discountInr: 0, reason: `You only have ${balance} points available` };
  }

  const discountInr = Math.floor(points * config.inr_per_point);
  const maxDiscountInr = Math.floor((subtotalInr * config.max_redeem_pct) / 100);
  if (discountInr > maxDiscountInr) {
    return {
      ok: false,
      points: 0,
      discountInr: 0,
      reason: `Points redemption is capped at ${config.max_redeem_pct}% of the bill (₹${maxDiscountInr})`,
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

/** Earns points for a completed, paid order (idempotent per order). */
export async function earnForOrder(orderId: string): Promise<void> {
  if (!orderId) return;
  const admin = createAdminSupabaseClient();

  const order = await loadOrderForLoyalty(admin, orderId);
  // An order with no account behind it (anonymous walk-in, unclaimed guest)
  // never earns; only completed + paid orders earn. A counter order linked by
  // phone (VAL-2) reaches this point exactly like a web order does.
  if (!order || !order.loyaltyUserId || order.status !== 'completed' || order.payment_status !== 'paid') {
    return;
  }

  // Idempotency: never double-earn for the same order.
  const { data: existing, error: existingError } = await admin
    .from('loyalty_transactions')
    .select('id')
    .eq('order_id', orderId)
    .eq('type', 'earn')
    .maybeSingle();
  if (existingError) {
    console.error('earnForOrder: idempotency check failed', existingError);
    return;
  }
  if (existing) return;

  const config = await getLoyaltyConfig();
  if (!config) return;

  const amountInr = order.total_inr ?? order.subtotal_inr ?? 0;
  const points = Math.floor(amountInr * config.points_per_inr);
  if (points <= 0) return;

  const { error: insertError } = await admin.from('loyalty_transactions').insert({
    user_id: order.loyaltyUserId,
    order_id: orderId,
    type: 'earn',
    points,
    note: `Earned on order #${formatOrderNumber(order.order_number)}`,
  });
  if (insertError) {
    console.error('earnForOrder: insert failed', insertError);
    return;
  }

  await syncAccountCache(admin, order.loyaltyUserId);
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
