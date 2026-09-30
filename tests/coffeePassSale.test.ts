import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildPassSaleRows,
  createPassSaleOrder,
  passLineLabel,
  passSaleBill,
  toPassSaleSummaries,
  type PassSaleInput,
} from '@/lib/passes/sale';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { CoffeePassPlan } from '@/lib/passes/types';
import type { StoreSettings } from '@/lib/types';
import { makePassAdmin, type Row } from './helpers/passAdmin';

// lib/passes/sale.ts: the one place a HIOC Ritual sale order is built, for both
// the website (checkout) and the counter (sell). Two layers:
//  1. the pure part (fields, bill, labels) with no database;
//  2. createPassSaleOrder against the in-memory fake: what it inserts, and that a
//     failed line takes the order back out.

const PLAN: CoffeePassPlan = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Weekly Ritual',
  description: '7 cups for the price of 5',
  drinks_total: 7,
  drinks_paid: 5,
  validity_days: 7,
  drink_value_inr: 150,
  price_inr: 750,
  max_per_day: null,
  gst_exempt: false,
  is_active: true,
  sort_order: 10,
};
const ACCOUNT = '00000000-0000-4000-8000-0000000000c1';
const STAFF = '00000000-0000-4000-8000-0000000000d1';

const settings = (over: Partial<StoreSettings> = {}): StoreSettings => ({ ...FALLBACK_STORE_SETTINGS, ...over });

function counterSale(over: Partial<PassSaleInput> = {}): PassSaleInput {
  return {
    plan: PLAN,
    channel: 'staff_pos',
    status: 'accepted',
    paymentStatus: 'unpaid',
    paymentMethod: null,
    customerName: 'Asha',
    customerPhone: '+919876543210',
    userId: null,
    customerUserId: ACCOUNT,
    createdBy: STAFF,
    settings: settings(),
    ...over,
  };
}

describe('passLineLabel', () => {
  it('reads "7 cups · 7 days" and uses the singular where it should', () => {
    expect(passLineLabel(PLAN)).toBe('7 cups · 7 days');
    expect(passLineLabel({ drinks_total: 1, validity_days: 1 })).toBe('1 cup · 1 day');
    expect(passLineLabel({ drinks_total: 7, validity_days: 30 })).toBe('7 cups · 30 days');
  });
});

describe('passSaleBill', () => {
  it('charges GST on top of the price when the store is GST-exclusive (spec §6: ₹750 -> ₹788)', () => {
    expect(passSaleBill(PLAN, settings({ gst_percent: 5, gst_inclusive: false }))).toMatchObject({
      subtotal_inr: 750,
      tax_inr: 38, // 37.5 rounds up
      packaging_inr: 0,
      discount_inr: 0,
      total_inr: 788,
    });
  });

  it('extracts GST from the price when the store is GST-inclusive (₹750 stays ₹750, ₹36 of it GST)', () => {
    expect(passSaleBill(PLAN, settings({ gst_percent: 5, gst_inclusive: true }))).toMatchObject({
      subtotal_inr: 750,
      tax_inr: 36,
      total_inr: 750,
    });
  });

  it('charges no GST on a GST-exempt plan, either way', () => {
    const exempt = { ...PLAN, gst_exempt: true };
    expect(passSaleBill(exempt, settings({ gst_inclusive: false }))).toMatchObject({ tax_inr: 0, total_inr: 750 });
    expect(passSaleBill(exempt, settings({ gst_inclusive: true }))).toMatchObject({ tax_inr: 0, total_inr: 750 });
  });

  it("never adds the store's packaging charge: there is nothing to pack", () => {
    const bill = passSaleBill(PLAN, settings({ packaging_charge_inr: 10 }));
    expect(bill.packaging_inr).toBe(0);
    expect(bill.total_inr).toBe(788);
  });
});

describe('buildPassSaleRows', () => {
  it('builds a counter sale: staff_pos, accepted, unpaid, created_by the staffer, filed under the account', () => {
    const { order, item, bill } = buildPassSaleRows(counterSale());
    expect(order).toMatchObject({
      order_kind: 'coffee_pass',
      channel: 'staff_pos',
      status: 'accepted',
      payment_status: 'unpaid',
      payment_method: null,
      created_by: STAFF,
      user_id: null,
      customer_user_id: ACCOUNT,
      customer_name: 'Asha',
      customer_phone: '+919876543210',
      subtotal_inr: 750,
      tax_inr: 38,
      packaging_inr: 0,
      discount_inr: 0,
      total_inr: 788,
    });
    expect(bill.total_inr).toBe(788);
    expect(item).toMatchObject({
      menu_item_id: null,
      variant_id: null,
      name_snapshot: 'Weekly Ritual',
      variant_label_snapshot: '7 cups · 7 days',
      price_inr_snapshot: 750,
      quantity: 1,
      line_total_inr: 750,
      gst_exempt: false,
      coffee_pass_plan_id: PLAN.id,
    });
  });

  it('fills every NOT NULL column of orders with a sensible value and leaves the pickup ones empty', () => {
    const { order } = buildPassSaleRows(counterSale());
    // NOT NULL text columns are '' (not undefined), nullable pickup columns are null.
    expect(order).toMatchObject({
      pickup_time: '',
      pickup_slot_label: '',
      table_label: '',
      notes: '',
      order_type: 'takeaway',
      pickup_slot_start: null,
      table_id: null,
      pickup_code: null,
    });
    // pass_discount_inr is for cups a pass COVERED on a menu order, never for selling one.
    expect(order).not.toHaveProperty('pass_discount_inr');
  });

  it('builds a website sale: customer_web, placed, payment_pending/online, the session as both user and account', () => {
    const { order } = buildPassSaleRows(
      counterSale({
        channel: 'customer_web',
        status: 'placed',
        paymentStatus: 'payment_pending',
        paymentMethod: 'online',
        userId: ACCOUNT,
        customerUserId: ACCOUNT,
        createdBy: null,
      }),
    );
    expect(order).toMatchObject({
      channel: 'customer_web',
      status: 'placed',
      payment_status: 'payment_pending',
      payment_method: 'online',
      user_id: ACCOUNT,
      customer_user_id: ACCOUNT,
      created_by: null,
    });
  });

  it('omits customer_user_id when there is no account, so the row never depends on that column', () => {
    expect(buildPassSaleRows(counterSale({ customerUserId: null })).order).not.toHaveProperty('customer_user_id');
  });

  it('marks the line GST-exempt when the plan is', () => {
    expect(buildPassSaleRows(counterSale({ plan: { ...PLAN, gst_exempt: true } })).item).toMatchObject({ gst_exempt: true });
  });
});

describe('toPassSaleSummaries', () => {
  it('names the sale by its one line and tolerates missing pieces', () => {
    expect(
      toPassSaleSummaries([
        { id: 'o1', order_number: 42, total_inr: 788, created_at: 'T1', order_items: [{ name_snapshot: 'Weekly Ritual' }] },
        { id: 'o2', created_at: 'T2', order_items: null },
      ]),
    ).toEqual([
      { order_id: 'o1', order_number: 42, plan_name: 'Weekly Ritual', total_inr: 788, created_at: 'T1' },
      { order_id: 'o2', order_number: null, plan_name: '', total_inr: 0, created_at: 'T2' },
    ]);
    expect(toPassSaleSummaries(null)).toEqual([]);
  });
});

describe('createPassSaleOrder', () => {
  const defaults = (table: string, row: Row): Row => (table === 'orders' ? { order_number: 7, version: 0, ...row } : row);

  it('inserts the order, its single line and the first status event, and returns the row with items', async () => {
    const admin = makePassAdmin({}, { defaults });
    const result = await createPassSaleOrder(admin as unknown as SupabaseClient, counterSale());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const orders = admin.tables.orders;
    const items = admin.tables.order_items;
    const events = admin.tables.order_status_events;
    expect(orders).toHaveLength(1);
    expect(items).toEqual([expect.objectContaining({ order_id: orders[0].id, name_snapshot: 'Weekly Ritual', quantity: 1 })]);
    expect(events).toEqual([
      expect.objectContaining({
        order_id: orders[0].id,
        from_status: null,
        to_status: 'accepted',
        actor_id: STAFF,
        actor_role: 'staff',
      }),
    ]);
    expect(result.order.id).toBe(orders[0].id);
    expect(result.order.order_items).toHaveLength(1);
    expect(result.order.order_items?.[0]).toMatchObject({ name_snapshot: 'Weekly Ritual', coffee_pass_plan_id: PLAN.id });
  });

  it('attributes an online sale to the system, not to a person', async () => {
    const admin = makePassAdmin({}, { defaults });
    await createPassSaleOrder(
      admin as unknown as SupabaseClient,
      counterSale({ channel: 'customer_web', status: 'placed', paymentStatus: 'payment_pending', paymentMethod: 'online', createdBy: null, userId: ACCOUNT }),
    );
    expect(admin.tables.order_status_events[0]).toMatchObject({ to_status: 'placed', actor_id: null, actor_role: 'system' });
  });

  it('honours an explicit actor role (a manager or owner selling)', async () => {
    const admin = makePassAdmin({}, { defaults });
    await createPassSaleOrder(admin as unknown as SupabaseClient, counterSale({ actorRole: 'owner' }));
    expect(admin.tables.order_status_events[0]).toMatchObject({ actor_role: 'owner' });
  });

  it('deletes the order again when its line cannot be written', async () => {
    const admin = makePassAdmin({}, {
      defaults,
      fail: (c) => (c.table === 'order_items' && c.op === 'insert' ? { message: 'boom' } : null),
    });
    const result = await createPassSaleOrder(admin as unknown as SupabaseClient, counterSale());
    expect(result).toMatchObject({ ok: false, missingSchema: false });
    expect(result.ok === false && result.message).toContain('boom');
    expect(admin.tables.orders).toEqual([]);
  });

  it('reports a database without the migration so the route can say which file to apply', async () => {
    const admin = makePassAdmin({}, {
      fail: (c) => (c.table === 'orders' && c.op === 'insert' ? { code: '42703', message: 'column "order_kind" does not exist' } : null),
    });
    const result = await createPassSaleOrder(admin as unknown as SupabaseClient, counterSale());
    expect(result).toMatchObject({ ok: false, missingSchema: true });
    expect(admin.tables.order_items ?? []).toEqual([]);
  });

  it('still succeeds when only the status event is lost (an SLA anchor, not the sale)', async () => {
    const admin = makePassAdmin({}, {
      defaults,
      fail: (c) => (c.table === 'order_status_events' ? { message: 'events down' } : null),
    });
    const result = await createPassSaleOrder(admin as unknown as SupabaseClient, counterSale());
    expect(result.ok).toBe(true);
    expect(admin.tables.orders).toHaveLength(1);
  });
});
