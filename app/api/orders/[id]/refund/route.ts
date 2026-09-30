import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { createGatewayRefund } from '@/lib/payments/gateway';
import { reverseForOrder } from '@/lib/loyalty/ledger';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { restorePassAfterFailedRefund, voidPassForRefund } from '@/lib/passes/server';
import { readIdempotencyKey } from '@/lib/orders/idempotency';
import {
  tenderBalances,
  totalRefundedInr,
  validateCounterRefund,
  type PriorRefund,
  type TenderPart,
} from '@/lib/orders/refunds';
import type { PaymentMethod, PaymentStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/orders/[id]/refund — manager/owner only (FND-5 gate; FND-2/PAY-3).
// Issues a full or partial refund via the gateway against the order's most
// recent captured payment, writes a `refunds` row EITHER WAY (processed or
// failed — a failed gateway call is logged, never silently dropped per the
// FND-2 AC), and sets orders.payment_status to 'refunded' (fully) or
// 'partially_refunded'. Any Beanies earned/redeemed on the order are clawed
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
  // a refund, return THAT one instead of issuing a second.
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey) {
    const existing = await findRefundByKey(admin, idempotencyKey);
    if (existing) {
      return NextResponse.json({ refund: existing, replayed: true });
    }
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

  if (order.payment_status !== 'paid' && order.payment_status !== 'partially_refunded') {
    return errorResponse(409, 'This order has no captured payment to refund.');
  }

  const { data: payment, error: paymentError } = await admin
    .from('payments')
    .select('id, gateway_payment_id, amount_inr')
    .eq('order_id', id)
    .eq('status', 'paid')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (paymentError) return errorResponse(500, 'Failed to load payment');

  // REF-1: a counter-settled order (cash/UPI/card taken at the till) has NO
  // payments row — those are written only by the gateway paths. Until now this
  // returned 409 and a walk-in customer simply could not be refunded in-system,
  // even though the staff UI offered the button. Route it to the counter path.
  const isPassSale = order.order_kind === 'coffee_pass';
  if (!payment || !payment.gateway_payment_id) {
    return counterRefund(admin, id, order as CounterOrder, body, reason, user.id, idempotencyKey, isPassSale);
  }

  const { data: priorRefunds, error: priorError } = await admin
    .from('refunds')
    .select('amount_inr')
    .eq('payment_id', payment.id)
    .eq('status', 'processed');
  if (priorError) return errorResponse(500, 'Failed to load prior refunds');

  const alreadyRefunded = (priorRefunds ?? []).reduce(
    (sum, r) => sum + (r.amount_inr as number),
    0,
  );
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

  const gatewayResult = await createGatewayRefund(payment.gateway_payment_id, amountInr, {
    reason,
    hioc_order_id: id,
  });

  if (!gatewayResult) {
    await admin.from('refunds').insert({
      payment_id: payment.id,
      order_id: id,
      amount_inr: amountInr,
      reason,
      status: 'failed',
      created_by: user.id,
    });
    // The money did not move, so the pass this call voided is good again.
    if (passVoid.voidedHere) await restorePassAfterFailedRefund(admin, id);
    return errorResponse(
      502,
      'Refund failed at the payment gateway — it has been logged; please retry.',
    );
  }

  const { data: refundRow, error: refundError } = await admin
    .from('refunds')
    .insert({
      payment_id: payment.id,
      order_id: id,
      amount_inr: amountInr,
      reason,
      status: 'processed',
      gateway_ref: gatewayResult.id,
      created_by: user.id,
      processed_at: new Date().toISOString(),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    })
    .select('*')
    .single();
  if (refundError) {
    // The gateway refund already succeeded — log so it's investigable, but
    // don't fail the request over a bookkeeping write (money already moved).
    console.error('refunds insert failed after a successful gateway refund', refundError);
  }

  const totalRefunded = alreadyRefunded + amountInr;
  const newPaymentStatus: PaymentStatus =
    totalRefunded >= payment.amount_inr ? 'refunded' : 'partially_refunded';

  const { data: updatedOrder, error: updateError } = await admin
    .from('orders')
    .update({ payment_status: newPaymentStatus })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (updateError) {
    console.error('order payment_status update after refund failed', updateError);
  }

  // Claw back Beanies ONLY on a FULL refund (H8). reverseForOrder reverses the
  // order's ENTIRE earn+redeem, so running it on a partial refund would wrongly
  // wipe all earned Beanies (e.g. a ₹10 refund on a ₹1000 order). A partial
  // refund leaves loyalty untouched.
  if (newPaymentStatus === 'refunded') {
    await reverseForOrder(id);
  }

  return NextResponse.json({ refund: refundRow, order: updatedOrder });
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

  const paidTotal = parts.reduce((sum, p) => sum + p.amount_inr, 0);
  const refundedTotal = totalRefundedInr(prior) + validated.amountInr;
  const newPaymentStatus: PaymentStatus =
    refundedTotal >= paidTotal ? 'refunded' : 'partially_refunded';

  const { data: updatedOrder, error: updateError } = await admin
    .from('orders')
    .update({ payment_status: newPaymentStatus })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (updateError) console.error('order payment_status update after counter refund failed', updateError);

  // Same rule as the gateway path (H8): a PARTIAL refund leaves loyalty alone,
  // because reverseForOrder reverses the order's entire earn+redeem (Beanies).
  if (newPaymentStatus === 'refunded') {
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
