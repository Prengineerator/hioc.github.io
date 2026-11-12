// CC-5 (docs/PHASE-5-CASH-COUNTS.md) — how payroll consumes and releases
// approved cash shortages, per the shortage state machine in lib/cash/counts.ts:
//
//   approved ──consume (finalize, ticked)──▶ approved + payroll_run_id = run
//            ◀──release (that run reversed)──
//
// Two things made the old inline version fragile:
//
//   * Marking at finalize updated by id alone. It now filters on the state the
//     machine requires (status 'approved', not yet consumed), reads back what
//     it actually marked, retries once, and REPORTS any shortfall.
//   * Releasing at reversal was the only thing standing between a reversed run
//     and its shortages being lost: a failed clear left them pointing at the
//     reversed run, no longer "unconsumed", never deducted again. Now a pointer
//     to a REVERSED run is read as unconsumed wherever payroll asks — a
//     reversed run's deductions are void by definition — so a failed release
//     strands nothing; the next finalize picks the shortage up and re-points it.
//
// The cash_counts / cash_shortages tables come from a migration that may not be
// applied yet (supabase/2026-09-cash-counts.sql); a missing table reads as no
// rows and releases as nothing, same as every other optional table payroll reads.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CashShortageRow {
  id: string;
  user_id: string;
  amount_inr: number;
  /** null, or a REVERSED run's id (a stale pointer a failed release left behind). */
  payroll_run_id: string | null;
}

type PgError = { code?: string; message?: string } | null | undefined;

/**
 * True when `error` means "the relation doesn't exist" — the cash-counts
 * migration hasn't been applied yet. PostgREST usually reports it as PGRST205
 * (schema-cache miss), raw Postgres as 42P01.
 */
export function isMissingRelation(error: PgError): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /relation .* does not exist|could not find the table|schema cache/i.test(error.message ?? '');
}

/**
 * Approved shortages in [from, to] that no ACTIVE payroll run has consumed:
 * payroll_run_id is null, or points at a run that has since been reversed.
 */
export async function loadUnconsumedApprovedShortages(
  admin: SupabaseClient,
  bounds: { from: string; to: string },
): Promise<CashShortageRow[]> {
  const { data } = await admin
    .from('cash_shortages')
    .select('id, user_id, amount_inr, payroll_run_id')
    .eq('status', 'approved')
    .gte('business_date', bounds.from)
    .lte('business_date', bounds.to);
  const rows = ((data ?? []) as CashShortageRow[]).map((r) => ({ ...r, payroll_run_id: r.payroll_run_id ?? null }));

  const pointed = [...new Set(rows.map((r) => r.payroll_run_id).filter((v): v is string => Boolean(v)))];
  if (pointed.length === 0) return rows;

  const { data: runRows, error } = await admin.from('payroll_runs').select('id, status').in('id', pointed);
  // If we cannot tell whether a run was reversed, assume it still stands:
  // deducting a shortage twice is worse than leaving it for the next look.
  const reversed = error
    ? new Set<string>()
    : new Set(((runRows ?? []) as { id: string; status: string }[]).filter((r) => r.status === 'reversed').map((r) => r.id));
  return rows.filter((r) => r.payroll_run_id === null || reversed.has(r.payroll_run_id));
}

export function sumShortagesByUser(rows: CashShortageRow[]): Map<string, number> {
  const byUser = new Map<string, number>();
  for (const r of rows) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + r.amount_inr);
  return byUser;
}

export interface MarkResult {
  marked: number;
  /** null when every row was marked. */
  error: string | null;
}

/**
 * consume: points `rows` at `runId`. Compare-and-set per current pointer (null,
 * or the reversed run it was stranded on) and status 'approved', so a row that
 * changed since the draft was computed is skipped and reported, never forced.
 */
export async function markShortagesConsumed(
  admin: SupabaseClient,
  runId: string,
  rows: readonly CashShortageRow[],
): Promise<MarkResult> {
  if (rows.length === 0) return { marked: 0, error: null };

  const groups = new Map<string | null, string[]>();
  for (const r of rows) {
    const key = r.payroll_run_id ?? null;
    groups.set(key, [...(groups.get(key) ?? []), r.id]);
  }

  let marked = 0;
  let lastError: string | null = null;
  for (const [pointer, ids] of groups) {
    const attempt = async () => {
      const base = admin
        .from('cash_shortages')
        .update({ payroll_run_id: runId })
        .in('id', ids)
        .eq('status', 'approved');
      const guarded = pointer === null ? base.is('payroll_run_id', null) : base.eq('payroll_run_id', pointer);
      return guarded.select('id');
    };
    let res: { data: unknown; error: PgError };
    try {
      res = await attempt();
      if (res.error) res = await attempt(); // one retry for a transient failure
    } catch (err) {
      res = { data: null, error: { message: err instanceof Error ? err.message : 'Could not mark cash shortages consumed.' } };
    }
    if (res.error) {
      lastError = res.error.message ?? 'Could not mark cash shortages consumed.';
      console.error('payroll: could not mark cash shortages consumed', runId, res.error);
      continue;
    }
    marked += ((res.data ?? []) as unknown[]).length;
  }

  if (lastError) return { marked, error: lastError };
  if (marked < rows.length) {
    return {
      marked,
      error: `${rows.length - marked} of ${rows.length} cash shortages changed before they could be marked as deducted.`,
    };
  }
  return { marked, error: null };
}

export interface ReleaseResult {
  cleared: number;
  error: string | null;
}

/**
 * release: unpoints every shortage consumed by `runId` (just reversed), with
 * one retry. A failure here is reported but no longer strands anything — see
 * loadUnconsumedApprovedShortages.
 */
export async function releaseShortagesForRun(admin: SupabaseClient, runId: string): Promise<ReleaseResult> {
  // Any row still pointing at a reversed run is stale by definition, so the
  // release filters on the pointer alone.
  const attempt = () =>
    admin.from('cash_shortages').update({ payroll_run_id: null }).eq('payroll_run_id', runId).select('id');
  let res: { data: unknown; error: PgError };
  try {
    res = await attempt();
    if (res.error && !isMissingRelation(res.error)) res = await attempt();
  } catch (err) {
    res = { data: null, error: { message: err instanceof Error ? err.message : 'Could not clear cash shortages.' } };
  }
  if (res.error) {
    // A missing cash-counts migration is not a failure worth reporting —
    // there was nothing to clear either way.
    if (isMissingRelation(res.error)) return { cleared: 0, error: null };
    console.error('payroll: could not clear cash_shortage payroll_run_id on reversal', runId, res.error);
    return { cleared: 0, error: res.error.message ?? 'Could not clear cash shortages.' };
  }
  return { cleared: ((res.data ?? []) as unknown[]).length, error: null };
}
