import { describe, expect, it } from 'vitest';
import {
  DRAFT_MAX_AGE_MS,
  draftContext,
  draftStorageKey,
  isDraftWorthKeeping,
  parseDraft,
  type DraftOrder,
} from '@/lib/pos/draftOrder';

// New order keeps the order being punched until it is placed, so leaving the
// screen, a reload or a crash never throws it away. What comes back out of
// storage must be a real draft from this shift, or nothing.

const now = 1_800_000_000_000;

const line = {
  key: 'latte|v1|',
  menuItemId: 'latte',
  variantId: 'v1',
  name: 'Latte',
  variantLabel: 'Regular',
  unitPriceInr: 180,
  addons: [],
  specialInstructions: '',
  qty: 2,
};

const draft: DraftOrder = {
  savedAt: now - 60_000,
  idempotencyKey: 'pos-abc',
  cart: [line],
  orderType: 'dine_in',
  tableId: 't4',
  custName: 'Asha',
  custPhone: '9876543210',
  custEmail: '',
  showCustomer: true,
};

describe('draftContext', () => {
  it('gives the counter, each table and each add its own slot', () => {
    expect(draftContext(null)).toBe('counter');
    expect(draftContext('t4')).toBe('table:t4');
    expect(draftContext('t4', 'o9')).toBe('add:o9');
    expect(draftStorageKey('table:t4')).toBe('hioc.pos.draft.v1.table:t4');
  });
});

describe('parseDraft', () => {
  it('brings back a recent draft as it was saved', () => {
    expect(parseDraft(JSON.stringify(draft), now)).toEqual(draft);
  });

  it('keeps the idempotency key, so charging again replays instead of duplicating', () => {
    expect(parseDraft(JSON.stringify(draft), now)?.idempotencyKey).toBe('pos-abc');
  });

  it('ignores nothing, junk and the wrong shape', () => {
    expect(parseDraft(null, now)).toBeNull();
    expect(parseDraft('{oops', now)).toBeNull();
    expect(parseDraft('null', now)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, cart: 'x' }), now)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, cart: [{ ...line, qty: 0 }] }), now)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, cart: [{ ...line, unitPriceInr: '180' }] }), now)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, orderType: 'drone' }), now)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, idempotencyKey: '' }), now)).toBeNull();
  });

  it('drops a draft from an earlier shift, or from a wrong clock', () => {
    expect(parseDraft(JSON.stringify({ ...draft, savedAt: now - DRAFT_MAX_AGE_MS - 1 }), now)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, savedAt: now + 60_000 }), now)).toBeNull();
  });

  it('drops an empty draft — nothing to put back', () => {
    const empty = { ...draft, cart: [], custName: ' ', custPhone: '', custEmail: '' };
    expect(parseDraft(JSON.stringify(empty), now)).toBeNull();
  });

  it('fills missing optional fields safely', () => {
    const { custEmail: _e, showCustomer: _s, tableId: _t, ...partial } = draft;
    const back = parseDraft(JSON.stringify(partial), now);
    expect(back?.custEmail).toBe('');
    expect(back?.showCustomer).toBe(false);
    expect(back?.tableId).toBeNull();
  });
});

describe('isDraftWorthKeeping', () => {
  it('keeps a cart, or customer details typed in, and nothing else', () => {
    expect(isDraftWorthKeeping({ cart: [line], custName: '', custPhone: '', custEmail: '' })).toBe(true);
    expect(isDraftWorthKeeping({ cart: [], custName: '', custPhone: '98765', custEmail: '' })).toBe(true);
    expect(isDraftWorthKeeping({ cart: [], custName: '  ', custPhone: '', custEmail: '' })).toBe(false);
  });
});
