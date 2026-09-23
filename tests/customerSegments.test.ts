import { describe, expect, it } from 'vitest';

// Pure — no Supabase, no 'server-only' — so no mocking needed (unlike
// channelAnalytics.test.ts's queries.ts import).
import {
  classifyOrderKind,
  customerBadgeLabel,
  enteredByLabel,
  identifiedKey,
  segmentCustomers,
  segmentForKind,
  tallyCustomerSegments,
  type CustomerOrderInput,
  type CustomerOrderRow,
} from '@/lib/analytics/customerSegments';

const walkIn = (over: Partial<CustomerOrderInput> = {}): CustomerOrderInput => ({
  channel: 'staff_pos',
  user_id: null,
  customer_user_id: null,
  customer_name: '',
  customer_phone: '',
  ...over,
});

describe('classifyOrderKind', () => {
  it('is walk_in for a staff_pos order with nothing typed or linked', () => {
    expect(classifyOrderKind(walkIn())).toBe('walk_in');
  });

  it('is counter_identified when a staff_pos order has a linked account', () => {
    expect(classifyOrderKind(walkIn({ customer_user_id: 'u1' }))).toBe('counter_identified');
  });

  it('is counter_identified when a staff_pos order has just a typed name', () => {
    expect(classifyOrderKind(walkIn({ customer_name: 'Priya' }))).toBe('counter_identified');
  });

  it('is counter_identified when a staff_pos order has just a typed phone', () => {
    expect(classifyOrderKind(walkIn({ customer_phone: '+919876543210' }))).toBe('counter_identified');
  });

  it('is online for customer_web regardless of link state', () => {
    expect(classifyOrderKind(walkIn({ channel: 'customer_web' }))).toBe('online');
    expect(classifyOrderKind(walkIn({ channel: 'customer_web', user_id: 'u1' }))).toBe('online');
  });

  it('is table_qr for table_qr regardless of link state', () => {
    expect(classifyOrderKind(walkIn({ channel: 'table_qr' }))).toBe('table_qr');
  });

  it('treats a missing customer_user_id column (undefined) the same as null', () => {
    const o = walkIn();
    delete (o as { customer_user_id?: string | null }).customer_user_id;
    expect(classifyOrderKind(o)).toBe('walk_in');
  });
});

describe('identifiedKey', () => {
  it('prefers user_id over customer_user_id', () => {
    expect(identifiedKey(walkIn({ user_id: 'web-1', customer_user_id: 'counter-1' }))).toBe('web-1');
  });
  it('falls back to customer_user_id', () => {
    expect(identifiedKey(walkIn({ customer_user_id: 'counter-1' }))).toBe('counter-1');
  });
  it('is null when neither is set', () => {
    expect(identifiedKey(walkIn())).toBeNull();
  });
});

describe('segmentForKind', () => {
  it('maps table_qr into the online bucket', () => {
    expect(segmentForKind('table_qr')).toBe('online');
  });
  it('maps every kind to its expected bucket', () => {
    expect(segmentForKind('walk_in')).toBe('walk_in');
    expect(segmentForKind('counter_identified')).toBe('identified');
    expect(segmentForKind('online')).toBe('online');
  });
});

describe('customerBadgeLabel', () => {
  it('labels an anonymous walk-in', () => {
    expect(customerBadgeLabel(walkIn())).toBe('Walk-in');
  });

  it('labels a counter order by its typed name', () => {
    expect(customerBadgeLabel(walkIn({ customer_name: 'Priya Sharma' }))).toBe('Counter · Priya Sharma');
  });

  it('falls back to the typed phone when no name was given', () => {
    expect(customerBadgeLabel(walkIn({ customer_phone: '+919876543210' }))).toBe('Counter · +919876543210');
  });

  it('falls back to a resolved profile name when nothing was typed but an account is linked', () => {
    expect(customerBadgeLabel(walkIn({ customer_user_id: 'u1' }), 'Ayush Garg')).toBe('Counter · Ayush Garg');
  });

  it('falls back to "Customer" when nothing is available at all', () => {
    expect(customerBadgeLabel(walkIn({ customer_user_id: 'u1' }))).toBe('Counter · Customer');
  });

  it('labels online and table_qr channels plainly', () => {
    expect(customerBadgeLabel(walkIn({ channel: 'customer_web' }))).toBe('Online');
    expect(customerBadgeLabel(walkIn({ channel: 'table_qr' }))).toBe('Table QR');
  });
});

describe('enteredByLabel', () => {
  it('is null for non-staff_pos channels', () => {
    expect(enteredByLabel('customer_web', 'Ayush Garg')).toBeNull();
    expect(enteredByLabel('table_qr', 'Ayush Garg')).toBeNull();
  });
  it('names the staffer for staff_pos', () => {
    expect(enteredByLabel('staff_pos', 'Ayush Garg')).toBe('Entered by Ayush Garg');
  });
  it('falls back when the staff name is unknown/blank', () => {
    expect(enteredByLabel('staff_pos', null)).toBe('Entered by Unknown staff');
    expect(enteredByLabel('staff_pos', '  ')).toBe('Entered by Unknown staff');
  });
});

describe('tallyCustomerSegments', () => {
  it('splits a mixed batch into walk-in/identified/online', () => {
    const out = tallyCustomerSegments([
      walkIn(), // walk_in
      walkIn({ customer_name: 'Priya' }), // identified
      walkIn({ channel: 'customer_web' }), // online
      walkIn({ channel: 'table_qr' }), // online (folded in)
    ]);
    expect(out).toEqual({ walk_in: 1, identified: 1, online: 2 });
  });

  it('returns all-zero for an empty batch', () => {
    expect(tallyCustomerSegments([])).toEqual({ walk_in: 0, identified: 0, online: 0 });
  });
});

const orderRow = (over: Partial<CustomerOrderRow> = {}): CustomerOrderRow => ({
  channel: 'staff_pos',
  user_id: null,
  customer_user_id: null,
  customer_name: '',
  customer_phone: '',
  total_inr: 100,
  created_at: '2026-09-01T00:00:00Z',
  ...over,
});

describe('segmentCustomers', () => {
  it('groups orders by COALESCE(user_id, customer_user_id)', () => {
    const out = segmentCustomers([
      orderRow({ user_id: 'w1', total_inr: 200, created_at: '2026-09-01T00:00:00Z' }),
      orderRow({ customer_user_id: 'w1', total_inr: 300, created_at: '2026-09-05T00:00:00Z' }), // same person, counter visit
    ]);
    expect(out.identified).toHaveLength(1);
    const w1 = out.identified[0];
    expect(w1.key).toBe('w1');
    expect(w1.orders).toBe(2);
    expect(w1.revenue_inr).toBe(500);
    expect(w1.aov_inr).toBe(250);
    expect(w1.first_order_at).toBe('2026-09-01T00:00:00Z');
    expect(w1.last_order_at).toBe('2026-09-05T00:00:00Z');
  });

  it('counts a fully anonymous staff_pos order as an anonymous walk-in', () => {
    const out = segmentCustomers([orderRow()]);
    expect(out.anonymousWalkInOrders).toBe(1);
    expect(out.phoneOnlyGuestOrders).toBe(0);
    expect(out.identified).toHaveLength(0);
  });

  it('counts a phone-but-no-account order as a phone-only guest, on any channel', () => {
    const out = segmentCustomers([
      orderRow({ customer_phone: '+919876543210' }),
      orderRow({ channel: 'customer_web', customer_phone: '+919876543210' }),
      orderRow({ channel: 'table_qr', customer_phone: '+911111111111' }),
    ]);
    expect(out.phoneOnlyGuestOrders).toBe(3);
    expect(out.phoneOnlyGuestPhones).toBe(2); // one phone repeats
    expect(out.anonymousWalkInOrders).toBe(0);
  });

  it('does not double count a linked order as a walk-in or phone-only guest', () => {
    const out = segmentCustomers([orderRow({ customer_user_id: 'u1', customer_phone: '+919876543210' })]);
    expect(out.identified).toHaveLength(1);
    expect(out.anonymousWalkInOrders).toBe(0);
    expect(out.phoneOnlyGuestOrders).toBe(0);
  });

  it('sorts identified customers by revenue, highest first', () => {
    const out = segmentCustomers([
      orderRow({ user_id: 'low', total_inr: 100 }),
      orderRow({ user_id: 'high', total_inr: 900 }),
    ]);
    expect(out.identified.map((c) => c.key)).toEqual(['high', 'low']);
  });

  it('treats null total_inr as zero revenue', () => {
    const out = segmentCustomers([orderRow({ user_id: 'u1', total_inr: null })]);
    expect(out.identified[0].revenue_inr).toBe(0);
    expect(out.identified[0].aov_inr).toBe(0);
  });

  it('reports totalOrders as the full input length regardless of bucket', () => {
    const out = segmentCustomers([orderRow(), orderRow({ user_id: 'u1' }), orderRow({ customer_phone: '+91123' })]);
    expect(out.totalOrders).toBe(3);
  });
});
