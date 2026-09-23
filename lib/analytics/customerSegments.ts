// Customer segregation (owner feedback: "orders all show as 'customer', we are
// not differentiating"). Pure classification/aggregation — no Supabase, no
// 'server-only' — so it is unit-testable and shared by the owner dashboard's
// "Recent orders" card and the customers page's segregation stats.
//
// The four order-level identities line up with the badges the dashboard shows:
//   - 'walk_in'           staff_pos, nothing at all typed/linked — Walk-in
//   - 'counter_identified' staff_pos, a linked account and/or a name/phone was
//                          typed — "Counter · <name>"
//   - 'online'             customer_web — Online
//   - 'table_qr'           table_qr — Table QR
//
// For the coarser "walk-in vs identified vs online" split, 'table_qr' folds
// into 'online' — both are self-service channels, as opposed to a staffer
// entering the order — while 'counter_identified' is what "identified" means.

import type { OrderChannel } from '@/lib/types';

// ---------------------------------------------------------------------------
// Per-order badge classification
// ---------------------------------------------------------------------------

export type OrderKind = 'walk_in' | 'counter_identified' | 'online' | 'table_qr';

export type CustomerSegment = 'walk_in' | 'identified' | 'online';

/** The minimal fields a badge/segment decision needs off an order row. */
export interface CustomerOrderInput {
  channel: OrderChannel;
  user_id: string | null;
  // Absent (undefined) is treated exactly like null — the caller couldn't read
  // the column (migration not applied) and degrades to "no link known", never
  // to a hard error. See app/api/orders/route.ts for the same posture.
  customer_user_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
}

/** The account this order is attributable to, if any — web session or counter link. */
export function identifiedKey(o: CustomerOrderInput): string | null {
  return o.user_id || o.customer_user_id || null;
}

function hasTypedIdentity(o: CustomerOrderInput): boolean {
  return Boolean(o.customer_name?.trim()) || Boolean(o.customer_phone?.trim());
}

/** Classify a single order into one of the four dashboard badge kinds. */
export function classifyOrderKind(o: CustomerOrderInput): OrderKind {
  if (o.channel === 'table_qr') return 'table_qr';
  if (o.channel === 'customer_web') return 'online';
  // staff_pos: identified either by an account link or by whatever the
  // staffer typed (a walk-in who never gave a name/phone has neither).
  return identifiedKey(o) || hasTypedIdentity(o) ? 'counter_identified' : 'walk_in';
}

/** Roll a badge kind up to the coarse 3-way split used for the daily totals. */
export function segmentForKind(kind: OrderKind): CustomerSegment {
  if (kind === 'walk_in') return 'walk_in';
  if (kind === 'counter_identified') return 'identified';
  return 'online'; // 'online' | 'table_qr'
}

/**
 * Display text for the "Recent orders" badge. `resolvedName` is an optional
 * profile-looked-up name, used only when the order itself carries neither a
 * customer_name nor a customer_phone (a counter order linked purely by an
 * existing account match).
 */
export function customerBadgeLabel(o: CustomerOrderInput, resolvedName?: string | null): string {
  const kind = classifyOrderKind(o);
  switch (kind) {
    case 'walk_in':
      return 'Walk-in';
    case 'online':
      return 'Online';
    case 'table_qr':
      return 'Table QR';
    case 'counter_identified': {
      const name = o.customer_name?.trim() || resolvedName?.trim() || o.customer_phone?.trim() || 'Customer';
      return `Counter · ${name}`;
    }
  }
}

/** "Entered by <staff name>" line — null for anything not staff-entered. */
export function enteredByLabel(channel: OrderChannel, staffName: string | null | undefined): string | null {
  if (channel !== 'staff_pos') return null;
  return `Entered by ${staffName?.trim() || 'Unknown staff'}`;
}

/** Tally orders into the walk-in/identified/online split (order counts). */
export function tallyCustomerSegments(rows: CustomerOrderInput[]): Record<CustomerSegment, number> {
  const out: Record<CustomerSegment, number> = { walk_in: 0, identified: 0, online: 0 };
  for (const r of rows) {
    out[segmentForKind(classifyOrderKind(r))] += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Customers-page segregation: identified customers keyed by
// COALESCE(user_id, customer_user_id), plus separate walk-in/phone-only counts.
// ---------------------------------------------------------------------------

export interface CustomerOrderRow extends CustomerOrderInput {
  total_inr: number | null;
  created_at: string;
}

export interface IdentifiedCustomerAgg {
  /** COALESCE(user_id, customer_user_id) */
  key: string;
  orders: number;
  revenue_inr: number;
  aov_inr: number;
  first_order_at: string;
  last_order_at: string;
  // Best-effort display fields taken from the most recent order that had them
  // — a fallback for when a profiles lookup is unavailable or blank (e.g. a
  // counter-linked account whose profile was never filled in).
  sample_name: string;
  sample_phone: string;
}

export interface CustomerSegmentation {
  identified: IdentifiedCustomerAgg[];
  /** Orders with no account link and nothing at all typed (channel staff_pos). */
  anonymousWalkInOrders: number;
  /** Orders with no account link but a phone was given (any channel). */
  phoneOnlyGuestOrders: number;
  /** Distinct phone numbers behind phoneOnlyGuestOrders. */
  phoneOnlyGuestPhones: number;
  totalOrders: number;
}

/**
 * Groups orders into identified-customer stats (by account) plus the two
 * "no account" buckets the owner asked to see split out. Pure — callers fetch
 * the rows (last N days, a reasonable limit) via the admin client.
 */
export function segmentCustomers(rows: CustomerOrderRow[]): CustomerSegmentation {
  const byKey = new Map<
    string,
    { orders: number; revenue_inr: number; first_order_at: string; last_order_at: string; sample_name: string; sample_phone: string }
  >();
  let anonymousWalkInOrders = 0;
  let phoneOnlyGuestOrders = 0;
  const phoneOnlyGuestPhoneSet = new Set<string>();

  for (const r of rows) {
    const key = identifiedKey(r);
    const revenue = r.total_inr ?? 0;

    if (key) {
      const acc = byKey.get(key) ?? {
        orders: 0,
        revenue_inr: 0,
        first_order_at: r.created_at,
        last_order_at: r.created_at,
        sample_name: '',
        sample_phone: '',
      };
      acc.orders += 1;
      acc.revenue_inr += revenue;
      if (r.created_at < acc.first_order_at) acc.first_order_at = r.created_at;
      if (r.created_at > acc.last_order_at) {
        acc.last_order_at = r.created_at;
        // Prefer the most recent order's name/phone as the sample — most
        // likely to be current.
        if (r.customer_name?.trim()) acc.sample_name = r.customer_name.trim();
        if (r.customer_phone?.trim()) acc.sample_phone = r.customer_phone.trim();
      } else {
        if (!acc.sample_name && r.customer_name?.trim()) acc.sample_name = r.customer_name.trim();
        if (!acc.sample_phone && r.customer_phone?.trim()) acc.sample_phone = r.customer_phone.trim();
      }
      byKey.set(key, acc);
      continue;
    }

    // No account link.
    const phone = r.customer_phone?.trim() ?? '';
    if (phone) {
      phoneOnlyGuestOrders += 1;
      phoneOnlyGuestPhoneSet.add(phone);
    } else if (r.channel === 'staff_pos' && !r.customer_name?.trim()) {
      anonymousWalkInOrders += 1;
    }
    // Orders with a name but no phone and no account (any channel) fall into
    // neither bucket — the owner asked for these two counts specifically, not
    // a full partition.
  }

  const identified: IdentifiedCustomerAgg[] = [...byKey.entries()]
    .map(([key, a]) => ({
      key,
      orders: a.orders,
      revenue_inr: a.revenue_inr,
      aov_inr: a.orders ? Math.round(a.revenue_inr / a.orders) : 0,
      first_order_at: a.first_order_at,
      last_order_at: a.last_order_at,
      sample_name: a.sample_name,
      sample_phone: a.sample_phone,
    }))
    .sort((x, y) => y.revenue_inr - x.revenue_inr);

  return {
    identified,
    anonymousWalkInOrders,
    phoneOnlyGuestOrders,
    phoneOnlyGuestPhones: phoneOnlyGuestPhoneSet.size,
    totalOrders: rows.length,
  };
}
