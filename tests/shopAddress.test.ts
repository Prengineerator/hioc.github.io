import { describe, expect, it } from 'vitest';
import {
  INDIAN_STATES,
  SAVED_ADDRESS_LABELS,
  normalizeAddressLabel,
  sameDeliveryAddress,
  validateSavedAddress,
  validateShopAddress,
} from '@/lib/shop/address';

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
        landmark: '',
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

describe('landmark', () => {
  it('is optional, cleaned and returned', () => {
    const blank = validateShopAddress(GOOD);
    expect(blank.ok && blank.address.landmark).toBe('');
    const r = validateShopAddress({ ...GOOD, landmark: '  Opp.   Axis  Bank ' });
    expect(r.ok && r.address.landmark).toBe('Opp. Axis Bank');
  });

  it('rejects more than 80 characters', () => {
    expect(validateShopAddress({ ...GOOD, landmark: 'x'.repeat(81) })).toEqual({
      ok: false,
      field: 'landmark',
      error: 'Landmark is too long (80 characters at most)',
    });
  });
});

describe('validateSavedAddress', () => {
  const { email: _email, ...NO_EMAIL } = GOOD;

  it('needs no email and defaults the label to Home', () => {
    const r = validateSavedAddress(NO_EMAIL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.address.label).toBe('Home');
    expect(r.address.phone).toBe('+919876543210');
    expect('email' in r.address).toBe(false);
  });

  it('keeps a trimmed label and rejects one over 20 characters', () => {
    const r = validateSavedAddress({ ...NO_EMAIL, label: '  Work ' });
    expect(r.ok && r.address.label).toBe('Work');
    expect(validateSavedAddress({ ...NO_EMAIL, label: 'x'.repeat(21) })).toEqual({
      ok: false,
      field: 'label',
      error: 'Label is too long (20 characters at most)',
    });
  });

  it('applies the same field rules as the order form', () => {
    expect(validateSavedAddress({ ...NO_EMAIL, pincode: '12' })).toMatchObject({ ok: false, field: 'pincode' });
    expect(validateSavedAddress({ ...NO_EMAIL, phone: '123' })).toMatchObject({ ok: false, field: 'phone' });
  });

  it('normalizeAddressLabel and the label choices', () => {
    expect(normalizeAddressLabel('   ')).toBe('Home');
    expect(normalizeAddressLabel(' Mum ')).toBe('Mum');
    expect(SAVED_ADDRESS_LABELS).toEqual(['Home', 'Work', 'Other']);
  });
});

describe('sameDeliveryAddress', () => {
  const A = { phone: '+919876543210', pincode: '302001', address_line1: '12, Rose Villa, MG Road', address_line2: 'Near City Mall', city: 'Jaipur' };

  it('folds case and whitespace', () => {
    expect(sameDeliveryAddress(A, { ...A, address_line1: '  12,  ROSE villa, mg road', city: 'JAIPUR ' })).toBe(true);
  });

  it('differs on phone, pincode, street or city', () => {
    expect(sameDeliveryAddress(A, { ...A, phone: '+919876543211' })).toBe(false);
    expect(sameDeliveryAddress(A, { ...A, pincode: '302002' })).toBe(false);
    expect(sameDeliveryAddress(A, { ...A, address_line1: '13, Rose Villa, MG Road' })).toBe(false);
    expect(sameDeliveryAddress(A, { ...A, address_line2: '' })).toBe(false);
    expect(sameDeliveryAddress(A, { ...A, city: 'Jodhpur' })).toBe(false);
  });
});
