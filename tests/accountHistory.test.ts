import { describe, expect, it } from 'vitest';

// The pure rules behind GET /api/account/history (ACC-2, widened so a
// customer logging in sees every order that belongs to them — web, counter,
// and unclaimed guest). No mocks: everything here is a function of its
// arguments, which is the whole reason it lives in lib/account/history.ts
// instead of inline in the route handler.

import {
  includeGuestOrdersByPhone,
  mergeOrderRows,
  ownsOrder,
  paginateOrderRows,
  type OrderIdRow,
} from '@/lib/account/history';

function row(id: string, created_at: string): OrderIdRow {
  return { id, created_at };
}

describe('mergeOrderRows', () => {
  it('combines multiple sources, newest first', () => {
    const owned = [row('a', '2026-09-20T10:00:00Z'), row('c', '2026-09-18T10:00:00Z')];
    const guest = [row('b', '2026-09-19T10:00:00Z')];
    expect(mergeOrderRows([owned, guest]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('dedupes an order that satisfies more than one source, keeping one copy', () => {
    // A staff-linked counter order (customer_user_id match) whose
    // customer_phone also matches the caller's own verified phone — it would
    // otherwise show up once from the owner-linked query and once from the
    // guest-phone query.
    const owned = [row('shared', '2026-09-20T10:00:00Z')];
    const guest = [row('shared', '2026-09-20T10:00:00Z'), row('only-guest', '2026-09-17T10:00:00Z')];
    const merged = mergeOrderRows([owned, guest]);
    expect(merged.map((r) => r.id)).toEqual(['shared', 'only-guest']);
    expect(merged).toHaveLength(2);
  });

  it('is stable when a source is empty (no verified phone -> no guest query)', () => {
    const owned = [row('a', '2026-09-20T10:00:00Z')];
    expect(mergeOrderRows([owned, []]).map((r) => r.id)).toEqual(['a']);
  });

  it('handles no sources at all', () => {
    expect(mergeOrderRows([])).toEqual([]);
    expect(mergeOrderRows([[], []])).toEqual([]);
  });

  it('treats equal timestamps as a stable tie (order not swapped)', () => {
    const same = '2026-09-20T10:00:00Z';
    const rows = [row('a', same), row('b', same)];
    expect(mergeOrderRows([rows]).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('paginateOrderRows', () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(`o${i}`, `2026-09-${25 - i}T00:00:00Z`));

  it('returns the first page and total/hasMore', () => {
    const page = paginateOrderRows(rows, 1, 10);
    expect(page.items.map((r) => r.id)).toEqual(rows.slice(0, 10).map((r) => r.id));
    expect(page.total).toBe(25);
    expect(page.hasMore).toBe(true);
  });

  it('returns the last (partial) page with hasMore false', () => {
    const page = paginateOrderRows(rows, 3, 10);
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
  });

  it('returns an empty page past the end', () => {
    const page = paginateOrderRows(rows, 4, 10);
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(25);
  });

  it('treats an invalid page (0, negative, non-integer) as page 1', () => {
    const first = paginateOrderRows(rows, 1, 10);
    expect(paginateOrderRows(rows, 0, 10)).toEqual(first);
    expect(paginateOrderRows(rows, -3, 10)).toEqual(first);
    expect(paginateOrderRows(rows, 1.5, 10)).toEqual(first);
  });

  it('handles an empty list', () => {
    expect(paginateOrderRows([], 1, 10)).toEqual({ items: [], total: 0, hasMore: false });
  });
});

describe('includeGuestOrdersByPhone — the widen-by-unverified-phone guard', () => {
  it('is true only when the CALLER has a verified phone on file', () => {
    expect(includeGuestOrdersByPhone({ phone: '+919876543210', phone_verified: true })).toBe(true);
  });

  it('is false when the phone is not verified, even if one is on file', () => {
    expect(includeGuestOrdersByPhone({ phone: '+919876543210', phone_verified: false })).toBe(false);
  });

  it('is false when verified is true but there is no phone to match against', () => {
    expect(includeGuestOrdersByPhone({ phone: null, phone_verified: true })).toBe(false);
    expect(includeGuestOrdersByPhone({ phone: '', phone_verified: true })).toBe(false);
  });

  it('is false for a missing profile row', () => {
    expect(includeGuestOrdersByPhone(null)).toBe(false);
    expect(includeGuestOrdersByPhone(undefined)).toBe(false);
  });
});

describe('ownsOrder — same three rules as the history route, for reorder (ACC-4)', () => {
  const ME = 'user-me';
  const STRANGER = 'user-stranger';
  const verifiedProfile = { phone: '+919876543210', phone_verified: true };

  it('owns a web order placed while logged in', () => {
    expect(ownsOrder({ user_id: ME, customer_user_id: null, customer_phone: null }, ME, null)).toBe(
      true,
    );
  });

  it('owns a counter order linked by customer_user_id, even with user_id null', () => {
    expect(
      ownsOrder({ user_id: null, customer_user_id: ME, customer_phone: '+910000000000' }, ME, null),
    ).toBe(true);
  });

  it('owns an unclaimed guest order matched by the caller\'s own VERIFIED phone', () => {
    expect(
      ownsOrder(
        { user_id: null, customer_user_id: null, customer_phone: '+919876543210' },
        ME,
        verifiedProfile,
      ),
    ).toBe(true);
  });

  it('does NOT own a guest order matched by phone when the caller is not verified', () => {
    expect(
      ownsOrder(
        { user_id: null, customer_user_id: null, customer_phone: '+919876543210' },
        ME,
        { phone: '+919876543210', phone_verified: false },
      ),
    ).toBe(false);
  });

  it('never owns an order plainly assigned to someone else, regardless of phone', () => {
    expect(
      ownsOrder({ user_id: STRANGER, customer_user_id: null, customer_phone: '+919876543210' }, ME, verifiedProfile),
    ).toBe(false);
  });

  it('is false for a missing order or a blank caller id', () => {
    expect(ownsOrder(null, ME, verifiedProfile)).toBe(false);
    expect(ownsOrder({ user_id: ME }, '', verifiedProfile)).toBe(false);
  });
});
