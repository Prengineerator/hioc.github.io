// Server-side loaders for the gateway facts the payment state machine needs
// (lib/orders/paymentStateMachine.ts gatewayOwnsPayment / checkCounterSettle):
// did a Razorpay capture take this order's money, and is a Razorpay order for
// it still open? Read from the order's `payments` rows, never from
// orders.payment_method (a UPI or card capture stores 'upi' / 'card' there,
// exactly like a counter settle).

import 'server-only';
import type { createAdminSupabaseClient } from '@/lib/supabase-server';
import { gatewayEvidenceFromRows, type GatewayEvidence } from './paymentRowStateMachine';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export type EvidenceResult = { ok: true; evidence: GatewayEvidence } | { ok: false };

/**
 * The gateway evidence for one order. `{ ok: false }` when the rows could not
 * be read: a caller deciding whether the counter may touch the money must
 * refuse then, not guess.
 */
export async function loadGatewayEvidence(admin: Admin, orderId: string): Promise<EvidenceResult> {
  const { data, error } = await admin.from('payments').select('status, error').eq('order_id', orderId);
  if (error) {
    console.error(`payments read failed for order ${orderId} — refusing to guess whether the gateway owns it`, error);
    return { ok: false };
  }
  return { ok: true, evidence: gatewayEvidenceFromRows(data as { status: string; error?: string | null }[] | null) };
}

/**
 * Marks every still-open Razorpay order for this café order abandoned
 * (payment_pending → unpaid): the order stopped waiting for it (switch to pay
 * at the counter, auto-expiry, a cancelled 'placed' order). Retry then mints a
 * fresh one rather than handing out a row nobody should pay, and a late
 * capture on it is still recorded (lib/payments/reconcile.ts). Best-effort:
 * the order has already moved on, and a row left pending is only a missed
 * cleanup — the order's own state is what retry and capture check first.
 */
export async function abandonGatewayPayments(admin: Admin, orderId: string): Promise<void> {
  const { error } = await admin
    .from('payments')
    .update({ status: 'unpaid' })
    .eq('order_id', orderId)
    .eq('status', 'payment_pending');
  if (error) console.error(`could not mark the open gateway payments for order ${orderId} abandoned`, error);
}
