import { describe, expect, it } from 'vitest';

// Settle → Edit order (lib/orders/settleEdit.ts): the pure rules the amend route
// validates a requested edit with, and the Settle sheet reads to decide what to
// offer. No mocks — plain fixtures.

import {
  canReduceLine,
  editReductionInr,
  MAX_EDIT_CHANGES,
  planSettleEdit,
  settleEditBlockReason,
  type PlannedEdit,
  type SettleEditLine,
} from '@/lib/orders/settleEdit';
import type { OrderStatus } from '@/lib/types';

const LATTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const BROWNIE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const BEANS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const MISSING = '99999999-9999-4999-8999-999999999999';

// Three cups of latte at ₹160, one brownie at ₹120 — ₹600 on the bill.
const lines = (): SettleEditLine[] => [
  { id: LATTE, voided: false, quantity: 3, price_inr_snapshot: 160, line_total_inr: 480 },
  { id: BROWNIE, voided: false, quantity: 1, price_inr_snapshot: 120, line_total_inr: 120 },
];

function plan(changes: unknown, rows: SettleEditLine[] = lines()) {
  return planSettleEdit(rows, changes);
}

describe('planSettleEdit', () => {
  it('lowers a quantity and re-prices the line from its unit price', () => {
    expect(plan([{ item_id: LATTE, quantity: 2 }])).toEqual({
      ok: true,
      changes: [
        {
          item_id: LATTE,
          from_quantity: 3,
          to_quantity: 2,
          from_line_total_inr: 480,
          to_line_total_inr: 320,
          remove: false,
        },
      ],
    });
  });

  it('removes a line when the quantity is 0, leaving its total as it was', () => {
    expect(plan([{ item_id: BROWNIE, quantity: 0 }])).toEqual({
      ok: true,
      changes: [
        {
          item_id: BROWNIE,
          from_quantity: 1,
          to_quantity: 0,
          from_line_total_inr: 120,
          to_line_total_inr: 120,
          remove: true,
        },
      ],
    });
  });

  it('plans several lines at once, in the order asked', () => {
    const result = plan([
      { item_id: BROWNIE, quantity: 0 },
      { item_id: LATTE, quantity: 1 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.map((c) => [c.item_id, c.to_quantity, c.remove])).toEqual([
      [BROWNIE, 0, true],
      [LATTE, 1, false],
    ]);
  });

  it('drops a line whose quantity is unchanged', () => {
    const result = plan([
      { item_id: LATTE, quantity: 3 },
      { item_id: BROWNIE, quantity: 0 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.map((c) => c.item_id)).toEqual([BROWNIE]);
  });

  it('400s when every change is a no-op', () => {
    expect(plan([{ item_id: LATTE, quantity: 3 }])).toEqual({ ok: false, status: 400, error: 'Nothing to change.' });
  });

  it('409s an increase — more goes through Add items so the kitchen gets a ticket', () => {
    const result = plan([{ item_id: LATTE, quantity: 4 }]);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toContain('Add items');
  });

  it('409s one increase even when the other changes are fine', () => {
    expect(
      plan([
        { item_id: BROWNIE, quantity: 0 },
        { item_id: LATTE, quantity: 9 },
      ]),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it('prices a sold-by-weight line from its unit price × quantity', () => {
    // The unit price of a weighed line already carries its weight (₹540 for the
    // 250 g bag), so a line of 2 bags lowered to 1 is simply ₹540.
    const rows: SettleEditLine[] = [
      { id: BEANS, voided: false, quantity: 2, price_inr_snapshot: 540, line_total_inr: 1080 },
      ...lines(),
    ];
    const result = plan([{ item_id: BEANS, quantity: 1 }], rows);
    expect(result.ok && result.changes[0]).toMatchObject({ to_quantity: 1, to_line_total_inr: 540 });
  });

  describe('a line a HIOC Ritual cup paid for', () => {
    const passRows = (): SettleEditLine[] => [
      { id: LATTE, voided: false, quantity: 3, price_inr_snapshot: 160, line_total_inr: 480, pass_drinks: 1 },
      { id: BROWNIE, voided: false, quantity: 1, price_inr_snapshot: 120, line_total_inr: 120 },
    ];

    it('409s a reduction — which units the cup paid for is not recorded', () => {
      const result = plan([{ item_id: LATTE, quantity: 2 }], passRows());
      expect(result).toMatchObject({ ok: false, status: 409 });
      expect(result.ok === false && result.error).toContain('HIOC Ritual');
    });

    it('still removes it whole', () => {
      const result = plan([{ item_id: LATTE, quantity: 0 }], passRows());
      expect(result.ok && result.changes[0]).toMatchObject({ item_id: LATTE, remove: true });
    });

    it('treats an absent pass_drinks (pre-migration database) as no cup', () => {
      expect(plan([{ item_id: LATTE, quantity: 2 }]).ok).toBe(true);
    });
  });

  it('409s emptying the order — cancel it instead', () => {
    const result = plan([
      { item_id: LATTE, quantity: 0 },
      { item_id: BROWNIE, quantity: 0 },
    ]);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toContain('empty the order');
  });

  it('409s removing the only live line, voided lines not counting as live', () => {
    const rows: SettleEditLine[] = [
      { id: LATTE, voided: true, quantity: 1, price_inr_snapshot: 160, line_total_inr: 160 },
      { id: BROWNIE, voided: false, quantity: 1, price_inr_snapshot: 120, line_total_inr: 120 },
    ];
    expect(plan([{ item_id: BROWNIE, quantity: 0 }], rows)).toMatchObject({ ok: false, status: 409 });
  });

  it('allows lowering the last remaining line (it stays on the order)', () => {
    const rows: SettleEditLine[] = [{ id: LATTE, voided: false, quantity: 3, price_inr_snapshot: 160, line_total_inr: 480 }];
    expect(plan([{ item_id: LATTE, quantity: 1 }], rows).ok).toBe(true);
  });

  it('404s a line that is not on the order', () => {
    expect(plan([{ item_id: MISSING, quantity: 0 }])).toMatchObject({ ok: false, status: 404 });
  });

  it('409s a line that has already been removed', () => {
    const rows: SettleEditLine[] = [
      { id: LATTE, voided: true, quantity: 3, price_inr_snapshot: 160, line_total_inr: 480 },
      { id: BROWNIE, voided: false, quantity: 1, price_inr_snapshot: 120, line_total_inr: 120 },
    ];
    expect(plan([{ item_id: LATTE, quantity: 1 }], rows)).toMatchObject({ ok: false, status: 409 });
  });

  describe('400s a malformed request', () => {
    it.each([
      ['not an array', { item_id: LATTE, quantity: 1 }],
      ['an empty array', []],
      ['undefined', undefined],
      ['null', null],
    ])('changes that is %s', (_name, changes) => {
      expect(plan(changes)).toMatchObject({ ok: false, status: 400 });
    });

    it('more changes than MAX_EDIT_CHANGES', () => {
      const changes = Array.from({ length: MAX_EDIT_CHANGES + 1 }, () => ({ item_id: LATTE, quantity: 1 }));
      expect(plan(changes)).toMatchObject({ ok: false, status: 400 });
    });

    it.each([
      ['a missing item_id', { quantity: 1 }],
      ['an item_id that is not a uuid', { item_id: 'latte', quantity: 1 }],
      ['a numeric item_id', { item_id: 7, quantity: 1 }],
      ['a null entry', null],
      ['a string entry', 'oops'],
      ['a missing quantity', { item_id: LATTE }],
      ['a negative quantity', { item_id: LATTE, quantity: -1 }],
      ['a fractional quantity', { item_id: LATTE, quantity: 1.5 }],
      ['a string quantity', { item_id: LATTE, quantity: '1' }],
      ['a NaN quantity', { item_id: LATTE, quantity: Number.NaN }],
      ['an infinite quantity', { item_id: LATTE, quantity: Infinity }],
    ])('%s', (_name, change) => {
      expect(plan([change])).toMatchObject({ ok: false, status: 400 });
    });

    it('the same line twice — even when the two entries agree', () => {
      const result = plan([
        { item_id: LATTE, quantity: 1 },
        { item_id: LATTE, quantity: 1 },
      ]);
      expect(result).toMatchObject({ ok: false, status: 400 });
    });

    it('names the offending entry', () => {
      const result = plan([{ item_id: LATTE, quantity: 1 }, { item_id: 'nope', quantity: 1 }]);
      expect(result.ok === false && result.error).toContain('changes[1]');
    });
  });
});

describe('settleEditBlockReason', () => {
  const open = (status: OrderStatus, extra: Record<string, unknown> = {}) => ({
    status,
    payment_status: 'unpaid',
    ...extra,
  });

  it.each<OrderStatus>(['accepted', 'preparing', 'ready'])('allows an unpaid %s order', (status) => {
    expect(settleEditBlockReason(open(status))).toBeNull();
  });

  it('refuses a HIOC Ritual sale before anything else', () => {
    const reason = settleEditBlockReason(open('accepted', { order_kind: 'coffee_pass', payment_status: 'paid' }));
    expect(reason).toContain('HIOC Ritual');
    expect(reason).toContain('cancel');
  });

  it('treats a menu order and an absent order_kind alike', () => {
    expect(settleEditBlockReason(open('accepted', { order_kind: 'menu' }))).toBeNull();
    expect(settleEditBlockReason(open('accepted', { order_kind: null }))).toBeNull();
  });

  it('refuses a paid bill, whatever its status', () => {
    expect(settleEditBlockReason(open('accepted', { payment_status: 'paid' }))).toBe('This bill is already paid.');
    expect(settleEditBlockReason(open('completed', { payment_status: 'paid' }))).toBe('This bill is already paid.');
  });

  it('sends a received order to be accepted first', () => {
    expect(settleEditBlockReason(open('received'))).toContain('Accept this order');
  });

  it('refuses a completed order because its stock has been used', () => {
    expect(settleEditBlockReason(open('completed'))).toContain('stock');
  });

  it.each<OrderStatus>(['rejected', 'cancelled'])('refuses a %s order with the generic message', (status) => {
    expect(settleEditBlockReason(open(status))).toBe('This order can no longer be changed.');
  });
});

describe('canReduceLine', () => {
  it('allows a live line of 2 or more with no pass cup', () => {
    expect(canReduceLine({ voided: false, quantity: 2 })).toBe(true);
    expect(canReduceLine({ voided: false, quantity: 2, pass_drinks: 0 })).toBe(true);
  });

  it('refuses a single unit (it can only be removed), a voided line, and a line a cup paid for', () => {
    expect(canReduceLine({ voided: false, quantity: 1 })).toBe(false);
    expect(canReduceLine({ voided: true, quantity: 3 })).toBe(false);
    expect(canReduceLine({ voided: false, quantity: 3, pass_drinks: 1 })).toBe(false);
  });
});

describe('editReductionInr', () => {
  const edit = (over: Partial<PlannedEdit>): PlannedEdit => ({
    item_id: LATTE,
    from_quantity: 3,
    to_quantity: 2,
    from_line_total_inr: 480,
    to_line_total_inr: 320,
    remove: false,
    ...over,
  });

  it('is the amount a reduction takes off the line', () => {
    expect(editReductionInr([edit({})])).toBe(160);
  });

  it('is the whole line total for a removal', () => {
    expect(editReductionInr([edit({ to_quantity: 0, to_line_total_inr: 480, remove: true })])).toBe(480);
  });

  it('adds up across changes, and is 0 for none', () => {
    expect(editReductionInr([edit({}), edit({ to_quantity: 0, to_line_total_inr: 120, from_line_total_inr: 120, remove: true })])).toBe(280);
    expect(editReductionInr([])).toBe(0);
  });

  it('agrees with a plan', () => {
    const result = plan([
      { item_id: LATTE, quantity: 2 },
      { item_id: BROWNIE, quantity: 0 },
    ]);
    expect(result.ok && editReductionInr(result.changes)).toBe(160 + 120);
  });
});
