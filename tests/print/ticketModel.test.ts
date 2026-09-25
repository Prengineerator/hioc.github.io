import { describe, expect, it } from 'vitest';
import { buildTicketDoc } from '@/lib/print/ticketModel';
import type { TicketBlock } from '@/lib/print/ticketDoc';
import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';
import type { OrderItemAddon } from '@/lib/types';

// PRN-3 — buildTicketDoc mirrors the exact content of KotTicket / ReceiptTicket
// / TokenSlip (components/print/StaffTickets.tsx) into printer-neutral blocks.
// Pure: no Supabase, no 'server-only' — a hand-built fixture is all this needs.

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
    ...overrides,
  };
}

function textBlocks(doc: { blocks: TicketBlock[] }): Extract<TicketBlock, { kind: 'text' }>[] {
  return doc.blocks.filter((b): b is Extract<TicketBlock, { kind: 'text' }> => b.kind === 'text');
}

function allText(doc: { blocks: TicketBlock[] }): string {
  return doc.blocks
    .map((b) => (b.kind === 'text' ? b.text : b.kind === 'row' ? `${b.left} ${b.right}` : ''))
    .join('\n');
}

describe('buildTicketDoc — kot', () => {
  it('carries no money anywhere on the ticket', () => {
    const doc = buildTicketDoc(order({ items: [item({ line_total_inr: 240 })] }), 'kot');
    expect(allText(doc)).not.toContain('Rs.');
    expect(allText(doc)).not.toContain('₹');
  });

  it('marks a voided line with strike: true, not by dropping it', () => {
    const doc = buildTicketDoc(
      order({ items: [item({ id: 'a', voided: false }), item({ id: 'b', voided: true, name_snapshot: 'Fries' })] }),
      'kot',
    );
    const lines = textBlocks(doc).filter((b) => b.text.includes('Fries'));
    expect(lines).toHaveLength(1);
    expect(lines[0].strike).toBe(true);
    // Not manually appended here — escpos.ts owns the "[VOID] " prefix.
    expect(lines[0].text).not.toContain('[VOID]');
  });

  it('shows the table for a dine-in order, not a token', () => {
    const doc = buildTicketDoc(order({ order_type: 'dine_in', table_label: 'T7' }), 'kot');
    expect(allText(doc)).toContain('Table: T7');
    expect(allText(doc)).not.toMatch(/Token:/);
  });

  it('shows the token for a takeaway order, not a table', () => {
    const doc = buildTicketDoc(
      order({ order_type: 'takeaway', table_label: '', pickup_code: 'A12' }),
      'kot',
    );
    expect(allText(doc)).toContain('Token: A12');
    expect(allText(doc)).not.toMatch(/Table:/);
  });

  it('includes the KITCHEN ORDER header, addons, and order note', () => {
    const doc = buildTicketDoc(
      order({
        notes: 'No onions please',
        items: [item({ addons: [addon()], special_instructions: 'Less sugar' })],
      }),
      'kot',
    );
    const text = allText(doc);
    expect(text).toContain('KITCHEN ORDER');
    expect(text).toContain('Extra cheese');
    expect(text).toContain('Less sugar');
    expect(text).toContain('Order note: No onions please');
  });
});

describe('buildTicketDoc — receipt', () => {
  it('includes subtotal/GST/total and a bold Total row', () => {
    const doc = buildTicketDoc(order({ subtotal_inr: 240, tax_inr: 12, total_inr: 252 }), 'receipt');
    const rows = doc.blocks.filter((b): b is Extract<TicketBlock, { kind: 'row' }> => b.kind === 'row');
    const totalRow = rows.find((r) => r.left === 'Total');
    expect(totalRow).toBeDefined();
    expect(totalRow?.bold).toBe(true);
    expect(totalRow?.right).toBe('Rs. 252');
    expect(rows.find((r) => r.left === 'Subtotal')?.right).toBe('Rs. 240');
    expect(rows.find((r) => r.left === 'GST')?.right).toBe('Rs. 12');
  });

  it('labels the discount with the coupon code when one applied', () => {
    const doc = buildTicketDoc(order({ discount_inr: 20, coupon_code: 'WELCOME10' }), 'receipt');
    const rows = doc.blocks.filter((b): b is Extract<TicketBlock, { kind: 'row' }> => b.kind === 'row');
    const discountRow = rows.find((r) => r.left.startsWith('Discount'));
    expect(discountRow?.left).toBe('Discount (WELCOME10)');
    expect(discountRow?.right).toBe('-Rs. 20');
  });

  it('falls back to a plain "Discount" label with no coupon', () => {
    const doc = buildTicketDoc(order({ discount_inr: 20, coupon_code: null }), 'receipt');
    const rows = doc.blocks.filter((b): b is Extract<TicketBlock, { kind: 'row' }> => b.kind === 'row');
    expect(rows.find((r) => r.left.startsWith('Discount'))?.left).toBe('Discount');
  });

  it('shows loyalty points earned when present, omits the block otherwise', () => {
    const withPoints = buildTicketDoc(order({ points_earned: 5 }), 'receipt');
    expect(allText(withPoints)).toContain('You earned 5 loyalty points');

    const withoutPoints = buildTicketDoc(order({ points_earned: 0 }), 'receipt');
    expect(allText(withoutPoints)).not.toContain('loyalty point');
  });

  it('excludes voided items from the printed lines and totals section', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({ id: 'a', name_snapshot: 'Latte', voided: false }),
          item({ id: 'b', name_snapshot: 'Mocha', voided: true }),
        ],
      }),
      'receipt',
    );
    expect(allText(doc)).toContain('Latte');
    expect(allText(doc)).not.toContain('Mocha');
  });
});

describe('buildTicketDoc — no wasted paper at the top', () => {
  // PRN-3 field report: "huge wastage at top" — guards against a `feed` block
  // or a blank leading line ever being reintroduced at the start of a ticket.
  // (The renderer itself starts every ticket with ESC @ + no feed; this just
  // makes sure the content these docs describe doesn't add one either.)
  it.each(['kot', 'receipt', 'token'] as const)('%s starts with real content, not a feed or a blank line', (type) => {
    const doc = buildTicketDoc(order(), type);
    expect(doc.blocks.length).toBeGreaterThan(0);
    const first = doc.blocks[0];
    expect(first.kind).not.toBe('feed');
    if (first.kind === 'text') {
      expect(first.text.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(['kot', 'receipt', 'token'] as const)('%s never emits a feed block at all', (type) => {
    const doc = buildTicketDoc(order(), type);
    expect(doc.blocks.some((b) => b.kind === 'feed')).toBe(false);
  });
});

describe('buildTicketDoc — token', () => {
  it('shows the token, order number, item count, time, and wait line', () => {
    const doc = buildTicketDoc(
      order({
        order_type: 'takeaway',
        pickup_code: 'B3',
        order_number: 1050,
        items: [item({ quantity: 2 }), item({ id: 'i2', quantity: 1 })],
      }),
      'token',
    );
    const text = allText(doc);
    expect(text).toContain('B3');
    expect(text).toContain('HIOC-001050');
    expect(text).toContain('3 items'); // 2 + 1, non-voided
    expect(text).toContain('Please wait for your token to be called.');
  });
});
