import { describe, expect, it } from 'vitest';
import {
  canAssign,
  canCancel,
  canPick,
  canReceive,
  expiryState,
  formatQty,
  inventoryErrorMessage,
  isIsoDate,
  lineHasDiscrepancy,
  orderUsage,
  parsePickLines,
  parseQty,
  parseReceiveLines,
  parseRecipeLines,
  parseRequestLines,
  recipeFor,
  summarizeStock,
  suggestedRequestQty,
  type RequestActor,
  type RequestFacts,
} from '@/lib/inventory/rules';
import { parseItemFields } from '@/lib/inventory/itemFields';

// The inventory rules (docs/INVENTORY-SPEC.md) — every decision the Stock
// screen and /api/inventory/** make, tested without a database.

const isId = (v: unknown): v is string => typeof v === 'string' && v.startsWith('id-');
const TODAY = '2026-09-26';

describe('quantities', () => {
  it('parses numbers and numeric strings to three decimals', () => {
    expect(parseQty(2)).toBe(2);
    expect(parseQty('0.25')).toBe(0.25);
    expect(parseQty(0.1 + 0.2)).toBe(0.3);
    expect(parseQty(1.23456)).toBe(1.235);
  });

  it('refuses zero unless allowed, negatives, junk and absurd amounts', () => {
    expect(parseQty(0)).toBeNull();
    expect(parseQty(0, { allowZero: true })).toBe(0);
    expect(parseQty(-1, { allowZero: true })).toBeNull();
    expect(parseQty('abc')).toBeNull();
    expect(parseQty('')).toBeNull();
    expect(parseQty(null)).toBeNull();
    expect(parseQty(Infinity)).toBeNull();
    expect(parseQty(2_000_000)).toBeNull();
  });

  it('formats with the unit label and no trailing zeros', () => {
    expect(formatQty(1.5, 'l')).toBe('1.5 L');
    expect(formatQty(200, 'g')).toBe('200 g');
    expect(formatQty(0.125, 'kg')).toBe('0.125 kg');
    expect(formatQty(3, 'pack')).toBe('3 packs');
  });
});

describe('expiry', () => {
  it('validates real calendar dates only', () => {
    expect(isIsoDate('2026-10-05')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('05/10/2026')).toBe(false);
    expect(isIsoDate(20261005)).toBe(false);
  });

  it('is good on its expiry date, expired the day after, soon within 3 days', () => {
    expect(expiryState(null, TODAY)).toBe('none');
    expect(expiryState('2026-09-25', TODAY)).toBe('expired');
    expect(expiryState('2026-09-26', TODAY)).toBe('soon');
    expect(expiryState('2026-09-28', TODAY)).toBe('soon');
    expect(expiryState('2026-09-29', TODAY)).toBe('ok');
  });
});

describe('summarizeStock', () => {
  const item = { par_level: 5, shortfall_since_count: 0 };

  it('adds up the batches and splits expired / expiring', () => {
    const s = summarizeStock(
      item,
      [
        { qty_remaining: 2, expiry_date: '2026-09-20' },
        { qty_remaining: 1.5, expiry_date: '2026-09-27' },
        { qty_remaining: 4, expiry_date: '2026-10-10' },
        { qty_remaining: 0, expiry_date: '2026-09-01' },
      ],
      TODAY,
    );
    expect(s.onHand).toBe(7.5);
    expect(s.expiredQty).toBe(2);
    expect(s.soonQty).toBe(1.5);
    expect(s.nextExpiry).toBe('2026-09-20');
    expect(s.low).toBe(false);
  });

  it('is low at or below par, never when par is 0', () => {
    expect(summarizeStock(item, [{ qty_remaining: 5, expiry_date: null }], TODAY).low).toBe(true);
    expect(summarizeStock({ ...item, par_level: 0 }, [], TODAY).low).toBe(false);
  });

  it('asks for a count once sales ran past the records', () => {
    expect(summarizeStock({ ...item, shortfall_since_count: 0.2 }, [], TODAY).countNeeded).toBe(true);
  });

  it('pre-fills a request with the reorder qty, else back up to par', () => {
    expect(suggestedRequestQty({ par_level: 5, reorder_qty: 12 }, 1)).toBe(12);
    expect(suggestedRequestQty({ par_level: 5, reorder_qty: 0 }, 1.5)).toBe(3.5);
    expect(suggestedRequestQty({ par_level: 5, reorder_qty: 0 }, 9)).toBe(0);
  });
});

describe('who may move a request', () => {
  const staff: RequestActor = { userId: 'asha', role: 'staff', surface: 'web' };
  const picker: RequestActor = { userId: 'vikram', role: 'staff', surface: 'pos' };
  const other: RequestActor = { userId: 'meera', role: 'staff', surface: 'pos' };
  const manager: RequestActor = { userId: 'boss', role: 'manager', surface: 'web' };
  const base: RequestFacts = { status: 'requested', requested_by: 'asha', assigned_to: null, picked_by: null };
  const assigned: RequestFacts = { ...base, status: 'assigned', assigned_to: 'vikram' };
  const picked: RequestFacts = { ...assigned, status: 'picked', picked_by: 'vikram' };

  it('assigning is for a manager, before picking', () => {
    expect(canAssign(base, staff)).toMatchObject({ ok: false, status: 403 });
    expect(canAssign(base, manager).ok).toBe(true);
    expect(canAssign(assigned, manager).ok).toBe(true); // re-assign
    expect(canAssign(picked, manager)).toMatchObject({ ok: false, status: 409 });
  });

  it('picking is for the assignee (or a manager), once assigned', () => {
    expect(canPick(base, picker)).toMatchObject({ ok: false, status: 409 });
    expect(canPick(assigned, picker).ok).toBe(true);
    expect(canPick(assigned, other)).toMatchObject({ ok: false, status: 403 });
    expect(canPick(assigned, manager).ok).toBe(true);
  });

  it('receiving happens at the POS only', () => {
    expect(canReceive(picked, { ...other, surface: 'web' })).toMatchObject({ ok: false, status: 403 });
    expect(canReceive(picked, other).ok).toBe(true);
  });

  it('the picker cannot verify their own pick, a manager can', () => {
    expect(canReceive(picked, picker)).toMatchObject({ ok: false, status: 403 });
    expect(canReceive({ ...picked, picked_by: 'boss' }, { ...manager, surface: 'pos' }).ok).toBe(true);
  });

  it('only a picked request can be received, and only once', () => {
    expect(canReceive(assigned, other)).toMatchObject({ ok: false, status: 409 });
    expect(canReceive({ ...picked, status: 'received' }, other)).toMatchObject({ ok: false, status: 409 });
  });

  it('the requester can cancel until it is assigned; a manager until received', () => {
    expect(canCancel(base, staff).ok).toBe(true);
    expect(canCancel(assigned, staff)).toMatchObject({ ok: false, status: 403 });
    expect(canCancel(picked, manager).ok).toBe(true);
    expect(canCancel({ ...picked, status: 'received' }, manager)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('request lines', () => {
  it('needs at least one item, each once, each with a quantity', () => {
    expect(parseRequestLines([], isId).ok).toBe(false);
    expect(parseRequestLines([{ itemId: 'bad', qty: 1 }], isId).ok).toBe(false);
    expect(parseRequestLines([{ itemId: 'id-1', qty: 0 }], isId).ok).toBe(false);
    expect(parseRequestLines([{ itemId: 'id-1', qty: 1 }, { itemId: 'id-1', qty: 2 }], isId).ok).toBe(false);
    expect(parseRequestLines([{ itemId: 'id-1', qty: '2.5' }], isId)).toEqual({ ok: true, lines: [{ itemId: 'id-1', qty: 2.5 }] });
  });

  it('a pick answers every line; zeros allowed but not all zero', () => {
    const ids = ['id-1', 'id-2'];
    expect(parsePickLines([{ itemId: 'id-1', qty: 1 }], ids).ok).toBe(false);
    expect(parsePickLines([{ itemId: 'id-1', qty: 1 }, { itemId: 'id-3', qty: 1 }], ids).ok).toBe(false);
    expect(parsePickLines([{ itemId: 'id-1', qty: 0 }, { itemId: 'id-2', qty: 0 }], ids)).toMatchObject({ ok: false });
    expect(parsePickLines([{ itemId: 'id-1', qty: 0 }, { itemId: 'id-2', qty: 3 }], ids).ok).toBe(true);
  });
});

describe('receiving', () => {
  const items = new Map([
    ['id-milk', { id: 'id-milk', name: 'Milk', tracks_expiry: true }],
    ['id-cups', { id: 'id-cups', name: 'Cups', tracks_expiry: false }],
  ]);
  const both = ['id-milk', 'id-cups'];

  it('needs an expiry date for perishables that arrived', () => {
    const r = parseReceiveLines([{ itemId: 'id-milk', qty: 5 }, { itemId: 'id-cups', qty: 100 }], items, TODAY, both);
    expect(r).toEqual({ ok: false, message: 'Enter the expiry date for Milk.' });
  });

  it('does not need one for a line that did not arrive, or a non-perishable', () => {
    const r = parseReceiveLines([{ itemId: 'id-milk', qty: 0 }, { itemId: 'id-cups', qty: 100 }], items, TODAY, both);
    expect(r).toEqual({
      ok: true,
      lines: [
        { itemId: 'id-milk', qty: 0, expiryDate: null },
        { itemId: 'id-cups', qty: 100, expiryDate: null },
      ],
    });
  });

  it('refuses stock that is already expired, and nonsense dates', () => {
    expect(parseReceiveLines([{ itemId: 'id-milk', qty: 1, expiryDate: '2026-09-25' }], items, TODAY).ok).toBe(false);
    expect(parseReceiveLines([{ itemId: 'id-milk', qty: 1, expiryDate: '2026-13-01' }], items, TODAY).ok).toBe(false);
    expect(parseReceiveLines([{ itemId: 'id-milk', qty: 1, expiryDate: '2026-09-26' }], items, TODAY).ok).toBe(true);
  });

  it('against a request, counts every line and nothing else', () => {
    expect(parseReceiveLines([{ itemId: 'id-cups', qty: 1 }], items, TODAY, both).ok).toBe(false);
    expect(parseReceiveLines([{ itemId: 'id-cups', qty: 1 }], items, TODAY, ['id-milk']).ok).toBe(false);
  });

  it('a direct delivery needs something > 0 and known items', () => {
    expect(parseReceiveLines([{ itemId: 'id-cups', qty: 0 }], items, TODAY).ok).toBe(false);
    expect(parseReceiveLines([{ itemId: 'id-nope', qty: 1 }], items, TODAY).ok).toBe(false);
  });

  it('flags a line that arrived different from what was picked', () => {
    expect(lineHasDiscrepancy({ qty_picked: 10, qty_received: 8 })).toBe(true);
    expect(lineHasDiscrepancy({ qty_picked: 10, qty_received: 10 })).toBe(false);
    expect(lineHasDiscrepancy({ qty_picked: 10, qty_received: null })).toBe(false);
  });
});

describe('recipes', () => {
  const lines = [
    { menu_item_id: 'latte', variant_id: null, item_id: 'milk', qty: 0.2 },
    { menu_item_id: 'latte', variant_id: null, item_id: 'beans', qty: 18 },
    { menu_item_id: 'latte', variant_id: 'large', item_id: 'milk', qty: 0.3 },
    { menu_item_id: 'latte', variant_id: 'large', item_id: 'beans', qty: 27 },
    { menu_item_id: 'mocha', variant_id: null, item_id: 'milk', qty: 0.25 },
  ];

  it('a size with its own recipe uses that instead of the base', () => {
    expect(recipeFor(lines, 'latte', 'large').map((l) => l.qty)).toEqual([0.3, 27]);
    expect(recipeFor(lines, 'latte', 'regular').map((l) => l.qty)).toEqual([0.2, 18]);
    expect(recipeFor(lines, 'latte', null).map((l) => l.qty)).toEqual([0.2, 18]);
  });

  it('sums an order’s usage per stock item', () => {
    const usage = orderUsage(
      [
        { menu_item_id: 'latte', variant_id: null, quantity: 2 },
        { menu_item_id: 'latte', variant_id: 'large', quantity: 1 },
        { menu_item_id: 'mocha', variant_id: null, quantity: 1 },
        { menu_item_id: null, variant_id: null, quantity: 3 }, // deleted menu item
        { menu_item_id: 'cookie', variant_id: null, quantity: 1 }, // no recipe
      ],
      lines,
    );
    expect(Object.fromEntries(usage)).toEqual({ milk: 0.95, beans: 63 });
  });

  it('validates the editor’s lines', () => {
    const sizes = new Set(['id-large']);
    expect(parseRecipeLines([], isId, sizes)).toEqual({ ok: true, lines: [] });
    expect(parseRecipeLines([{ variantId: 'id-small', itemId: 'id-milk', qty: 1 }], isId, sizes).ok).toBe(false);
    expect(parseRecipeLines([{ variantId: null, itemId: 'id-milk', qty: 0 }], isId, sizes).ok).toBe(false);
    expect(
      parseRecipeLines(
        [
          { variantId: null, itemId: 'id-milk', qty: 1 },
          { variantId: null, itemId: 'id-milk', qty: 2 },
        ],
        isId,
        sizes,
      ).ok,
    ).toBe(false);
    expect(
      parseRecipeLines(
        [
          { variantId: null, itemId: 'id-milk', qty: 0.2 },
          { variantId: 'id-large', itemId: 'id-milk', qty: 0.3 },
        ],
        isId,
        sizes,
      ).ok,
    ).toBe(true);
  });
});

describe('stock item fields', () => {
  it('a new item needs a name and a known unit', () => {
    expect(parseItemFields({ unit: 'g' }, { requireAll: true }).ok).toBe(false);
    expect(parseItemFields({ name: 'Milk', unit: 'litre' }, { requireAll: true }).ok).toBe(false);
    expect(parseItemFields({ name: '  Full  cream milk ', unit: 'l', parLevel: 5, reorderQty: '10' }, { requireAll: true })).toEqual({
      ok: true,
      fields: { name: 'Full cream milk', unit: 'l', par_level: 5, reorder_qty: 10 },
    });
  });

  it('an edit sends only what changed, and must change something', () => {
    expect(parseItemFields({}, { requireAll: false }).ok).toBe(false);
    expect(parseItemFields({ isActive: false }, { requireAll: false })).toEqual({ ok: true, fields: { is_active: false } });
    expect(parseItemFields({ parLevel: -1 }, { requireAll: false }).ok).toBe(false);
  });
});

describe('database error messages', () => {
  it('passes through the function’s own message, capitalised', () => {
    expect(inventoryErrorMessage({ message: 'inventory: enter the expiry date for Milk' })).toBe('Enter the expiry date for Milk');
    expect(inventoryErrorMessage({ message: 'duplicate key value' })).toBeNull();
    expect(inventoryErrorMessage(null)).toBeNull();
  });
});
