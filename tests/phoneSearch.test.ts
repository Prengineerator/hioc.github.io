import { describe, expect, it } from 'vitest';
import { mergeCustomerSuggestions, phoneSearchPrefix } from '@/lib/customers/phoneSearch';

describe('phoneSearchPrefix', () => {
  it('searches from 4 digits up to 9', () => {
    expect(phoneSearchPrefix('987')).toBeNull();
    expect(phoneSearchPrefix('9876')).toBe('+919876');
    expect(phoneSearchPrefix('98765 432')).toBe('+9198765432');
  });

  it('leaves a full number to the exact lookup', () => {
    expect(phoneSearchPrefix('9876543210')).toBeNull();
    expect(phoneSearchPrefix('+91 98765 43210')).toBeNull();
  });

  it('ignores numbers that cannot be Indian mobiles', () => {
    expect(phoneSearchPrefix('1234')).toBeNull();
  });
});

describe('mergeCustomerSuggestions', () => {
  it('merges one row per phone, best name first, most recent visit first', () => {
    const rows = mergeCustomerSuggestions({
      accounts: [{ phone: '+919876500001', name: 'Asha (account)' }],
      orders: [
        { customer_phone: '+919876500002', customer_name: 'Ravi', created_at: '2026-09-25T10:00:00Z' },
        { customer_phone: '+919876500001', customer_name: 'asha', created_at: '2026-09-20T10:00:00Z' },
        { customer_phone: '+919876500002', customer_name: 'Ravi K', created_at: '2026-09-01T10:00:00Z' },
      ],
      legacy: [
        { phone: '+919876500001', name: 'Asha P', order_count: 12, last_order_at: '2026-08-01T10:00:00Z' },
        { phone: '+919876500003', name: 'Old Timer', order_count: 40, last_order_at: '2024-01-01T10:00:00Z' },
      ],
    });
    expect(rows).toEqual([
      { phone: '9876500002', name: 'Ravi', order_count: 2, last_order_at: '2026-09-25T10:00:00Z' },
      { phone: '9876500001', name: 'Asha (account)', order_count: 13, last_order_at: '2026-09-20T10:00:00Z' },
      { phone: '9876500003', name: 'Old Timer', order_count: 40, last_order_at: '2024-01-01T10:00:00Z' },
    ]);
  });

  it('skips blank or malformed phones and caps the list', () => {
    const orders = Array.from({ length: 10 }, (_, i) => ({
      customer_phone: `+91987650001${i}`,
      customer_name: `C${i}`,
      created_at: `2026-09-${10 + i}T10:00:00Z`,
    }));
    const rows = mergeCustomerSuggestions({
      accounts: [{ phone: null, name: 'x' }],
      orders: [...orders, { customer_phone: '', customer_name: 'blank', created_at: '2026-09-30T00:00:00Z' }],
      legacy: [],
    });
    expect(rows).toHaveLength(6);
    expect(rows[0].name).toBe('C9');
  });
});
