import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { requestGatewayRefund } from '@/lib/payments/gateway';
import {
  REFUNDABLE_ROW_STATUSES,
  canTransitionPaymentRow,
  isOrphanCapture,
  paymentRowAfterRefund,
} from '@/lib/payments/paymentRowStateMachine';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { canTransitionPayment, isRefundable, paymentStatusAfterRefund } from '@/lib/orders/paymentStateMachine';
import {
  MONEY_MAY_HAVE_MOVED,
  REFUND_PENDING_MESSAGE,
  REFUND_UNCONFIRMED_MESSAGE,
  canTransitionRefund,
  hasPendingRefund,
  processedInr,
  refundStatusForOutcome,
  refundedOrPendingInr,
} from '@/lib/orders/refundStateMachine';
import { reverseForOrder } from '@/lib/loyalty/ledger';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { restorePassAfterFailedRefund, voidPassForRefund } from '@/lib/passes/server';
import { readIdempotencyKey } from '@/lib/orders/idempotency';
import { balanceOf, describeBalance, hasOpenBalance, type PaidChangeOrder } from '@/lib/orders/paidChange';
import {
  tenderBalances,
  validateCounterRefund,
  type PriorRefund,
  type TenderPart,
} from '@/lib/orders/refunds';
import type { PaymentMethod, PaymentStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/orders/[id]/refund — manager/owner only (FND-5 gate; FND-2/PAY-3).
// Issues a full or partial refund via the gateway against the order's most
// recent captured payment, writes a `refunds` row EITHER WAY (a failed gateway
// call is logged, never silently dropped per the FND-2 AC), and sets
// orders.payment_status to 'refunded' (fully) or 'partially_refunded'.
//
// The gateway refund's row follows lib/orders/refundStateMachine.ts: it is
// CLAIMED as 'pending' (with the Idempotency-Key) before Razorpay is asked to
// move money, then 'processed' when the gateway accepts or 'failed' when it
// definitely refuses (the key is released). A timeout or 5xx is neither: the
// row stays 'pending', the pass stays void, the answer is a 504 with code
// 'refund_unconfirmed', and no new gateway refund starts on that payment
// (409 'refund_pending') until someone has checked the Razorpay dashboard.
// Both payment statuses are then written from a fresh read of the refunds,
// compare-and-set. An ORPHAN capture (money taken after the order stopped
// waiting for it — lib/payments/reconcile.ts) is refunded the same way and
// leaves the order's own status alone. Any Beanies earned/redeemed on the order are clawed
// back (FND-4 edge case). Body: { amount_inr?: number, reason: string } —
// amount_inr omitted = full refund of whatever remains unrefunded.
//
// HIOC Ritual (CP-D15): refunding the SALE of a pass voids the pass BEFORE any
// money moves, and only if no cup has been used. See voidPassBeforeMoney below.
// PIN-3: gated by getCounterActor() — classic session first, unchanged; an
// enrolled-device PIN operator only when there is no session at all.
// roleHint = actor.role: hasPermission() would otherwise re-derive the role
// via the RLS-bound session client, which a device operator has none of.
export async function POST(request: Request, { params }: RouteParams) {
  // Gate via the owner-configurable matrix (FND3-6): a valid staff session, then
  // the 'refund' permission (default = manager-and-up, preserving FND-5 behavior).
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  const user = actor.user;
  if (!(await hasPermission(user, 'refund', actor.role))) {
    return errorResponse(403, 'Manager permission required for refunds');
  }

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return errorResponse(400, 'reason is required');
  }

  const admin = createAdminSupabaseClient();

  // REF-2: a refund moves money OUTWARD, so a replay is worse than a duplicate
  // order — guard_refund_total caps the total but does not deduplicate, and two
  // identical part-refunds are each under the cap. If this key already produced
  // a refund, return THAT one instead of issuing a second; if that one is still
  // waiting on the gateway's answer, say so rather than ask the gateway again.
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey) {
    const existing = await findRefundByKey(admin, idempotencyKey);
    if (existing) return replayOf(existing as RefundRow);
  }

  // `*` rather than a column list because order_kind (HIOC Ritual,
  // 2026-10-coffee-pass.sql) does not exist before that migration, and a select
  // naming an unknown column would fail every refund on such a database; here
  // it is simply absent, which reads as an ordinary menu order.
  const { data: order, error: orderError } = await admin
    .from('orders')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (orderError) return errorResponse(500, 'Failed to load order');
  if (!order) return notFound();

  // The latest gateway payment that still has money to give back: 'paid' or
  // 'partially_refunded' (the payments row machine, lib/payments/
  // paymentRowStateMachine.ts — a fully refunded row reads 'refunded').
  const { data: payment, error: paymentError } = await admin
    .from('payments')
    .select('id, gateway_payment_id, amount_inr, status, error')
    .eq('order_id', id)
    .in('status', [...REFUNDABLE_ROW_STATUSES])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (paymentError) return errorResponse(500, 'Failed to load payment');

  // An ORPHAN capture — money Razorpay took after the order stopped waiting for
  // it (cancelled, or paid at the counter after switching) — is refunded
  // whatever the order's own payment status says, and leaves that status alone:
  // the order never took that money.
  const orphan = Boolean(payment?.gateway_payment_id && isOrphanCapture(payment as { error?: string | null }));
  if (!orphan && !isRefundable(order.payment_status as string)) {
    return errorResponse(409, 'This order has no captured payment to refund.');
  }
  // A paid bill changed afterwards with a difference still open (lib/orders/
  // paidChange.ts): refunding it first left the balance behind on a bill that
  // is no longer 'paid' — the balance route then refused it and an amount
  // still owed blocked completion for good. Settle the difference first.
  if (!orphan && hasOpenBalance(order as PaidChangeOrder)) {
    const balance = balanceOf(order as PaidChangeOrder);
    return errorResponse(
      409,
      `This bill has ${describeBalance(balance)} — settle that on the Settle screen before refunding.`,
    );
  }

  // REF-1: a counter-settled order (cash/UPI/card taken at the till) has NO
  // payments row — those are written only by the gateway paths. Until now this
  // returned 409 and a walk-in customer simply could not be refunded in-system,
  // even though the staff UI offered the button. Route it to the counter path.
  const isPassSale = order.order_kind === 'coffee_pass';
  if (!payment || !payment.gateway_payment_id) {
    return counterRefund(admin, id, order as CounterOrder, body, reason, user.id, idempotencyKey, isPassSale);
  }

  // Every refund on this payment that may have moved money: processed, and
  // pending (claimed, the gateway's answer not known). A pending one blocks a
  // new refund outright — if it did go through, a second would pay the customer
  // twice — until someone has checked the Razorpay dashboard.
  const { data: priorRefunds, error: priorError } = await admin
    .from('refunds')
    .select('amount_inr, status')
    .eq('payment_id', payment.id)
    .in('status', [...MONEY_MAY_HAVE_MOVED]);
  if (priorError) return errorResponse(500, 'Failed to load prior refunds');
  const prior = (priorRefunds ?? []) as { amount_inr: number; status: string }[];
  if (hasPendingRefund(prior)) {
    return NextResponse.json({ error: REFUND_PENDING_MESSAGE, code: 'refund_pending' }, { status: 409 });
  }

  const alreadyRefunded = refundedOrPendingInr(prior);
  const refundable = payment.amount_inr - alreadyRefunded;
  if (refundable <= 0) {
    return errorResponse(409, 'This payment has already been fully refunded.');
  }

  let amountInr = refundable;
  if (body?.amount_inr !== undefined) {
    if (
      typeof body.amount_inr !== 'number' ||
      !Number.isInteger(body.amount_inr) ||
      body.amount_inr <= 0
    ) {
      return errorResponse(400, 'amount_inr must be a positive integer');
    }
    amountInr = body.amount_inr;
  }
  if (amountInr > refundable) {
    // Block partial refund exceeding what's left to refund (FND-2 edge case).
    return errorResponse(400, `amount_inr exceeds the refundable balance (₹${refundable})`);
  }

  // Every check that could refuse this refund has passed, so this is the moment
  // to void the pass: any earlier and a bad amount would leave a voided pass
  // and no refund.
  const passVoid = await voidPassBeforeMoney(admin, id, isPassSale);
  if (!passVoid.ok) return passVoid.response;

  // CLAIM the refund before any money moves (lib/orders/refundStateMachine.ts,
  // (create) → pending). The row carries the Idempotency-Key, so a second tap
  // with the same key meets the unique index here and never reaches the
  // gateway. Before, the key was stored only after the gateway call, so two
  // taps could both refund at Razorpay.
  const claim = await claimGatewayRefund(admin, {
    payment_id: payment.id,
    order_id: id,
    amount_inr: amountInr,
    reason,
    created_by: user.id,
    idempotencyKey,
  });
  if (!claim.ok) {
    if (claim.replay) return replayOf(claim.replay);
    // Nothing moved: the pass this call voided is good again.
    if (passVoid.voidedHere) await restorePassAfterFailedRefund(admin, id);
    return errorResponse(500, 'Could not start the refund — nothing was refunded. Please try again.');
  }

  const outcome = await requestGatewayRefund(payment.gateway_payment_id, amountInr, {
    reason,
    hioc_order_id: id,
  });
  const next = refundStatusForOutcome(outcome);

  if (next === 'failed') {
    // pending → failed: the gateway refused it, so no money moved. The key is
    // released with it (a retry is a fresh attempt), the pass this call voided
    // is good again, and the failed attempt stays on record (FND-2 AC).
    await resolveClaim(admin, claim.row.id, {
      status: 'failed',
      ...(claim.keyed ? { idempotency_key: null } : {}),
    });
    if (passVoid.voidedHere) await restorePassAfterFailedRefund(admin, id);
    return errorResponse(
      502,
      'Refund failed at the payment gateway — it has been logged; please retry.',
    );
  }

  if (next === null) {
    // No answer we can trust (a timeout, a 5xx): the money MAY have moved. The
    // row stays pending, the pass stays void, nothing is given back, and no new
    // gateway refund starts on this payment until someone has looked.
    console.error(
      `refund ${claim.row.id} on order ${id}: the gateway's answer is UNKNOWN — left pending. ` +
        `Check Razorpay payment ${payment.gateway_payment_id} for a ₹${amountInr} refund.`,
    );
    return NextResponse.json(
      { error: REFUND_UNCONFIRMED_MESSAGE, code: 'refund_unconfirmed', refund: claim.row },
      { status: 504 },
    );
  }

  // pending → processed.
  const processedRow = await resolveClaim(admin, claim.row.id, {
    status: 'processed',
    gateway_ref: outcome.kind === 'processed' ? outcome.refundId : '',
    processed_at: new Date().toISOString(),
  });
  if (!processedRow) {
    // The gateway refund already succeeded — log so it's investigable, but
    // don't fail the request over a bookkeeping write (money already moved).
    // The row still reads 'pending', so it keeps counting against what is left.
    console.error(`refund ${claim.row.id} on order ${id}: done at the gateway but could not be marked processed`);
  }

  // Both statuses from a FRESH read of what has gone back on this payment —
  // not the sum read before the gateway call (another refund may have landed).
  const refundedNow = await sumProcessed(admin, { payment_id: payment.id });
  if (refundedNow !== null) {
    const rowNext = paymentRowAfterRefund(payment.amount_inr, refundedNow);
    if (rowNext !== payment.status && canTransitionPaymentRow(payment.status as string, rowNext, 'refund')) {
      await admin.from('payments').update({ status: rowNext }).eq('id', payment.id).eq('status', payment.status);
    }
  }

  // The order's own payment status — not for an orphan, whose money the order never took.
  const written = orphan
    ? { order: order as Record<string, unknown>, status: order.payment_status as PaymentStatus }
    : await writeRefundedStatus(admin, id, payment.amount_inr, () => sumProcessed(admin, { payment_id: payment.id }));

  // Claw back Beanies ONLY on a FULL refund (H8). reverseForOrder reverses the
  // order's ENTIRE earn+redeem, so running it on a partial refund would wrongly
  // wipe all earned Beanies (e.g. a ₹10 refund on a ₹1000 order). A partial
  // refund leaves loyalty untouched.
  if (!orphan && written.status === 'refunded') {
    await reverseForOrder(id);
  }

  return NextResponse.json({ refund: processedRow ?? claim.row, order: written.order });
}

type Admin = ReturnType<typeof createAdminSupabaseClient>;
type RefundRow = { id: string; status?: string } & Record<string, unknown>;

/** The answer for a key that already has a refund: that refund, or "still waiting on the gateway". */
function replayOf(existing: RefundRow): NextResponse {
  if (existing.status === 'pending') {
    return NextResponse.json({ error: REFUND_PENDING_MESSAGE, code: 'refund_pending', refund: existing }, { status: 409 });
  }
  return NextResponse.json({ refund: existing, replayed: true });
}

type ClaimResult = { ok: true; row: RefundRow; keyed: boolean } | { ok: false; replay?: RefundRow };

/**
 * Inserts the 'pending' row that claims a gateway refund (and its key). A
 * duplicate key (23505) is the other tap's claim: its row is handed back. A
 * database without the idempotency column claims without the key, as before
 * the key existed (logged).
 */
async function claimGatewayRefund(
  admin: Admin,
  fields: {
    payment_id: string;
    order_id: string;
    amount_inr: number;
    reason: string;
    created_by: string;
    idempotencyKey: string | null;
  },
): Promise<ClaimResult> {
  if (!canTransitionRefund(null, 'pending', 'gateway')) return { ok: false };
  const { idempotencyKey, ...row } = fields;
  const insert = (withKey: boolean) =>
    admin
      .from('refunds')
      .insert({ ...row, status: 'pending', ...(withKey && idempotencyKey ? { idempotency_key: idempotencyKey } : {}) })
      .select('*')
      .single();

  let keyed = Boolean(idempotencyKey);
  let { data, error } = await insert(keyed);
  if (error && keyed && (error as { code?: string }).code === '23505') {
    const already = await findRefundByKey(admin, idempotencyKey!);
    return { ok: false, replay: (already as RefundRow | null) ?? undefined };
  }
  if (error && keyed && isMissingColumnError(error)) {
    console.error(
      'refunds.idempotency_key is missing — claiming this refund WITHOUT replay protection. ' +
        'Is supabase/2026-08-refund-idempotency.sql applied?',
      error,
    );
    keyed = false;
    ({ data, error } = await insert(false));
  }
  if (error || !data) {
    console.error('refund claim (pending row) insert failed — no money was moved', error);
    return { ok: false };
  }
  return { ok: true, row: data as RefundRow, keyed };
}

/** pending → processed | failed, only from pending. The row as written, or null when it didn't move. */
async function resolveClaim(
  admin: Admin,
  refundId: string,
  patch: { status: 'processed' | 'failed' } & Record<string, unknown>,
): Promise<RefundRow | null> {
  if (!canTransitionRefund('pending', patch.status, 'gateway')) return null;
  const { data, error } = await admin
    .from('refunds')
    .update(patch)
    .eq('id', refundId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) console.error(`refund ${refundId}: pending → ${patch.status} failed`, error);
  return (data as RefundRow | null) ?? null;
}

/**
 * Rupees processed against one gateway payment, or on one order, read fresh
 * (the bucket the refund being recorded belongs to). Null on a read error.
 */
async function sumProcessed(
  admin: Admin,
  by: { payment_id: string } | { order_id: string },
): Promise<number | null> {
  const base = admin.from('refunds').select('amount_inr, status').eq('status', 'processed');
  const { data, error } = 'payment_id' in by ? await base.eq('payment_id', by.payment_id) : await base.eq('order_id', by.order_id);
  if (error) {
    console.error('refund total re-read failed — payment status left as it was', error);
    return null;
  }
  return processedInr((data ?? []) as { amount_inr: number; status: string }[]);
}

// How many times the payment-status write re-reads and retries when the order
// moved between its read and its write.
const STATUS_WRITE_ATTEMPTS = 3;

/**
 * Writes the order's payment status after a refund, from a FRESH read of the
 * order and of what has gone back, compare-and-set on the status (and version)
 * it read — so a refund or capture that landed meanwhile is counted, never
 * overwritten. Before, it was computed from the refunds read before the money
 * moved and written blind. Returns the order as it now stands.
 */
async function writeRefundedStatus(
  admin: Admin,
  id: string,
  takenInr: number,
  loadRefunded: () => Promise<number | null>,
): Promise<{ order: Record<string, unknown> | null; status: PaymentStatus | null }> {
  let last: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < STATUS_WRITE_ATTEMPTS; attempt++) {
    const { data: fresh } = await admin.from('orders').select('*').eq('id', id).maybeSingle();
    if (!fresh) return { order: last, status: null };
    last = fresh as Record<string, unknown>;
    const from = fresh.payment_status as PaymentStatus;
    // Already moved on (another refund finished it): nothing more to write.
    if (!isRefundable(from)) return { order: last, status: from };
    const refunded = await loadRefunded();
    if (refunded === null) return { order: last, status: from };
    const next = paymentStatusAfterRefund(takenInr, refunded);
    if (next === from) return { order: last, status: from };
    if (!canTransitionPayment(from, next, 'refund', 'counter').ok) {
      console.error(`order ${id}: refund status ${from} → ${next} is not a machine move — left as it was`);
      return { order: last, status: from };
    }
    const version = typeof fresh.version === 'number' ? (fresh.version as number) : null;
    let write = admin
      .from('orders')
      .update({ payment_status: next, ...(version !== null ? { version: version + 1 } : {}) })
      .eq('id', id)
      .eq('payment_status', from);
    if (version !== null) write = write.eq('version', version);
    const { data: updated, error } = await write.select('*').maybeSingle();
    if (error) {
      console.error('order payment_status update after refund failed', error);
      return { order: last, status: from };
    }
    if (updated) return { order: updated as Record<string, unknown>, status: next };
  }
  console.error(`order ${id}: the payment status after this refund kept losing races — left as last read`);
  return { order: last, status: (last?.payment_status as PaymentStatus | undefined) ?? null };
}

/**
 * CP-D15 — before a refund on the SALE of a HIOC Ritual pass moves money, void
 * the pass. Any refund on a pass sale cancels the pass (so a sale paid in two
 * tenders can be refunded one tender at a time), and a pass with a cup already
 * used cannot be refunded in the app at all.
 *
 *   'used'      a cup was spent: 409, nothing moves
 *   'ok'        THIS call voided it: `voidedHere`, so if the money step then
 *               fails the caller must give the pass back
 *   'already'   an earlier refund voided it: carry on
 *   'not_found' no pass was ever issued for this sale (it was refunded before
 *               the trigger ran, or predates the feature): carry on
 *   'error'     the call itself failed: 503, nothing moves, because refunding
 *               without knowing whether cups were spent could pay back a pass
 *               that has been drunk
 *
 * Not gated on the feature flag: a sale made while it was on is still refunded
 * correctly after it is switched off. An order that is not a pass sale skips
 * all of this (`isPassSale` false), which is every order before the feature.
 */
async function voidPassBeforeMoney(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  orderId: string,
  isPassSale: boolean,
): Promise<{ ok: true; voidedHere: boolean } | { ok: false; response: NextResponse }> {
  if (!isPassSale) return { ok: true, voidedHere: false };
  const code = await voidPassForRefund(admin, orderId);
  switch (code) {
    case 'used':
      return {
        ok: false,
        response: errorResponse(409, `This ${PASS_PROGRAM_NAME} has already been used — it can't be refunded.`),
      };
    case 'error':
      return {
        ok: false,
        response: errorResponse(503, `${PASS_PROGRAM_NAME} is temporarily unavailable — please try the refund again.`),
      };
    case 'ok':
      return { ok: true, voidedHere: true };
    default: // 'already' | 'not_found'
      return { ok: true, voidedHere: false };
  }
}

type CounterOrder = {
  id: string;
  payment_status: string;
  payment_method: PaymentMethod | null;
  total_inr: number | null;
  subtotal_inr: number;
};

/**
 * REF-1 — refund an order settled at the counter. No gateway is involved: the
 * money physically leaves the drawer, or the staffer reverses a UPI/card charge
 * on the terminal. This records WHAT was given back and ON WHICH TENDER, which
 * the cash day then reads so the drawer reconciles.
 *
 * D4-2: the tender is chosen, never spread proportionally — see lib/orders/refunds.ts.
 */
/**
 * REF-2 — the refund a given Idempotency-Key already produced, or null.
 * `idempotency_key` carries a partial UNIQUE index, so this is the read half of
 * the replay guard; the index itself is the hard guarantee against a race.
 */
async function findRefundByKey(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  key: string,
): Promise<unknown | null> {
  const { data, error } = await admin
    .from('refunds')
    .select('*')
    .eq('idempotency_key', key)
    .maybeSingle();
  if (error) {
    // Most likely the column is missing (migration not applied). Losing replay
    // protection is bad; refusing a legitimate refund is worse — proceed, and
    // say which migration would have prevented it.
    console.error(
      'refund idempotency lookup failed — proceeding WITHOUT replay protection. ' +
        'Is supabase/2026-08-refund-idempotency.sql applied?',
      error,
    );
    return null;
  }
  return data ?? null;
}

async function counterRefund(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  id: string,
  order: CounterOrder,
  body: Record<string, unknown> | null,
  reason: string,
  userId: string,
  idempotencyKey: string | null,
  isPassSale: boolean,
) {
  // What was actually taken, per tender. POS4-1 orders have parts; anything
  // older is a single tender for the whole total.
  const { data: partRows, error: partsError } = await admin
    .from('order_payments')
    .select('method, amount_inr')
    .eq('order_id', id);
  if (partsError) return errorResponse(500, 'Failed to load the payment breakdown');

  let parts = (partRows ?? []) as TenderPart[];
  if (parts.length === 0) {
    if (!order.payment_method) {
      return errorResponse(409, 'This order has no recorded payment method to refund against.');
    }
    parts = [
      { method: order.payment_method, amount_inr: order.total_inr ?? order.subtotal_inr },
    ];
  }

  const { data: priorRows, error: priorError } = await admin
    .from('refunds')
    .select('method, amount_inr')
    .eq('order_id', id)
    .eq('status', 'processed');
  if (priorError) return errorResponse(500, 'Failed to load prior refunds');
  const prior = (priorRows ?? []) as PriorRefund[];

  const balances = tenderBalances(parts, prior);
  const validated = validateCounterRefund(balances, body?.method, body?.amount_inr);
  if (!validated.ok) {
    // A "nothing left" is a state conflict; a bad method/amount is a bad request.
    const status = /already been fully refunded|Nothing left/i.test(validated.error) ? 409 : 400;
    return errorResponse(status, validated.error);
  }

  // Recording the refund IS the money step at the counter (the cash leaves the
  // drawer / the terminal reverses), so the pass is voided just before it, once
  // the tender and amount have been accepted (CP-D15).
  const passVoid = await voidPassBeforeMoney(admin, id, isPassSale);
  if (!passVoid.ok) return passVoid.response;

  const { data: refundRow, error: refundError } = await admin
    .from('refunds')
    .insert({
      payment_id: null, // no gateway payment exists — REF-1 made this nullable
      order_id: id,
      amount_inr: validated.amountInr,
      method: validated.method,
      reason,
      status: 'processed', // the money moved at the counter, not via a gateway
      created_by: userId,
      processed_at: new Date().toISOString(),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    })
    .select('*')
    .single();

  // REF-2 race: two taps arrived close enough that both passed the read check.
  // The unique index caught the second — return the first one's refund rather
  // than an error, and DON'T re-run the status/loyalty side effects below.
  if (refundError && (refundError as { code?: string }).code === '23505' && idempotencyKey) {
    const already = await findRefundByKey(admin, idempotencyKey);
    if (already) return NextResponse.json({ refund: already, replayed: true });
  }

  if (refundError) {
    // Nothing has moved in our records yet, so this one IS fatal — unlike the
    // gateway path, where the money had already left before the insert.
    console.error('counter refund insert failed', refundError);
    // No refund was recorded, so the pass this call voided is good again.
    if (passVoid.voidedHere) await restorePassAfterFailedRefund(admin, id);
    return errorResponse(
      500,
      'Could not record the refund — is supabase/2026-08-counter-refunds.sql applied?',
    );
  }

  // The payment status from a FRESH read of what has gone back on this order
  // (a refund recorded by another till meanwhile counts), compare-and-set —
  // the same writer as the gateway path.
  const paidTotal = parts.reduce((sum, p) => sum + p.amount_inr, 0);
  const written = await writeRefundedStatus(admin, id, paidTotal, () => sumProcessed(admin, { order_id: id }));
  const updatedOrder = written.order;

  // Same rule as the gateway path (H8): a PARTIAL refund leaves loyalty alone,
  // because reverseForOrder reverses the order's entire earn+redeem (Beanies).
  if (written.status === 'refunded') {
    await reverseForOrder(id);
  }

  return NextResponse.json({
    refund: refundRow,
    order: updatedOrder,
    // So the UI can say "give ₹200 back from the drawer" vs "reverse on the terminal".
    refunded: { method: validated.method, amount_inr: validated.amountInr },
    balances: tenderBalances(parts, [
      ...prior,
      { method: validated.method, amount_inr: validated.amountInr },
    ]),
  });
}
