import { describe, expect, it } from 'vitest';
import { INDIAN_STATES } from '@/lib/shop/address';
import { PREFIX_RANGES, stateForPincode } from '@/lib/shop/pincode';

describe('stateForPincode', () => {
  it.each([
    ['302001', 'Rajasthan'],
    ['560001', 'Karnataka'],
    ['110001', 'Delhi'],
    ['400001', 'Maharashtra'],
    ['600001', 'Tamil Nadu'],
    ['700001', 'West Bengal'],
    ['500001', 'Telangana'],
    ['380001', 'Gujarat'],
    ['781001', 'Assam'],
    ['160017', 'Chandigarh'],
    ['403001', 'Goa'],
    ['737101', 'Sikkim'],
    ['736101', 'West Bengal'],
    ['738000', 'West Bengal'],
    ['682001', null],
  ])('%s -> %s', (pin, state) => {
    expect(stateForPincode(pin)).toBe(state);
  });

  it('tolerates spaces inside the pin', () => {
    expect(stateForPincode('302 001')).toBe('Rajasthan');
  });

  it('returns null for invalid or short input', () => {
    for (const bad of ['', '3020', '3020011', '012345', 'abcdef', '30200a']) expect(stateForPincode(bad)).toBeNull();
    expect(stateForPincode(undefined as unknown as string)).toBeNull();
  });

  it('returns null for prefixes shared by more than one state or territory', () => {
    for (const pin of ['396001', '605001', '682551', '673310', '244001', '194101', '160055', '362520']) {
      expect(stateForPincode(pin)).toBeNull();
    }
  });

  it('only ever returns a state the address form knows', () => {
    for (let prefix = 100; prefix <= 999; prefix++) {
      const s = stateForPincode(`${prefix}001`);
      if (s) expect(INDIAN_STATES).toContain(s);
    }
  });

  it('never maps Diu (362520) to Gujarat', () => {
    expect(stateForPincode('362520')).not.toBe('Gujarat');
  });

  it('has no 3-digit prefix matched by more than one range', () => {
    for (let prefix = 100; prefix <= 999; prefix++) {
      const hits = PREFIX_RANGES.filter(([from, to]) => prefix >= from && prefix <= to);
      expect(hits.length, `prefix ${prefix}`).toBeLessThanOrEqual(1);
    }
  });
});
