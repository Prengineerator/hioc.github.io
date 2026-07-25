import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { actorRoleFor, getManagerUser, getStaffOrOwner } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isOrderStatus, isUuid } from '@/lib/api/constants';
import { canTransition } from '@/lib/orders/stateMachine';
import { getStoreSettings } from '@/lib/store/settings';
import { sendOrderNotification } from '@/lib/notifications/engine';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';
import { earnForOrder, reverseForOrder } from '@/lib/loyalty/ledger';
import type { Order, OrderType, PaymentStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };
const MIN_ETA_LEAD_MS = 5 * 60 * 1000; // ETA must be at least +5 min (S3 edge case)

// PATCH /api/orders/[id]/status — staff/owner only. Drives the F1 state machine:
// validates the requested transition, guards it with an optimistic `version`
// check, appends an `order_status_events` row (who/when/why), and fires the
// customer notification the transition maps to. Body:
//   { status, reason?, promised_ready_at?, version? }
export async function PATCH(request: Request, { params }: RouteParams) {
  const actor = await getStaffOrOwner();
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
  const { data: current, error: readError } = await admin
    .from('orders')
    .select('id, status, version, customer_phone, order_number, order_type, payment_status')
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

  // FND3-5 manager comp override: an unpaid dine-in at `ready` can be completed
  // without collecting payment when a manager explicitly comps it, with a
  // reason and an audit row. We resolve `isComp` BEFORE canTransition so the
  // settlement guard can see it. TODO(FND3-6): swap getManagerUser() for
  // hasPermission('comp_order') once the permission matrix lands.
  let isComp = false;
  const compBody = body.comp as { reason?: string } | undefined;
  const isDineInSettleCompletion =
    from === 'ready' &&
    to === 'completed' &&
    current.order_type === 'dine_in' &&
    current.payment_status !== 'paid';

  if (isDineInSettleCompletion && compBody) {
    const manager = await getManagerUser();
    if (!manager) {
      return errorResponse(403, 'A manager is required to comp an order');
    }
    const compReason = typeof compBody.reason === 'string' ? compBody.reason.trim() : '';
    if (!compReason) {
      return errorResponse(400, 'A comp requires a reason');
    }
    // Set a paid-equivalent (payment_method left as-is/null) + audit trail
    // BEFORE the transition so the guard passes. Not version-guarded: it only
    // sets payment_status and never races the status column.
    await admin.from('orders').update({ payment_status: 'paid' }).eq('id', id);
    await admin.from('order_amendments').insert({
      order_id: id,
      staff_id: manager.id,
      kind: 'comp',
      payload: { reason: compReason },
    });
    isComp = true;
  }

  const check = canTransition(from, to, actorRole, reason, {
    orderType: current.order_type as OrderType,
    paymentStatus: current.payment_status as PaymentStatus,
    isComp,
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

  // Guarded update: `eq('version', current.version)` makes the write itself the
  // race arbiter — if another transition landed first, zero rows update → 409.
  const { data: updated, error: updateError } = await admin
    .from('orders')
    .update(patch)
    .eq('id', id)
    .eq('version', current.version)
    .select('*')
    .maybeSingle();

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

  const order = updated as Order;

  // Fire the customer notification this transition maps to (accepted/ready/
  // rejected/cancelled). Awaited but non-throwing so the send is logged before
  // the function returns; failures never fail the transition. The D7 dine-in
  // 'ready' suppression lives in the engine (caller-agnostic) — `order` is the
  // post-update select('*') row, so it carries order_type for that rule.
  if (check.rule?.notify) {
    await sendOrderNotification(order, check.rule.notify);
  }

  // Loyalty ledger hooks (FND-4): earn points when an order completes, reverse
  // them if it's rejected/cancelled. No-ops until the Loyalty engine is wired.
  if (to === 'completed') {
    await earnForOrder(id);
  } else if (to === 'rejected' || to === 'cancelled') {
    await reverseForOrder(id);
  }

  // Push the change to any live customer status page (< 2s, F2).
  await broadcastOrderEvent(id, to);

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
