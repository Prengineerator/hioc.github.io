import { describe, expect, it } from 'vitest';
import { buildTicketDoc } from '@/lib/print/ticketModel';
import { renderEscPos } from '@/lib/print/escpos';
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
    points_redeemed: null,
    points_balance: null,
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

// PRN-7 field report — "+ Normal" under "1 x Espresso (Large)" with no
// indication of what group ("Sugar"?) it belonged to.
describe('buildTicketDoc — addon group names', () => {
  it('prints "+ Group: Option" on the KOT, not just the bare option name', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            addons: [addon({ group_name_snapshot: 'Sugar', option_name_snapshot: 'Normal', price_inr_snapshot: 0 })],
          }),
        ],
      }),
      'kot',
    );
    expect(allText(doc)).toContain('+ Sugar: Normal');
  });

  it('joins several options sharing a group onto one line: "+ Milk: Oat, Extra shot"', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            addons: [
              addon({ id: 'a1', group_name_snapshot: 'Milk', option_name_snapshot: 'Oat', price_inr_snapshot: 0 }),
              addon({
                id: 'a2',
                group_name_snapshot: 'Milk',
                option_name_snapshot: 'Extra shot',
                price_inr_snapshot: 0,
              }),
            ],
          }),
        ],
      }),
      'kot',
    );
    expect(allText(doc)).toContain('+ Milk: Oat, Extra shot');
  });

  it('emits one line per distinct group when an item has addons from multiple groups', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            addons: [
              addon({ id: 'a1', group_name_snapshot: 'Sugar', option_name_snapshot: 'Normal', price_inr_snapshot: 0 }),
              addon({ id: 'a2', group_name_snapshot: 'Milk', option_name_snapshot: 'Oat', price_inr_snapshot: 0 }),
            ],
          }),
        ],
      }),
      'kot',
    );
    const text = allText(doc);
    expect(text).toContain('+ Sugar: Normal');
    expect(text).toContain('+ Milk: Oat');
  });

  it('keeps the KOT money-free even when an addon has a price', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            addons: [
              addon({ group_name_snapshot: 'Extra shot', option_name_snapshot: 'Double', price_inr_snapshot: 30 }),
            ],
          }),
        ],
      }),
      'kot',
    );
    const text = allText(doc);
    expect(text).toContain('+ Extra shot: Double');
    expect(text).not.toContain('Rs.');
    expect(text).not.toContain('30');
  });

  it('shows the addon price on the receipt only when it is > 0: "+ Extra shot: Double (Rs. 30)"', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            addons: [
              addon({ group_name_snapshot: 'Extra shot', option_name_snapshot: 'Double', price_inr_snapshot: 30 }),
            ],
          }),
        ],
      }),
      'receipt',
    );
    expect(allText(doc)).toContain('+ Extra shot: Double (Rs. 30)');
  });

  it('omits the price on the receipt when the addon is free', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            addons: [addon({ group_name_snapshot: 'Sugar', option_name_snapshot: 'Normal', price_inr_snapshot: 0 })],
          }),
        ],
      }),
      'receipt',
    );
    const text = allText(doc);
    expect(text).toContain('+ Sugar: Normal');
    expect(text).not.toContain('+ Sugar: Normal (');
  });
});

// PRN-7 field report — "Paid ? cash" / "Thank you for your order! ? HIOC."
// on real thermal paper, caused by escpos.ts's transliterate() having no
// mapping for '·'. ticketModel.ts's own separators are now plain ASCII so
// the bug can't come back even if transliterate regresses.
describe('buildTicketDoc — no "?"-prone separators', () => {
  it('never uses a middle dot (·) anywhere in the receipt text', () => {
    const doc = buildTicketDoc(order({ payment_status: 'paid', payment_method: 'cash' }), 'receipt');
    expect(allText(doc)).not.toContain('·');
  });

  it('the payment row and closing thank-you line use a plain ASCII separator', () => {
    const doc = buildTicketDoc(order({ payment_status: 'paid', payment_method: 'cash' }), 'receipt');
    const rows = doc.blocks.filter((b): b is Extract<TicketBlock, { kind: 'row' }> => b.kind === 'row');
    expect(rows.find((r) => r.left === 'Payment')?.right).toBe('Paid - cash');
    expect(allText(doc)).toContain('Thank you for your order! - HIOC.');
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

  it('shows a "Points earned" row when present, omits it otherwise', () => {
    const withPoints = buildTicketDoc(order({ points_earned: 5 }), 'receipt');
    const rows = withPoints.blocks.filter((b): b is Extract<TicketBlock, { kind: 'row' }> => b.kind === 'row');
    expect(rows.find((r) => r.left === 'Points earned')?.right).toBe('5');

    const withoutPoints = buildTicketDoc(order({ points_earned: 0 }), 'receipt');
    expect(allText(withoutPoints)).not.toContain('Points earned');

    const nullPoints = buildTicketDoc(order({ points_earned: null }), 'receipt');
    expect(allText(nullPoints)).not.toContain('Points earned');
  });

  it('shows "Points redeemed" only when points were redeemed on this order', () => {
    const withRedeemed = buildTicketDoc(order({ points_redeemed: 40 }), 'receipt');
    const rows = withRedeemed.blocks.filter((b): b is Extract<TicketBlock, { kind: 'row' }> => b.kind === 'row');
    expect(rows.find((r) => r.left === 'Points redeemed')?.right).toBe('40');

    const noneRedeemed = buildTicketDoc(order({ points_redeemed: null }), 'receipt');
    expect(allText(noneRedeemed)).not.toContain('Points redeemed');
  });

  it('shows "Points balance" whenever it is known, even when nothing was earned/redeemed on this order', () => {
    const withBalance = buildTicketDoc(
      order({ points_earned: null, points_redeemed: null, points_balance: 210 }),
      'receipt',
    );
    const rows = withBalance.blocks.filter((b): b is Extract<TicketBlock, { kind: 'row' }> => b.kind === 'row');
    expect(rows.find((r) => r.left === 'Points balance')?.right).toBe('210');

    const noBalance = buildTicketDoc(order({ points_balance: null }), 'receipt');
    expect(allText(noBalance)).not.toContain('Points balance');
  });

  it('shows nothing loyalty-related for a guest order with no linked account', () => {
    const guest = buildTicketDoc(
      order({ points_earned: null, points_redeemed: null, points_balance: null }),
      'receipt',
    );
    expect(allText(guest)).not.toContain('Points earned');
    expect(allText(guest)).not.toContain('Points redeemed');
    expect(allText(guest)).not.toContain('Points balance');
  });

  it('places Points redeemed/earned/balance rows right after Payment, before the closing divider', () => {
    const withAll = buildTicketDoc(
      order({ points_earned: 5, points_redeemed: 40, points_balance: 210 }),
      'receipt',
    );
    const kinds = withAll.blocks.map((b) =>
      b.kind === 'row' ? `row:${b.left}` : b.kind,
    );
    const paymentIdx = kinds.indexOf('row:Payment');
    expect(kinds[paymentIdx + 1]).toBe('row:Points redeemed');
    expect(kinds[paymentIdx + 2]).toBe('row:Points earned');
    expect(kinds[paymentIdx + 3]).toBe('row:Points balance');
    expect(kinds[paymentIdx + 4]).toBe('divider');
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

describe('buildTicketDoc — brand header (logo + "हाईओक" / "HIOC.")', () => {
  it('receipt starts with the brandHeader placeholder block', () => {
    const doc = buildTicketDoc(order(), 'receipt');
    expect(doc.blocks[0]).toEqual({ kind: 'brandHeader' });
  });

  it('token starts with the brandHeader placeholder block', () => {
    const doc = buildTicketDoc(order(), 'token');
    expect(doc.blocks[0]).toEqual({ kind: 'brandHeader' });
  });

  it('the KOT never carries a brandHeader block anywhere', () => {
    const doc = buildTicketDoc(order(), 'kot');
    expect(doc.blocks.some((b) => b.kind === 'brandHeader')).toBe(false);
  });

  it('renders byte-identical to before this feature: a KOT doc still produces zero raster/brandHeader bytes', () => {
    // The KOT builder and renderEscPos's handling of its existing block kinds
    // (text/row/divider/feed/qr) are untouched by this feature — this pins
    // that a real KOT doc never triggers the new raster code path at all.
    const doc = buildTicketDoc(order(), 'kot');
    const bytes = renderEscPos(doc, { paperWidthMm: 80, cut: true });
    const gsV0 = [0x1d, 0x76, 0x30];
    let found = false;
    outer: for (let i = 0; i <= bytes.length - gsV0.length; i++) {
      for (let j = 0; j < gsV0.length; j++) {
        if (bytes[i + j] !== gsV0[j]) continue outer;
      }
      found = true;
      break;
    }
    expect(found).toBe(false);
    expect(bytes[0]).toBe(0x1b); // ESC @ still opens the ticket, unchanged
    expect(bytes[1]).toBe(0x40);
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
