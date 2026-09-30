// Attribution — which recipients came back, and how (spec §1.8).
//
// The clock starts at a recipient's `reference_at`: `sent_at` for a treated recipient,
// and the campaign's `started_at` for a holdout recipient (stamped when the campaign
// starts sending). A recipient is converted by, in this order:
//
//   1. COUPON  a coupon_redemptions row for the recipient's own coupon, on a valid
//              order. The coupon is unambiguous evidence: we issued it to this phone.
//   2. ORDER   otherwise, the first valid order by that contact (user id, counter-linked
//              user id, or phone — the orderMatchFilter rule) in (reference_at,
//              reference_at + attribution_days].
//
// Both routes use the SAME window. A coupon redeemed after it would otherwise count for
// the treated arm while the holdout arm — which has no coupon — could never earn the
// equivalent, and the measured lift would be flattered by the difference in rules
// rather than by the campaign.
//
// The run stamps converted_order_id / converted_at / conversion_revenue_inr /
// attributed_via, once (the UPDATE is guarded by `converted_at is null`, so a re-run or
// two overlapping runs cannot stamp a recipient twice or move a stamp).
//
// One ORDER converts at most one recipient PER CAMPAIGN. Two recipients can reach the same
// order (it matches one by account and another by the phone typed on it), and counting it for
// both inflates the campaign's returns, revenue and lift. Candidates are handled oldest
// reference_at first, so the earliest recipient keeps the order and a later one either finds
// its own next order in the window or stays unconverted.

import 'server-only';
import { DAY_MS } from '@/lib/marketing/ist';
import type { MarketingSettings } from '@/lib/marketing/types';
import {
  IN_CHUNK,
  assertOk,
  chunk,
  loadValidOrders,
  marketingAdmin,
  pageAll,
  toE164,
  type Admin,
  type OrderRow,
} from './repo';

/**
 * How far back a not-yet-converted recipient is still looked at: the attribution window
 * plus a small grace, so a missed nightly run (a deploy, an outage) does not strand the
 * last days of a window unattributed. It only widens who is CHECKED — the window in
 * which an order counts is still exactly attribution_days.
 */
export const ATTRIBUTION_LOOKBACK_GRACE_DAYS = 3;

interface Candidate {
  id: string;
  campaign_id: string;
  phone: string;
  user_id: string | null;
  arm: 'treatment' | 'holdout';
  coupon_id: string | null;
  reference_at: string;
}

interface Conversion {
  order: OrderRow;
  via: 'coupon' | 'order';
}

/**
 * The conversion for one candidate, or null. Pure: the orders and the redemptions are
 * passed in already loaded, so every boundary (an order exactly at reference_at, one
 * exactly at the window's end, a coupon order that is out of window) is testable.
 */
export function findConversion(
  candidate: Pick<Candidate, 'phone' | 'user_id' | 'arm' | 'coupon_id' | 'reference_at'>,
  attributionDays: number,
  ordersByUser: ReadonlyMap<string, readonly OrderRow[]>,
  ordersByPhone: ReadonlyMap<string, readonly OrderRow[]>,
  redeemedOrderIds: ReadonlyMap<string, readonly string[]>,
  ordersById: ReadonlyMap<string, OrderRow>,
  /** Orders this candidate's campaign has already counted for someone else: they convert nobody else there. */
  takenOrderIds: ReadonlySet<string> = new Set(),
): Conversion | null {
  const start = Date.parse(candidate.reference_at);
  if (!Number.isFinite(start)) return null;
  const end = start + attributionDays * DAY_MS;
  // (start, end] — an order in the same instant as the message is not a response to it.
  const inWindow = (o: OrderRow) => {
    const at = Date.parse(o.created_at);
    return Number.isFinite(at) && at > start && at <= end && !takenOrderIds.has(o.id);
  };
  const earliest = (orders: readonly OrderRow[]) =>
    orders.reduce<OrderRow | null>((best, o) => (!best || Date.parse(o.created_at) < Date.parse(best.created_at) ? o : best), null);

  if (candidate.coupon_id) {
    const redeemed = (redeemedOrderIds.get(candidate.coupon_id) ?? [])
      .map((id) => ordersById.get(id))
      .filter((o): o is OrderRow => o !== undefined && inWindow(o));
    const hit = earliest(redeemed);
    if (hit) return { order: hit, via: 'coupon' };
  }

  const own: OrderRow[] = [];
  if (candidate.user_id) own.push(...(ordersByUser.get(candidate.user_id) ?? []));
  const phone = toE164(candidate.phone);
  if (phone) own.push(...(ordersByPhone.get(phone) ?? []));
  const hit = earliest(own.filter(inWindow));
  return hit ? { order: hit, via: 'order' } : null;
}

/**
 * Attributes returns to recipients whose window is still open (or closed within the
 * grace). Treated recipients are those that were actually sent (sent / delivered / read);
 * holdout recipients need a `reference_at`, which the sender stamps when the campaign
 * starts. Returns how many were newly stamped.
 */
export async function attributeRecipients(
  now: Date,
  settings: Pick<MarketingSettings, 'attribution_days'>,
  admin: Admin = marketingAdmin(),
): Promise<number> {
  const days = settings.attribution_days;
  const lookbackIso = new Date(now.getTime() - (days + ATTRIBUTION_LOOKBACK_GRACE_DAYS) * DAY_MS).toISOString();

  const candidates = await pageAll<Candidate>('marketing_recipients read', (from, to) =>
    admin
      .from('marketing_recipients')
      .select('id, campaign_id, phone, user_id, arm, coupon_id, reference_at')
      .is('converted_at', null)
      .not('reference_at', 'is', null)
      .gte('reference_at', lookbackIso)
      .lte('reference_at', now.toISOString())
      .in('status', ['sent', 'delivered', 'read', 'holdout'])
      .order('reference_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (candidates.length === 0) return 0;

  // Orders since the earliest reference: at most days + grace of orders, however many recipients there are.
  const earliestRef = candidates.reduce((min, c) => (c.reference_at < min ? c.reference_at : min), candidates[0].reference_at);
  const orders = await loadValidOrders(earliestRef);
  const ordersById = new Map(orders.map((o) => [o.id, o]));
  const ordersByUser = new Map<string, OrderRow[]>();
  const ordersByPhone = new Map<string, OrderRow[]>();
  const push = (map: Map<string, OrderRow[]>, key: string, o: OrderRow) => {
    const list = map.get(key);
    if (list) list.push(o);
    else map.set(key, [o]);
  };
  for (const o of orders) {
    for (const u of new Set([o.user_id, o.customer_user_id].filter((x): x is string => Boolean(x)))) push(ordersByUser, u, o);
    const phone = toE164(o.customer_phone);
    if (phone) push(ordersByPhone, phone, o);
  }

  // Coupon redemptions for the coupons these recipients hold.
  const couponIds = [...new Set(candidates.map((c) => c.coupon_id).filter((id): id is string => Boolean(id)))];
  const redeemed = new Map<string, string[]>();
  for (const part of chunk(couponIds, IN_CHUNK)) {
    const { data, error } = await admin.from('coupon_redemptions').select('coupon_id, order_id').in('coupon_id', part);
    assertOk('coupon_redemptions read', error);
    for (const r of (data ?? []) as { coupon_id: string; order_id: string }[]) {
      const list = redeemed.get(r.coupon_id);
      if (list) list.push(r.order_id);
      else redeemed.set(r.coupon_id, [r.order_id]);
    }
  }

  // Orders each campaign has already counted — from earlier runs (stamped rows) and from this one.
  const taken = new Map<string, Set<string>>();
  const take = (campaignId: string, orderId: string) => {
    const set = taken.get(campaignId);
    if (set) set.add(orderId);
    else taken.set(campaignId, new Set([orderId]));
  };
  for (const part of chunk([...new Set(candidates.map((c) => c.campaign_id))], IN_CHUNK)) {
    const stamped = await pageAll<{ campaign_id: string; converted_order_id: string }>('marketing_recipients read', (from, to) =>
      admin
        .from('marketing_recipients')
        .select('campaign_id, converted_order_id')
        .in('campaign_id', part)
        .not('converted_order_id', 'is', null)
        .order('campaign_id', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const r of stamped) take(r.campaign_id, r.converted_order_id);
  }

  let attributed = 0;
  for (const c of candidates) {
    const hit = findConversion(c, days, ordersByUser, ordersByPhone, redeemed, ordersById, taken.get(c.campaign_id));
    if (!hit) continue;
    const { data, error } = await admin
      .from('marketing_recipients')
      .update({
        converted_order_id: hit.order.id,
        converted_at: hit.order.created_at,
        conversion_revenue_inr: Math.max(0, Math.round(hit.order.total_inr)),
        attributed_via: hit.via,
      })
      .eq('id', c.id)
      .is('converted_at', null)
      .select('id');
    if (error) {
      // One recipient failing must not stop the rest; it is picked up again next run.
      console.error('marketing attribution: stamp failed', error.message);
      continue;
    }
    if ((data ?? []).length > 0) {
      attributed += 1;
      take(c.campaign_id, hit.order.id);
    }
  }
  return attributed;
}
