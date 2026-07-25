import { describe, expect, it } from 'vitest';
import {
  groupTablesByZone,
  isOpenDineInOrder,
  openDineInOrdersByTable,
  orderItemCount,
  type OrderWithItems,
  type StaffTable,
} from '@/lib/staff/tableOccupancy';
import type { OrderItem, OrderStatus, OrderType } from '@/lib/types';

// POS-3 tables-board occupancy logic. These lock in the rules the board renders:
// which orders make a table "occupied", grouping several open orders per table
// (counter model D2), item counts excluding voided lines, and zone grouping.

function makeItem(over: Partial<OrderItem> = {}): OrderItem {
  return {
    id: over.id ?? 'item-1',
    order_id: 'o1',
    menu_item_id: 'm1',
    variant_id: 'v1',
    name_snapshot: 'Latte',
    variant_label_snapshot: 'Regular',
    price_inr_snapshot: 200,
    quantity: 1,
    line_total_inr: 200,
    special_instructions: '',
    addons: [],
    voided: false,
    void_reason: '',
    voided_by: null,
    voided_at: null,
    ...over,
  };
}

let seq = 0;
function makeOrder(over: {
  id?: string;
  status?: OrderStatus;
  order_type?: OrderType;
  table_id?: string | null;
  created_at?: string;
  total_inr?: number | null;
  items?: OrderItem[];
}): OrderWithItems {
  seq += 1;
  return {
    id: over.id ?? `o${seq}`,
    order_number: 1000 + seq,
    customer_name: '',
    customer_phone: '',
    customer_email: null,
    pickup_time: '',
    status: over.status ?? 'accepted',
    subtotal_inr: 200,
    notes: '',
    created_at: over.created_at ?? '2026-07-25T10:00:00.000Z',
    updated_at: '2026-07-25T10:00:00.000Z',
    order_type: over.order_type ?? 'dine_in',
    promised_ready_at: null,
    pickup_code: null,
    pickup_slot_start: null,
    pickup_slot_label: '',
    tax_inr: 0,
    packaging_inr: 0,
    discount_inr: 0,
    total_inr: over.total_inr === undefined ? 236 : over.total_inr,
    payment_status: 'unpaid',
    payment_method: null,
    reject_reason: '',
    version: 1,
    user_id: null,
    channel: 'staff_pos',
    table_id: over.table_id === undefined ? 't1' : over.table_id,
    table_label: 'T1',
    created_by: 'staff-1',
    items: over.items ?? [makeItem()],
  };
}

function makeTable(over: Partial<StaffTable> & { id: string; label: string }): StaffTable {
  return {
    zone: '',
    capacity: 4,
    is_active: true,
    sort_order: 0,
    ...over,
  };
}

describe('isOpenDineInOrder', () => {
  it('treats accepted/preparing/ready dine-in with a table as open', () => {
    for (const status of ['accepted', 'preparing', 'ready'] as OrderStatus[]) {
      expect(isOpenDineInOrder(makeOrder({ status }))).toBe(true);
    }
  });

  it('excludes completed/cancelled/rejected orders', () => {
    for (const status of ['completed', 'cancelled', 'rejected'] as OrderStatus[]) {
      expect(isOpenDineInOrder(makeOrder({ status }))).toBe(false);
    }
  });

  it('excludes takeaway orders and orders without a table', () => {
    expect(isOpenDineInOrder(makeOrder({ order_type: 'takeaway', table_id: null }))).toBe(false);
    expect(isOpenDineInOrder(makeOrder({ table_id: null }))).toBe(false);
  });
});

describe('orderItemCount', () => {
  it('sums quantities and excludes voided lines', () => {
    const order = makeOrder({
      items: [
        makeItem({ id: 'a', quantity: 2 }),
        makeItem({ id: 'b', quantity: 3, voided: true }),
        makeItem({ id: 'c', quantity: 1 }),
      ],
    });
    expect(orderItemCount(order)).toBe(3);
  });
});

describe('openDineInOrdersByTable', () => {
  it('groups several open orders on one table, newest-first (counter model D2)', () => {
    const older = makeOrder({ id: 'old', table_id: 't1', created_at: '2026-07-25T09:00:00.000Z' });
    const newer = makeOrder({ id: 'new', table_id: 't1', created_at: '2026-07-25T11:00:00.000Z' });
    const otherTable = makeOrder({ id: 'x', table_id: 't2' });
    const closed = makeOrder({ id: 'done', table_id: 't1', status: 'completed' });

    const byTable = openDineInOrdersByTable([older, newer, otherTable, closed]);
    expect(byTable.get('t1')?.map((o) => o.id)).toEqual(['new', 'old']);
    expect(byTable.get('t2')?.map((o) => o.id)).toEqual(['x']);
  });
});

describe('groupTablesByZone', () => {
  it('marks free vs occupied and attaches open orders to the right table', () => {
    const tables = [
      makeTable({ id: 't1', label: 'T1', zone: 'Terrace', sort_order: 0 }),
      makeTable({ id: 't2', label: 'T2', zone: 'Terrace', sort_order: 1 }),
    ];
    const orders = [makeOrder({ id: 'o-t1', table_id: 't1' })];

    const zones = groupTablesByZone(tables, orders);
    expect(zones).toHaveLength(1);
    const [terrace] = zones;
    expect(terrace.zone).toBe('Terrace');
    expect(terrace.tables[0].orders).toHaveLength(1); // T1 occupied
    expect(terrace.tables[1].orders).toHaveLength(0); // T2 free
  });

  it('orders zones by first table and pushes the unzoned group last', () => {
    const tables = [
      makeTable({ id: 't3', label: 'T3', zone: '', sort_order: 0 }),
      makeTable({ id: 't1', label: 'T1', zone: 'Terrace', sort_order: 1 }),
      makeTable({ id: 't2', label: 'T2', zone: 'Indoor', sort_order: 2 }),
    ];
    const zones = groupTablesByZone(tables, []);
    expect(zones.map((z) => z.zone)).toEqual(['Terrace', 'Indoor', '']);
  });

  it('sorts tables within a zone by sort_order then label', () => {
    const tables = [
      makeTable({ id: 'b', label: 'T-B', zone: 'Main', sort_order: 5 }),
      makeTable({ id: 'a', label: 'T-A', zone: 'Main', sort_order: 5 }),
      makeTable({ id: 'c', label: 'T-C', zone: 'Main', sort_order: 1 }),
    ];
    const zones = groupTablesByZone(tables, []);
    expect(zones[0].tables.map((t) => t.table.label)).toEqual(['T-C', 'T-A', 'T-B']);
  });
});
