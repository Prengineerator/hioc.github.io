import 'server-only';

// The cash-drawer checkpoint engine (docs/PHASE-5-CASH-COUNTS.md, CC-2).
// Server-only DB access behind the pure contract in lib/cash/counts.ts — this
// file does the Supabase reads/writes; lib/cash/counts.ts stays framework-free
// so it is trivially unit-testable. Do not import this from a client component.
//
// TIMESTAMP / WINDOWING NOTE (read before touching cashFlowsBetween):
//
// The chain wants, for a window (from, to], "how much cash actually entered or
// left the drawer in that span". The schema gives us an exact answer for a
// SPLIT settlement (order_payments.created_at, POS4-1) and for a refund
// (refunds.processed_at) — both are written once, at the moment the money
// moved, and never touched again.
//
// A single-tender settle writes no order_payments row; it is windowed by
// orders.paid_at, which the trg_orders_paid_at trigger
// (supabase/2026-09-cash-counts.sql) stamps ONCE, with DB time, the first time
// the order becomes paid. It is deliberately NOT orders.updated_at: that moves
// on every later status change (preparing → ready → completed), which would
// count the same cash again in a later window and charge an honest staffer a
// phantom shortage.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizeDenoms, denomsTotalInr } from '@/lib/cash/denoms';
import { istBusinessDate } from '@/lib/cash/date';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import {
  expectedAtCount,
  shortageToCharge,
  type CashCountKind,
  type CashCountResult,
  type CashFlowsInWindow,
  type PunchCashRequirement,
  type PunchType,
} from '@/lib/cash/counts';
import type { CashDenoms } from '@/lib/types';

type Admin = SupabaseClient;

/** A `cash_counts` row as stored (see supabase/2026-09-cash-counts.sql). */
export interface CashCountRow {
  id: string;
  kind: CashCountKind;
  user_id: string;
  attendance_session_id: string | null;
  cash_day_id: string | null;
  business_date: string;
  denoms: CashDenoms | null;
  counted_total_inr: number | null;
  previous_count_id: string | null;
  expected_total_inr: number | null;
  variance_inr: number | null;
  override_by: string | null;
  override_reason: string | null;
  created_at: string;
}

// True when `error` means "the relation/column doesn't exist" — the migration
// (supabase/2026-09-cash-counts.sql) hasn't been applied yet, or a column it
// adds to an existing table is missing. PostgREST reports this as PGRST205
// (schema-cache miss) or 42703 (undefined_column); raw Postgres sometimes
// surfaces 42P01 (undefined_table). Mirrors the same check
// app/api/owner/staff/_lib.ts uses for staff_accounts, duplicated locally
// rather than imported across feature boundaries.
function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === '42703') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('schema cache') || msg.includes('does not exist');
}

interface CashCountSettings {
  required: boolean;
  toleranceInr: number;
}

/**
 * attendance_settings.cash_count_required / cash_count_tolerance_inr. Both
 * columns are added by supabase/2026-09-cash-counts.sql and are NOT (yet) on
 * the `AttendanceSettings` type in lib/types.ts (a contract gap — see the
 * handback report) so this reads them directly rather than going through
 * lib/attendance/settings.ts. Any failure (migration not applied, table
 * missing) degrades to "not required, no tolerance" — the safe default that
 * matches the owner decision that this feature ships OFF.
 */
async function getCashCountSettings(admin: Admin): Promise<CashCountSettings> {
  try {
    const { data, error } = await admin
      .from('attendance_settings')
      .select('cash_count_required, cash_count_tolerance_inr')
      .eq('is_singleton', true)
      .maybeSingle();
    if (error || !data) return { required: false, toleranceInr: 0 };
    const row = data as { cash_count_required?: boolean | null; cash_count_tolerance_inr?: number | null };
    return {
      required: Boolean(row.cash_count_required),
      toleranceInr: Number(row.cash_count_tolerance_inr ?? 0),
    };
  } catch (err) {
    console.error('getCashCountSettings: failed, defaulting to off', err);
    return { required: false, toleranceInr: 0 };
  }
}

/**
 * Cash settled/refunded/moved in the window (from, to] — see the module doc
 * comment above for how "settled" is windowed. Throws on a genuine query
 * failure against a table that should exist (orders, order_payments,
 * refunds); tolerates `cash_movements` not existing yet (it's new in this
 * migration) by treating it as "no movements".
 */
export async function cashFlowsBetween(
  admin: Admin,
  fromIso: string,
  toIso: string,
): Promise<CashFlowsInWindow> {
  // 1. POS4-1 split cash parts, by their OWN timestamp — the precise case.
  const { data: partRows, error: partsError } = await admin
    .from('order_payments')
    .select('amount_inr')
    .eq('method', 'cash')
    .gt('created_at', fromIso)
    .lte('created_at', toIso);
  if (partsError) {
    throw new Error(`cashFlowsBetween: order_payments query failed: ${partsError.message}`);
  }
  const splitCashInr = ((partRows ?? []) as { amount_inr: number | null }[]).reduce(
    (sum, p) => sum + (p.amount_inr ?? 0),
    0,
  );

  // 2. Single-tender cash settles, by when they were paid (orders.paid_at —
  //    see the module doc comment). A later refund moves payment_status on to
  //    partially_refunded/refunded; the cash still came in at paid_at, and the
  //    refund leaves the drawer separately in step 3.
  const { data: candidateOrders, error: ordersError } = await admin
    .from('orders')
    .select('id, total_inr, subtotal_inr')
    .in('payment_status', ['paid', 'partially_refunded', 'refunded'])
    .eq('payment_method', 'cash')
    .gt('paid_at', fromIso)
    .lte('paid_at', toIso);
  if (ordersError) {
    throw new Error(`cashFlowsBetween: orders query failed: ${ordersError.message}`);
  }
  const candidates = (candidateOrders ?? []) as {
    id: string;
    total_inr: number | null;
    subtotal_inr: number | null;
  }[];

  let legacyCashInr = 0;
  if (candidates.length > 0) {
    const { data: anyParts, error: anyPartsError } = await admin
      .from('order_payments')
      .select('order_id')
      .in(
        'order_id',
        candidates.map((o) => o.id),
      );
    if (anyPartsError) {
      throw new Error(`cashFlowsBetween: order_payments existence check failed: ${anyPartsError.message}`);
    }
    const hasParts = new Set(((anyParts ?? []) as { order_id: string }[]).map((p) => p.order_id));
    for (const o of candidates) {
      if (hasParts.has(o.id)) continue; // already counted via its own parts, step 1
      legacyCashInr += o.total_inr ?? o.subtotal_inr ?? 0;
    }
  }

  // 3. Refunds paid back OUT of the drawer, by when they were processed — not
  //    when the original order was placed or settled.
  const { data: refundRows, error: refundsError } = await admin
    .from('refunds')
    .select('amount_inr, method')
    .eq('status', 'processed')
    .gt('processed_at', fromIso)
    .lte('processed_at', toIso);
  if (refundsError) {
    throw new Error(`cashFlowsBetween: refunds query failed: ${refundsError.message}`);
  }
  const cashRefundedInr = ((refundRows ?? []) as { amount_inr: number | null; method?: string | null }[])
    .filter((r) => !r.method || r.method === 'cash')
    .reduce((sum, r) => sum + (r.amount_inr ?? 0), 0);

  // 4. Manual cash-in / cash-out entries. NEW table (this migration) — treat
  //    it not existing yet as "no movements" rather than failing the count.
  let cashOutInr = 0;
  let cashInInr = 0;
  const { data: moveRows, error: movesError } = await admin
    .from('cash_movements')
    .select('direction, amount_inr')
    .gt('created_at', fromIso)
    .lte('created_at', toIso);
  if (movesError) {
    if (!isMissingRelation(movesError)) {
      throw new Error(`cashFlowsBetween: cash_movements query failed: ${movesError.message}`);
    }
  } else {
    for (const m of (moveRows ?? []) as { direction: string; amount_inr: number | null }[]) {
      if (m.direction === 'out') cashOutInr += m.amount_inr ?? 0;
      else if (m.direction === 'in') cashInInr += m.amount_inr ?? 0;
    }
  }

  return {
    cashSettledInr: splitCashInr + legacyCashInr,
    cashRefundedInr,
    cashOutInr,
    cashInInr,
  };
}

/** The latest checkpoint that actually counted something (kind != 'override'), or null if none yet. */
export async function lastRealCount(admin: Admin): Promise<CashCountRow | null> {
  const { data, error } = await admin
    .from('cash_counts')
    .select('*')
    .neq('kind', 'override')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('lastRealCount: query failed (is supabase/2026-09-cash-counts.sql applied?)', error);
    return null;
  }
  return (data as CashCountRow | null) ?? null;
}

export interface RecordCountParams {
  kind: Exclude<CashCountKind, 'override'>;
  userId: string;
  denoms: unknown;
  attendanceSessionId?: string;
  cashDayId?: string;
}

/**
 * Records one real checkpoint and chains it to the previous one.
 *
 * Two-step write, deliberately: insert first (denoms/counted + the DB-default
 * `created_at`, no app-server timestamp anywhere), THEN compute the window as
 * (previous.created_at, this row's OWN created_at] and update expected/
 * variance onto it. This keeps every window boundary equal to a real
 * checkpoint's real DB timestamp, by construction — no app-server clock ever
 * enters the money math (the same DB-time discipline the punch route uses for
 * A-1). The alternative (compute the window against `now()` before inserting)
 * would let the stored row's actual `created_at` land a few ms later than the
 * window used to compute its own expected/variance — a subtle, permanent
 * mismatch for no benefit, since a two-step write costs one extra round trip.
 *
 * RESIDUAL RACE: two counts started within the same instant both read
 * `lastRealCount()` before either has inserted, so both chain off the same
 * previous checkpoint and each computes its own (correct, on its own) window
 * — but the two windows overlap, so whichever settle/refund activity happened
 * in that overlap gets counted by both. There is no advisory-lock RPC
 * available to serialize this. In practice two people are not expected to
 * count the same drawer within the same second, so this is accepted and
 * logged as a known gap rather than solved here.
 */
export async function recordCount(admin: Admin, params: RecordCountParams): Promise<CashCountResult> {
  const denoms = sanitizeDenoms(params.denoms);
  const countedTotalInr = denomsTotalInr(denoms);
  const previous = await lastRealCount(admin);
  const businessDate = istBusinessDate();

  const { data: inserted, error: insertError } = await admin
    .from('cash_counts')
    .insert({
      kind: params.kind,
      user_id: params.userId,
      attendance_session_id: params.attendanceSessionId ?? null,
      cash_day_id: params.cashDayId ?? null,
      business_date: businessDate,
      denoms,
      counted_total_inr: countedTotalInr,
      previous_count_id: previous?.id ?? null,
      expected_total_inr: null,
      variance_inr: null,
    })
    .select('*')
    .single();
  if (insertError || !inserted) {
    throw new Error(`recordCount: cash_counts insert failed: ${insertError?.message ?? 'no row returned'}`);
  }
  const row = inserted as CashCountRow;

  let expectedTotalInr: number | null = null;
  let varianceInr: number | null = null;
  let shortageInr = 0;

  if (previous) {
    const flows = await cashFlowsBetween(admin, previous.created_at, row.created_at);
    expectedTotalInr = expectedAtCount(previous.counted_total_inr ?? 0, flows);
    varianceInr = countedTotalInr - expectedTotalInr;

    const settings = await getCashCountSettings(admin);
    shortageInr = shortageToCharge(varianceInr, settings.toleranceInr);

    const { error: updateError } = await admin
      .from('cash_counts')
      .update({ expected_total_inr: expectedTotalInr, variance_inr: varianceInr })
      .eq('id', row.id);
    if (updateError) {
      console.error('recordCount: expected/variance update failed', updateError);
    }

    if (shortageInr > 0) {
      const { error: shortageError } = await admin.from('cash_shortages').insert({
        count_id: row.id,
        user_id: params.userId,
        original_user_id: params.userId,
        amount_inr: shortageInr,
        business_date: businessDate,
      });
      if (shortageError) {
        console.error('recordCount: cash_shortages insert failed', shortageError);
      }
    }
  }

  return {
    id: row.id,
    kind: params.kind,
    countedTotalInr,
    expectedTotalInr,
    varianceInr,
    shortageInr,
  };
}

export interface RecordOverrideParams {
  userId: string;
  punchType: PunchType;
  attendanceSessionId?: string;
}

/**
 * Records a 'override' checkpoint (nothing counted) and consumes the grant
 * that authorized it. Re-reads the grant itself (rather than trusting one
 * passed in from an earlier `cashRequirementFor` call) so the usability check
 * — unused, unexpired, matching user + punch type — is as fresh as possible.
 *
 * RESIDUAL RACE: the "mark used" update is guarded on `used_at is null`, but
 * if two requests both re-read the same still-unused grant before either
 * writes, both can insert an override checkpoint referencing it (the second
 * guarded update then affects 0 rows, logged, not fatal). Same class of gap
 * as recordCount's — no advisory lock available — and bounded: it can only
 * ever produce one EXTRA skip in the chain, never a double financial count,
 * because an override checkpoint carries no money.
 */
export async function recordOverride(admin: Admin, params: RecordOverrideParams): Promise<CashCountResult> {
  const nowIso = new Date().toISOString();
  const { data: overrideRow, error: findError } = await admin
    .from('cash_count_overrides')
    .select('id, reason, granted_by')
    .eq('user_id', params.userId)
    .eq('punch_type', params.punchType)
    .is('used_at', null)
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findError || !overrideRow) {
    throw new Error('recordOverride: no usable override found (expired, already used, or missing)');
  }
  const grant = overrideRow as { id: string; reason: string; granted_by: string };

  const { data: inserted, error: insertError } = await admin
    .from('cash_counts')
    .insert({
      kind: 'override',
      user_id: params.userId,
      attendance_session_id: params.attendanceSessionId ?? null,
      cash_day_id: null,
      business_date: istBusinessDate(),
      denoms: null,
      counted_total_inr: null,
      previous_count_id: null,
      expected_total_inr: null,
      variance_inr: null,
      override_by: grant.granted_by,
      override_reason: grant.reason,
    })
    .select('*')
    .single();
  if (insertError || !inserted) {
    throw new Error(`recordOverride: cash_counts insert failed: ${insertError?.message ?? 'no row returned'}`);
  }
  const row = inserted as CashCountRow;

  const { error: consumeError } = await admin
    .from('cash_count_overrides')
    .update({ used_at: nowIso, used_count_id: row.id })
    .eq('id', grant.id)
    .is('used_at', null);
  if (consumeError) {
    console.error('recordOverride: failed to mark the override used', consumeError);
  }

  return {
    id: row.id,
    kind: 'override',
    countedTotalInr: null,
    expectedTotalInr: null,
    varianceInr: null,
    shortageInr: 0,
  };
}

async function findUsableOverride(
  admin: Admin,
  userId: string,
): Promise<PunchCashRequirement['override']> {
  const { data, error } = await admin
    .from('cash_count_overrides')
    .select('punch_type, reason, granted_by, expires_at')
    .eq('user_id', userId)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { punch_type: PunchType; reason: string; granted_by: string; expires_at: string };
  const names = await getStaffDisplayNames(admin, [row.granted_by]);
  return {
    punchType: row.punch_type,
    reason: row.reason,
    grantedByName: names.get(row.granted_by) ?? 'A manager',
    expiresAt: row.expires_at,
  };
}

/**
 * What the caller owes before their NEXT punch: whether a count is required at
 * all, and whether they're already holding a usable override. Deliberately
 * fails ENTIRELY SAFE (required: false, override: null) on any error —
 * missing migration, missing column, an unexpected DB hiccup — because this
 * feature must never be able to accidentally block clocking in. Same
 * principle as the store-network flag (SECURITY-PLAYBOOK A-9c): a bug in an
 * auxiliary check should degrade to "off", not "nobody can punch".
 */
export async function cashRequirementFor(admin: Admin, userId: string): Promise<PunchCashRequirement> {
  try {
    const settings = await getCashCountSettings(admin);

    let handlesCash = true;
    if (settings.required) {
      const { data, error } = await admin
        .from('staff_accounts')
        .select('handles_cash')
        .eq('user_id', userId)
        .maybeSingle();
      if (!error && data) {
        handlesCash = Boolean((data as { handles_cash: boolean | null }).handles_cash);
      }
      // No row, a read error, or a missing column all fall through to the
      // documented default: true (handles_cash's own DB default).
    }

    const override = await findUsableOverride(admin, userId);

    return { required: settings.required && handlesCash, override };
  } catch (err) {
    console.error('cashRequirementFor: failed, defaulting to not-required', err);
    return { required: false, override: null };
  }
}
