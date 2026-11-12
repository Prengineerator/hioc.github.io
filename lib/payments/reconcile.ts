// Shared "mark a gateway payment captured" logic (FND-1). Used by both the
// webhook route (app/api/payments/webhook) and the reconcile-poll route
// (app/api/payments/[orderId]/status) so a payment can be confirmed either
// by the signed webhook OR by us polling the gateway — whichever lands
// first — without duplicating the order-transition logic, and staying
// idempotent no matter which path runs (or if both run for the same event).

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { canTransition } from '@/lib/orders/stateMachine';
import { captureDisposition, type CaptureDisposition } from '@/lib/orders/paymentStateMachine';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';
import { sendBillNotification } from '@/lib/notifications/engine';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { mapRazorpayMethod } from './gateway';
import { CAPTURABLE_ROW_STATUSES, ORPHAN_CAPTURE_NOTE, isOrphanCapture } from './paymentRowStateMachine';
import type { Order, PaymentMethod } from '@/lib/types';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export interface CaptureResult {
  ok: boolean;
  order: Order | null;
  alreadyProcessed?: boolean;
  /**
   * The money moved at the gateway, but the café order was no longer waiting
   * for it (cancelled, paid another way, refunded): the payments row records it
   * as an orphan for the refund route, and the order was left as it was.
   */
  orphan?: boolean;
}

// How many times the order write is re-read and retried when something else
// changed the order between the read and the write.
const ORDER_WRITE_ATTEMPTS = 3;

// A row recorded this long ago whose order never moved was left half-done by a
// call that died between the two writes. Younger than this, another call may
// still be on its way to the order write, and finishing it here would race it.
const STALE_CLAIM_MS = 60_000;

/**
 * Marks the `payments` row for `gatewayOrderId` as paid and, if the order is
 * still gated at 'placed', transitions it into the staff queue ('received').
 * Idempotent by gateway_order_id: a payment already recorded (duplicate
 * webhook, or webhook racing the reconcile poll) is a no-op success.
 *
 * Every write is a compare-and-set on the state it read
 * (lib/payments/paymentRowStateMachine.ts, lib/orders/paymentStateMachine.ts):
 * the row only from the status it was read in, so exactly one caller records
 * it; the order only from the payment status it was read in, so a counter
 * settle or a cancel that lands in between is never overwritten. A capture on
 * an order that stopped waiting for it is an ORPHAN (captureDisposition): the
 * row records the money with ORPHAN_CAPTURE_NOTE and the order is not touched
 * — marking a cancelled pass sale paid would issue the pass, and marking a bill
 * the counter settled in cash 'upi' would take the cash out of the drawer.
 */
export async function captureGatewayPayment(params: {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  method?: string;
  signatureOk: boolean;
  capturedAmountPaise?: number; // for the M5 amount cross-check
}): Promise<CaptureResult> {
  const admin = createAdminSupabaseClient();

  const { data: payment, error: paymentError } = await admin
    .from('payments')
    .select('id, order_id, status, amount_inr, error, updated_at')
    .eq('gateway', 'razorpay')
    .eq('gateway_order_id', params.gatewayOrderId)
    .maybeSingle();

  if (paymentError || !payment) {
    console.error('captureGatewayPayment: payment row not found', paymentError);
    return { ok: false, order: null };
  }

  const method: PaymentMethod = mapRazorpayMethod(params.method);
  const orderId = payment.order_id as string;

  if (!(CAPTURABLE_ROW_STATUSES as readonly string[]).includes(payment.status as string)) {
    // Recorded already (paid, or since refunded). Normally the order moved with
    // it; if an earlier call died between the two writes, the order is still
    // waiting for this money — finish it, once, rather than leave it stuck.
    const order = await readOrder(admin, orderId);
    const recordedAt = Date.parse(String((payment as { updated_at?: string }).updated_at ?? ''));
    if (
      payment.status === 'paid' &&
      !isOrphanCapture(payment as { error?: string | null }) &&
      Number.isFinite(recordedAt) &&
      Date.now() - recordedAt > STALE_CLAIM_MS &&
      order &&
      captureDisposition(order).kind === 'capture'
    ) {
      console.error(`captureGatewayPayment: order ${orderId} was left waiting on a recorded payment — finishing it`);
      return moveOrderToPaid(admin, orderId, payment.id as string, method, order, { healing: true });
    }
    return { ok: true, order, alreadyProcessed: true };
  }

  // M5: defense-in-depth — the captured amount should equal what we recorded
  // for this order. Razorpay binds the amount to the order, so a mismatch is
  // anomalous; log it (money already moved — don't block, but make it visible).
  if (
    typeof params.capturedAmountPaise === 'number' &&
    params.capturedAmountPaise !== (payment.amount_inr as number) * 100
  ) {
    console.error(
      `captureGatewayPayment: AMOUNT MISMATCH for ${params.gatewayOrderId} — captured ${params.capturedAmountPaise}p vs expected ${(payment.amount_inr as number) * 100}p`,
    );
  }

  // Read BEFORE the row is claimed, so the claim already says whether this is
  // the order's payment or an orphan. `*` rather than a column list because
  // order_kind (HIOC Ritual, 2026-10-coffee-pass.sql) does not exist before that
  // migration, and a select naming an unknown column would make every capture
  // fail to find its order. Absent = a menu order.
  const { data: current, error: orderReadError } = await admin
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();

  if (orderReadError || !current) {
    console.error('captureGatewayPayment: order not found', orderReadError);
    return { ok: false, order: null };
  }

  const disposition = captureDisposition(current as Order);

  // Claim the row — only from the status it was read in, so two paths
  // capturing the same payment record it once; the loser reads it as done.
  const { data: claimed, error: claimError } = await admin
    .from('payments')
    .update({
      status: 'paid',
      gateway_payment_id: params.gatewayPaymentId,
      method,
      signature_ok: params.signatureOk,
      error: disposition.kind === 'orphan' ? orphanNote(disposition, current as Order) : '',
    })
    .eq('id', payment.id)
    .eq('status', payment.status)
    .select('id')
    .maybeSingle();
  if (claimError) {
    console.error('captureGatewayPayment: could not record the payment', claimError);
    return { ok: false, order: null };
  }
  if (!claimed) {
    return { ok: true, order: await readOrder(admin, orderId), alreadyProcessed: true };
  }

  if (disposition.kind === 'orphan') {
    logOrphan(params.gatewayPaymentId, payment.amount_inr as number, orderId, orphanNote(disposition, current as Order));
    return { ok: true, order: current as Order, orphan: true };
  }

  return moveOrderToPaid(admin, orderId, payment.id as string, method, current as Order);
}

/**
 * The order half of a capture: payment_status → 'paid' (and 'placed' →
 * 'received'), compare-and-set on what was read. If the order changed in
 * between, it is read again: still waiting → retried; no longer waiting →
 * this capture is an orphan after all, and the row is marked so.
 */
async function moveOrderToPaid(
  admin: Admin,
  orderId: string,
  paymentRowId: string,
  method: PaymentMethod,
  first: Order,
  opts: { healing?: boolean } = {},
): Promise<CaptureResult> {
  let current: Order | null = first;
  for (let attempt = 0; attempt < ORDER_WRITE_ATTEMPTS && current; attempt++) {
    const disposition = captureDisposition(current);
    // Finishing a half-done capture, an order someone paid meanwhile is left
    // alone: which payment it took can't be told apart here, so nothing is
    // marked an orphan on a guess.
    if (disposition.kind === 'orphan' && opts.healing) return { ok: true, order: current };
    if (disposition.kind === 'orphan') {
      const note = orphanNote(disposition, current);
      await admin.from('payments').update({ error: note }).eq('id', paymentRowId).eq('status', 'paid');
      logOrphan(paymentRowId, null, orderId, note);
      return { ok: true, order: current, orphan: true };
    }

    const from = current.status;
    // The SALE of a HIOC Ritual pass has no kitchen queue to enter: it is not
    // advanced placed → received. Setting payment_status = 'paid' below is what
    // matters: a database trigger issues the pass, completes the order and logs
    // its own status event (spec §5.5), so nothing here writes a status, an
    // event or a broadcast for it.
    const isPassSale = current.order_kind === 'coffee_pass';
    const shouldAdvance = !isPassSale && from === 'placed' && canTransition(from, 'received', 'system').ok;

    const patch: Record<string, unknown> = { payment_status: 'paid', payment_method: method };
    if (shouldAdvance) {
      patch.status = 'received';
      patch.version = current.version + 1;
    }

    let query = admin
      .from('orders')
      .update(patch)
      .eq('id', orderId)
      .eq('payment_status', current.payment_status);
    if (shouldAdvance) {
      query = query.eq('version', current.version);
    }
    const { data: updated, error: updateError } = await query.select('*').maybeSingle();

    if (updateError) {
      // The row is recorded; the next reconcile call finishes the order (see
      // the already-recorded branch above).
      console.error('captureGatewayPayment: order update failed', updateError);
      return { ok: true, order: await readOrder(admin, orderId) };
    }
    if (!updated) {
      console.error(`captureGatewayPayment: order ${orderId} changed under the capture — re-reading`);
      current = await readOrder(admin, orderId);
      continue;
    }

    if (shouldAdvance) {
      await admin.from('order_status_events').insert({
        order_id: orderId,
        from_status: from,
        to_status: 'received',
        actor_id: null,
        actor_role: 'system',
        reason: 'Payment captured',
      });
      await broadcastOrderEvent(orderId, 'received');
    }

    if (shouldAdvance || isPassSale) {
      // The order confirmation (bill) was held back at placement while payment
      // was pending (app/api/orders/route.ts). This is the one place an online
      // order becomes confirmed — the compare-and-set step above succeeds
      // exactly once, whichever of verify/webhook/poll gets here first — so it
      // is sent here. A pass sale has no such step, but its customer still gets
      // the bill for what they paid, sent here for the same reason. Reloaded
      // with its lines for the item count.
      // Best-effort: a failed send must never undo a captured payment.
      try {
        const { data: full } = await admin
          .from('orders')
          .select('*, order_items(*, order_item_addons(*))')
          .eq('id', orderId)
          .single();
        await sendBillNotification(full ? toOrderResponse(full as OrderRowWithItems) : (updated as Order));
      } catch (billError) {
        console.error('captureGatewayPayment: bill notification failed', billError);
      }
    }

    return { ok: true, order: updated as Order };
  }
  return { ok: true, order: current };
}

async function readOrder(admin: Admin, orderId: string): Promise<Order | null> {
  const { data } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle();
  return (data as Order | null) ?? null;
}

function orphanNote(disposition: Extract<CaptureDisposition, { kind: 'orphan' }>, order: Order): string {
  const why =
    disposition.reason === 'dead_order'
      ? `the order was ${order.status}`
      : disposition.reason === 'paid_elsewhere'
        ? 'the order was already paid another way'
        : disposition.reason === 'refunded'
          ? 'the order was refunded'
          : `the order could not take it (${order.status}, ${order.payment_status})`;
  return `${ORPHAN_CAPTURE_NOTE} captured after ${why}`;
}

function logOrphan(paymentRef: string, amountInr: number | null, orderId: string, note: string): void {
  console.error(
    `captureGatewayPayment: ORPHAN CAPTURE ${paymentRef}${amountInr !== null ? ` (₹${amountInr})` : ''} on order ` +
      `${orderId} — ${note}. The order was left as it was; refund this payment.`,
  );
}

/**
 * Records a failed payment attempt's gateway error (payment.failed webhook).
 *
 * Only while the row is still open (payment_pending): a failed ATTEMPT is
 * normally followed by another one on the same Razorpay order, and once one is
 * captured (or the row abandoned) a late failure webhook must not overwrite
 * what the row says — in particular the ORPHAN_CAPTURE_NOTE the refund route
 * reads. The status never moves here: one failed attempt doesn't close the order.
 */
export async function markGatewayPaymentFailed(gatewayOrderId: string, errorMsg: string): Promise<void> {
  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from('payments')
    .update({ error: errorMsg.slice(0, 500) })
    .eq('gateway', 'razorpay')
    .eq('gateway_order_id', gatewayOrderId)
    .eq('status', 'payment_pending');
  if (error) {
    console.error('markGatewayPaymentFailed: update failed', error);
  }
}
