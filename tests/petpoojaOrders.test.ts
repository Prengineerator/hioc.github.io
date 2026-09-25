import { describe, expect, it } from 'vitest';
import { dedupeOrders, parseOrderSheet } from '@/lib/petpooja/orders';
import type { MenuSnapshotItem, ParsedLegacyOrder } from '@/lib/petpooja/types';

// All names/phones below are invented (PII rule: never real customer data).
const menu: MenuSnapshotItem[] = [
  { id: 'm-cupcake', name: 'Choco Chip Cupcake', variants: [{ id: 'v-reg', label: 'Regular' }] },
  { id: 'm-garlic', name: 'Garlic Bread Toast', variants: [{ id: 'v-reg2', label: 'Regular' }] },
  {
    id: 'm-tripple',
    name: 'Tripple Choco',
    variants: [
      { id: 'v-b', label: 'B' },
      { id: 'v-l', label: 'L' },
    ],
  },
];

const TITLE_BLOCK: unknown[][] = [
  ['Name:', 'Order Report', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  ['Restaurant Name:', 'Test Cafe', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  ['Restaurant Address:', 'Test Address, Test City', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  new Array(23).fill(null),
];

const HEADER_ROW: unknown[] = [
  'Order No.', 'Client OrderID', 'Order Type', 'Sub Order Type', 'Customer Name', 'Customer Phone',
  'GSTIN', 'Customer Address', 'Delivery Boy', 'Delivery Boy Number', 'Items', 'My Amount (₹)',
  'Total Discount (₹)', 'Delivery Charge (₹)', 'Container Charge (₹)', 'Total Tax (₹)', 'Round Off (₹)',
  'Grand Total (₹)', 'Payment Type', 'Payment Description', 'Status', 'Created', 'Sequence Name',
];

// A normal Pick Up bill, paid in full by Cash.
const NORMAL_BILL: unknown[] = [
  101, null, 'Pick Up', 'Pick Up', 'Test Customer', 9876500001, null, null, null, null,
  'Choco Chip Cupcake, Garlic Bread', 200.0, 0.0, 0.0, 0.0, 10.0, 0.0, 210.0,
  'Cash', null, 'Printed', '15 Jul 2025 12:00:00', null,
];

// A cancelled Zomato delivery bill — no customer phone, has a Client OrderID.
const CANCELLED_ZOMATO_BILL: unknown[] = [
  102, 5551112222, 'Delivery', 'Zomato', 'Test Customer Two', null, null, 'Test Address, Agra India',
  null, null, 'Tripple Choco Waffle [n] (B)', 150.0, 0.0, 0.0, 20.0, 0.0, 0.0, 170.0,
  'Online', null, 'Cancelled', '16 Jul 2025 19:10:01', null,
];

// A Dine In (table 2) bill.
const DINE_IN_BILL: unknown[] = [
  103, null, 'Dine In (2)', 'Dine In', 'Test Customer Three', 9876500003, null, null, null, null,
  'Choco Chip Cupcake', 100.0, 0.0, 0.0, 0.0, 5.0, 0.0, 105.0,
  'Cash', null, 'Printed', '17 Jul 2025 20:00:00', null,
];

// A part-payment bill: parent row (Grand Total 0, Payment Description carries
// the real total) followed by 2 continuation rows, one per part payment.
const PART_PAYMENT_PARENT: unknown[] = [
  104, null, 'Delivery', 'Delivery', 'Test Customer Four', 9876500004, null, null, null, null,
  'Choco Chip Cupcake, Garlic Bread', 960.0, 0.0, 0.0, 0.0, 47.0, 0.0, 0.0,
  'Part Payment', 'Total : 1007.00', 'Printed', '18 Jul 2025 23:48:15', null,
];
const PART_PAYMENT_CONT_1: unknown[] = [
  104, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  31, 'Other [UPI]', null, null, null, null,
];
const PART_PAYMENT_CONT_2: unknown[] = [
  104, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  976, 'Cash', null, null, null, null,
];

function sheet(): unknown[][] {
  return [
    ...TITLE_BLOCK,
    HEADER_ROW,
    NORMAL_BILL,
    CANCELLED_ZOMATO_BILL,
    DINE_IN_BILL,
    PART_PAYMENT_PARENT,
    PART_PAYMENT_CONT_1,
    PART_PAYMENT_CONT_2,
  ];
}

describe('parseOrderSheet', () => {
  it('finds the header row past the title block and parses every bill', () => {
    const { orders } = parseOrderSheet(sheet(), menu);
    expect(orders).toHaveLength(4);
    expect(orders.map((o) => o.bill_no)).toEqual(['101', '102', '103', '104']);
  });

  it('parses a normal bill: phone, items, payments, fiscal year, channel', () => {
    const { orders } = parseOrderSheet(sheet(), menu);
    const o = orders[0];
    expect(o.customer_phone).toBe('+919876500001');
    expect(o.channel).toBe('counter');
    expect(o.status).toBe('completed');
    expect(o.total_inr).toBe(210);
    expect(o.payments).toEqual([{ method: 'Cash', amount_inr: 210 }]);
    expect(o.fiscal_year).toBe('2025-26');
    expect(o.items).toHaveLength(2);
    expect(o.items[0]).toMatchObject({ item_name: 'Choco Chip Cupcake', matched_menu_name: 'Choco Chip Cupcake' });
    expect(o.items[1]).toMatchObject({ item_name: 'Garlic Bread', matched_menu_name: 'Garlic Bread Toast' });
  });

  it('parses a cancelled Zomato bill with no phone', () => {
    const { orders } = parseOrderSheet(sheet(), menu);
    const o = orders[1];
    expect(o.channel).toBe('zomato');
    expect(o.status).toBe('cancelled');
    expect(o.customer_phone).toBeNull();
    expect(o.customer_phone_raw).toBe('');
    expect(o.client_order_id).toBe('5551112222');
    expect(o.items[0]).toMatchObject({ item_name: 'Tripple Choco Waffle', variant_label: 'B', matched_menu_name: 'Tripple Choco' });
  });

  it('parses a Dine In bill and extracts the table label', () => {
    const { orders } = parseOrderSheet(sheet(), menu);
    const o = orders[2];
    expect(o.channel).toBe('dine_in');
    expect(o.table_label).toBe('2');
  });

  it('resolves a part-payment bill: payments from the continuation rows, total from the description', () => {
    const { orders } = parseOrderSheet(sheet(), menu);
    const o = orders[3];
    expect(o.payment_type).toBe('Part Payment');
    expect(o.payments).toEqual([
      { method: 'Other [UPI]', amount_inr: 31 },
      { method: 'Cash', amount_inr: 976 },
    ]);
    expect(o.total_inr).toBe(1007);
  });

  it('falls back to summing the parts when the description has no parseable total', () => {
    const rows = [
      ...TITLE_BLOCK,
      HEADER_ROW,
      [
        105, null, 'Pick Up', 'Menu QR Code', 'Test Customer Five', 9876500005, null, null, null, null,
        'Choco Chip Cupcake', 50.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        'Menu QR Code [Part Payment]', '', 'Printed', '19 Jul 2025 10:00:00', null,
      ],
      [105, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 20, 'Cash', null, null, null, null],
      [105, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 30, 'Other [UPI]', null, null, null, null],
    ];
    const { orders } = parseOrderSheet(rows, menu);
    expect(orders[0].total_inr).toBe(50);
    expect(orders[0].channel).toBe('qr');
  });

  it('counts an orphaned continuation row instead of crashing', () => {
    const rows = [
      ...TITLE_BLOCK,
      HEADER_ROW,
      [106, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 20, 'Cash', null, null, null, null],
    ];
    const { orders, skipped } = parseOrderSheet(rows, menu);
    expect(orders).toHaveLength(0);
    expect(skipped.find((s) => s.reason === 'orphan_continuation_row')?.count).toBe(1);
  });
});

describe('dedupeOrders', () => {
  function order(bill_no: string, ordered_at: string): ParsedLegacyOrder {
    return {
      source: 'petpooja', bill_no, fiscal_year: '2025-26', ordered_at,
      client_order_id: null, order_type: 'Pick Up', sub_order_type: 'Pick Up', channel: 'counter',
      table_label: '', customer_name: '', customer_phone: null, customer_phone_raw: '',
      customer_address: '', customer_gstin: '', items_text: '', subtotal_inr: 0, discount_inr: 0,
      delivery_charge_inr: 0, container_charge_inr: 0, tax_inr: 0, round_off_inr: 0, total_inr: 0,
      payment_type: '', payments: [], status: 'completed', raw: {}, items: [],
    };
  }

  it('keeps the first occurrence and counts the rest as duplicates', () => {
    const a = order('101', '2025-07-15T12:00:00+05:30');
    const b = order('101', '2025-07-15T12:00:00+05:30'); // same bill_no + ordered_at, from an overlapping file
    const c = order('102', '2025-07-16T12:00:00+05:30');
    const { orders, duplicates } = dedupeOrders([a, b, c]);
    expect(orders).toHaveLength(2);
    expect(orders[0]).toBe(a);
    expect(duplicates).toBe(1);
  });

  it('treats the same bill_no at a different timestamp as distinct (FY reset)', () => {
    const a = order('1', '2025-04-01T10:00:00+05:30');
    const b = order('1', '2026-04-01T10:00:00+05:30'); // new fiscal year, Order No. reset to 1
    const { orders, duplicates } = dedupeOrders([a, b]);
    expect(orders).toHaveLength(2);
    expect(duplicates).toBe(0);
  });
});
