// The life of a shop order's money and Beanies (docs/SHOP-V2-SPEC.md E5, E2a, E7).
//
//   checkout   Beanies the customer spends are RESERVED (taken off their balance)
//   captured   the reservation is KEPT: the order is paid
//   expired    the order sat unpaid for 30 minutes: the reservation is RETURNED
//   cancelled  the owner cancels a paid order: the spend is RETURNED, and any
//              Beanies EARNED from it are TAKEN BACK, in the same ledger row
//   delivered  Beanies are EARNED (only now, never at payment)
//
// The intro offer is claimed at payment capture (lib/shop/payments.ts) and
// released when the order is cancelled, so a cancelled first order does not use
// up the customer's once-only offer. Coupon counts exclude cancelled orders in
// SQL, so nothing is deleted.
//
// Every step is idempotent: the ledger functions write one row per order and
// the status updates are guarded (updateShopOrderIf), so a double click, a
// cron retry or a webhook racing the owner cannot pay out or return twice.
// Nothing here throws: money bookkeeping must never turn a successful status
// change into an error page; failures are logged. A failed Beanie return or
// intro-claim release is retried by the retry pass at the end of
// expireStaleShopOrders (expired / cancelled orders of the last 14 days), which
// is safe because both steps are idempotent.
//
// The expire-orders cron (4 times a day, including 00:00 IST) calls
// expireStaleShopOrders and sweepDeliveredShopOrders, which is the nightly sweep.
// Orders are never deleted on expiry: a payment that lands late must still
// find its order (captureShopPayment honours a paid-after-expiry order).
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchOrderPaymentAttempts } from '@/lib/payments/gateway';
import { earnForShopOrder, reverseForShopOrder } from '@/lib/loyalty/ledger';
import { captureShopPayment } from '@/lib/shop/payments';
import { isMissingShopSchema, toShopOrderRow, updateShopOrderIf } from '@/lib/shop/server';
import { fetchShiprocketOrder, isShiprocketConfigured } from '@/lib/shop/shiprocket';
import { shopStatusFromShiprocket } from '@/lib/shop/status';
import type { ShopOrderRow } from '@/lib/shop/types';

/** Unpaid orders older than this are expired. */
export const SHOP_PENDING_EXPIRE_MIN = 30;

/** How far back the retry pass looks for expired / cancelled orders. */
const RETRY_WINDOW_DAYS = 14;
/** Most orders the retry pass handles per run. */
const RETRY_LIMIT = 100;

/** Earns Beanies for a delivered order. Idempotent; never throws. */
export async function onShopOrderDelivered(order: ShopOrderRow): Promise<{ earned: number }> {
  try {
    const earned = await earnForShopOrder(order.id);
    return { earned: Number.isFinite(earned) ? earned : 0 };
  } catch (e) {
    console.error('shop lifecycle: earn on delivered failed', order.id, e);
    return { earned: 0 };
  }
}

/** Reverses earn and redeem in one ledger row and releases the intro claim. Never throws. */
export async function onShopOrderCancelled(
  admin: SupabaseClient,
  order: ShopOrderRow,
): Promise<{ beanies_returned: number }> {
  let returned = 0;
  try {
    const n = await reverseForShopOrder(order.id, 'order cancelled');
    returned = Number.isFinite(n) ? n : 0;
  } catch (e) {
    console.error('shop lifecycle: ledger reversal failed', order.id, e);
  }
  try {
    const { error } = await admin.rpc('release_shop_intro_claim', { p_shop_order_id: order.id });
    if (error) {
      const { error: delError } = await admin.from('shop_intro_claims').delete().eq('shop_order_id', order.id);
      if (delError) console.error('shop lifecycle: intro claim release failed', order.id, delError);
    }
  } catch (e) {
    console.error('shop lifecycle: intro claim release threw', order.id, e);
  }
  return { beanies_returned: returned };
}

/**
 * Expires unpaid orders older than SHOP_PENDING_EXPIRE_MIN, after asking
 * Razorpay whether they were in fact paid. Returns counts.
 */
export async function expireStaleShopOrders(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<{ expired: number; recovered: number }> {
  const result = { expired: 0, recovered: 0 };
  const cutoff = new Date(now.getTime() - SHOP_PENDING_EXPIRE_MIN * 60_000).toISOString();
  const { data, error } = await admin
    .from('shop_orders')
    .select('*')
    .eq('status', 'payment_pending')
    .lt('created_at', cutoff);
  if (error) {
    if (!isMissingShopSchema(error)) console.error('shop lifecycle: stale order query failed', error);
    return result;
  }

  for (const raw of data ?? []) {
    try {
      const order = toShopOrderRow(raw as Record<string, unknown>);
      if (order.razorpay_order_id) {
        const attempts = await fetchOrderPaymentAttempts(order.razorpay_order_id);
        if (!attempts) continue; // gateway unreachable: try again next run
        if (attempts.some((a) => a.status === 'authorized')) continue; // may still capture
        const captured = attempts.find((a) => a.status === 'captured');
        if (captured) {
          const cap = await captureShopPayment({
            gatewayOrderId: order.razorpay_order_id,
            gatewayPaymentId: captured.id,
            method: captured.method,
            capturedAmountPaise: captured.amount,
          });
          if (cap.handled) result.recovered++;
          continue;
        }
      }
      const updated = await updateShopOrderIf(admin, order.id, ['payment_pending'], {
        status: 'expired',
        cancel_reason: 'Payment not completed in time',
      });
      if (!updated) continue; // it moved on (paid) meanwhile
      try {
        await reverseForShopOrder(order.id, 'payment not completed');
      } catch (e) {
        console.error('shop lifecycle: ledger reversal failed (the retry pass will redo it)', order.id, e);
      }
      result.expired++;
    } catch (e) {
      console.error('shop lifecycle: expiring an order failed', e);
    }
  }

  await retryShopOrderReversals(admin, now);
  return result;
}

/**
 * Retry pass: a Beanie return or intro-claim release that failed (a DB or
 * network blip) would otherwise be lost, because expired and cancelled orders
 * are never selected again. Re-runs both for recent expired / cancelled orders;
 * reverseForShopOrder returns 0 when a reverse row exists and the claim release
 * is a delete, so repeating them is harmless. Paid orders are never touched.
 */
async function retryShopOrderReversals(admin: SupabaseClient, now: Date): Promise<void> {
  try {
    const since = new Date(now.getTime() - RETRY_WINDOW_DAYS * 86_400_000).toISOString();
    const { data, error } = await admin
      .from('shop_orders')
      .select('id, status')
      .in('status', ['expired', 'cancelled'])
      .gte('created_at', since)
      .limit(RETRY_LIMIT);
    if (error) {
      if (!isMissingShopSchema(error)) console.error('shop lifecycle: retry pass query failed', error);
      return;
    }
    let fixed = 0;
    for (const row of (data ?? []) as { id: string; status: string }[]) {
      // Two separate try/catches: a reversal that throws must not skip the claim release.
      try {
        const n = await reverseForShopOrder(row.id, row.status === 'expired' ? 'payment not completed' : 'order cancelled');
        if (Number.isFinite(n) && n !== 0) fixed++;
      } catch (e) {
        console.error('shop lifecycle: retry reversal failed', row.id, e);
      }
      if (row.status !== 'cancelled') continue;
      try {
        const { error: relError } = await admin.rpc('release_shop_intro_claim', { p_shop_order_id: row.id });
        if (relError) console.error('shop lifecycle: retry claim release failed', row.id, relError);
      } catch (e) {
        console.error('shop lifecycle: retry claim release threw', row.id, e);
      }
    }
    if (fixed > 0) console.log(`shop lifecycle: retry pass fixed ${fixed} order(s)`);
  } catch (e) {
    console.error('shop lifecycle: retry pass failed', e);
  }
}

/**
 * Catches deliveries nobody clicked: shipped orders are checked against
 * Shiprocket and moved to delivered (earning Beanies). One failure never stops the rest.
 */
export async function sweepDeliveredShopOrders(
  admin: SupabaseClient,
  limit = 50,
): Promise<{ checked: number; delivered: number }> {
  const result = { checked: 0, delivered: 0 };
  if (!isShiprocketConfigured()) return result;
  const { data, error } = await admin
    .from('shop_orders')
    .select('*')
    .eq('status', 'shipped')
    .not('shiprocket_order_id', 'is', null)
    .order('shipped_at', { ascending: true })
    .limit(limit);
  if (error) {
    if (!isMissingShopSchema(error)) console.error('shop lifecycle: delivery sweep query failed', error);
    return result;
  }

  for (const raw of data ?? []) {
    try {
      const order = toShopOrderRow(raw as Record<string, unknown>);
      if (!order.shiprocket_order_id) continue;
      result.checked++;
      const sr = await fetchShiprocketOrder(order.shiprocket_order_id);
      if (!sr.ok) continue;
      if (shopStatusFromShiprocket(order.status, sr.state.status, sr.state.awb) !== 'delivered') continue;
      const updated = await updateShopOrderIf(admin, order.id, ['shipped'], {
        status: 'delivered',
        delivered_at: new Date().toISOString(),
        shiprocket_status: sr.state.status,
      });
      if (!updated) continue;
      await onShopOrderDelivered(updated);
      result.delivered++;
    } catch (e) {
      console.error('shop lifecycle: sweeping an order failed', e);
    }
  }
  return result;
}
