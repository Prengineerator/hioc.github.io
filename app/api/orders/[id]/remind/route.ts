import { NextResponse } from 'next/server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { sendReadyReminder } from '@/lib/notifications/engine';
import {
  PICKUP_REMINDER_COOLDOWN_SEC,
  reminderCooldownRemaining,
  reminderCutoffIso,
} from '@/lib/notifications/pickupReminder';
import type { Order } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/orders/[id]/remind — staff "Send pickup reminder". Resends the
// approved "order ready" WhatsApp for an order sitting at Ready, at most once
// per PICKUP_REMINDER_COOLDOWN_SEC per order.
//
// The cooldown is claimed with ONE conditional UPDATE before anything is sent,
// so two tablets tapping in the same second cannot both message the customer.
// If the send then fails the stamp is rolled back — a failed reminder must not
// lock staff out of trying again — and the failure is reported as a failure:
// this route never answers 200 for a message that did not go out.
//
// PIN-3: gated by getCounterActor() like the other counter routes.
export async function POST(_request: Request, { params }: RouteParams) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const admin = createAdminSupabaseClient();
  const { data, error: loadError } = await admin.from('orders').select('*').eq('id', id).maybeSingle();
  if (loadError) return errorResponse(500, 'Could not load the order');
  if (!data) return notFound();
  const order = data as Order;

  if (order.status !== 'ready') {
    return errorResponse(409, 'Only a Ready order can be reminded');
  }
  if (!order.customer_phone) {
    return errorResponse(409, 'This order has no customer phone number');
  }
  // A table dine-in "ready" means "we will bring it to your table" — the
  // automatic ready message is suppressed for the same reason (engine D7). A
  // website dine-in has no table and is collected at the counter like a pickup.
  if (order.order_type === 'dine_in' && order.table_id) {
    return errorResponse(409, 'Dine-in orders are served at the table — no pickup reminder');
  }

  const nowMs = Date.now();
  const remaining = reminderCooldownRemaining(order.pickup_reminded_at, nowMs);
  if (remaining > 0) {
    return tooSoon(remaining);
  }

  // Claim the slot. Zero rows back = another tap got there first (or the order
  // moved on from Ready in the meantime).
  const remindedAt = new Date(nowMs).toISOString();
  const { data: claimed, error: claimError } = await admin
    .from('orders')
    .update({ pickup_reminded_at: remindedAt })
    .eq('id', id)
    .eq('status', 'ready')
    .or(`pickup_reminded_at.is.null,pickup_reminded_at.lte.${reminderCutoffIso(nowMs)}`)
    .select('id')
    .maybeSingle();
  if (claimError) {
    console.error('remind: could not claim the reminder slot', claimError);
    return errorResponse(500, 'Could not record the reminder — has the pickup-reminder migration been applied?');
  }
  if (!claimed) {
    return tooSoon(PICKUP_REMINDER_COOLDOWN_SEC);
  }

  const result = await sendReadyReminder(order);
  if (!result.sent) {
    // Roll back only our own stamp, so a concurrent success is never undone.
    await admin
      .from('orders')
      .update({ pickup_reminded_at: order.pickup_reminded_at ?? null })
      .eq('id', id)
      .eq('pickup_reminded_at', remindedAt);

    if (result.skipped === 'notifications_disabled' || result.skipped?.startsWith('not_configured')) {
      return errorResponse(503, 'WhatsApp is not set up on this server, so no reminder was sent.');
    }
    return errorResponse(502, `WhatsApp did not accept the reminder${result.error ? `: ${result.error}` : '.'}`);
  }

  return NextResponse.json({ reminded_at: remindedAt, delivered: { whatsapp: true } });
}

function tooSoon(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      error: 'A reminder was sent recently — please wait before sending another.',
      retry_after_seconds: retryAfterSeconds,
    },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}
