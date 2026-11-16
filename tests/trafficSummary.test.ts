import { describe, expect, it } from 'vitest';
import {
  conversionRate,
  istDay,
  parseTrafficRange,
  summarizeTraffic,
  trafficRange,
  type TrafficEventRow,
} from '@/lib/traffic/summary';

// Owner → Traffic arithmetic (lib/traffic/summary.ts).

function row(over: Partial<TrafficEventRow>): TrafficEventRow {
  return {
    created_at: '2026-11-10T06:00:00.000Z',
    event: 'view',
    session_id: 'sess-aaaaaaaa',
    page_group: 'orders',
    route: '/menu',
    landing: false,
    source: 'direct',
    referrer_host: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    device: 'mobile',
    country: 'IN',
    city: 'Agra',
    order_id: null,
    shop_order_id: null,
    value_inr: null,
    ...over,
  };
}

const RANGE = { sinceDay: '2026-11-04', untilDay: '2026-11-10', days: 7 };

describe('ranges and days', () => {
  it('reads 7, 30 or 90 days and falls back to 30', () => {
    expect(parseTrafficRange('7')).toBe(7);
    expect(parseTrafficRange('90')).toBe(90);
    expect(parseTrafficRange('365')).toBe(30);
    expect(parseTrafficRange(undefined)).toBe(30);
    expect(parseTrafficRange(['7'])).toBe(7);
  });

  it('counts days in India: 20:00 UTC is already the next day', () => {
    expect(istDay('2026-11-10T18:29:00Z')).toBe('2026-11-10');
    expect(istDay('2026-11-10T18:31:00Z')).toBe('2026-11-11');
  });

  it('covers the last N days in India, today included, from Indian midnight', () => {
    const r = trafficRange(7, new Date('2026-11-16T20:00:00Z')); // 01:30 on the 17th in India
    expect(r).toEqual({ sinceDay: '2026-11-11', untilDay: '2026-11-17', sinceIso: '2026-11-10T18:30:00.000Z', days: 7 });
  });

  it('gives a conversion rate only when there were visits', () => {
    expect(conversionRate(1, 4)).toBe(0.25);
    expect(conversionRate(0, 0)).toBeNull();
  });
});

describe('summarizeTraffic', () => {
  const rows: TrafficEventRow[] = [
    // Visit A: Instagram (tagged), lands on /shop, then menu, then a paid shop order.
    row({ session_id: 'A-aaaaaaaa', page_group: 'shop', route: '/shop', landing: true, source: 'instagram', referrer_host: 'l.instagram.com', utm_source: 'instagram', utm_medium: 'bio', created_at: '2026-11-09T05:00:00Z' }),
    row({ session_id: 'A-aaaaaaaa', page_group: 'orders', route: '/menu', source: 'instagram', referrer_host: 'l.instagram.com', utm_source: 'instagram', utm_medium: 'bio', created_at: '2026-11-09T05:01:00Z' }),
    row({ session_id: 'A-aaaaaaaa', event: 'shop_order', page_group: 'shop', route: '/shop', source: 'instagram', referrer_host: 'l.instagram.com', utm_source: 'instagram', utm_medium: 'bio', shop_order_id: 'shop-1', value_inr: 599, created_at: '2026-11-09T05:05:00Z' }),
    // Visit B: Google, menu → checkout → an order that went through.
    row({ session_id: 'B-bbbbbbbb', route: '/menu', landing: true, source: 'google', referrer_host: 'google.com', device: 'desktop', created_at: '2026-11-10T07:00:00Z' }),
    row({ session_id: 'B-bbbbbbbb', route: '/checkout', source: 'google', referrer_host: 'google.com', device: 'desktop', created_at: '2026-11-10T07:03:00Z' }),
    row({ session_id: 'B-bbbbbbbb', event: 'order', route: '/checkout', source: 'google', referrer_host: 'google.com', order_id: 'ord-1', value_inr: 320, created_at: '2026-11-10T07:04:00Z' }),
    // The same order recorded twice (a retried request) counts once.
    row({ session_id: 'B-bbbbbbbb', event: 'order', route: '/checkout', source: 'google', referrer_host: 'google.com', order_id: 'ord-1', value_inr: 320, created_at: '2026-11-10T07:04:01Z' }),
    // Visit C: direct, an order that was never paid (not counted), and an unpaid shop order.
    row({ session_id: 'C-cccccccc', route: '/order/[id]/receipt', landing: true, city: 'Delhi', created_at: '2026-11-10T08:00:00Z' }),
    row({ session_id: 'C-cccccccc', event: 'order', route: '/checkout', order_id: 'ord-unpaid', value_inr: 200, created_at: '2026-11-10T08:05:00Z' }),
    row({ session_id: 'C-cccccccc', event: 'shop_order', page_group: 'shop', route: '/shop', shop_order_id: 'shop-unpaid', value_inr: 399, created_at: '2026-11-10T08:06:00Z' }),
  ];
  const s = summarizeTraffic({
    rows: [...rows].reverse(), // order of arrival must not matter
    counted: { orderIds: new Set(['ord-1']), shopOrderIds: new Set(['shop-1']) },
    range: RANGE,
  });

  it('counts visits, page views and each group', () => {
    expect(s.visits).toBe(3);
    expect(s.orderingVisits).toBe(3); // A also opened the menu
    expect(s.shopVisits).toBe(2); // A, and C's shop checkout
    expect(s.pageViews).toBe(5);
    expect(s.firstAt).toBe('2026-11-09T05:00:00Z');
  });

  it('counts only orders that went through, once each, with their value', () => {
    expect(s.orders).toBe(1);
    expect(s.orderValue).toBe(320);
    expect(s.shopOrders).toBe(1);
    expect(s.shopValue).toBe(599);
  });

  it('credits each visit and its orders to the visit’s source', () => {
    expect(s.sources.map((r) => [r.source, r.visits, r.orders, r.shopOrders])).toEqual([
      ['instagram', 1, 0, 1],
      ['google', 1, 1, 0],
      ['direct', 1, 0, 0],
    ]);
    expect(s.sources.find((r) => r.source === 'instagram')).toMatchObject({ label: 'Instagram', orderingVisits: 1, shopVisits: 1 });
  });

  it('lists tagged links as campaigns and linking sites as referrers', () => {
    expect(s.campaigns).toEqual([
      expect.objectContaining({ utmSource: 'instagram', utmMedium: 'bio', utmCampaign: null, visits: 1, shopOrders: 1, shopValue: 599 }),
    ]);
    expect(s.referrers).toEqual([
      { host: 'l.instagram.com', source: 'instagram', visits: 1 },
      { host: 'google.com', source: 'google', visits: 1 },
    ]);
  });

  it('counts pages by views, visits and landings', () => {
    expect(s.pages.find((p) => p.route === '/menu')).toEqual({ route: '/menu', label: 'Menu', group: 'orders', views: 2, visits: 2, landings: 1 });
    expect(s.pages.find((p) => p.route === '/order/[id]/receipt')).toMatchObject({ label: 'Digital bill', landings: 1 });
  });

  it('fills every day of the range, quiet days as zero', () => {
    expect(s.daily).toHaveLength(7);
    expect(s.daily[0]).toEqual({ day: '2026-11-04', orderingVisits: 0, shopVisits: 0 });
    expect(s.daily.find((d) => d.day === '2026-11-09')).toEqual({ day: '2026-11-09', orderingVisits: 1, shopVisits: 1 });
    expect(s.daily.find((d) => d.day === '2026-11-10')).toEqual({ day: '2026-11-10', orderingVisits: 2, shopVisits: 1 });
  });

  it('counts devices and places by visit', () => {
    expect(s.devices).toEqual([
      { device: 'mobile', visits: 2 },
      { device: 'desktop', visits: 1 },
    ]);
    expect(s.places[0]).toEqual({ country: 'IN', city: 'Agra', visits: 2 });
  });

  it('is empty but complete with no rows', () => {
    const empty = summarizeTraffic({ rows: [], counted: { orderIds: new Set(), shopOrderIds: new Set() }, range: RANGE });
    expect(empty).toMatchObject({ visits: 0, pageViews: 0, orders: 0, sources: [], campaigns: [], firstAt: null });
    expect(empty.daily).toHaveLength(7);
  });
});
