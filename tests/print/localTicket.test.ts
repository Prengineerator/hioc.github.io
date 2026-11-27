import { describe, expect, it } from 'vitest';
import { buildTicketDoc } from '@/lib/print/ticketModel';
import { onlyKotItems, parseKotItemsParam } from '@/lib/print/kotAddition';
import { localPrintOrder, localTicketDoc, ticketOrderFor } from '@/lib/print/localTicket';
import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';
import type { OrderItemAddon } from '@/lib/types';

// The counter builds a placement's tickets from the order the create answer
// carried, instead of asking GET /api/print/ticket. The paper must be exactly
// what that route would have printed, so every case here compares against the
// route's own steps (onlyKotItems on the parsed ?items=, then buildTicketDoc),
// and the order goes through JSON first, the way it arrives.

function addon(overrides: Partial<OrderItemAddon> = {}): OrderItemAddon {
  return {
    id: 'addon-1',
    order_item_id: 'item-1',
    addon_option_id: 'opt-1',
    group_name_snapshot: 'Add-ons',
    option_name_snapshot: 'Extra cheese',
    price_inr_snapshot: 30,
    ...overrides,
  };
}

function item(overrides: Partial<StaffPrintOrder['items'][number]> = {}): StaffPrintOrder['items'][number] {
  return {
    id: 'item-1',
    menu_item_id: 'menu-1',
    variant_id: null,
    name_snapshot: 'Cold Coffee',
    variant_label_snapshot: '',
    price_inr_snapshot: 120,
    quantity: 2,
    line_total_inr: 240,
    special_instructions: '',
    addons: [],
    voided: false,
    void_reason: '',
    voided_by: null,
    voided_at: null,
    ...overrides,
  };
}

function order(overrides: Partial<StaffPrintOrder> = {}): StaffPrintOrder {
  return {
    id: 'order-1',
    order_number: 1042,
    customer_name: 'Aisha Khan',
    customer_phone: '+919000000000',
    customer_email: null,
    pickup_time: '',
    status: 'accepted',
    subtotal_inr: 240,
    notes: '',
    created_at: '2026-09-24T10:30:00.000Z',
    updated_at: '2026-09-24T10:30:00.000Z',
    order_type: 'dine_in',
    promised_ready_at: null,
    pickup_code: null,
    pickup_slot_start: null,
    pickup_slot_label: '',
    tax_inr: 12,
    packaging_inr: 0,
    discount_inr: 0,
    total_inr: 252,
    payment_status: 'paid',
    payment_method: 'cash',
    reject_reason: '',
    version: 1,
    user_id: null,
    channel: 'staff_pos',
    table_id: 'table-1',
    table_label: 'T4',
    created_by: 'staff-1',
    customer_user_id: null,
    items: [item()],
    coupon_code: null,
    points_earned: null,
    points_redeemed: null,
    points_balance: null,
    cashier_name: 'Ayush Garg',
    ...overrides,
  };
}


const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** What the ticket route answers for /api/print/ticket/<id>/<type>?items=<ids>. */
function routeDoc(o: StaffPrintOrder, type: 'kot' | 'receipt' | 'token', items?: string | null) {
  const narrowed = type === 'kot' ? onlyKotItems(o, parseKotItemsParam(items ?? null)) : o;
  return buildTicketDoc(narrowed, type);
}

const overJson = (o: StaffPrintOrder): StaffPrintOrder => JSON.parse(JSON.stringify(o));

describe('localPrintOrder', () => {
  it('prints the first attempt from the carried order', () => {
    const o = order();
    expect(localPrintOrder({ printOrder: o, attempts: 1 })).toBe(o);
  });

  it('asks the server on a retry, so a reprint reflects the order as it is now', () => {
    expect(localPrintOrder({ printOrder: order(), attempts: 2 })).toBeNull();
  });

  it('asks the server when nothing was carried', () => {
    expect(localPrintOrder({ attempts: 1 })).toBeNull();
  });
});

describe('localTicketDoc — the same paper as the ticket route', () => {
  const twoLines = () =>
    overJson(
      order({
        items: [item({ id: A, name_snapshot: 'Cold Coffee' }), item({ id: B, name_snapshot: 'Masala Fries', addons: [addon({ order_item_id: B })] })],
      }),
    );

  it('matches for each ticket type', () => {
    const o = twoLines();
    for (const type of ['kot', 'receipt', 'token'] as const) {
      expect(localTicketDoc(o, type)).toEqual(routeDoc(o, type));
    }
  });

  it('matches an added-items KOT', () => {
    const o = twoLines();
    const doc = localTicketDoc(o, 'kot', [B]);
    expect(doc).toEqual(routeDoc(o, 'kot', B));
    expect(JSON.stringify(doc)).toContain('Masala Fries');
    expect(JSON.stringify(doc)).not.toContain('Cold Coffee');
  });

  it('parses the line ids the way the ?items= query is parsed (junk dropped, whole order when none match)', () => {
    const o = twoLines();
    expect(localTicketDoc(o, 'kot', ['not-a-uuid', A, A])).toEqual(routeDoc(o, 'kot', `not-a-uuid,${A},${A}`));
    expect(localTicketDoc(o, 'kot', ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'])).toEqual(routeDoc(o, 'kot'));
  });

  it('ignores line ids on a receipt, as the route does', () => {
    const o = twoLines();
    expect(localTicketDoc(o, 'receipt', [A])).toEqual(routeDoc(o, 'receipt'));
  });
});

describe('ticketOrderFor — a pass sale', () => {
  const sale = () => order({ order_kind: 'coffee_pass' } as Partial<StaffPrintOrder>);

  it('refuses a kitchen ticket or a pickup token: a payment, not food', () => {
    expect(() => ticketOrderFor(sale(), 'kot')).toThrow(/no kitchen ticket/);
    expect(() => ticketOrderFor(sale(), 'token')).toThrow(/no kitchen ticket/);
  });

  it('prints its receipt', () => {
    expect(() => localTicketDoc(sale(), 'receipt')).not.toThrow();
  });
});
