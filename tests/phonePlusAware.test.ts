import { describe, expect, it } from 'vitest';
import { indianE164HonouringPlus, normalizeIndianMobile, normalizeIndianMobileHonouringPlus } from '@/lib/phone';
import { customerKey } from '@/lib/marketing/segments';

// A '+' states the country: '+6581234567' is Singapore, not the Indian mobile 6581234567 that
// normalizeIndianMobile (which throws the '+' away with every other non-digit) would make of it.
// Marketing consent is keyed by phone, so the two readings are different customers.

describe('normalizeIndianMobileHonouringPlus', () => {
  it.each([
    ['+919812345678', '9812345678'],
    ['+91 98123 45678', '9812345678'],
    ['+91-98123-45678', '9812345678'],
    ['9812345678', '9812345678'],
    ['09812345678', '9812345678'],
    ['919812345678', '9812345678'],
  ])('%s is Indian: %s', (input, out) => expect(normalizeIndianMobileHonouringPlus(input)).toBe(out));

  it.each(['+6581234567', '+65 8123 4567', '+6421234567', '+14155550123', '+447911123456', '+9812345678'])(
    '%s states a foreign country, so it is not Indian',
    (input) => expect(normalizeIndianMobileHonouringPlus(input)).toBeNull(),
  );

  it('the blind normaliser is the one that got it wrong (the regression this exists for)', () => {
    expect(normalizeIndianMobile('+6581234567')).toBe('6581234567');
  });

  it.each(['', '   ', 'abc', '12345', '5876543210', '+91 12345 67890'])('%j is not an Indian mobile', (input) => {
    expect(normalizeIndianMobileHonouringPlus(input)).toBeNull();
  });
});

describe('indianE164HonouringPlus', () => {
  it('gives +91XXXXXXXXXX for any Indian spelling, null for everything else', () => {
    expect(indianE164HonouringPlus('98123 45678')).toBe('+919812345678');
    expect(indianE164HonouringPlus('+919812345678')).toBe('+919812345678');
    expect(indianE164HonouringPlus('+6581234567')).toBeNull();
    expect(indianE164HonouringPlus(undefined)).toBeNull();
    expect(indianE164HonouringPlus(9812345678)).toBeNull();
  });
});

describe('customerKey (the weekly "distinct customers" identity)', () => {
  it('a foreign order phone is not counted as the Indian customer with the same ten digits', () => {
    const singapore = customerKey({ customer_phone: '+6581234567' });
    const indian = customerKey({ customer_phone: '+916581234567' });
    expect(indian).toBe('p:6581234567');
    expect(singapore).not.toBe(indian);
    expect(singapore).toBeNull();
  });

  it('still joins an Indian customer\'s spellings', () => {
    expect(customerKey({ customer_phone: '9812345678' })).toBe(customerKey({ customer_phone: '+919812345678' }));
  });
});
