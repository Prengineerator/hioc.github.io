import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { actorRoleFor, getStaffOrOwner } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isOrderStatus, isUuid } from '@/lib/api/constants';
import { canTransition } from '@/lib/orders/stateMachine';
import { getStoreSettings } from '@/lib/store/settings';
import { sendOrderNotification } from '@/lib/notifications/engine';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';
import type { Order } from '@/lib/types';

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
  const { data: current, error: readError } = await admin
    .from('orders')
    .select('id, status, version, customer_phone, order_number')
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

  const check = canTransition(from, to, actorRole, reason);
  if (!check.ok) {
    if (check.code === 'forbidden_actor') return errorResponse(403, check.message!);
    if (check.code === 'reason_required') return errorResponse(400, check.message!);
    // not_allowed → the transition is illegal from this state.
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
  // the function returns; failures never fail the transition.
  if (check.rule?.notify) {
    await sendOrderNotification(order, check.rule.notify);
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
