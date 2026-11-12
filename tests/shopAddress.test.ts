import { describe, expect, it } from 'vitest';
import { INDIAN_STATES, validateShopAddress } from '@/lib/shop/address';

const GOOD = {
  customer_name: '  Riya   Sharma ',
  phone: '098765 43210',
  email: 'Riya@Example.COM',
  address_line1: '12, Rose Villa,\n MG Road',
  address_line2: 'Near City Mall',
  city: 'Jaipur',
  state: 'rajasthan',
  pincode: '302 001',
};

describe('validateShopAddress', () => {
  it('returns the stored form: trimmed, +91 phone, lowercased email, canonical state', () => {
    expect(validateShopAddress(GOOD)).toEqual({
      ok: true,
      address: {
        customer_name: 'Riya Sharma',
        phone: '+919876543210',
        email: 'riya@example.com',
        address_line1: '12, Rose Villa, MG Road',
        address_line2: 'Near City Mall',
        city: 'Jaipur',
        state: 'Rajasthan',
        pincode: '302001',
      },
    });
  });

  it('allows an empty second address line', () => {
    const r = validateShopAddress({ ...GOOD, address_line2: '' });
    expect(r.ok && r.address.address_line2).toBe('');
  });

  it.each([
    ['customer_name', { customer_name: 'R' }],
    ['phone', { phone: '12345' }],
    ['phone', { phone: '5876543210' }],
    ['email', { email: 'riya@' }],
    ['address_line1', { address_line1: 'abc' }],
    ['address_line2', { address_line2: 'x'.repeat(121) }],
    ['city', { city: '' }],
    ['state', { state: 'Atlantis' }],
    ['pincode', { pincode: '012345' }],
    ['pincode', { pincode: '30200' }],
  ])('points at %s when it is wrong', (field, patch) => {
    const r = validateShopAddress({ ...GOOD, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe(field);
  });

  it('treats a missing body as empty', () => {
    expect(validateShopAddress(null)).toMatchObject({ ok: false, field: 'customer_name' });
  });

  it('knows all 28 states and 8 union territories', () => {
    expect(INDIAN_STATES).toHaveLength(36);
    expect(INDIAN_STATES).toContain('Uttar Pradesh');
    expect(INDIAN_STATES).toContain('Delhi');
  });
});
