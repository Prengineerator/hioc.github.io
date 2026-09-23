import { describe, expect, it } from 'vitest';
import {
  POS_FALLBACK_ORDER_TYPE,
  resolveAutoPrint,
  resolveDefaultOrderType,
} from '@/lib/pos/deviceSettings';
import { AUTO_PRINT_DEFAULTS } from '@/lib/staff/autoPrint';

// DEV-3 — device override → store setting → documented default. Three layers,
// and the middle one is where the bug lives: a device that says "never print"
// stores `false`, which every `||` in the world reads as "no opinion".

const STORE_BOTH_ON = { auto_print_kot: true, auto_print_bill: true };
const STORE_BOTH_OFF = { auto_print_kot: false, auto_print_bill: false };
const NO_OPINION = { auto_print_kot: null, auto_print_bill: null };

describe('resolveAutoPrint', () => {
  it('uses the store settings when the device has no opinion', () => {
    expect(resolveAutoPrint(STORE_BOTH_ON, NO_OPINION)).toEqual({ kot: true, bill: true });
    expect(resolveAutoPrint(STORE_BOTH_OFF, NO_OPINION)).toEqual({ kot: false, bill: false });
  });

  it('uses the store settings when there is no device at all', () => {
    // A personal phone, a browser that cleared its cookies, a revoked till.
    expect(resolveAutoPrint(STORE_BOTH_ON, null)).toEqual({ kot: true, bill: true });
    expect(resolveAutoPrint(STORE_BOTH_ON, undefined)).toEqual({ kot: true, bill: true });
  });

  it('lets a device turn printing OFF against a store that turns it on', () => {
    // The event stand has no kitchen. `false` is an answer, not an absence —
    // this is the case `||` gets wrong and the reason the resolver uses `??`.
    expect(resolveAutoPrint(STORE_BOTH_ON, { auto_print_kot: false, auto_print_bill: false })).toEqual({
      kot: false,
      bill: false,
    });
  });

  it('lets a device turn printing ON against a store that leaves it off', () => {
    expect(resolveAutoPrint(STORE_BOTH_OFF, { auto_print_kot: true, auto_print_bill: true })).toEqual({
      kot: true,
      bill: true,
    });
  });

  it('resolves each switch independently', () => {
    // The counter overrides the receipt but defers on the kitchen ticket.
    expect(resolveAutoPrint(STORE_BOTH_OFF, { auto_print_kot: null, auto_print_bill: true })).toEqual({
      kot: false,
      bill: true,
    });
  });

  it('falls all the way back to the documented defaults', () => {
    // A deploy that lands before the store-settings migration, on a machine
    // that is not enrolled: still prints the kitchen's ticket.
    expect(resolveAutoPrint(null, null)).toEqual(AUTO_PRINT_DEFAULTS);
    expect(resolveAutoPrint(undefined, NO_OPINION)).toEqual(AUTO_PRINT_DEFAULTS);
  });
});

describe('resolveDefaultOrderType', () => {
  it('opens on the device default when it has one', () => {
    expect(resolveDefaultOrderType({ default_order_type: 'takeaway' })).toBe('takeaway');
    expect(resolveDefaultOrderType({ default_order_type: 'dine_in' })).toBe('dine_in');
  });

  it('opens on dine-in when nothing has an opinion', () => {
    expect(resolveDefaultOrderType(null)).toBe(POS_FALLBACK_ORDER_TYPE);
    expect(resolveDefaultOrderType({ default_order_type: null })).toBe('dine_in');
  });
});
