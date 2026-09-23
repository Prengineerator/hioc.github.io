// Shared helpers for app/api/owner/cash-shortages/** (docs/PHASE-5-CASH-COUNTS.md).
// Every route in this tree is owner-gated by its own handler (getOwnerUser())
// before any of this runs — nothing here re-checks auth.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import type { CashCountKind, ShortageStatus } from '@/lib/cash/counts';

type PgError = { code?: string; message?: string } | null | undefined;

/**
 * True when `error` means "the relation/column doesn't exist" — the
 * cash-counts migration (supabase/2026-09-cash-counts.sql) hasn't been
 * applied yet. Mirrors app/api/owner/staff/_lib.ts's isMissingTable.
 */
export function isMissingTable(error: PgError): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === '42703' || error.code === 'PGRST204' || error.code === 'PGRST205') {
    return true;
  }
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('schema cache') || msg.includes('does not exist');
}

/** A raw cash_shortages row, as selected by the routes in this tree. */
export interface ShortageRow {
  id: string;
  count_id: string;
  user_id: string;
  original_user_id: string;
  amount_inr: number;
  business_date: string;
  status: ShortageStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string;
  payroll_run_id: string | null;
  created_at: string;
}

export const SHORTAGE_COLUMNS =
  'id, count_id, user_id, original_user_id, amount_inr, business_date, status, decided_by, decided_at, decision_note, payroll_run_id, created_at';

interface CountRow {
  id: string;
  kind: CashCountKind;
  user_id: string;
  counted_total_inr: number | null;
  expected_total_inr: number | null;
  variance_inr: number | null;
  previous_count_id: string | null;
  created_at: string;
}

interface PreviousCountRow {
  id: string;
  counted_total_inr: number | null;
  user_id: string;
  created_at: string;
}

/** GET/PATCH response shape for one shortage — the count that revealed it
 * (counted vs expected) and that count's own previous count (who counted
 * last, and what), plus resolved display names throughout. */
export interface OwnerShortageRow {
  id: string;
  status: ShortageStatus;
  amountInr: number;
  businessDate: string;
  createdAt: string;
  /** Currently charged to (may differ from originalUserId after a reassign). */
  userId: string;
  userName: string;
  /** Whose count revealed the shortage — never changes, even across reassigns. */
  originalUserId: string;
  originalUserName: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string;
  /** True once an approved shortage has been deducted in a finalized payroll run — immutable from here on. */
  locked: boolean;
  count: {
    id: string;
    kind: CashCountKind;
    countedTotalInr: number | null;
    expectedTotalInr: number | null;
    varianceInr: number | null;
    createdAt: string;
  } | null;
  previousCount: {
    id: string;
    countedTotalInr: number | null;
    userId: string;
    userName: string;
    createdAt: string;
  } | null;
}

/**
 * Enriches raw cash_shortages rows with the count that revealed them (and
 * ITS previous count, for "counted vs expected, the previous count and who
 * did it" — docs/PHASE-5-CASH-COUNTS.md), plus display names. One batched
 * round trip per related table however many shortage rows come in.
 */
export async function buildShortageRows(
  admin: SupabaseClient,
  shortages: ShortageRow[],
): Promise<OwnerShortageRow[]> {
  if (shortages.length === 0) return [];

  const countIds = [...new Set(shortages.map((s) => s.count_id))];
  const { data: countRows, error: countErr } = await admin
    .from('cash_counts')
    .select('id, kind, user_id, counted_total_inr, expected_total_inr, variance_inr, previous_count_id, created_at')
    .in('id', countIds);
  if (countErr) console.error('buildShortageRows: cash_counts lookup failed', countErr);
  const counts = (countRows ?? []) as CountRow[];
  const countById = new Map(counts.map((c) => [c.id, c]));

  const previousIds = [...new Set(counts.map((c) => c.previous_count_id).filter((v): v is string => Boolean(v)))];
  let previousById = new Map<string, PreviousCountRow>();
  if (previousIds.length > 0) {
    const { data: prevRows, error: prevErr } = await admin
      .from('cash_counts')
      .select('id, counted_total_inr, user_id, created_at')
      .in('id', previousIds);
    if (prevErr) console.error('buildShortageRows: previous cash_counts lookup failed', prevErr);
    previousById = new Map(((prevRows ?? []) as PreviousCountRow[]).map((p) => [p.id, p]));
  }

  const ids = new Set<string>();
  for (const s of shortages) {
    ids.add(s.user_id);
    ids.add(s.original_user_id);
    if (s.decided_by) ids.add(s.decided_by);
  }
  for (const c of counts) ids.add(c.user_id);
  for (const p of previousById.values()) ids.add(p.user_id);
  const names = await getStaffDisplayNames(admin, [...ids]);

  return shortages.map((s) => {
    const count = countById.get(s.count_id) ?? null;
    const previous = count?.previous_count_id ? (previousById.get(count.previous_count_id) ?? null) : null;
    return {
      id: s.id,
      status: s.status,
      amountInr: s.amount_inr,
      businessDate: s.business_date,
      createdAt: s.created_at,
      userId: s.user_id,
      userName: names.get(s.user_id) ?? 'Unknown staff',
      originalUserId: s.original_user_id,
      originalUserName: names.get(s.original_user_id) ?? 'Unknown staff',
      decidedBy: s.decided_by,
      decidedByName: s.decided_by ? (names.get(s.decided_by) ?? 'Unknown staff') : null,
      decidedAt: s.decided_at,
      decisionNote: s.decision_note,
      locked: Boolean(s.payroll_run_id),
      count: count
        ? {
            id: count.id,
            kind: count.kind,
            countedTotalInr: count.counted_total_inr,
            expectedTotalInr: count.expected_total_inr,
            varianceInr: count.variance_inr,
            createdAt: count.created_at,
          }
        : null,
      previousCount: previous
        ? {
            id: previous.id,
            countedTotalInr: previous.counted_total_inr,
            userId: previous.user_id,
            userName: names.get(previous.user_id) ?? 'Unknown staff',
            createdAt: previous.created_at,
          }
        : null,
    };
  });
}

/** 'YYYY-MM' → the first/last calendar-date strings of that month. Mirrors
 * app/api/owner/payroll/route.ts's monthBounds. */
export function monthBounds(month: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
