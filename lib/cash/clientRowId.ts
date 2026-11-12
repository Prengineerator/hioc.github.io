// Retry safety for the cash forms without a migration: the CLIENT names the
// row it is creating.
//
// A cash-out, cash-in or expense punched on a laggy tablet whose answer is
// lost gets tapped again — and used to be recorded twice, which the next count
// reads as cash missing (or the owner sees as a phantom expense). Both routes
// write a `cash_movements` row, whose primary key is
// `id uuid primary key default gen_random_uuid()` (supabase/2026-09-cash-counts.sql),
// so the client may supply it:
//
//  - the form mints ONE uuid per attempt (newClientRowId) and keeps it until
//    the entry is recorded or the form changes — a retry sends the same id;
//  - the route inserts with it; a retry whose first attempt landed hits the
//    primary key (23505) and is answered with the row already there (200),
//    when it is the same actor's same entry (sameEntry) — never recorded twice;
//  - the id is optional: without one the database picks it, exactly as before.
//
// Pure (no server-only): the forms and the routes share it.

import { isUuid } from '@/lib/api/constants';

/** A fresh uuid for a new attempt, or null when this browser can't make one (then none is sent). */
export function newClientRowId(): string | null {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    // RFC 4122 version 4 from 16 random bytes.
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return null;
}

export type ClientRowIdParse = { ok: true; id: string | null } | { ok: false; error: string };

/** The body's optional `id`: absent/null → none; otherwise it must be a uuid. */
export function parseClientRowId(raw: unknown): ClientRowIdParse {
  if (raw === undefined || raw === null) return { ok: true, id: null };
  if (!isUuid(raw)) return { ok: false, error: 'id must be a uuid (the entry id the form generated)' };
  return { ok: true, id: raw.toLowerCase() };
}

/** A unique violation (23505) — with a client id, the row with that id already exists. */
export function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

export interface CashEntryFacts {
  recorded_by: string;
  direction: string;
  amount_inr: number;
  reason?: string | null;
  category?: string | null;
}

/**
 * Whether the row already stored under the client's id is THIS request again
 * (same actor, same money, same reason/category) — answered as recorded — or
 * a different entry that happens to carry the id (refused, never overwritten).
 */
export function sameEntry(existing: CashEntryFacts, wanted: CashEntryFacts): boolean {
  return (
    existing.recorded_by === wanted.recorded_by &&
    existing.direction === wanted.direction &&
    existing.amount_inr === wanted.amount_inr &&
    (existing.reason ?? '') === (wanted.reason ?? '') &&
    (existing.category ?? null) === (wanted.category ?? null)
  );
}

export const ID_TAKEN_MESSAGE = 'That entry id is already used by a different entry — reload and try again.';
