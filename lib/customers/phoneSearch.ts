// POS customer suggestions while a phone number is being typed (New order →
// Customer). The pure half: what counts as a searchable prefix, and how
// matches from app accounts, app orders and the Petpooja history merge into
// one short list. GET /api/customers/search runs the queries.

export const MIN_SEARCH_DIGITS = 4;
export const MAX_SUGGESTIONS = 6;

/**
 * The +91 prefix to search for, or null. Needs at least 4 digits (fewer would
 * list half the city) and fewer than 10 — a full number goes to the exact
 * lookup instead. A pasted +91/0 prefix is dropped first.
 */
export function phoneSearchPrefix(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length > 10 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length < MIN_SEARCH_DIGITS || digits.length >= 10) return null;
  if (!/^[6-9]/.test(digits)) return null; // Indian mobiles start 6–9
  return `+91${digits}`;
}

export interface CustomerSuggestion {
  /** 10 digits, ready for the phone field. */
  phone: string;
  name: string;
  /** Bills across the app and Petpooja (the app part is from recent orders). */
  order_count: number;
  last_order_at: string | null;
}

interface Sources {
  accounts: { phone: string | null; name: string | null }[];
  /** Most recent first. */
  orders: { customer_phone: string | null; customer_name: string | null; created_at: string }[];
  legacy: { phone: string | null; name: string | null; order_count: number | null; last_order_at: string | null }[];
}

const tenDigits = (e164: string | null) => (e164 && /^\+91[6-9]\d{9}$/.test(e164) ? e164.slice(3) : null);
const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a >= b ? a : b);

/**
 * One row per phone. Name: the verified account's, else the latest app
 * order's, else Petpooja's. Most recent visit first, then most orders.
 */
export function mergeCustomerSuggestions(sources: Sources, limit = MAX_SUGGESTIONS): CustomerSuggestion[] {
  const byPhone = new Map<string, CustomerSuggestion & { nameRank: number }>();
  const upsert = (phone: string | null, name: string | null, nameRank: number, count: number, last: string | null) => {
    const key = tenDigits(phone);
    if (!key) return;
    const cleanName = (name ?? '').trim();
    const row = byPhone.get(key) ?? { phone: key, name: '', nameRank: 99, order_count: 0, last_order_at: null };
    if (cleanName && nameRank < row.nameRank) {
      row.name = cleanName;
      row.nameRank = nameRank;
    }
    row.order_count += count;
    row.last_order_at = later(row.last_order_at, last);
    byPhone.set(key, row);
  };

  for (const a of sources.accounts) upsert(a.phone, a.name, 0, 0, null);
  // Orders arrive newest first, so the first name seen per phone is the latest.
  for (const o of sources.orders) upsert(o.customer_phone, o.customer_name, 1, 1, o.created_at);
  for (const l of sources.legacy) upsert(l.phone, l.name, 2, l.order_count ?? 0, l.last_order_at);

  return [...byPhone.values()]
    .sort(
      (a, b) =>
        (b.last_order_at ?? '').localeCompare(a.last_order_at ?? '') || b.order_count - a.order_count,
    )
    .slice(0, limit)
    .map(({ nameRank: _rank, ...row }) => row);
}
