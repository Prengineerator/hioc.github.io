// Petpooja customer analytics for the owner dashboard — read-only aggregate
// stats for the period Aug 2023 – Sep 2026. Queries the legacy_customers table
// (service-role only, never touches 'orders' or loyalty ledger). Pure functions
// (phone masking, lapsed filtering, aggregates) are unit-testable.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

// ────────────────────────────────────────────────────────────────────────────
// Pure functions (no Supabase, unit-testable)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mask a phone number to show only the last 4 digits.
 * E.g. '+919876543210' → '••••••3210'
 * Falls back to '—' for empty/short/invalid input.
 */
export function maskPhoneNumber(phone: string | null | undefined): string {
  if (!phone || typeof phone !== 'string' || phone.length < 4) {
    return '—';
  }
  const last4 = phone.slice(-4);
  return '••••••' + last4;
}

/**
 * Normalize a phone number to '+91XXXXXXXXXX' format.
 * Handles both '+91XXXXXXXXXX' (E.164) and bare '10-digit' formats.
 * Returns null if the number is too short or invalid.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') return null;
  const trimmed = phone.trim();

  // Already in E.164 format
  if (trimmed.startsWith('+91')) {
    if (trimmed.length === 13) return trimmed;
    return null;
  }

  // Bare 10-digit format
  if (/^\d{10}$/.test(trimmed)) {
    return '+91' + trimmed;
  }

  return null;
}

/** A regular with no Petpooja bill and no app order for this long is lapsed. */
export const LAPSED_AFTER_DAYS = 60;

/**
 * Check if a customer is a "lapsed regular" — has ≥5 completed bills AND
 * last bill is older than LAPSED_AFTER_DAYS before `now` AND not in
 * recentAppPhones.
 */
export function isLapsedRegular(
  orderCount: number,
  lastOrderAt: string | null | undefined,
  phone: string,
  recentAppPhones: Set<string>,
  now: Date = new Date(),
): boolean {
  if (orderCount < 5 || !lastOrderAt) return false;
  if (recentAppPhones.has(phone)) return false; // Ordered in app recently
  const lastOrder = new Date(lastOrderAt);
  return lastOrder.getTime() <= now.getTime() - LAPSED_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Aggregate stats for a list of customers.
 */
export interface LegacyCustomerStats {
  totalCustomers: number;
  customersWithBills: number;
  repeatCustomers: number;
  totalSpendInr: number;
}

export function aggregateLegacyStats(
  customers: Array<{
    order_count: number;
    total_spend_inr: number;
  }>,
): LegacyCustomerStats {
  return {
    totalCustomers: customers.length,
    customersWithBills: customers.filter((c) => c.order_count > 0).length,
    repeatCustomers: customers.filter((c) => c.order_count >= 2).length,
    totalSpendInr: customers.reduce((sum, c) => sum + (c.total_spend_inr ?? 0), 0),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Supabase queries (service-role only)
// ────────────────────────────────────────────────────────────────────────────

export interface PetpoojaCustomerRow {
  phone: string;
  name: string;
  order_count: number;
  total_spend_inr: number;
  last_order_at: string | null;
}

/**
 * Display row for top customers or lapsed regulars.
 * `key` is used only for React's key prop — must never be rendered.
 */
export interface PetpoojaCustomerForDisplay {
  key: string; // Phone number, for React key only
  name: string;
  maskedPhone: string;
  orderCount: number;
  totalSpendInr: number;
  lastOrderAt: string | null;
}

export interface LegacyCustomerStats {
  totalCustomers: number;
  customersWithBills: number;
  repeatCustomers: number;
  totalSpendInr: number;
}

export interface PetpoojaOverview {
  ok: true;
  stats: LegacyCustomerStats;
  top: PetpoojaCustomerForDisplay[];
  lapsed: PetpoojaCustomerForDisplay[];
}

export interface PetpoojaOverviewFailure {
  ok: false;
}

/**
 * Fetch all Petpooja customers (paginated by PostgREST's 1000-row limit).
 * Returns only the columns needed: phone, name, order_count, total_spend_inr, last_order_at.
 * On error, returns null (no partial data).
 */
async function getAllPetpoojaCustomers(
  admin: SupabaseClient,
): Promise<PetpoojaCustomerRow[] | null> {
  const allCustomers: PetpoojaCustomerRow[] = [];
  const pageSize = 1000;
  let offset = 0;

  // Paginate through the legacy_customers table in 1000-row chunks.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await admin
      .from('legacy_customers')
      .select('phone, name, order_count, total_spend_inr, last_order_at')
      .order('phone')
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error('getAllPetpoojaCustomers: query failed', error);
      return null; // Return failure, not partial data
    }

    if (!data || data.length === 0) {
      break; // No more rows
    }

    allCustomers.push(
      ...(data as PetpoojaCustomerRow[]),
    );

    if (data.length < pageSize) {
      break; // Last page, fewer rows than requested
    }

    offset += pageSize;
  }

  return allCustomers;
}

/**
 * Distinct phones (normalized to '+91XXXXXXXXXX') on this app's orders from the
 * last 60 days, excluding rejected/cancelled ones — the people who must NOT be
 * shown as lapsed. Paged: at café volume 60 days is well over PostgREST's
 * 1000-row response cap, and a truncated set would wrongly list active app
 * customers as lapsed. Returns null on any error so the caller shows the
 * section as unavailable rather than a lapsed list it can't vouch for.
 */
async function getRecentAppOrderPhones(admin: SupabaseClient, now: Date): Promise<Set<string> | null> {
  const since = new Date(now.getTime() - LAPSED_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const phones = new Set<string>();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin
      .from('orders')
      .select('customer_phone')
      .gte('created_at', since)
      .not('status', 'in', '("rejected","cancelled")')
      .not('customer_phone', 'is', null)
      .order('id')
      .range(offset, offset + pageSize - 1);
    if (error) {
      console.error('getRecentAppOrderPhones: query failed', error);
      return null;
    }
    const rows = (data ?? []) as { customer_phone: string | null }[];
    for (const row of rows) {
      const phone = normalizePhone(row.customer_phone);
      if (phone) phones.add(phone);
    }
    if (rows.length < pageSize) return phones;
  }
}

/**
 * Build the complete Petpooja overview (stats, top customers, lapsed regulars)
 * from a single fetch of legacy_customers, normalized recent app order phones,
 * and current time. Pure function; unit-testable.
 */
export function buildPetpoojaOverview(
  customers: PetpoojaCustomerRow[],
  recentAppPhones: Set<string>,
  now: Date,
): PetpoojaOverview {
  const stats = aggregateLegacyStats(customers);

  const top = customers
    .filter((c) => c.order_count > 0)
    .sort((a, b) => (b.total_spend_inr ?? 0) - (a.total_spend_inr ?? 0))
    .slice(0, 10)
    .map((c) => ({
      key: c.phone,
      name: c.name || '—',
      maskedPhone: maskPhoneNumber(c.phone),
      orderCount: c.order_count,
      totalSpendInr: c.total_spend_inr ?? 0,
      lastOrderAt: c.last_order_at,
    }));

  const lapsed = customers
    .filter((c) => isLapsedRegular(c.order_count, c.last_order_at, c.phone, recentAppPhones, now))
    .sort((a, b) => b.order_count - a.order_count)
    .slice(0, 10)
    .map((c) => ({
      key: c.phone,
      name: c.name || '—',
      maskedPhone: maskPhoneNumber(c.phone),
      orderCount: c.order_count,
      totalSpendInr: c.total_spend_inr ?? 0,
      lastOrderAt: c.last_order_at,
    }));

  return {
    ok: true,
    stats,
    top,
    lapsed,
  };
}

/**
 * Fetch the complete Petpooja customer overview: stats, top customers by spend,
 * and lapsed regulars (excluding those who recently ordered in this app).
 * Single Supabase call for legacy_customers + one for recent app orders.
 * Returns failure on any error; never partial data.
 */
export async function getPetpoojaCustomerOverview(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<PetpoojaOverview | PetpoojaOverviewFailure> {
  try {
    const [customers, recentAppPhones] = await Promise.all([
      getAllPetpoojaCustomers(admin),
      getRecentAppOrderPhones(admin, now),
    ]);

    if (!customers || !recentAppPhones) {
      return { ok: false };
    }

    return buildPetpoojaOverview(customers, recentAppPhones, now);
  } catch (err) {
    console.error('getPetpoojaCustomerOverview: error', err);
    return { ok: false };
  }
}
