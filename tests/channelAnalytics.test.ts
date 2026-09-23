import { describe, expect, it, vi } from 'vitest';

// queries.ts is server-only (uses the service-role client); the `server-only`
// guard has no Node resolution, so stub it — the helpers under test are pure and
// touch neither the client nor the guard.
vi.mock('server-only', () => ({}));

import { bucketDineInHours, summariseChannels } from '@/lib/analytics/queries';
import type { ChannelMixRow } from '@/lib/types';

// Pure OPS-1 helpers: rolling the channel×type mix up per channel (with avg
// ticket) and bucketing dine-in timestamps into IST hours. Deterministic — no DB.

const row = (
  channel: ChannelMixRow['channel'],
  order_type: ChannelMixRow['order_type'],
  orders: number,
  revenue_inr: number,
): ChannelMixRow => ({
  channel,
  order_type,
  orders,
  revenue_inr,
  avg_ticket_inr: orders ? Math.round(revenue_inr / orders) : 0,
});

describe('summariseChannels', () => {
  it('rolls the order-type split up to one row per channel', () => {
    const out = summariseChannels([
      row('staff_pos', 'dine_in', 2, 600),
      row('staff_pos', 'takeaway', 3, 400),
      row('customer_web', 'takeaway', 5, 2500),
    ]);
    expect(out).toHaveLength(2);
    const staff = out.find((r) => r.channel === 'staff_pos')!;
    expect(staff.orders).toBe(5);
    expect(staff.revenue_inr).toBe(1000);
    expect(staff.avg_ticket_inr).toBe(200); // round(1000 / 5)
  });

  it('sorts channels by revenue, highest first', () => {
    const out = summariseChannels([
      row('staff_pos', 'dine_in', 1, 100),
      row('customer_web', 'takeaway', 1, 900),
    ]);
    expect(out.map((r) => r.channel)).toEqual(['customer_web', 'staff_pos']);
  });

  it('never divides by zero when a channel somehow has no orders', () => {
    const out = summariseChannels([row('table_qr', 'dine_in', 0, 0)]);
    expect(out[0].avg_ticket_inr).toBe(0);
  });

  it('returns nothing for an empty mix', () => {
    expect(summariseChannels([])).toEqual([]);
  });
});

describe('bucketDineInHours', () => {
  it('always returns 24 zero-filled slots', () => {
    const out = bucketDineInHours([]);
    expect(out).toHaveLength(24);
    expect(out.every((b, i) => b.hour === i && b.orders === 0)).toBe(true);
  });

  it('buckets UTC timestamps into their IST hour-of-day', () => {
    // 06:30 UTC = 12:00 IST; 20:15 UTC = 01:45 IST (next day, hour 1).
    const out = bucketDineInHours(['2026-07-15T06:30:00Z', '2026-07-15T20:15:00Z']);
    expect(out[12].orders).toBe(1);
    expect(out[1].orders).toBe(1);
  });

  it('accumulates multiple orders in the same IST hour', () => {
    const out = bucketDineInHours([
      '2026-07-15T06:00:00Z', // 11:30 IST
      '2026-07-15T06:29:00Z', // 11:59 IST
    ]);
    expect(out[11].orders).toBe(2); // both land in IST hour 11
  });

  it('skips unparseable timestamps', () => {
    const out = bucketDineInHours(['not-a-date', '2026-07-15T06:30:00Z']);
    expect(out.reduce((a, b) => a + b.orders, 0)).toBe(1);
  });
});
