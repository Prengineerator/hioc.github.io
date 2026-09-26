import { describe, expect, it } from 'vitest';
import { canEditMenu, canTakeOrders } from '@/lib/staff/surfaceRules';

// POS vs staff website: the POS takes orders and edits the menu; the staff
// website takes orders only when switched on, and never edits the menu.

describe('canTakeOrders', () => {
  it('always on the POS', () => {
    expect(canTakeOrders('pos', false)).toBe(true);
    expect(canTakeOrders('pos', undefined)).toBe(true);
  });

  it('on the staff website only when switched on (off by default, and before the migration)', () => {
    expect(canTakeOrders('web', undefined)).toBe(false);
    expect(canTakeOrders('web', null)).toBe(false);
    expect(canTakeOrders('web', false)).toBe(false);
    expect(canTakeOrders('web', true)).toBe(true);
  });
});

describe('canEditMenu', () => {
  it('only on the POS', () => {
    expect(canEditMenu('pos')).toBe(true);
    expect(canEditMenu('web')).toBe(false);
  });
});
