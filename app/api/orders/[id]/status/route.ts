import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { actorRoleFor, getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isOrderStatus, isUuid } from '@/lib/api/constants';
import { canTransition } from '@/lib/orders/stateMachine';
import { getStoreSettings } from '@/lib/store/settings';
import { sendBillNotification, sendOrderNotification } from '@/lib/notifications/engine';
import { enqueueFeedbackRequest } from '@/lib/feedback/enqueue';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';
import { runAfterResponse } from '@/lib/api/background';
import { earnForOrder, reverseForOrder } from '@/lib/loyalty/ledger';
import { consumeStockForOrder } from '@/lib/inventory/server';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import type { Order, OrderType, PaymentStatus } from '@/lib/types';

import { balanceOf } from '@/lib/orders/paidChange';
import { canTransitionPayment } from '@/lib/orders/paymentStateMachine';
import { abandonGatewayPayments, loadGatewayEvidence } from '@/lib/payments/evidence';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };
const MIN_ETA_LEAD_MS = 5 * 60 * 1000; // ETA must be at least +5 min (S3 edge case)

// PATCH /api/orders/[id]/status — staff/owner only. Drives the F1 state machine:
// validates the requested transition, guards it with an optimistic `version`
// check, appends an `order_status_events` row (who/when/why), and fires the
// customer notification the transition maps to. Body:
//   { status, reason?, promised_ready_at?, version? }
//
// PIN-3/PIN-4: gated by getCounterActor() — classic session first, unchanged;
// an enrolled-device PIN operator only when there is no session at all.
export async function PATCH(request: Request, { params }: RouteParams) {
  const actor = await getCounterActor();
  if (!actor) {
    return unauthorized();
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const body = await parseJsonBody(request);
  if (!body || !isOrderStatus(body.status)) {
    return errorResponse(400, 'status is required and must be a valid order status');
  }
  const to = body.status;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const actorRole = actorRoleFor(actor.role);

  const admin = createAdminSupabaseClient();

  // Read current status + version (source of truth for the transition + guard).
  // order_type/payment_status feed the FND3-5 dine-in settlement guard, which
  // must see them BEFORE the write decides whether the transition is legal.
  // `*` rather than a column list because order_kind (HIOC Ritual, 2026-10-
  // coffee-pass.sql) does not exist before that migration, and a select naming
  // an unknown column would fail every status change on such a database; here
  // it is simply absent, which reads as an ordinary menu order.
  const { data: current, error: readError } = await admin
    .from('orders')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (readError) {
    return errorResponse(500, 'Failed to load order');
  }
  if (!current) {
    return notFound();
  }

  const from = current.status as Order['status'];

  // Idempotent no-op: asking for the status it's already in just echoes back.
  if (from === to) {
    const { data: unchanged } = await admin
      .from('orders')
      .select('*')
      .eq('id', id)
      .single();
    return NextResponse.json({ order: unchanged as Order });
  }

  // The SALE of a HIOC Ritual pass has no kitchen steps: a database trigger
  // completes it the moment it is paid, and it never appears on the board. So
  // every transition is refused here — except withdrawing a sale that has not
  // been paid yet (a mistaken or abandoned one).
  //
  // This runs BEFORE the manager-comp logic below on purpose. A comp writes
  // payment_status = 'paid' ahead of the transition, and paying a pass sale is
  // what ISSUES the pass: comping one would hand out a free 7-cup pass with an
  // audit row that says "comp". Refusing first means the comp write never runs.
  // A paid sale is undone by refunding it (which voids the pass), never by a
  // status change.
  if (current.order_kind === 'coffee_pass') {
    if (!(to === 'cancelled' && current.payment_status === 'unpaid')) {
      return errorResponse(409, `A ${PASS_PROGRAM_NAME} sale has no kitchen steps.`);
    }
  }

  // FND3-5 manager comp override: an unpaid order at `ready` can be completed
  // without collecting payment when a manager explicitly comps it, with a
  // reason and an audit row. We resolve `isComp` BEFORE canTransition so the
  // settlement guard can see it. PIN-3: gated by hasPermission('comp_order',
  // roleHint) rather than getManagerUser() — that helper re-derives the role
  // via the RLS-bound session client, which a device operator has none of
  // (see lib/permissions.ts's own note on this). actor.role already carries
  // the right answer either way (classic session or capped device operator).
  let isComp = false;
  let compReason = '';
  const compBody = body.comp as { reason?: string } | undefined;
  // Every order type now has to be settled before it completes (see the
  // ready → completed guard in lib/orders/stateMachine.ts), so the comp
  // override applies to every type too, not just dine-in. Only a bill with
  // nothing collected yet is comped: a refunded or part-refunded one WAS
  // settled (the guard lets it complete as it is), and comping it used to
  // write 'paid' over the refund marker.
  const isUnpaidCompletion =
    from === 'ready' &&
    to === 'completed' &&
    (current.payment_status === 'unpaid' || current.payment_status === 'payment_pending');

  if (isUnpaidCompletion && compBody) {
    if (!(await hasPermission(actor.user, 'comp_order', actor.role))) {
      return errorResponse(403, 'A manager is required to comp an order');
    }
    compReason = typeof compBody.reason === 'string' ? compBody.reason.trim() : '';
    if (!compReason) {
      return errorResponse(400, 'A comp requires a reason');
    }
    // The payment machine's comp rule (lib/orders/paymentStateMachine.ts): a
    // Ready order, and — if it is waiting on the gateway — no Razorpay order
    // still open for it (the customer could pay it as well as being comped).
    let gatewayLive = false;
    if (current.payment_status === 'payment_pending') {
      const evidence = await loadGatewayEvidence(admin, id);
      if (!evidence.ok) return errorResponse(500, 'Could not check this order’s online payment. Try again.');
      gatewayLive = evidence.evidence.gatewayLive;
    }
    const comp = canTransitionPayment(current.payment_status as PaymentStatus, 'paid', 'comp', 'counter', {
      orderStatus: from,
      gatewayLive,
    });
    if (!comp.ok) return errorResponse(409, comp.message!);
    // The paid-equivalent (payment_method left as-is/null) is written IN the
    // guarded transition below, and the audit row only once that commits: a
    // comp that loses the race leaves the order exactly as it was, never paid
    // with a comp row and still not completed.
    isComp = true;
  }

  const check = canTransition(from, to, actorRole, reason, {
    orderType: current.order_type as OrderType,
    paymentStatus: current.payment_status as PaymentStatus,
    isComp,
    // A paid bill changed afterwards with money still owed (2026-11-paid-order-
    // changes.sql); absent before that migration = nothing owed.
    balanceDueInr: balanceOf(current),
  });
  if (!check.ok) {
    if (check.code === 'forbidden_actor') return errorResponse(403, check.message!);
    if (check.code === 'reason_required') return errorResponse(400, check.message!);
    // payment_required (dine-in unsettled) and not_allowed (illegal from this
    // state) are both conflicts with the order's current state → 409.
    if (check.code === 'payment_required') return errorResponse(409, check.message!);
    return errorResponse(409, check.message!);
  }

  // Optimistic concurrency (F1) is enforced by the guarded UPDATE below
  // (`.eq('version', current.version)` against the freshly-read version), which
  // 409s only on a genuine concurrent write. We deliberately do NOT reject on a
  // stale *client*-supplied version here: a single staffer clicking through
  // statuses faster than the board refetches would send a stale version and get
  // spurious 409s, silently stalling the order. `current` is always fresh, so
  // the DB guard is the correct — and sufficient — arbiter.

  // Build the column patch for this transition.
  const patch: Record<string, unknown> = {
    status: to,
    version: (current.version as number) + 1,
  };
  if (to === 'rejected' || to === 'cancelled') {
    patch.reject_reason = reason;
  }
  if (to === 'accepted') {
    patch.promised_ready_at = await resolveEta(body.promised_ready_at);
  }
  if (isComp) {
    patch.payment_status = 'paid';
  }
  // A 'placed' order cancelled before it was paid stops waiting on the gateway
  // (the payment machine's cancel_placed rule): it reads unpaid, like an
  // expired one, so a capture that lands later is recorded as an orphan for a
  // refund instead of marking a cancelled order paid.
  const cancelsPlacedPayment =
    from === 'placed' &&
    to === 'cancelled' &&
    current.payment_status === 'payment_pending' &&
    canTransitionPayment('payment_pending', 'unpaid', 'cancel_placed', 'counter', { orderStatus: from }).ok;
  if (cancelsPlacedPayment) {
    patch.payment_status = 'unpaid';
  }

  // Guarded update: `eq('version', current.version)` makes the write itself the
  // race arbiter — if another transition landed first, zero rows update → 409.
  // A payment change rides with it only from the payment status it was read
  // in (settling and refunding have not always bumped the version).
  let guardedWrite = admin
    .from('orders')
    .update(patch)
    .eq('id', id)
    .eq('version', current.version);
  if (isComp || cancelsPlacedPayment) guardedWrite = guardedWrite.eq('payment_status', current.payment_status);
  const { data: updated, error: updateError } = await guardedWrite.select('*').maybeSingle();

  if (updateError) {
    return errorResponse(500, 'Failed to update order status');
  }
  if (!updated) {
    return errorResponse(409, 'Order was updated by someone else — please refresh.');
  }

  // Append the attributed lifecycle event (F1 / audit / SLA metrics).
  const { error: eventError } = await admin.from('order_status_events').insert({
    order_id: id,
    from_status: from,
    to_status: to,
    actor_id: actor.user.id,
    actor_role: actorRole,
    reason,
  });
  if (eventError) {
    // The status change already committed; a missing event row shouldn't fail
    // the request, but log it — the event log feeds SLA metrics (OWN-008).
    console.error('order_status_events insert failed', eventError);
  }

  if (isComp) {
    // The comp's audit trail (2026-11-paid-order-changes.sql kind 'comp'),
    // after the write it explains. Logged loudly if it fails: the order is
    // already completed on the house.
    const { error: compAuditError } = await admin.from('order_amendments').insert({
      order_id: id,
      staff_id: actor.user.id,
      kind: 'comp',
      payload: { reason: compReason },
    });
    if (compAuditError) console.error(`comp audit row FAILED for order ${id} (completed on the house)`, compAuditError);
  }
  if (cancelsPlacedPayment) await abandonGatewayPayments(admin, id);

  const order = updated as Order;

  // Ledger writes stay inline: they decide the order's points balance and must
  // land before we reply.
  const completedSale = to === 'completed' && current.order_kind !== 'coffee_pass';
  if (completedSale) {
    await earnForOrder(id);
  } else if (to === 'rejected' || to === 'cancelled') {
    await reverseForOrder(id);
  }

  // Everything below is best-effort and never fails the transition, so it runs
  // after the response is sent (runAfterResponse keeps the function alive until
  // it finishes). Previously the counter waited on external WhatsApp/email
  // providers here before seeing its status change land. Order of the steps
  // and every rule inside them is unchanged.
  runAfterResponse(
    (async () => {
      // Customer notification for this transition (accepted/ready/rejected/
      // cancelled). D7 dine-in 'ready' suppression lives in the engine.
      if (check.rule?.notify) {
        await sendOrderNotification(order, check.rule.notify);
      }

      if (completedSale) {
        // Inventory (docs/INVENTORY-SPEC.md): never throws; no-op while the flag is off.
        await consumeStockForOrder(id, actor.user.id);

        // RCT-1 / Issue-3: deliver the settled bill only when the order is
        // actually paid. Reload with lines so the bill's item count is right.
        if (order.payment_status === 'paid') {
          try {
            const { data: full } = await admin
              .from('orders')
              .select('*, order_items(*, order_item_addons(*))')
              .eq('id', id)
              .single();
            await sendBillNotification(full ? toOrderResponse(full as OrderRowWithItems) : order);
          } catch (billError) {
            console.error('settle bill notification failed', billError);
          }
        }

        // Post-order feedback request (cron re-checks every skip rule at send time).
        await enqueueFeedbackRequest({
          orderId: id,
          customerPhone: order.customer_phone,
          customerName: order.customer_name,
        });
      }

      // Push the change to any live customer status page (< 2s, F2).
      await broadcastOrderEvent(id, to);
    })(),
  );

  return NextResponse.json({ order });
}

// Resolves the promised-ready timestamp on accept: use a valid future
// client-provided ETA, else default to now + the store's default prep time.
async function resolveEta(raw: unknown): Promise<string> {
  const now = Date.now();
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (!Number.isNaN(t) && t >= now + MIN_ETA_LEAD_MS) {
      return new Date(t).toISOString();
    }
  }
  const settings = await getStoreSettings();
  const bufferMin = settings.default_prep_min;
  return new Date(now + bufferMin * 60 * 1000).toISOString();
}
