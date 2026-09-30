import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb, Row } from './helpers/marketingDb';
import { DAY, NOW_SEND, daysAgo, newDb, rowsOf } from './helpers/marketingWorld';

// Attribution (spec §1.8): which recipients came back, and how. A coupon redemption
// beats a plain order; both use the same window, (reference_at, reference_at + N days];
// holdout recipients are measured from the campaign's start; a stamp is set once.

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));

const { attributeRecipients, findConversion } = await import('@/lib/marketing/server/attribution');

const PHONE = '+919876543210';
const SETTINGS = { attribution_days: 7 };
const db = () => h.db;
const rec = (id: string) => rowsOf(db(), 'marketing_recipients', (r) => r.id === id)[0];

let n = 0;
const recipient = (over: Row = {}): Row => {
  const row: Row = {
    id: `r${++n}`, campaign_id: 'c1', phone: PHONE, user_id: null, arm: 'treatment', status: 'sent', coupon_id: null,
    reference_at: daysAgo(3), converted_at: null, created_at: daysAgo(3), ...over,
  };
  (db().tables.marketing_recipients ??= []).push(row);
  return row;
};
const order = (over: Row = {}): Row => {
  const row: Row = {
    id: `o${++n}`, created_at: daysAgo(2), total_inr: 320, status: 'completed', user_id: null, customer_user_id: null, customer_phone: PHONE, ...over,
  };
  (db().tables.orders ??= []).push(row);
  return row;
};

beforeEach(() => {
  n = 0;
  h.db = newDb();
});

describe('by order', () => {
  it('stamps the first valid order after the message, with its revenue', async () => {
    const r = recipient();
    order({ id: 'late', created_at: daysAgo(1), total_inr: 500 });
    order({ id: 'first', created_at: daysAgo(2), total_inr: 320 });

    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(1);
    expect(rec(r.id as string)).toMatchObject({
      converted_order_id: 'first', converted_at: daysAgo(2), conversion_revenue_inr: 320, attributed_via: 'order',
    });
  });

  it('matches by user id, counter-linked user id, and either phone spelling', async () => {
    const byUser = recipient({ phone: '+919111111111', user_id: 'u1' });
    const byLinked = recipient({ phone: '+919222222222', user_id: 'u2' });
    const byPlus = recipient({ phone: '+919333333333' });
    const byBare = recipient({ phone: '+919444444444' });
    order({ id: 'o-user', user_id: 'u1', customer_phone: '+910000000000' });
    order({ id: 'o-linked', customer_user_id: 'u2', customer_phone: '' });
    order({ id: 'o-plus', customer_phone: '+919333333333' });
    // Older rows keep the bare ten digits.
    order({ id: 'o-bare', customer_phone: '9444444444' });

    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(4);
    expect(rec(byUser.id as string).converted_order_id).toBe('o-user');
    expect(rec(byLinked.id as string).converted_order_id).toBe('o-linked');
    expect(rec(byPlus.id as string).converted_order_id).toBe('o-plus');
    expect(rec(byBare.id as string).converted_order_id).toBe('o-bare');
  });

  it('does not credit someone else\'s order', async () => {
    recipient();
    order({ customer_phone: '+919999999999', user_id: 'someone-else' });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
  });

  it('ignores cancelled and rejected orders', async () => {
    recipient();
    order({ status: 'cancelled' });
    order({ status: 'rejected', created_at: daysAgo(1) });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
  });

  it('counts only orders AFTER the message: one at the very instant does not count', async () => {
    const r = recipient({ reference_at: daysAgo(3) });
    order({ created_at: daysAgo(3) });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
    order({ id: 'just-after', created_at: new Date(NOW_SEND.getTime() - 3 * DAY + 1).toISOString() });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(1);
    expect(rec(r.id as string).converted_order_id).toBe('just-after');
  });

  it('the window is (reference_at, reference_at + attribution_days]: the end is inclusive, one ms later is out', async () => {
    const ref = new Date(NOW_SEND.getTime() - 8 * DAY);
    const r = recipient({ reference_at: ref.toISOString() });
    order({ id: 'too-late', created_at: new Date(ref.getTime() + 7 * DAY + 1).toISOString() });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
    order({ id: 'last-moment', created_at: new Date(ref.getTime() + 7 * DAY).toISOString() });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(1);
    expect(rec(r.id as string).converted_order_id).toBe('last-moment');
  });

  it('only statuses that mean "a message went out" (or holdout) are attributed', async () => {
    for (const [i, status] of ['failed', 'skipped', 'queued', 'pending', 'cancelled', 'sending'].entries()) {
      recipient({ status, phone: `+91980000000${i}` });
      order({ customer_phone: `+91980000000${i}` });
    }
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
  });

  it('does not look at recipients whose window closed long ago', async () => {
    // Beyond attribution_days + the 3-day grace: nobody is going to change that result now.
    recipient({ reference_at: daysAgo(11) });
    order({ created_at: daysAgo(9) });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
  });

  it('but does still catch one whose window closed a day or two ago (a missed nightly run)', async () => {
    recipient({ reference_at: daysAgo(9) });
    order({ created_at: daysAgo(4) });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(1);
  });
});

describe('by coupon', () => {
  it('a redemption of the recipient\'s coupon beats an earlier plain order', async () => {
    const r = recipient({ coupon_id: 'cp1' });
    order({ id: 'plain', created_at: daysAgo(2.5), total_inr: 300 });
    order({ id: 'redeemed', created_at: daysAgo(1), total_inr: 260 });
    db().tables.coupon_redemptions = [{ id: 'cr1', coupon_id: 'cp1', order_id: 'redeemed' }];

    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(1);
    expect(rec(r.id as string)).toMatchObject({ converted_order_id: 'redeemed', conversion_revenue_inr: 260, attributed_via: 'coupon' });
  });

  it('a redemption on a cancelled order does not count — the order rule then applies', async () => {
    const r = recipient({ coupon_id: 'cp1' });
    order({ id: 'plain', created_at: daysAgo(2), total_inr: 300 });
    order({ id: 'redeemed', created_at: daysAgo(1), status: 'cancelled' });
    db().tables.coupon_redemptions = [{ id: 'cr1', coupon_id: 'cp1', order_id: 'redeemed' }];
    await attributeRecipients(NOW_SEND, SETTINGS);
    expect(rec(r.id as string)).toMatchObject({ converted_order_id: 'plain', attributed_via: 'order' });
  });

  it('a redemption outside the window is not credited', async () => {
    const ref = new Date(NOW_SEND.getTime() - 8 * DAY);
    recipient({ coupon_id: 'cp1', reference_at: ref.toISOString() });
    order({ id: 'redeemed', created_at: new Date(ref.getTime() + 7 * DAY + 60_000).toISOString() });
    db().tables.coupon_redemptions = [{ id: 'cr1', coupon_id: 'cp1', order_id: 'redeemed' }];
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
  });

  it('a redemption of ANOTHER recipient\'s coupon is not this recipient\'s conversion', async () => {
    recipient({ coupon_id: 'cp-mine', phone: '+919111111111' });
    order({ id: 'theirs', customer_phone: '+919222222222' });
    db().tables.coupon_redemptions = [{ id: 'cr1', coupon_id: 'cp-other', order_id: 'theirs' }];
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
  });
});

describe('the holdout', () => {
  it('is measured from the campaign start: a holdout who ordered is a conversion of the CONTROL group', async () => {
    const r = recipient({ arm: 'holdout', status: 'holdout', reference_at: daysAgo(3), phone: '+919555555555' });
    order({ customer_phone: '+919555555555', created_at: daysAgo(1), total_inr: 280 });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(1);
    expect(rec(r.id as string)).toMatchObject({ attributed_via: 'order', conversion_revenue_inr: 280 });
  });

  it('cannot be measured before the campaign has started (no reference_at yet)', async () => {
    recipient({ arm: 'holdout', status: 'holdout', reference_at: null, phone: '+919555555555' });
    order({ customer_phone: '+919555555555' });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
  });
});

// Two recipients can reach the same order — it matches one by account and the other by the phone typed on it — and
// counting it for both inflates the campaign's returns, revenue and lift.
describe('one order converts at most one recipient per campaign', () => {
  const both = () => {
    // A is reached by the order's account, B by the phone typed on the very same order.
    const a = recipient({ id: 'A', phone: '+919111111111', user_id: 'u1', reference_at: daysAgo(4) });
    const b = recipient({ id: 'B', phone: '+919222222222', user_id: null, reference_at: daysAgo(3) });
    order({ id: 'shared', user_id: 'u1', customer_phone: '+919222222222', created_at: daysAgo(2), total_inr: 400 });
    return { a, b };
  };

  it('the recipient with the earlier reference_at keeps the order; the other is not converted by it', async () => {
    both();
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(1);
    expect(rec('A')).toMatchObject({ converted_order_id: 'shared', conversion_revenue_inr: 400, attributed_via: 'order' });
    expect(rec('B').converted_order_id ?? null).toBeNull();
    expect(rec('B').converted_at ?? null).toBeNull();
    expect(rowsOf(db(), 'marketing_recipients', (r) => r.converted_order_id === 'shared')).toHaveLength(1);
  });

  it('the loser still converts on an order of its own, if it has one in its window', async () => {
    both();
    order({ id: 'own', customer_phone: '+919222222222', created_at: daysAgo(1), total_inr: 150 });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(2);
    expect(rec('A').converted_order_id).toBe('shared');
    expect(rec('B')).toMatchObject({ converted_order_id: 'own', conversion_revenue_inr: 150 });
  });

  it('an order stamped by an EARLIER run is already taken when a later run looks at the other recipient', async () => {
    const { a } = both();
    Object.assign(a, { converted_order_id: 'shared', converted_at: daysAgo(2), conversion_revenue_inr: 400, attributed_via: 'order' });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
    expect(rec('B').converted_order_id ?? null).toBeNull();
  });

  it('a coupon redemption is taken too: the order the earlier recipient\'s coupon redeemed cannot also convert the next', async () => {
    recipient({ id: 'A', phone: '+919111111111', coupon_id: 'cp-a', reference_at: daysAgo(4) });
    recipient({ id: 'B', phone: '+919222222222', reference_at: daysAgo(3) });
    order({ id: 'shared', customer_phone: '+919222222222', created_at: daysAgo(2) });
    db().tables.coupon_redemptions = [{ id: 'cr', coupon_id: 'cp-a', order_id: 'shared' }];
    await attributeRecipients(NOW_SEND, SETTINGS);
    expect(rec('A')).toMatchObject({ converted_order_id: 'shared', attributed_via: 'coupon' });
    expect(rec('B').converted_order_id ?? null).toBeNull();
  });

  it('only WITHIN a campaign: two campaigns may each count the same order', async () => {
    recipient({ id: 'A', campaign_id: 'c1', phone: '+919111111111', user_id: 'u1', reference_at: daysAgo(4) });
    recipient({ id: 'B', campaign_id: 'c2', phone: '+919222222222', reference_at: daysAgo(3) });
    order({ id: 'shared', user_id: 'u1', customer_phone: '+919222222222', created_at: daysAgo(2) });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(2);
    expect(rec('A').converted_order_id).toBe('shared');
    expect(rec('B').converted_order_id).toBe('shared');
  });

  it('holds across the arms of a campaign too (a treated and a holdout recipient cannot both claim it)', async () => {
    recipient({ id: 'A', phone: '+919111111111', user_id: 'u1', reference_at: daysAgo(4) });
    recipient({ id: 'H', phone: '+919222222222', arm: 'holdout', status: 'holdout', reference_at: daysAgo(3) });
    order({ id: 'shared', user_id: 'u1', customer_phone: '+919222222222', created_at: daysAgo(2) });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(1);
    expect(rec('H').converted_order_id ?? null).toBeNull();
  });
});

describe('stamping', () => {
  it('stamps once: a second run finds nothing left to do and never moves the stamp', async () => {
    const r = recipient();
    order({ id: 'first', created_at: daysAgo(2) });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(1);
    order({ id: 'earlier-arrival', created_at: daysAgo(2.5) });
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
    expect(rec(r.id as string).converted_order_id).toBe('first');
  });

  it('two overlapping runs cannot both stamp the same recipient', async () => {
    const r = recipient();
    order();
    const [a, b] = await Promise.all([attributeRecipients(NOW_SEND, SETTINGS), attributeRecipients(NOW_SEND, SETTINGS)]);
    expect(a + b).toBeGreaterThanOrEqual(1);
    expect(rec(r.id as string).attributed_via).toBe('order');
  });

  it('does nothing when there are no candidates, and reads no orders', async () => {
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(0);
  });

  it('one failed stamp does not stop the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = recipient({ phone: '+919111111111' });
    const b = recipient({ phone: '+919222222222' });
    order({ customer_phone: '+919111111111' });
    order({ customer_phone: '+919222222222' });
    db().failNext('update marketing_recipients');
    expect(await attributeRecipients(NOW_SEND, SETTINGS)).toBe(1);
    const stamped = [rec(a.id as string), rec(b.id as string)].filter((r) => r.attributed_via === 'order');
    expect(stamped).toHaveLength(1);
  });
});

describe('findConversion (pure)', () => {
  type OrderRow = import('@/lib/marketing/server/repo').OrderRow;
  const o = (id: string, at: string, over: Partial<OrderRow> = {}): OrderRow => ({
    id, created_at: at, total_inr: 100, status: 'completed', user_id: null, customer_user_id: null, customer_name: null, customer_phone: PHONE, ...over,
  });
  const index = (orders: OrderRow[]) => ({
    byUser: new Map<string, OrderRow[]>(),
    byPhone: new Map<string, OrderRow[]>([[PHONE, orders]]),
    byId: new Map<string, OrderRow>(orders.map((x) => [x.id, x])),
  });

  it('returns null with no orders, and null for an unparseable reference', () => {
    const { byUser, byPhone, byId } = index([]);
    const cand = { phone: PHONE, user_id: null, arm: 'treatment' as const, coupon_id: null, reference_at: '2026-10-01T00:00:00.000Z' };
    expect(findConversion(cand, 7, byUser, byPhone, new Map(), byId)).toBeNull();
    expect(findConversion({ ...cand, reference_at: 'nonsense' }, 7, byUser, byPhone, new Map(), byId)).toBeNull();
  });

  it('skips orders its campaign has already counted for someone else', () => {
    const list = [o('a', '2026-10-02T00:00:00.000Z'), o('b', '2026-10-03T00:00:00.000Z')];
    const { byUser, byPhone, byId } = index(list);
    const cand = { phone: PHONE, user_id: null, arm: 'treatment' as const, coupon_id: null, reference_at: '2026-10-01T00:00:00.000Z' };
    expect(findConversion(cand, 7, byUser, byPhone, new Map(), byId, new Set(['a']))?.order.id).toBe('b');
    expect(findConversion(cand, 7, byUser, byPhone, new Map(), byId, new Set(['a', 'b']))).toBeNull();
  });

  it('picks the earliest in-window order, not the first in the list', () => {
    const list = [o('b', '2026-10-03T00:00:00.000Z'), o('a', '2026-10-02T00:00:00.000Z')];
    const { byUser, byPhone, byId } = index(list);
    const cand = { phone: PHONE, user_id: null, arm: 'treatment' as const, coupon_id: null, reference_at: '2026-10-01T00:00:00.000Z' };
    expect(findConversion(cand, 7, byUser, byPhone, new Map(), byId)?.order.id).toBe('a');
  });
});
