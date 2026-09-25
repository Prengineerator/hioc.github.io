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
    cashier_name: 'Ayush Garg',
    ...overrides,
  };
}

function textBlocks(doc: { blocks: TicketBlock[] }): Extract<TicketBlock, { kind: 'text' }>[] {
  return doc.blocks.filter((b): b is Extract<TicketBlock, { kind: 'text' }> => b.kind === 'text');
}

function rowBlocks(doc: { blocks: TicketBlock[] }): Extract<TicketBlock, { kind: 'row' }>[] {
  return doc.blocks.filter((b): b is Extract<TicketBlock, { kind: 'row' }> => b.kind === 'row');
}

function columnsBlocks(doc: { blocks: TicketBlock[] }): Extract<TicketBlock, { kind: 'columns' }>[] {
  return doc.blocks.filter((b): b is Extract<TicketBlock, { kind: 'columns' }> => b.kind === 'columns');
}

function allText(doc: { blocks: TicketBlock[] }): string {
  return doc.blocks
    .map((b) => {
      if (b.kind === 'text') return b.text;
      if (b.kind === 'row') return `${b.left} ${b.right}`;
      if (b.kind === 'columns') return b.columns.map((c) => c.text).join(' ');
      return '';
    })
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

  it('shows a priced addon on the receipt as "Group: Option - QtyxUnit = Total", no leading "+ "', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            quantity: 1,
            addons: [
              addon({ group_name_snapshot: 'Choose Milk', option_name_snapshot: 'Almond', price_inr_snapshot: 40 }),
            ],
          }),
        ],
      }),
      'receipt',
    );
    const text = allText(doc);
    expect(text).toContain('Choose Milk: Almond - 1x40 = 40');
    expect(text).not.toContain('+ Choose Milk');
  });

  it('multiplies the addon unit price by the ITEM quantity, not always 1, and keeps 2 decimals only when there is paise', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            quantity: 2,
            addons: [
              addon({ group_name_snapshot: 'Milk', option_name_snapshot: 'Oat', price_inr_snapshot: 16.5 }),
            ],
          }),
        ],
      }),
      'receipt',
    );
    // 2 x 16.50 = 33 — the per-unit price keeps its paise, the whole total doesn't need to.
    expect(allText(doc)).toContain('Milk: Oat - 2x16.50 = 33');
  });

  it('gives each priced option in a group its own line rather than joining them onto one', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            quantity: 2,
            addons: [
              addon({ id: 'a1', group_name_snapshot: 'Milk', option_name_snapshot: 'Oat', price_inr_snapshot: 30 }),
              addon({
                id: 'a2',
                group_name_snapshot: 'Milk',
                option_name_snapshot: 'Extra shot',
                price_inr_snapshot: 20,
              }),
            ],
          }),
        ],
      }),
      'receipt',
    );
    const text = allText(doc);
    expect(text).toContain('Milk: Oat - 2x30 = 60');
    expect(text).toContain('Milk: Extra shot - 2x20 = 40');
  });

  it('omits the math for a free addon on the receipt — a plain comma-joined line, no leading "+ "', () => {
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
    expect(text).toContain('Sugar: Normal');
    expect(text).not.toContain('+ Sugar: Normal');
    expect(text).not.toContain('Sugar: Normal -');
  });
});

describe('buildTicketDoc — no "?"-prone separators', () => {
  it('never uses a middle dot (·) anywhere in the receipt text', () => {
    const doc = buildTicketDoc(order({ payment_status: 'paid', payment_method: 'cash' }), 'receipt');
    expect(allText(doc)).not.toContain('·');
  });

  it('"Paid via <method>" and the footer tagline use plain ASCII, no separators at all', () => {
    const doc = buildTicketDoc(order({ payment_status: 'paid', payment_method: 'cash' }), 'receipt');
    expect(allText(doc)).toContain('Paid via Cash');
    expect(allText(doc)).toContain('Love to get you high on Coffee!');
    expect(allText(doc)).toContain('Please Visit Again!');
  });
});

describe('buildTicketDoc — receipt header (PRN header redesign)', () => {
  it('opens with the brand header, the payment-status banner, "RETAIL INVOICE", the legal name, address, phone, and GST No.', () => {
    const doc = buildTicketDoc(order({ payment_status: 'paid' }), 'receipt');
    expect(doc.blocks[0]).toEqual({ kind: 'brandHeader' });
    const text = allText(doc);
    expect(text).toContain('PAID');
    expect(text).toContain('RETAIL INVOICE');
    expect(text).toContain('Arry Foods');
    expect(text).toContain('Phone No-');
    expect(text).toContain('GST No-09AGJPA9390E1Z9');
  });

  it.each([
    ['paid', 'PAID'],
    ['unpaid', 'UNPAID'],
    ['payment_pending', 'PAYMENT PENDING'],
    ['refunded', 'REFUNDED'],
    ['partially_refunded', 'PARTIALLY REFUNDED'],
  ] as const)('shows the "%s" banner as "%s"', (status, banner) => {
    const doc = buildTicketDoc(order({ payment_status: status }), 'receipt');
    const bannerBlock = textBlocks(doc).find((b) => b.text === banner);
    expect(bannerBlock).toBeDefined();
    expect(bannerBlock?.bold).toBe(true);
  });

  it('prints Name/Phone only when the order carries a customer, behind their own divider', () => {
    const withCustomer = buildTicketDoc(order({ customer_name: 'Aisha Khan', customer_phone: '+919000000000' }), 'receipt');
    expect(allText(withCustomer)).toContain('Name: Aisha Khan');
    expect(allText(withCustomer)).toContain('Phone: +919000000000');

    const guest = buildTicketDoc(order({ customer_name: '', customer_phone: '' }), 'receipt');
    expect(allText(guest)).not.toContain('Name:');
    expect(allText(guest)).not.toContain('Phone:');
  });
});

describe('buildTicketDoc — receipt meta block (date / cashier / bill no / table-or-token)', () => {
  it('formats the date as dd/mm/yy HH:mm in IST', () => {
    const doc = buildTicketDoc(order({ created_at: '2026-09-24T10:30:00.000Z' }), 'receipt');
    // 10:30 UTC = 16:00 IST, same calendar day.
    expect(allText(doc)).toContain('Date: 24/09/26 16:00');
  });

  it('shows the order type alongside the date, on the same two-column row', () => {
    const doc = buildTicketDoc(order({ order_type: 'takeaway' }), 'receipt');
    const dateCols = columnsBlocks(doc).find((c) => c.columns[0]?.text.startsWith('Date:'));
    expect(dateCols).toBeDefined();
    expect(dateCols?.columns[1]?.text).toBe('Takeaway');
  });

  it('pairs Cashier with Bill No. on one row when the cashier name resolved', () => {
    const doc = buildTicketDoc(order({ cashier_name: 'Ayush Garg', order_number: 1042 }), 'receipt');
    const cashierCols = columnsBlocks(doc).find((c) => c.columns[0]?.text.startsWith('Cashier:'));
    expect(cashierCols).toBeDefined();
    expect(cashierCols?.columns[0]?.text).toBe('Cashier: Ayush Garg');
    expect(cashierCols?.columns[1]?.text).toBe('Bill No.: HIOC-001042');
  });

  it('falls back to a plain "Cashier: Online" pairing for a web order (no created_by at all)', () => {
    const doc = buildTicketDoc(order({ cashier_name: 'Online', order_number: 1042 }), 'receipt');
    const cashierCols = columnsBlocks(doc).find((c) => c.columns[0]?.text.startsWith('Cashier:'));
    expect(cashierCols?.columns[0]?.text).toBe('Cashier: Online');
  });

  it('omits the Cashier row entirely when the name could not be resolved, but still prints Bill No.', () => {
    const doc = buildTicketDoc(order({ cashier_name: null, order_number: 1042 }), 'receipt');
    expect(allText(doc)).not.toContain('Cashier:');
    const billRow = rowBlocks(doc).find((r) => r.left === 'Bill No.');
    expect(billRow?.right).toBe('HIOC-001042');
  });

  it('shows Table for dine-in, Token No. for takeaway/delivery — never both', () => {
    const dineIn = buildTicketDoc(order({ order_type: 'dine_in', table_label: 'L1', pickup_code: null }), 'receipt');
    expect(rowBlocks(dineIn).find((r) => r.left === 'Table')?.right).toBe('L1');
    expect(allText(dineIn)).not.toContain('Token No.');

    const takeaway = buildTicketDoc(
      order({ order_type: 'takeaway', table_label: '', pickup_code: '18' }),
      'receipt',
    );
    expect(rowBlocks(takeaway).find((r) => r.left === 'Token No.')?.right).toBe('18');
    expect(allText(takeaway)).not.toContain('Table');
  });
});

describe('buildTicketDoc — receipt item table (columns block)', () => {
  it('emits a bold header row with No. / Item / Qty. / Price / Amount', () => {
    const doc = buildTicketDoc(order(), 'receipt');
    const header = columnsBlocks(doc).find((c) => c.columns[0]?.text === 'No.');
    expect(header).toBeDefined();
    expect(header?.bold).toBe(true);
    expect(header?.columns.map((c) => c.text)).toEqual(['No.', 'Item', 'Qty.', 'Price', 'Amount']);
  });

  it('numbers each active item and carries its name, qty, unit price, and line total, all to 2 decimals', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({ id: 'a', name_snapshot: 'Hazelnut Hot Chocolate', variant_label_snapshot: 'Large', quantity: 1, price_inr_snapshot: 290, line_total_inr: 290 }),
        ],
      }),
      'receipt',
    );
    const itemRow = columnsBlocks(doc).find((c) => c.columns[1]?.text.includes('Hazelnut'));
    expect(itemRow).toBeDefined();
    expect(itemRow?.columns[0].text).toBe('1');
    expect(itemRow?.columns[1].text).toBe('Hazelnut Hot Chocolate (Large)');
    expect(itemRow?.columns[2].text).toBe('1');
    expect(itemRow?.columns[3].text).toBe('290.00');
    expect(itemRow?.columns[4].text).toBe('290.00');
  });

  it('derives Price from Amount/Qty, not the raw price_inr_snapshot field, so Qty × Price = Amount even with a priced add-on', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            name_snapshot: 'Hazelnut Hot Chocolate',
            quantity: 2,
            // Deliberately inconsistent with what resolveOrderLines
            // (lib/orders/lines.ts) actually produces — price_inr_snapshot
            // there already bakes add-ons in (unitPrice = variant.price_inr
            // + addonsTotal), so this and line_total_inr never really
            // disagree in real data. But the ticket builder must not RELY
            // on that: it derives Price from Amount/Qty directly, so the
            // printed table is self-consistent (Qty × Price = Amount)
            // regardless of what price_inr_snapshot happens to hold.
            price_inr_snapshot: 250, // base/variant price alone, no add-on
            line_total_inr: 580, // (250 base + 40 add-on) x 2 — the real total
            addons: [
              addon({ group_name_snapshot: 'Choose Milk', option_name_snapshot: 'Almond', price_inr_snapshot: 40 }),
            ],
          }),
        ],
      }),
      'receipt',
    );
    const itemRow = columnsBlocks(doc).find((c) => c.columns[1]?.text.includes('Hazelnut'))!;
    const qty = Number(itemRow.columns[2].text);
    const price = Number(itemRow.columns[3].text);
    const amount = Number(itemRow.columns[4].text);
    expect(price).toBe(290); // 580 / 2 — NOT the raw 250 snapshot
    expect(qty * price).toBeCloseTo(amount, 2);
  });

  it('the sum of every item row\'s Amount equals the Sub Total row', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({ id: 'a', name_snapshot: 'Latte', quantity: 2, price_inr_snapshot: 150, line_total_inr: 300 }),
          item({ id: 'b', name_snapshot: 'Croissant', quantity: 1, price_inr_snapshot: 90, line_total_inr: 90 }),
          item({
            id: 'c',
            name_snapshot: 'Voided Mocha',
            quantity: 1,
            price_inr_snapshot: 200,
            line_total_inr: 200,
            voided: true,
          }),
        ],
        subtotal_inr: 390, // 300 + 90 — the voided line is excluded, same rule as lib/orders/amend.ts
      }),
      'receipt',
    );
    const amountSum = columnsBlocks(doc)
      .filter((c) => c.columns[0]?.text !== 'No.') // exclude the header row
      .reduce((sum, c) => sum + Number(c.columns[4]?.text || 0), 0);
    const subTotalRow = rowBlocks(doc).find((r) => r.left === 'Sub Total');
    expect(subTotalRow?.right).toBe('Rs. 390.00');
    expect(amountSum).toBeCloseTo(390, 2);
  });

  it('marks the Price column optional (droppable at 58mm) but never the others', () => {
    const doc = buildTicketDoc(order(), 'receipt');
    const header = columnsBlocks(doc).find((c) => c.columns[0]?.text === 'No.')!;
    expect(header.columns.find((c) => c.text === 'Price')?.optional).toBe(true);
    for (const label of ['No.', 'Item', 'Qty.', 'Amount']) {
      expect(header.columns.find((c) => c.text === label)?.optional).toBeFalsy();
    }
  });

  it('excludes voided items from the item table and the totals section', () => {
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

  it('indents addon and note lines (hanging, via the text block\'s `indent`) right under the item, after its columns row', () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({
            addons: [addon({ group_name_snapshot: 'Milk', option_name_snapshot: 'Oat', price_inr_snapshot: 0 })],
            special_instructions: 'No sugar',
          }),
        ],
      }),
      'receipt',
    );
    const text = allText(doc);
    expect(text).toContain('Milk: Oat');
    expect(text).toContain('Note: No sugar');

    const addonBlock = textBlocks(doc).find((b) => b.text === 'Milk: Oat');
    const noteBlock = textBlocks(doc).find((b) => b.text === 'Note: No sugar');
    // 4 = the No. column's width (3) + 1 gap — same at 48 and 32 cols (see
    // ITEM_COLUMN_INDENT in lib/print/ticketModel.ts).
    expect(addonBlock?.indent).toBe(4);
    expect(noteBlock?.indent).toBe(4);
  });
});

describe('buildTicketDoc — receipt totals', () => {
  it('includes Total Qty, Sub Total, GST, and a bold, larger Grand Total row, all money to 2 decimals with the "Rs." prefix', () => {
    const doc = buildTicketDoc(
      order({ items: [item({ quantity: 3 })], subtotal_inr: 240, tax_inr: 12, total_inr: 252 }),
      'receipt',
    );
    const rows = rowBlocks(doc);
    expect(rows.find((r) => r.left === 'Total Qty')?.right).toBe('3');
    expect(rows.find((r) => r.left === 'Sub Total')?.right).toBe('Rs. 240.00');
    expect(rows.find((r) => r.left === 'GST')?.right).toBe('Rs. 12.00');
    const grandTotal = rows.find((r) => r.left === 'Grand Total');
    expect(grandTotal?.right).toBe('Rs. 252.00');
    expect(grandTotal?.bold).toBe(true);
    expect(grandTotal?.size).toBe('large');
  });

  it('shows the discount in parentheses, labelled with the coupon code when one applied', () => {
    const doc = buildTicketDoc(order({ discount_inr: 20, coupon_code: 'WELCOME10' }), 'receipt');
    const discountRow = rowBlocks(doc).find((r) => r.left.startsWith('Discount'));
    expect(discountRow?.left).toBe('Discount (WELCOME10)');
    expect(discountRow?.right).toBe('(Rs. 20.00)');
  });

  it('falls back to a plain "Discount" label with no coupon', () => {
    const doc = buildTicketDoc(order({ discount_inr: 20, coupon_code: null }), 'receipt');
    expect(rowBlocks(doc).find((r) => r.left.startsWith('Discount'))?.left).toBe('Discount');
  });

  it('prints "Paid via <method>" centered only when the order is paid and a method is known', () => {
    const paidCash = buildTicketDoc(order({ payment_status: 'paid', payment_method: 'cash' }), 'receipt');
    const paidLine = textBlocks(paidCash).find((b) => b.text.startsWith('Paid via'));
    expect(paidLine?.text).toBe('Paid via Cash');
    expect(paidLine?.align).toBe('center');

    const unpaid = buildTicketDoc(order({ payment_status: 'unpaid', payment_method: null }), 'receipt');
    expect(allText(unpaid)).not.toContain('Paid via');
  });

  it.each([
    ['cash', 'Cash'],
    ['upi', 'UPI'],
    ['card', 'Card'],
    ['online', 'Online'],
  ] as const)('labels payment_method %s as "%s"', (method, label) => {
    const doc = buildTicketDoc(order({ payment_status: 'paid', payment_method: method }), 'receipt');
    expect(allText(doc)).toContain(`Paid via ${label}`);
  });
});

describe('buildTicketDoc — receipt customer notes', () => {
  it('prints "Customer Notes: …" behind its own divider only when the order has notes', () => {
    const withNotes = buildTicketDoc(order({ notes: 'Extra napkins please' }), 'receipt');
    expect(allText(withNotes)).toContain('Customer Notes: Extra napkins please');

    const withoutNotes = buildTicketDoc(order({ notes: '' }), 'receipt');
    expect(allText(withoutNotes)).not.toContain('Customer Notes');
  });
});

describe('buildTicketDoc — receipt loyalty points', () => {
  it('shows a "Points earned" row when present, omits it otherwise', () => {
    const withPoints = buildTicketDoc(order({ points_earned: 5 }), 'receipt');
    expect(rowBlocks(withPoints).find((r) => r.left === 'Points earned')?.right).toBe('5');

    const withoutPoints = buildTicketDoc(order({ points_earned: 0 }), 'receipt');
    expect(allText(withoutPoints)).not.toContain('Points earned');

    const nullPoints = buildTicketDoc(order({ points_earned: null }), 'receipt');
    expect(allText(nullPoints)).not.toContain('Points earned');
  });

  it('shows "Points redeemed" only when points were redeemed on this order', () => {
    const withRedeemed = buildTicketDoc(order({ points_redeemed: 40 }), 'receipt');
    expect(rowBlocks(withRedeemed).find((r) => r.left === 'Points redeemed')?.right).toBe('40');

    const noneRedeemed = buildTicketDoc(order({ points_redeemed: null }), 'receipt');
    expect(allText(noneRedeemed)).not.toContain('Points redeemed');
  });

  it('shows "Points balance" whenever it is known, even when nothing was earned/redeemed on this order', () => {
    const withBalance = buildTicketDoc(
      order({ points_earned: null, points_redeemed: null, points_balance: 210 }),
      'receipt',
    );
    expect(rowBlocks(withBalance).find((r) => r.left === 'Points balance')?.right).toBe('210');

    const noBalance = buildTicketDoc(order({ points_balance: null }), 'receipt');
    expect(allText(noBalance)).not.toContain('Points balance');
  });

  it('shows nothing loyalty-related, and no extra divider, for a guest order with no linked account', () => {
    const guest = buildTicketDoc(
      order({ points_earned: null, points_redeemed: null, points_balance: null }),
      'receipt',
    );
    expect(allText(guest)).not.toContain('Points earned');
    expect(allText(guest)).not.toContain('Points redeemed');
    expect(allText(guest)).not.toContain('Points balance');
  });

  it('groups all present points rows together, behind their own divider, right before the FSSAI footer', () => {
    const withAll = buildTicketDoc(order({ points_earned: 5, points_redeemed: 40, points_balance: 210 }), 'receipt');
    const kinds = withAll.blocks.map((b) => (b.kind === 'row' ? `row:${b.left}` : b.kind));
    const redeemedIdx = kinds.indexOf('row:Points redeemed');
    expect(kinds[redeemedIdx + 1]).toBe('row:Points earned');
    expect(kinds[redeemedIdx + 2]).toBe('row:Points balance');
    expect(kinds[redeemedIdx + 3]).toBe('divider');
    const fssaiIdx = textBlocks(withAll).findIndex((b) => b.text.startsWith('FSSAI'));
    expect(fssaiIdx).toBeGreaterThan(-1);
  });
});

describe('buildTicketDoc — receipt footer', () => {
  it('ends with the FSSAI license number and the brand tagline lines, all centered', () => {
    const doc = buildTicketDoc(order(), 'receipt');
    const tail = textBlocks(doc).slice(-3);
    expect(tail.map((b) => b.text)).toEqual([
      'FSSAI Lic No. 22723576000183',
      'Love to get you high on Coffee!',
      'Please Visit Again!',
    ]);
    expect(tail.every((b) => b.align === 'center')).toBe(true);
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
