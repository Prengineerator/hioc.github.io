// Seed helpers for the marketing engine tests: a small, believable cafe — settings,
// playbooks, customers with orders, consent and points — written into a fake db
// (tests/helpers/marketingDb.ts). Invented data only (SPEC.md PII rule).

import { DEFAULT_PLAYBOOKS, DEFAULT_SETTINGS } from '@/lib/marketing/types';
import type { PlaybookKey, PlaybookMode } from '@/lib/marketing/types';
import type { FakeDb, Row } from './marketingDb';
import { makeMarketingDb } from './marketingDb';

export const DAY = 24 * 60 * 60 * 1000;

/** 12:30 IST on Monday 5 Oct 2026 — inside the default 11:00–20:00 send window. */
export const NOW_SEND = new Date('2026-10-05T07:00:00.000Z');
/** 09:45 IST the same day — where the nightly planner runs (outside the window). */
export const NOW_PLAN = new Date('2026-10-05T04:15:00.000Z');
/** 22:00 IST — outside the window. */
export const NOW_NIGHT = new Date('2026-10-05T16:30:00.000Z');

export const daysAgo = (n: number, from: Date = NOW_SEND) => new Date(from.getTime() - n * DAY).toISOString();

export const UNIQUE = {
  marketing_campaigns: [['playbook_key', 'planned_for']],
  marketing_recipients: [['campaign_id', 'phone'], ['click_token']],
  coupons: [['code']],
  marketing_consent: [['phone']],
  whatsapp_opt_outs: [['phone']],
};

export function newDb(over: { missing?: string[]; missingColumns?: Record<string, string[]>; startMs?: number } = {}): FakeDb {
  return makeMarketingDb({ unique: UNIQUE, startMs: NOW_SEND.getTime(), ...over });
}

const table = (db: FakeDb, name: string): Row[] => db.tables[name] ?? (db.tables[name] = []);

export function seedSettings(db: FakeDb, over: Record<string, unknown> = {}): Row {
  const { updated_at: _u, ...defaults } = DEFAULT_SETTINGS;
  void _u;
  // Sending is ON by default here (the shipped default is OFF): tests that need it off say so.
  const row: Row = { is_singleton: true, ...defaults, enabled: true, whatsapp_business_number: '+919876500000', ...over };
  db.tables.marketing_settings = [row];
  return row;
}

export function seedPlaybooks(db: FakeDb, modes: Partial<Record<PlaybookKey, PlaybookMode>> = {}, over: Partial<Record<PlaybookKey, Row>> = {}): void {
  db.tables.marketing_playbooks = (Object.keys(DEFAULT_PLAYBOOKS) as PlaybookKey[]).map((key) => {
    const d = DEFAULT_PLAYBOOKS[key];
    return {
      key,
      mode: modes[key] ?? 'off',
      priority: d.priority,
      params: { ...d.params },
      offer: { ...d.offer },
      template: { ...d.template, vars: [...d.template.vars] },
      prior_conversion_pct: d.prior_conversion_pct,
      observed_treated: 0,
      observed_conversions: 0,
      last_planned_at: null,
      ...(over[key] ?? {}),
    };
  });
}

export function seedLoyalty(db: FakeDb, over: Record<string, unknown> = {}): void {
  db.tables.loyalty_config = [
    { id: 'lc', is_singleton: true, points_per_inr: 0.1, inr_per_point: 1, min_redeem_points: 20, max_redeem_pct: 50, points_expiry_days: 30, ...over },
  ];
}

/** One item, one variant, with a real cost, so the food-cost coverage guardrail passes. */
export function seedCostedMenu(db: FakeDb, over: { price?: number; cost?: number } = {}): { itemId: string; variantId: string } {
  const price = over.price ?? 200;
  const cost = over.cost ?? 60;
  db.tables.menu_items = [{ id: 'item-1', name: 'Cold Coffee', category: 'Coffee', is_available: true, sort_order: 1 }];
  db.tables.menu_item_variants = [{ id: 'var-1', menu_item_id: 'item-1', label: 'Regular', price_inr: price, sort_order: 1 }];
  db.tables.menu_item_costs = [{ variant_id: 'var-1', menu_item_id: 'item-1', cost_inr: cost }];
  return { itemId: 'item-1', variantId: 'var-1' };
}

export interface SeedCustomer {
  phone: string;
  userId?: string;
  name?: string;
  role?: string;
  /** Orders as [days ago, total ₹]. */
  orders?: [number, number][];
  optedIn?: boolean;
  optedOut?: boolean;
  verified?: boolean;
  /** Ledger credits as [days ago, points]. */
  points?: [number, number][];
}

let orderSeq = 0;

/** A customer with a verified account, consent, orders (each with one costed line) and a points ledger. */
export function seedCustomer(db: FakeDb, c: SeedCustomer, now: Date = NOW_SEND): void {
  const userId = c.userId ?? `u-${c.phone.slice(-4)}`;
  if (c.verified !== false) {
    table(db, 'profiles').push({ id: userId, name: c.name ?? 'Asha Rao', phone: c.phone, phone_verified: true, role: c.role ?? 'customer', marketing_consent: c.optedIn ?? false });
  }
  if (c.optedIn) {
    table(db, 'marketing_consent').push({ phone: c.phone, user_id: userId, status: 'opted_in', source: 'profile', consented_at: daysAgo(60, now), withdrawn_at: null });
  }
  if (c.optedOut) table(db, 'whatsapp_opt_outs').push({ phone: c.phone, source: 'stop_keyword' });
  for (const [ago, total] of c.orders ?? []) {
    const id = `o-${++orderSeq}`;
    table(db, 'orders').push({
      id,
      created_at: daysAgo(ago, now),
      total_inr: total,
      status: 'completed',
      user_id: userId,
      customer_user_id: null,
      customer_name: c.name ?? 'Asha Rao',
      customer_phone: c.phone,
    });
    table(db, 'order_items').push({ id: `oi-${id}`, order_id: id, variant_id: 'var-1', quantity: 1, line_total_inr: total, voided: false });
  }
  for (const [ago, points] of c.points ?? []) {
    table(db, 'loyalty_transactions').push({ id: `lt-${++orderSeq}`, user_id: userId, points, created_at: daysAgo(ago, now), type: 'earn' });
  }
}

/** The rows of a table matching a predicate — for terse assertions. */
export const rowsOf = (db: FakeDb, name: string, where: (r: Row) => boolean = () => true): Row[] => table(db, name).filter(where);
