import { describe, expect, it } from 'vitest';
import { COUNTER_MODE_HREFS, nextNewOrderIds, readSoundPref } from '@/lib/staff/newOrderWatch';

// The staff shell's new-order watch and settings. The alarm now runs on every
// staff page, so what counts as "new" must match what the Orders page shows.

const set = (...ids: string[]) => new Set(ids);

describe('nextNewOrderIds', () => {
  it('treats orders already waiting on the first load as the baseline, not new', () => {
    expect(nextNewOrderIds(null, set('a', 'b'), set())).toEqual(set());
  });

  it('marks an order that arrives later as new', () => {
    expect(nextNewOrderIds(set('a'), set('a', 'b'), set())).toEqual(set('b'));
  });

  it('keeps a new order new until it leaves "received", then drops it', () => {
    expect(nextNewOrderIds(set('a', 'b'), set('a', 'b'), set('b'))).toEqual(set('b'));
    expect(nextNewOrderIds(set('a', 'b'), set('a'), set('b'))).toEqual(set());
  });

  it('never marks an old baseline order as new', () => {
    expect(nextNewOrderIds(set('a'), set('a', 'c'), set())).toEqual(set('c'));
  });
});

describe('readSoundPref', () => {
  it('is on unless this device turned it off', () => {
    expect(readSoundPref(null)).toBe(true);
    expect(readSoundPref(undefined)).toBe(true);
    expect(readSoundPref('on')).toBe(true);
    expect(readSoundPref('off')).toBe(false);
  });
});

describe('COUNTER_MODE_HREFS', () => {
  it('keeps Live orders, Orders, New order and Tables within reach', () => {
    expect([...COUNTER_MODE_HREFS]).toEqual(['/staff', '/staff/orders', '/staff/settle', '/staff/orders/new', '/staff/tables']);
  });
});
