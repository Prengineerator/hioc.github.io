import { describe, expect, it } from 'vitest';
import {
  filterOrdersInWindow,
  mapLegacyOrderForProfile,
  mergeProfileOrders,
  type LegacyProfileOrderRow,
  type ProfileRawOrder,
} from '@/lib/suggest/legacyOrders';

const NOW = new Date('2026-09-24T12:00:00+05:30');

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function legacyRow(over: Partial<LegacyProfileOrderRow> = {}): LegacyProfileOrderRow {
  return {
    status: 'completed',
    ordered_at: NOW.toISOString(),
    total_inr: 150,
    subtotal_inr: 150,
    legacy_order_items: null,
    ...over,
  };
}

function profileRawOrder(over: Partial<ProfileRawOrder> = {}): ProfileRawOrder {
  return {
    status: 'completed',
    created_at: NOW.toISOString(),
    total_inr: 150,
    subtotal_inr: 150,
    order_items: null,
    ...over,
  };
}

describe('mapLegacyOrderForProfile', () => {
  it('maps completed status to completed', () => {
    const row = legacyRow({ status: 'completed' });
    const result = mapLegacyOrderForProfile(row);
    expect(result.status).toBe('completed');
  });

  it('maps cancelled status to cancelled', () => {
    const row = legacyRow({ status: 'cancelled' });
    const result = mapLegacyOrderForProfile(row);
    expect(result.status).toBe('cancelled');
  });

  it('maps unknown status to cancelled', () => {
    const row = legacyRow({ status: 'unknown' as any });
    const result = mapLegacyOrderForProfile(row);
    expect(result.status).toBe('cancelled');
  });

  it('maps ordered_at to created_at', () => {
    const orderedAt = daysAgo(5);
    const row = legacyRow({ ordered_at: orderedAt });
    const result = mapLegacyOrderForProfile(row);
    expect(result.created_at).toBe(orderedAt);
  });

  it('preserves total_inr and subtotal_inr', () => {
    const row = legacyRow({ total_inr: 250, subtotal_inr: 240 });
    const result = mapLegacyOrderForProfile(row);
    expect(result.total_inr).toBe(250);
    expect(result.subtotal_inr).toBe(240);
  });

  it('preserves null total_inr', () => {
    const row = legacyRow({ total_inr: null });
    const result = mapLegacyOrderForProfile(row);
    expect(result.total_inr).toBeNull();
  });

  it('sets quantity to 1 and voided to false for every line', () => {
    const row = legacyRow({
      legacy_order_items: [
        { menu_item_id: 'item1' },
        { menu_item_id: 'item2' },
        { menu_item_id: null },
      ],
    });
    const result = mapLegacyOrderForProfile(row);
    expect(result.order_items).toEqual([
      { menu_item_id: 'item1', quantity: 1, voided: false },
      { menu_item_id: 'item2', quantity: 1, voided: false },
      { menu_item_id: null, quantity: 1, voided: false },
    ]);
  });

  it('keeps menu_item_id: null', () => {
    const row = legacyRow({
      legacy_order_items: [{ menu_item_id: null }],
    });
    const result = mapLegacyOrderForProfile(row);
    expect(result.order_items![0].menu_item_id).toBeNull();
  });

  it('maps null legacy_order_items to empty array', () => {
    const row = legacyRow({ legacy_order_items: null });
    const result = mapLegacyOrderForProfile(row);
    expect(result.order_items).toEqual([]);
  });

  it('maps empty legacy_order_items to empty array', () => {
    const row = legacyRow({ legacy_order_items: [] });
    const result = mapLegacyOrderForProfile(row);
    expect(result.order_items).toEqual([]);
  });
});

describe('filterOrdersInWindow', () => {
  it('includes orders on or after the window start', () => {
    const windowStart = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000).getTime();
    const orders = [
      profileRawOrder({ created_at: daysAgo(89) }),
      profileRawOrder({ created_at: daysAgo(90) }),
      profileRawOrder({ created_at: daysAgo(91) }),
    ];
    const result = filterOrdersInWindow(orders, windowStart);
    expect(result.length).toBe(2);
    expect(result[0]?.created_at).toBe(daysAgo(89));
    expect(result[1]?.created_at).toBe(daysAgo(90));
  });

  it('excludes orders before the window start', () => {
    const windowStart = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).getTime();
    const orders = [
      profileRawOrder({ created_at: daysAgo(3) }),
      profileRawOrder({ created_at: daysAgo(6) }),
    ];
    const result = filterOrdersInWindow(orders, windowStart);
    expect(result.length).toBe(1);
    expect(result[0]?.created_at).toBe(daysAgo(3));
  });

  it('returns empty array when no orders are in window', () => {
    const windowStart = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).getTime();
    const orders = [profileRawOrder({ created_at: daysAgo(10) })];
    const result = filterOrdersInWindow(orders, windowStart);
    expect(result).toEqual([]);
  });

  it('returns all orders when window is very old', () => {
    const windowStart = 0;
    const orders = [
      profileRawOrder({ created_at: daysAgo(90) }),
      profileRawOrder({ created_at: daysAgo(30) }),
      profileRawOrder({ created_at: daysAgo(1) }),
    ];
    const result = filterOrdersInWindow(orders, windowStart);
    expect(result).toEqual(orders);
  });

  it('handles boundary: order exactly at window start', () => {
    const windowStart = new Date(daysAgo(5)).getTime();
    const orders = [profileRawOrder({ created_at: daysAgo(5) })];
    const result = filterOrdersInWindow(orders, windowStart);
    expect(result.length).toBe(1);
  });
});

describe('mergeProfileOrders', () => {
  it('returns orders newest first', () => {
    const appOrders = [
      profileRawOrder({ created_at: daysAgo(5) }),
      profileRawOrder({ created_at: daysAgo(10) }),
    ];
    const legacyOrders = [
      profileRawOrder({ created_at: daysAgo(3) }),
      profileRawOrder({ created_at: daysAgo(7) }),
    ];
    const result = mergeProfileOrders(appOrders, legacyOrders, 100);
    const timestamps = result.map((o) => new Date(o.created_at).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeLessThanOrEqual(timestamps[i - 1]);
    }
  });

  it('merges app and legacy orders interleaved by date', () => {
    const appOrders = [
      profileRawOrder({ created_at: daysAgo(1), total_inr: 100 }),
      profileRawOrder({ created_at: daysAgo(5), total_inr: 200 }),
    ];
    const legacyOrders = [
      profileRawOrder({ created_at: daysAgo(2), total_inr: 300 }),
      profileRawOrder({ created_at: daysAgo(6), total_inr: 400 }),
    ];
    const result = mergeProfileOrders(appOrders, legacyOrders, 100);
    expect(result.length).toBe(4);
    expect(result[0]?.total_inr).toBe(100); // daysAgo(1)
    expect(result[1]?.total_inr).toBe(300); // daysAgo(2)
    expect(result[2]?.total_inr).toBe(200); // daysAgo(5)
    expect(result[3]?.total_inr).toBe(400); // daysAgo(6)
  });

  it('applies cap to the merged list', () => {
    const appOrders = [
      profileRawOrder({ created_at: daysAgo(1) }),
      profileRawOrder({ created_at: daysAgo(3) }),
      profileRawOrder({ created_at: daysAgo(5) }),
    ];
    const legacyOrders = [
      profileRawOrder({ created_at: daysAgo(2) }),
      profileRawOrder({ created_at: daysAgo(4) }),
    ];
    const result = mergeProfileOrders(appOrders, legacyOrders, 3);
    expect(result.length).toBe(3);
    // Newest 3: days 1, 2, 3
    expect(result[0]?.created_at).toBe(daysAgo(1));
    expect(result[1]?.created_at).toBe(daysAgo(2));
    expect(result[2]?.created_at).toBe(daysAgo(3));
  });

  it('respects cap of 0', () => {
    const appOrders = [profileRawOrder({ created_at: daysAgo(1) })];
    const legacyOrders = [profileRawOrder({ created_at: daysAgo(2) })];
    const result = mergeProfileOrders(appOrders, legacyOrders, 0);
    expect(result).toEqual([]);
  });

  it('returns empty when both lists are empty', () => {
    const result = mergeProfileOrders([], [], 100);
    expect(result).toEqual([]);
  });

  it('handles only app orders', () => {
    const appOrders = [
      profileRawOrder({ created_at: daysAgo(1), total_inr: 100 }),
      profileRawOrder({ created_at: daysAgo(2), total_inr: 200 }),
    ];
    const result = mergeProfileOrders(appOrders, [], 100);
    expect(result.length).toBe(2);
    expect(result[0]?.total_inr).toBe(100);
    expect(result[1]?.total_inr).toBe(200);
  });

  it('handles only legacy orders', () => {
    const legacyOrders = [
      profileRawOrder({ created_at: daysAgo(1), total_inr: 100 }),
      profileRawOrder({ created_at: daysAgo(2), total_inr: 200 }),
    ];
    const result = mergeProfileOrders([], legacyOrders, 100);
    expect(result.length).toBe(2);
    expect(result[0]?.total_inr).toBe(100);
    expect(result[1]?.total_inr).toBe(200);
  });

  it('drops oldest orders when cap is reached', () => {
    const appOrders = Array.from({ length: 5 }, (_, i) =>
      profileRawOrder({ created_at: daysAgo(i), total_inr: i })
    );
    const legacyOrders = Array.from({ length: 5 }, (_, i) =>
      profileRawOrder({ created_at: daysAgo(i + 5), total_inr: 100 + i })
    );
    const result = mergeProfileOrders(appOrders, legacyOrders, 7);
    expect(result.length).toBe(7);
    // Should drop orders from day 7 onwards (oldest)
    expect(result.some((o) => new Date(o.created_at).getTime() < new Date(daysAgo(7)).getTime())).toBe(false);
  });
});
