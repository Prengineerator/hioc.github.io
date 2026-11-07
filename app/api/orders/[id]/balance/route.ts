import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';
import {
  parseSettleAdjustment,
  shortNeedsManager,
  STAFF_SETTLE_SHORT_LIMIT_INR,
  validateParts,
} from '@/lib/orders/payments';
import { bookingReferenceClash } from '@/lib/orders/settlePayment';
import { tenderBalances, validateCounterRefund, type PriorRefund, type TenderPart } from '@/lib/orders/refunds';
import {
  GIVE_BACK_REASON,
  PAID_CHANGE_MIGRATION,
  appendSettleReason,
  balanceActionError,
  balanceOf,
  hasBalanceColumns,
  settledInr,
  type BalanceAction,
} from '@/lib/orders/paidChange';
import type { OrderStatus, UserRole } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };
type Admin = ReturnType<typeof createAdminSupabaseClient>;

type BalanceOrder = {
  id: string;
  status: OrderStatus;
  version: number;
  payment_status: string;
  payment_method: string | null;
  total_inr: number | null;
  subtotal_inr: number;
  balance_due_inr?: number;
  /** Absent before 2026-09-settle-adjustments.sql. */
  settle_discount_inr?: number;
  tip_inr?: number;
  settle_reason?: string | null;
};

const MIN_REASON_LENGTH = 3;
const MAX_REASON_LENGTH = 200;

const STALE = (balance: number) =>
  `The balance on this bill is now ₹${Math.abs(balance)} ${balance > 0 ? 'to collect' : 'to give back'} — check it and try again.`;
const RACED = 'This bill was changed or settled by someone else — please re-check it and try again.';

// POST /api/orders/[id]/balance — settle the difference left on a PAID dine-in
// bill that was changed after it was paid (lib/orders/paidChange.ts; the
// change itself is POST /api/orders/[id]/amend). Three actions:
//
//   { action: 'collect', parts, adjustment? }   the customer pays what they owe:
//        the same tenders as any settle (cash with change, UPI, card, a dining
//        app with its booking ID, a split), validated against the BALANCE, and
//        the same ±₹5 round-off / short / tip adjustment and ₹50 manager rule.
//        The tenders are ADDED beside the ones already taken — never replacing
//        them — so the drawer counts each when it was taken.
//
//   { action: 'give_back', amount_inr, method?, reason? }   the café returns
//        what it owes, on one of the bill's tenders (you can't hand back more
//        cash than came in as cash). Recorded as a counter refund, which the
//        drawer and the reports already read; the bill stays 'paid'. Money
//        leaving the till: the `refund` permission (manager by default).
//
//   { action: 'write_off', amount_inr, reason }   the café lets an owed balance
//        go (the customer left): a settlement discount, under the same ₹50
//        manager rule as a short settle.
//
// `amount_inr` on give_back / write_off must be the balance the staffer saw:
// if another change moved it meanwhile, the request is refused rather than
// returning (or forgiving) the wrong amount. A collect's parts are checked
// against the server's balance the same way.
//
// Each action writes its money record first, then zeroes the balance under the
// optimistic version guard (and only while the bill is still paid with that
// balance); a lost race takes the money record back out. The version is bumped,
// so a change to the bill racing the settlement loses cleanly too. Audited in
// order_amendments ('settle_balance').
//
// PIN-3: gated by getCounterActor() — classic session first, an enrolled-device
// PIN operator only when there is no session at all; the operator's role is the
// one every permission check below is asked about.
export async function POST(request: Request, { params }: RouteParams) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const admin = createAdminSupabaseClient();
  const { data, error: readError } = await admin.from('orders').select('*').eq('id', id).maybeSingle();
  if (readError) return errorResponse(500, 'Failed to load the order');
  if (!data) return notFound();
  const order = data as BalanceOrder;

  if (!hasBalanceColumns(order)) {
    return errorResponse(409, `Settling a balance needs the database update ${PAID_CHANGE_MIGRATION}.`);
  }
  if (order.status === 'cancelled' || order.status === 'rejected') {
    return errorResponse(409, 'This order is no longer live — there is no balance to settle.');
  }
  if (order.payment_status !== 'paid') {
    return errorResponse(409, 'Only a paid bill has a balance to settle — settle the bill itself instead.');
  }

  const balance = balanceOf(order);
  const actionError = balanceActionError(body.action, balance);
  if (actionError) return errorResponse(balance === 0 ? 409 : 400, actionError);
  const action = body.action as BalanceAction;

  if (action === 'collect') return collect(admin, order, balance, body, actor.user.id, actor.role);
  if (action === 'give_back') return giveBack(admin, order, balance, body, actor.user, actor.role);
  return writeOff(admin, order, balance, body, actor.user.id, actor.role);
}

/** The customer pays what they owe: new tenders beside the ones already taken. */
async function collect(
  admin: Admin,
  order: BalanceOrder,
  balance: number,
  body: Record<string, unknown>,
  userId: string,
  role: UserRole,
) {
  const adjustment = parseSettleAdjustment(body.adjustment, balance);
  if (!adjustment.ok) return errorResponse(400, adjustment.error);
  if (shortNeedsManager(adjustment.shortInr) && role !== 'manager' && role !== 'owner') {
    return errorResponse(
      403,
      `A shortfall above ₹${STAFF_SETTLE_SHORT_LIMIT_INR} needs a manager or the owner to approve it.`,
    );
  }
  const adjusted = adjustment.shortInr > 0 || adjustment.tipInr > 0;
  if (adjusted && !('settle_discount_inr' in order)) {
    return errorResponse(409, 'A short or tip needs the database update supabase/2026-09-settle-adjustments.sql.');
  }

  const validated = validateParts(body.parts, balance, adjustment);
  if (!validated.ok) return errorResponse(400, validated.error);
  const { parts, changeInr } = validated;

  const clash = await bookingReferenceClash(admin, order.id, parts);
  if (clash) return errorResponse(clash.status, clash.error);

  // The tenders first, each stamped now (when this money came in).
  const { data: inserted, error: partsError } = await admin
    .from('order_payments')
    .insert(
      parts.map((p) => ({
        order_id: order.id,
        method: p.method,
        amount_inr: p.amount_inr,
        tendered_inr: p.tendered_inr ?? null,
        ...(p.reference ? { reference: p.reference } : {}),
        created_by: userId,
      })),
    )
    .select('id');
  if (partsError) {
    console.error(`balance collect: order_payments insert failed for order ${order.id}`, partsError);
    return errorResponse(500, 'Could not record the payment. Try again.');
  }
  const partIds = ((inserted ?? []) as { id: string }[]).map((r) => r.id);

  const adjustmentColumns = adjusted
    ? {
        settle_discount_inr: (order.settle_discount_inr ?? 0) + adjustment.shortInr,
        tip_inr: (order.tip_inr ?? 0) + adjustment.tipInr,
        settle_reason: appendSettleReason(order.settle_reason, adjustment.reason),
      }
    : {};
  const settled = await zeroBalance(admin, order, balance, adjustmentColumns);
  if (!settled.ok) {
    if (partIds.length > 0) {
      const { error } = await admin.from('order_payments').delete().in('id', partIds);
      if (error) console.error('balance collect rollback failed', error, partIds);
    }
    return settled.response;
  }

  await audit(admin, order.id, userId, {
    action: 'collect',
    amount_inr: balance,
    parts: parts.map((p) => ({ method: p.method, amount_inr: p.amount_inr })),
    ...(adjusted ? { short_inr: adjustment.shortInr, tip_inr: adjustment.tipInr, reason: adjustment.reason } : {}),
  });
  return respond(admin, order, { change_due_inr: changeInr });
}

/** The café returns what it owes, as a counter refund on one of the bill's tenders. */
async function giveBack(
  admin: Admin,
  order: BalanceOrder,
  balance: number,
  body: Record<string, unknown>,
  user: { id: string },
  role: UserRole,
) {
  // Money leaving the till — the same gate as a refund.
  if (!(await hasPermission(user as never, 'refund', role))) {
    return errorResponse(403, 'Manager permission required to give money back');
  }
  const owed = -balance;
  if (body.amount_inr !== owed) return errorResponse(409, STALE(balance));

  const note = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (note.length > MAX_REASON_LENGTH) {
    return errorResponse(400, `The reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
  }
  const reason = note ? `${GIVE_BACK_REASON} — ${note}` : GIVE_BACK_REASON;

  // What was actually taken, per tender, less what already went back.
  const [{ data: partRows, error: partsError }, { data: priorRows, error: priorError }] = await Promise.all([
    admin.from('order_payments').select('method, amount_inr').eq('order_id', order.id),
    admin.from('refunds').select('method, amount_inr').eq('order_id', order.id).eq('status', 'processed'),
  ]);
  if (partsError || priorError) return errorResponse(500, 'Failed to load how the bill was paid');
  let parts = (partRows ?? []) as TenderPart[];
  if (parts.length === 0 && order.payment_method && order.payment_method !== 'online') {
    // Not expected after a paid change (it writes the original tender), but a
    // bill settled before tender rows existed still has one tender: its method,
    // for what was taken (the bill as it is now, plus what is owed back).
    parts = [{ method: order.payment_method as TenderPart['method'], amount_inr: settledInr(order) }];
  }
  const validated = validateCounterRefund(tenderBalances(parts, (priorRows ?? []) as PriorRefund[]), body.method, owed);
  if (!validated.ok) return errorResponse(400, validated.error);

  const { data: refundRow, error: refundError } = await admin
    .from('refunds')
    .insert({
      payment_id: null,
      order_id: order.id,
      amount_inr: validated.amountInr,
      method: validated.method,
      reason,
      status: 'processed',
      created_by: user.id,
      processed_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (refundError || !refundRow) {
    console.error(`balance give-back: refund insert failed for order ${order.id}`, refundError);
    return errorResponse(500, 'Could not record the money given back. Try again.');
  }
  const refundId = (refundRow as { id: string }).id;

  // payment_status stays 'paid': this is the bill coming down, not a refund of it.
  const settled = await zeroBalance(admin, order, balance, {});
  if (!settled.ok) {
    const { error } = await admin.from('refunds').delete().eq('id', refundId);
    if (error) console.error('balance give-back rollback failed', error, refundId);
    return settled.response;
  }

  await audit(admin, order.id, user.id, {
    action: 'give_back',
    amount_inr: validated.amountInr,
    method: validated.method,
    reason,
    refund_id: refundId,
  });
  return respond(admin, order, { given_back: { method: validated.method, amount_inr: validated.amountInr } });
}

/** The café lets an owed balance go: a settlement discount, with a reason. */
async function writeOff(
  admin: Admin,
  order: BalanceOrder,
  balance: number,
  body: Record<string, unknown>,
  userId: string,
  role: UserRole,
) {
  if (body.amount_inr !== balance) return errorResponse(409, STALE(balance));
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    return errorResponse(
      400,
      `A reason (${MIN_REASON_LENGTH}–${MAX_REASON_LENGTH} characters) is required to let a balance go.`,
    );
  }
  if (shortNeedsManager(balance) && role !== 'manager' && role !== 'owner') {
    return errorResponse(
      403,
      `Letting go of more than ₹${STAFF_SETTLE_SHORT_LIMIT_INR} needs a manager or the owner to approve it.`,
    );
  }
  if (!('settle_discount_inr' in order)) {
    return errorResponse(409, 'Letting a balance go needs the database update supabase/2026-09-settle-adjustments.sql.');
  }

  const settled = await zeroBalance(admin, order, balance, {
    settle_discount_inr: (order.settle_discount_inr ?? 0) + balance,
    settle_reason: appendSettleReason(order.settle_reason, reason),
  });
  if (!settled.ok) return settled.response;

  await audit(admin, order.id, userId, { action: 'write_off', amount_inr: balance, reason });
  return respond(admin, order, {});
}

/**
 * Zeroes the balance under the optimistic guard: only if nobody changed the
 * bill since it was read (version), it is still paid, and its balance is still
 * the one being settled. Bumps the version, so a change racing this loses too.
 */
async function zeroBalance(
  admin: Admin,
  order: BalanceOrder,
  balance: number,
  extra: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const { data: guarded, error } = await admin
    .from('orders')
    .update({ balance_due_inr: 0, ...extra, version: order.version + 1 })
    .eq('id', order.id)
    .eq('version', order.version)
    .eq('payment_status', 'paid')
    .eq('balance_due_inr', balance)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(`balance settle: guarded update failed for order ${order.id}`, error);
    return { ok: false, response: errorResponse(500, 'Could not settle the balance. Try again.') };
  }
  if (!guarded) return { ok: false, response: errorResponse(409, RACED) };
  return { ok: true };
}

/** The audit row — after the guarded write, so a lost race leaves none. A failed one is logged, never fatal. */
async function audit(admin: Admin, orderId: string, userId: string, payload: Record<string, unknown>) {
  const { error } = await admin.from('order_amendments').insert({
    order_id: orderId,
    staff_id: userId,
    kind: 'settle_balance',
    payload,
  });
  if (error) {
    console.error(
      `order_amendments audit FAILED for balance settlement on order ${orderId} — is ${PAID_CHANGE_MIGRATION} applied?`,
      error,
    );
  }
}

async function respond(admin: Admin, order: BalanceOrder, extra: Record<string, unknown>) {
  await broadcastOrderEvent(order.id, order.status);
  const { data: full, error } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .eq('id', order.id)
    .single();
  if (error || !full) return errorResponse(500, 'Settled the balance but failed to reload the order');
  return NextResponse.json({ order: toOrderResponse(full as OrderRowWithItems), ...extra });
}
