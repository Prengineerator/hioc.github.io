import { describe, expect, it } from 'vitest';
import {
  maskPhoneNumber,
  normalizePhone,
  isLapsedRegular,
  aggregateLegacyStats,
  buildPetpoojaOverview,
} from '@/lib/legacy/ownerStats';
import type { PetpoojaCustomerRow } from '@/lib/legacy/ownerStats';

describe('maskPhoneNumber', () => {
  it('masks a full phone number to show only last 4 digits', () => {
    expect(maskPhoneNumber('+919876543210')).toBe('••••••3210');
  });

  it('falls back to — for null', () => {
    expect(maskPhoneNumber(null)).toBe('—');
  });

  it('falls back to — for undefined', () => {
    expect(maskPhoneNumber(undefined)).toBe('—');
  });

  it('falls back to — for empty string', () => {
    expect(maskPhoneNumber('')).toBe('—');
  });

  it('falls back to — for strings shorter than 4 chars', () => {
    expect(maskPhoneNumber('123')).toBe('—');
    expect(maskPhoneNumber('ab')).toBe('—');
  });

  it('handles exactly 4 character strings', () => {
    expect(maskPhoneNumber('1234')).toBe('••••••1234');
  });

  it('handles non-phone strings', () => {
    expect(maskPhoneNumber('abcdefghij')).toBe('••••••ghij');
  });
});

describe('normalizePhone', () => {
  it('accepts E.164 format (+91XXXXXXXXXX)', () => {
    expect(normalizePhone('+919876543210')).toBe('+919876543210');
  });

  it('converts bare 10-digit format to E.164', () => {
    expect(normalizePhone('9876543210')).toBe('+919876543210');
  });

  it('returns null for invalid E.164 (wrong length)', () => {
    expect(normalizePhone('+919876543')).toBeNull();
    expect(normalizePhone('+91987654321099')).toBeNull();
  });

  it('returns null for numbers that are not 10 digits', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('123456789012')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('returns null for non-digit bare numbers', () => {
    expect(normalizePhone('abc7654321')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(normalizePhone('  9876543210  ')).toBe('+919876543210');
    expect(normalizePhone('  +919876543210  ')).toBe('+919876543210');
  });
});

describe('isLapsedRegular', () => {
  const phone = '+919876543210';
  const recentPhones = new Set<string>();

  it('returns false if order_count < 5', () => {
    const now = new Date('2026-09-26');
    const lastOrder = '2026-08-01'; // ~55 days ago
    expect(isLapsedRegular(4, lastOrder, phone, recentPhones, now)).toBe(false);
    expect(isLapsedRegular(0, lastOrder, phone, recentPhones, now)).toBe(false);
  });

  it('returns false if no last_order_at', () => {
    const now = new Date('2026-09-26');
    expect(isLapsedRegular(10, null, phone, recentPhones, now)).toBe(false);
    expect(isLapsedRegular(10, undefined, phone, recentPhones, now)).toBe(false);
  });

  it('returns false if phone is in recentPhones (ordered in app recently)', () => {
    const now = new Date('2026-09-26');
    const lastOrder = '2026-06-01'; // way more than 60 days ago
    const recentPhones2 = new Set([phone]);
    expect(isLapsedRegular(5, lastOrder, phone, recentPhones2, now)).toBe(false);
  });

  it('returns false if last order is within 60 days', () => {
    const now = new Date('2026-09-26');
    const lastOrder = '2026-08-27'; // exactly 30 days ago
    expect(isLapsedRegular(5, lastOrder, phone, recentPhones, now)).toBe(false);
  });

  it('returns true if last order is exactly 60 days ago (boundary)', () => {
    const now = new Date('2026-09-26');
    // 60 days before 2026-09-26 is 2026-07-27
    const lastOrder = '2026-07-27T00:00:00Z';
    expect(isLapsedRegular(5, lastOrder, phone, recentPhones, now)).toBe(true);
  });

  it('returns true if last order is older than 60 days and not in recent app orders', () => {
    const now = new Date('2026-09-26');
    const lastOrder = '2026-07-15'; // ~73 days ago
    expect(isLapsedRegular(5, lastOrder, phone, recentPhones, now)).toBe(true);
  });

  it('requires order_count >= 5, lapsed, and not in recentPhones', () => {
    const now = new Date('2026-09-26');
    const oldOrder = '2026-06-01';
    expect(isLapsedRegular(4, oldOrder, phone, recentPhones, now)).toBe(false); // not enough orders
    expect(isLapsedRegular(5, oldOrder, phone, recentPhones, now)).toBe(true); // all conditions met
    expect(isLapsedRegular(5, oldOrder, phone, new Set([phone]), now)).toBe(false); // in recent phones
  });
});

describe('aggregateLegacyStats', () => {
  it('counts zero customers when given empty array', () => {
    const stats = aggregateLegacyStats([]);
    expect(stats.totalCustomers).toBe(0);
    expect(stats.customersWithBills).toBe(0);
    expect(stats.repeatCustomers).toBe(0);
    expect(stats.totalSpendInr).toBe(0);
  });

  it('counts all customers and those with bills', () => {
    const customers = [
      { order_count: 0, total_spend_inr: 0 },
      { order_count: 1, total_spend_inr: 500 },
      { order_count: 3, total_spend_inr: 1500 },
    ];
    const stats = aggregateLegacyStats(customers);
    expect(stats.totalCustomers).toBe(3);
    expect(stats.customersWithBills).toBe(2); // order_count > 0
  });

  it('counts repeat customers as those with order_count >= 2', () => {
    const customers = [
      { order_count: 1, total_spend_inr: 100 },
      { order_count: 2, total_spend_inr: 400 },
      { order_count: 5, total_spend_inr: 1000 },
      { order_count: 0, total_spend_inr: 0 },
    ];
    const stats = aggregateLegacyStats(customers);
    expect(stats.repeatCustomers).toBe(2); // order_count >= 2
  });

  it('sums total_spend_inr', () => {
    const customers = [
      { order_count: 1, total_spend_inr: 100 },
      { order_count: 2, total_spend_inr: 200 },
      { order_count: 3, total_spend_inr: 300 },
    ];
    const stats = aggregateLegacyStats(customers);
    expect(stats.totalSpendInr).toBe(600);
  });

  it('handles null total_spend_inr as 0', () => {
    const customers = [
      { order_count: 1, total_spend_inr: 100 },
      { order_count: 2, total_spend_inr: null as unknown as number },
    ];
    const stats = aggregateLegacyStats(customers);
    expect(stats.totalSpendInr).toBe(100);
  });
});

describe('buildPetpoojaOverview', () => {
  it('returns ok: true with stats, top, and lapsed', () => {
    const now = new Date('2026-09-26');
    const customers: PetpoojaCustomerRow[] = [
      {
        phone: '+919876543210',
        name: 'Alice',
        order_count: 10,
        total_spend_inr: 5000,
        last_order_at: '2026-08-15',
      },
      {
        phone: '+919876543211',
        name: 'Bob',
        order_count: 5,
        total_spend_inr: 1000,
        last_order_at: '2026-07-01', // 86 days ago, lapsed
      },
    ];
    const recentPhones = new Set<string>();

    const overview = buildPetpoojaOverview(customers, recentPhones, now);
    expect(overview.ok).toBe(true);
    if (!overview.ok) return; // TypeScript guard
    expect(overview.stats.totalCustomers).toBe(2);
    expect(overview.stats.customersWithBills).toBe(2);
    expect(overview.top).toHaveLength(2);
    expect(overview.lapsed).toHaveLength(1);
  });

  it('excludes recent app order phones from lapsed', () => {
    const now = new Date('2026-09-26');
    const customers: PetpoojaCustomerRow[] = [
      {
        phone: '+919876543210',
        name: 'Charlie',
        order_count: 5,
        total_spend_inr: 2000,
        last_order_at: '2026-07-01', // Would be lapsed
      },
    ];
    const recentPhones = new Set(['+919876543210']); // This phone ordered in app recently

    const overview = buildPetpoojaOverview(customers, recentPhones, now);
    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.lapsed).toHaveLength(0); // Excluded because in recentPhones
  });

  it('sorts top customers by spend descending', () => {
    const now = new Date('2026-09-26');
    const customers: PetpoojaCustomerRow[] = [
      { phone: '+919876543210', name: 'Alice', order_count: 1, total_spend_inr: 500, last_order_at: '2026-09-01' },
      { phone: '+919876543211', name: 'Bob', order_count: 1, total_spend_inr: 2000, last_order_at: '2026-09-02' },
      { phone: '+919876543212', name: 'Charlie', order_count: 1, total_spend_inr: 1000, last_order_at: '2026-09-03' },
    ];
    const recentPhones = new Set<string>();

    const overview = buildPetpoojaOverview(customers, recentPhones, now);
    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.top[0].totalSpendInr).toBe(2000);
    expect(overview.top[1].totalSpendInr).toBe(1000);
    expect(overview.top[2].totalSpendInr).toBe(500);
  });

  it('sorts lapsed by order_count descending', () => {
    const now = new Date('2026-09-26');
    const customers: PetpoojaCustomerRow[] = [
      { phone: '+919876543210', name: 'Alice', order_count: 7, total_spend_inr: 1000, last_order_at: '2026-07-01' },
      { phone: '+919876543211', name: 'Bob', order_count: 5, total_spend_inr: 2000, last_order_at: '2026-07-02' },
      { phone: '+919876543212', name: 'Charlie', order_count: 10, total_spend_inr: 3000, last_order_at: '2026-07-03' },
    ];
    const recentPhones = new Set<string>();

    const overview = buildPetpoojaOverview(customers, recentPhones, now);
    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.lapsed[0].orderCount).toBe(10); // Highest order count first
    expect(overview.lapsed[1].orderCount).toBe(7);
    expect(overview.lapsed[2].orderCount).toBe(5);
  });
});
