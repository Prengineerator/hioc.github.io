import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// HIOC Ritual on the HTML receipt (components/print/StaffTickets.tsx
// ReceiptTicket). It mirrors buildReceiptBlocks (lib/print/ticketModel.ts) row
// for row — the pass cover after Discount, "(Ritual ×N)" under a covered line,
// "Valid till …" under a pass sale — so the on-screen ticket and the ESC/POS
// print cannot disagree. There is no DOM in this suite, so this server-renders
// the ticket; the ticket is a pure Server Component with no effects.

import { ReceiptTicket } from '@/components/print/StaffTickets';
import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';

function line(overrides: Partial<StaffPrintOrder['items'][number]> = {}): StaffPrintOrder['items'][number] {
  return {
    id: 'item-1',
    menu_item_id: 'menu-1',
    variant_id: null,
    name_snapshot: 'Cappuccino',
    variant_label_snapshot: 'L',
    price_inr_snapshot: 120,
    quantity: 1,
    line_total_inr: 120,
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
    status: 'completed',
    subtotal_inr: 120,
    notes: '',
    created_at: '2026-09-28T04:30:00.000Z',
    updated_at: '2026-09-28T04:30:00.000Z',
    order_type: 'takeaway',
    promised_ready_at: null,
    pickup_code: null,
    pickup_slot_start: null,
    pickup_slot_label: '',
    tax_inr: 0,
    packaging_inr: 0,
    discount_inr: 0,
    total_inr: 0,
    payment_status: 'paid',
    payment_method: 'cash',
    reject_reason: '',
    version: 1,
    user_id: null,
    channel: 'staff_pos',
    table_id: null,
    table_label: '',
    created_by: 'staff-1',
    customer_user_id: null,
    items: [line()],
    coupon_code: null,
    points_earned: null,
    points_redeemed: null,
    points_balance: null,
    cashier_name: 'Ayush Garg',
    ...overrides,
  };
}

const html = (o: StaffPrintOrder) => renderToStaticMarkup(createElement(ReceiptTicket, { order: o }));
// The rendered text with the tags stripped, so a label and its figure can be read together.
const text = (o: StaffPrintOrder) => html(o).replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

describe('ReceiptTicket — HIOC Ritual', () => {
  it('prints the cups’ cover as its own row, in parentheses, after Discount and before GST', () => {
    const out = text(
      order({
        subtotal_inr: 335,
        tax_inr: 3,
        total_inr: 48,
        discount_inr: 20,
        coupon_code: 'WELCOME10',
        pass_discount_inr: 270,
        items: [
          line({ id: 'a', name_snapshot: 'Lotus Biscoff Latte', variant_label_snapshot: 'XL', line_total_inr: 215, price_inr_snapshot: 215, pass_drinks: 1, pass_covered_inr: 150 }),
          line({ id: 'b', pass_drinks: 1, pass_covered_inr: 120 }),
        ],
      }),
    );
    expect(out).toContain('HIOC Ritual (2 cups)|(₹270.00)');
    expect(out.indexOf('Discount (WELCOME10)')).toBeLessThan(out.indexOf('HIOC Ritual (2 cups)'));
    // '|GST|' is the totals row (the header's "GST No-…" line is not).
    expect(out.indexOf('HIOC Ritual (2 cups)')).toBeLessThan(out.indexOf('|GST|'));
  });

  it('marks a covered line "(Ritual ×N)" and leaves the others alone', () => {
    const out = html(
      order({
        pass_discount_inr: 240,
        subtotal_inr: 540,
        total_inr: 315,
        tax_inr: 15,
        items: [
          line({ id: 'a', quantity: 3, line_total_inr: 360, pass_drinks: 2, pass_covered_inr: 240 }),
          line({ id: 'b', name_snapshot: 'Sandwich', variant_label_snapshot: '', price_inr_snapshot: 180, line_total_inr: 180 }),
        ],
      }),
    );
    expect(out.match(/\(Ritual ×2\)/g)).toHaveLength(1);
    expect(out).not.toContain('Ritual ×0');
  });

  it('says "Valid till" under the pass on a pass sale', () => {
    const out = html(
      order({
        order_kind: 'coffee_pass',
        subtotal_inr: 750,
        tax_inr: 38,
        total_inr: 788,
        items: [
          line({ menu_item_id: null, name_snapshot: 'Weekly Ritual', variant_label_snapshot: '7 cups · 7 days', price_inr_snapshot: 750, line_total_inr: 750 }),
        ],
        pass_sale: { expires_at: '2026-10-04T18:30:00.000Z', drinks_total: 7 },
      }),
    );
    expect(out).toContain('Valid till Sun 4 Oct 2026');
    expect(out).toContain('Weekly Ritual');
  });

  it('prints none of it for an ordinary order', () => {
    const out = html(order({ subtotal_inr: 120, tax_inr: 6, total_inr: 126 }));
    expect(out).not.toContain('HIOC Ritual');
    expect(out).not.toContain('Ritual ×');
    expect(out).not.toContain('Valid till');
  });

  it('leaves "Valid till" off a sale whose pass is not known yet', () => {
    const out = html(order({ order_kind: 'coffee_pass', pass_sale: null }));
    expect(out).not.toContain('Valid till');
  });
});
