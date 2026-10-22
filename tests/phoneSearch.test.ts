import { describe, expect, it } from 'vitest';
import {
  MAX_SUGGESTIONS,
  mergeCustomerSuggestions,
  nameSearchTerm,
  phoneSearchPrefix,
  searchIsComplete,
  SEARCH_ACCOUNTS_LIMIT,
  SEARCH_LEGACY_LIMIT,
  SEARCH_ORDERS_LIMIT,
  suggestionsFromAnswer,
  type CustomerSuggestion,
} from '@/lib/customers/phoneSearch';

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

describe('nameSearchTerm', () => {
  it('needs at least 2 characters after trimming', () => {
    expect(nameSearchTerm('')).toBeNull();
    expect(nameSearchTerm('  a ')).toBeNull();
    expect(nameSearchTerm(' as ')).toBe('as');
  });

  it('collapses whitespace', () => {
    expect(nameSearchTerm('  Asha \t  Patel ')).toBe('Asha Patel');
  });

  it('strips characters that would widen an ilike pattern or break a filter', () => {
    expect(nameSearchTerm('%%')).toBeNull();
    expect(nameSearchTerm('a_')).toBeNull();
    expect(nameSearchTerm('as%ha')).toBe('as ha');
    expect(nameSearchTerm('a\\b,(c)*d')).toBe('a b c d');
  });

  it('caps the length', () => {
    expect(nameSearchTerm('x'.repeat(100))).toBe('x'.repeat(40));
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

describe('searchIsComplete', () => {
  const full = { accounts: 3, orders: 40, legacy: 2, merged: 4, failed: false };

  it('is complete when nothing was cut short', () => {
    expect(searchIsComplete(full)).toBe(true);
  });

  it('is not complete when any source hit its limit', () => {
    expect(searchIsComplete({ ...full, accounts: SEARCH_ACCOUNTS_LIMIT })).toBe(false);
    expect(searchIsComplete({ ...full, orders: SEARCH_ORDERS_LIMIT })).toBe(false);
    expect(searchIsComplete({ ...full, legacy: SEARCH_LEGACY_LIMIT })).toBe(false);
  });

  it('is not complete at six suggestions — there may have been a seventh', () => {
    expect(searchIsComplete({ ...full, merged: MAX_SUGGESTIONS })).toBe(false);
  });

  it('is not complete when a query failed', () => {
    expect(searchIsComplete({ ...full, failed: true })).toBe(false);
  });
});

describe('suggestionsFromAnswer', () => {
  const row = (phone: string): CustomerSuggestion => ({ phone, name: phone, order_count: 1, last_order_at: null });
  const customers = [row('9876512345'), row('9876598765'), row('9876500000')];

  it('reuses an answer for the same digits, complete or not (a backspace)', () => {
    expect(suggestionsFromAnswer({ digits: '98765', customers, complete: false }, '98765')).toBe(customers);
  });

  it('narrows a complete answer as more digits are typed, keeping its order', () => {
    const answer = { digits: '98765', customers, complete: true };
    expect(suggestionsFromAnswer(answer, '987651')).toEqual([row('9876512345')]);
    expect(suggestionsFromAnswer(answer, '9876')).toBeNull(); // shorter: the server may know more
    expect(suggestionsFromAnswer(answer, '987659')).toEqual([row('9876598765')]);
    expect(suggestionsFromAnswer(answer, '9876577')).toEqual([]);
  });

  it('leaves an incomplete answer to the server', () => {
    expect(suggestionsFromAnswer({ digits: '98765', customers, complete: false }, '987651')).toBeNull();
  });

  it('does not apply an answer for other digits', () => {
    expect(suggestionsFromAnswer({ digits: '98765', customers, complete: true }, '91234')).toBeNull();
  });
});
