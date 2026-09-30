// Coffee Pass — the database half (docs/COFFEE-PASS-SPEC.md). Reads shaped for
// the checkout, the counter and the owner screens, and thin wrappers over the
// SQL functions in supabase/2026-10-coffee-pass.sql. The rules themselves are
// lib/passes/rules.ts (pure, tested); this module only fetches and maps.
//
// Every function takes the admin client first (the caller has already done its
// own auth), logs a failure with console.error and returns an empty / 'error'
// result. NOTHING here throws: a pass problem must degrade to "no pass offered",
// never take an order or a receipt down with it.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingPassSchema, PASS_MIGRATION_HINT } from '@/lib/passes/api';
import type {
  CoffeePassPlan,
  PassAdjustCode,
  PassRedeemCode,
  PassRedemptionEntry,
  PassRestoreCode,
  PassSummary,
  PassVoidCode,
  UsablePass,
} from '@/lib/passes/types';

type Row = Record<string, unknown>;

/** The columns of v_coffee_pass_balances the screens read. */
export const PASS_BALANCE_COLUMNS =
  'id, plan_id, plan_name, drinks_total, drinks_used, drinks_credited, drinks_remaining, drink_value_inr, ' +
  'max_per_day, used_today, price_inr, starts_at, expires_at, status, state, order_id, drink_menu_item_id, drink_label, created_at';

export const PLAN_COLUMNS =
  'id, name, description, drinks_total, drinks_paid, validity_days, drink_value_inr, price_inr, max_per_day, gst_exempt, is_active, sort_order';

const VIEW = 'v_coffee_pass_balances';

function logFailure(what: string, error: unknown) {
  const hint = isMissingPassSchema(error as { code?: string; message?: string } | null) ? ` — ${PASS_MIGRATION_HINT}` : '';
  console.error(`coffee pass: ${what} failed${hint}`, error);
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

const PASS_STATES = new Set(['active', 'used_up', 'expired', 'refunded', 'void']);

function toPassSummary(row: Row): PassSummary {
  const status = row.status === 'refunded' || row.status === 'void' ? row.status : 'active';
  return {
    id: String(row.id),
    plan_id: String(row.plan_id),
    plan_name: String(row.plan_name ?? ''),
    drinks_total: num(row.drinks_total),
    drinks_used: num(row.drinks_used),
    drinks_credited: num(row.drinks_credited),
    drinks_remaining: num(row.drinks_remaining),
    drink_value_inr: num(row.drink_value_inr),
    max_per_day: numOrNull(row.max_per_day),
    used_today: num(row.used_today),
    price_inr: num(row.price_inr),
    starts_at: String(row.starts_at),
    expires_at: String(row.expires_at),
    status,
    state: PASS_STATES.has(String(row.state)) ? (row.state as PassSummary['state']) : 'expired',
    order_id: String(row.order_id),
    drink_menu_item_id: typeof row.drink_menu_item_id === 'string' && row.drink_menu_item_id ? row.drink_menu_item_id : null,
    drink_label: typeof row.drink_label === 'string' ? row.drink_label : '',
  };
}

/** A coffee_pass_plans row as the app sees it. */
export function toCoffeePassPlan(row: Row): CoffeePassPlan {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    drinks_total: num(row.drinks_total),
    drinks_paid: num(row.drinks_paid),
    validity_days: num(row.validity_days),
    // Both are null on every plan since per-drink pricing (CP-D24): never 0.
    drink_value_inr: numOrNull(row.drink_value_inr),
    price_inr: numOrNull(row.price_inr),
    max_per_day: numOrNull(row.max_per_day),
    gst_exempt: row.gst_exempt === true,
    is_active: row.is_active === true,
    sort_order: num(row.sort_order),
  };
}

/**
 * A customer's passes with their balances: the ones still in play first,
 * soonest-expiring first (the order they will be spent in), then the others,
 * newest first.
 *
 * `includeInactive` (default false) adds used-up, expired, refunded and void
 * passes. `limit` caps the whole list (default 50); `inactiveLimit` caps just
 * the non-active part (default: the same), so a screen can ask for "every
 * active pass plus the last 10 others".
 */
export async function loadPassSummaries(
  admin: SupabaseClient,
  userId: string,
  opts: { includeInactive?: boolean; limit?: number; inactiveLimit?: number } = {},
): Promise<PassSummary[]> {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 50));
  try {
    const active = await admin
      .from(VIEW)
      .select(PASS_BALANCE_COLUMNS)
      .eq('user_id', userId)
      .eq('state', 'active')
      .order('expires_at', { ascending: true })
      .limit(limit);
    if (active.error) {
      logFailure('loading passes', active.error);
      return [];
    }
    const out = ((active.data ?? []) as unknown as Row[]).map(toPassSummary);
    if (!opts.includeInactive || out.length >= limit) return out.slice(0, limit);

    const room = Math.min(limit - out.length, Math.max(0, Math.trunc(opts.inactiveLimit ?? limit)));
    if (room === 0) return out;
    const others = await admin
      .from(VIEW)
      .select(PASS_BALANCE_COLUMNS)
      .eq('user_id', userId)
      .neq('state', 'active')
      .order('created_at', { ascending: false })
      .limit(room);
    if (others.error) {
      logFailure('loading past passes', others.error);
      return out;
    }
    return out.concat(((others.data ?? []) as unknown as Row[]).map(toPassSummary).slice(0, room));
  } catch (error) {
    logFailure('loading passes', error);
    return [];
  }
}

/**
 * One pass by id, with its balance, whoever holds it (the caller has already
 * decided the actor may see it: a manager adjusting it). Null when there is no
 * such pass or the read failed.
 */
export async function loadPassSummaryById(admin: SupabaseClient, passId: string): Promise<PassSummary | null> {
  try {
    const { data, error } = await admin.from(VIEW).select(PASS_BALANCE_COLUMNS).eq('id', passId).maybeSingle();
    if (error) {
      logFailure('loading a pass', error);
      return null;
    }
    return data ? toPassSummary(data as unknown as Row) : null;
  } catch (error) {
    logFailure('loading a pass', error);
    return null;
  }
}

/**
 * The passes a customer can spend RIGHT NOW, with their full summaries (plan
 * name, expiry, cups left): active, in date, with cups left, soonest-expiring
 * first. The database decides `state` with its own clock; `now` is checked as
 * well so a pass that expired in the last moment is never offered.
 *
 * This is the one query behind both what the allocator spends
 * (loadUsablePasses) and what a screen shows the customer (the quote's `pass`
 * block, the counter's customer lookup), so the two can never disagree.
 */
export async function loadUsablePassSummaries(
  admin: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<PassSummary[]> {
  try {
    const { data, error } = await admin
      .from(VIEW)
      .select(PASS_BALANCE_COLUMNS)
      .eq('user_id', userId)
      .eq('state', 'active')
      .order('expires_at', { ascending: true });
    if (error) {
      logFailure('loading usable passes', error);
      return [];
    }
    return ((data ?? []) as unknown as Row[])
      .map(toPassSummary)
      .filter((p) => p.drinks_remaining > 0 && Date.parse(p.expires_at) > now.getTime());
  } catch (error) {
    logFailure('loading usable passes', error);
    return [];
  }
}

/** What the allocator needs to know about a pass (lib/passes/rules.ts allocatePassDrinks). */
export function toUsablePass(p: PassSummary): UsablePass {
  return {
    id: p.id,
    drinks_remaining: p.drinks_remaining,
    drink_value_inr: p.drink_value_inr,
    expires_at: p.expires_at,
    max_per_day: p.max_per_day,
    used_today: p.used_today,
  };
}

/** The passes a customer can spend right now, in the shape the allocator takes. */
export async function loadUsablePasses(
  admin: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<UsablePass[]> {
  return (await loadUsablePassSummaries(admin, userId, now)).map(toUsablePass);
}

/**
 * The ids of the menu items a pass can pay for (menu_items.pass_eligible).
 * Pass `menuItemIds` to check just the items in a cart. On any failure the set
 * is empty, which fails CLOSED: nothing is treated as eligible.
 */
export async function loadEligibleMenuIds(admin: SupabaseClient, menuItemIds?: string[]): Promise<Set<string>> {
  if (menuItemIds && menuItemIds.length === 0) return new Set();
  try {
    let query = admin.from('menu_items').select('id').eq('pass_eligible', true);
    if (menuItemIds) query = query.in('id', menuItemIds);
    const { data, error } = await query;
    if (error) {
      logFailure('loading eligible menu items', error);
      return new Set();
    }
    return new Set(((data ?? []) as unknown as Row[]).map((r) => String(r.id)));
  } catch (error) {
    logFailure('loading eligible menu items', error);
    return new Set();
  }
}

function orderPlans(plans: CoffeePassPlan[]): CoffeePassPlan[] {
  return plans.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

/** The plans on sale (is_active), in the owner's order. */
export async function loadActivePlans(admin: SupabaseClient): Promise<CoffeePassPlan[]> {
  try {
    const { data, error } = await admin
      .from('coffee_pass_plans')
      .select(PLAN_COLUMNS)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) {
      logFailure('loading plans', error);
      return [];
    }
    return orderPlans(((data ?? []) as unknown as Row[]).map(toCoffeePassPlan));
  } catch (error) {
    logFailure('loading plans', error);
    return [];
  }
}

/** One plan by id, active or not (the sale routes check is_active themselves); null when missing or unreadable. */
export async function loadPlanById(admin: SupabaseClient, planId: string): Promise<CoffeePassPlan | null> {
  try {
    const { data, error } = await admin.from('coffee_pass_plans').select(PLAN_COLUMNS).eq('id', planId).maybeSingle();
    if (error) {
      logFailure('loading a plan', error);
      return null;
    }
    return data ? toCoffeePassPlan(data as unknown as Row) : null;
  } catch (error) {
    logFailure('loading a plan', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The SQL functions. Each returns the function's own reason code, or 'error'
// when the call itself failed (network, a missing migration): an 'error' is the
// caller's cue to fail safe, never to assume success.
// ---------------------------------------------------------------------------

const REDEEM_CODES: readonly PassRedeemCode[] = ['ok', 'not_owner', 'inactive', 'expired', 'insufficient', 'daily_limit', 'bad_input'];
const VOID_CODES: readonly PassVoidCode[] = ['ok', 'used', 'not_found', 'already'];
const RESTORE_CODES: readonly PassRestoreCode[] = ['ok', 'not_found', 'not_voided', 'order_refunded'];
const ADJUST_CODES: readonly PassAdjustCode[] = ['ok', 'bad_input', 'not_found', 'inactive'];

async function callForCode<T extends string>(
  admin: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  codes: readonly T[],
): Promise<T | 'error'> {
  try {
    const { data, error } = await admin.rpc(fn, args);
    if (error) {
      logFailure(fn, error);
      return 'error';
    }
    if (typeof data === 'string' && (codes as readonly string[]).includes(data)) return data as T;
    console.error(`coffee pass: ${fn} returned an unexpected result`, data);
    return 'error';
  } catch (error) {
    logFailure(fn, error);
    return 'error';
  }
}

/**
 * Spends pass cups on an order, all or nothing, under a row lock on each pass.
 * `'ok'` also means "already redeemed for this order" (a retry). Anything else
 * is a refusal: the caller deletes the order and answers 409.
 */
export async function redeemPassDrinks(
  admin: SupabaseClient,
  args: {
    userId: string;
    orderId: string;
    allocations: { pass_id: string; order_item_id: string; drinks: number; covered_inr: number }[];
  },
): Promise<PassRedeemCode | 'error'> {
  return callForCode(
    admin,
    'coffee_pass_redeem',
    { p_user_id: args.userId, p_order_id: args.orderId, p_allocations: args.allocations },
    REDEEM_CODES,
  );
}

/** Voids the pass sold on `orderId` BEFORE its refund moves money (CP-D15): 'used' means a cup was spent, so refuse. */
export async function voidPassForRefund(admin: SupabaseClient, orderId: string): Promise<PassVoidCode | 'error'> {
  return callForCode(admin, 'coffee_pass_void_for_refund', { p_order_id: orderId }, VOID_CODES);
}

/** Undoes voidPassForRefund when the refund's money step failed. */
export async function restorePassAfterFailedRefund(
  admin: SupabaseClient,
  orderId: string,
): Promise<PassRestoreCode | 'error'> {
  return callForCode(admin, 'coffee_pass_restore_after_failed_refund', { p_order_id: orderId }, RESTORE_CODES);
}

/** A manager extends a pass by whole days or gives cups back; audited, with a reason (CP-D16). */
export async function adjustPass(
  admin: SupabaseClient,
  args: {
    passId: string;
    kind: 'extend' | 'credit';
    days?: number | null;
    drinks?: number | null;
    reason: string;
    actorId: string | null;
  },
): Promise<PassAdjustCode | 'error'> {
  return callForCode(
    admin,
    'coffee_pass_adjust',
    {
      p_pass_id: args.passId,
      p_kind: args.kind,
      p_days: args.days ?? null,
      p_drinks: args.drinks ?? null,
      p_reason: args.reason,
      p_actor: args.actorId,
    },
    ADJUST_CODES,
  );
}

/**
 * The uses of each pass, newest first, grouped by pass id (every id asked for
 * is present, with [] when unused). One entry per redeemed order line pair, so
 * an order that spent cups on two lines shows as two entries; `reversed` marks
 * cups that came back. `perPass` caps each list (default 20).
 */
export async function loadPassRedemptionHistory(
  admin: SupabaseClient,
  passIds: string[],
  opts: { perPass?: number } = {},
): Promise<Record<string, PassRedemptionEntry[]>> {
  const out: Record<string, PassRedemptionEntry[]> = {};
  for (const id of passIds) out[id] = [];
  if (passIds.length === 0) return out;
  const perPass = Math.max(1, Math.trunc(opts.perPass ?? 20));
  try {
    const { data, error } = await admin
      .from('coffee_pass_redemptions')
      .select('pass_id, order_id, drinks, covered_inr, created_at, reversed_at, orders(order_number)')
      .in('pass_id', passIds)
      .order('created_at', { ascending: false });
    if (error) {
      logFailure('loading pass history', error);
      return out;
    }
    for (const row of (data ?? []) as unknown as Row[]) {
      const list = out[String(row.pass_id)];
      if (!list || list.length >= perPass) continue;
      // PostgREST embeds a many-to-one as an object; tolerate an array too.
      const embedded = Array.isArray(row.orders) ? row.orders[0] : row.orders;
      const orderNumber = (embedded as Row | null | undefined)?.order_number;
      list.push({
        order_id: String(row.order_id),
        order_number: orderNumber === null || orderNumber === undefined ? null : num(orderNumber),
        drinks: num(row.drinks),
        covered_inr: num(row.covered_inr),
        created_at: String(row.created_at),
        reversed: row.reversed_at !== null && row.reversed_at !== undefined,
      });
    }
    return out;
  } catch (error) {
    logFailure('loading pass history', error);
    return out;
  }
}
