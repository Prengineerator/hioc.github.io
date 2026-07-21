// Notification engine (F4). Called from order transition Route Handlers when a
// lifecycle change should message the customer (accepted/ready/rejected/
// cancelled), and at order placement for the e-bill (RCT-1/2). Renders the
// message, sends via the relevant adapter(s), and logs the outcome to the
// `notifications` table with idempotency + one retry.
//
// Transactional order notifications ALWAYS send — marketing consent (XC-022)
// does not gate these. Never throws: a send failure must not fail the
// underlying transition/placement, so all errors are swallowed + logged.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import {
  getAdapter,
  emailAdapter,
  whatsappAdapter,
  type NotificationAdapter,
  type SendInput,
} from '@/lib/notifications/adapters';
import { renderNotification, templateVarsFor } from '@/lib/notifications/templates';
import { renderBillEmail } from '@/lib/notifications/billEmail';
import { flags } from '@/lib/flags';
import type { NotificationEvent, Order } from '@/lib/types';

const MAX_ATTEMPTS = 2; // initial try + one retry (NFR / F4 "retried >=1")

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/**
 * Sends one message via one adapter and records the result, idempotent per
 * (order_id, event, channel): a prior successful send no-ops, and a retry after
 * an earlier failure updates the row in place. Never throws.
 */
async function deliverAndLog(
  admin: Admin,
  order: Order,
  event: NotificationEvent,
  adapter: NotificationAdapter,
  input: SendInput,
): Promise<{ sent: boolean; skipped?: string }> {
  const channel = adapter.channel;

  // Idempotency guard: skip a channel that already sent for this (order,event).
  // The unique index is the hard backstop; this avoids a wasted send.
  const { data: existing } = await admin
    .from('notifications')
    .select('id, status, attempts')
    .eq('order_id', order.id)
    .eq('event', event)
    .eq('channel', channel)
    .maybeSingle();

  if (existing?.status === 'sent') {
    return { sent: true, skipped: 'already_sent' };
  }

  let lastError = '';
  let providerRef = '';
  let ok = false;
  let attempts = existing?.attempts ?? 0;

  for (let i = attempts; i < MAX_ATTEMPTS && !ok; i++) {
    attempts = i + 1;
    try {
      const res = await adapter.send(input);
      ok = res.ok;
      providerRef = res.providerRef;
      lastError = res.error;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'send threw';
    }
  }

  const row = {
    order_id: order.id,
    channel,
    event,
    status: ok ? ('sent' as const) : ('failed' as const),
    provider_ref: providerRef,
    error: ok ? '' : lastError,
    attempts,
    sent_at: ok ? new Date().toISOString() : null,
  };

  // Upsert on the idempotency key so a retry after a 'failed' row updates it in
  // place rather than violating the unique index.
  const { error: upsertError } = await admin
    .from('notifications')
    .upsert(row, { onConflict: 'order_id,event,channel' });

  if (upsertError) {
    console.error('deliverAndLog: failed to log delivery', upsertError);
  }

  return { sent: ok };
}

/**
 * Sends the customer notification for an order lifecycle event on the active
 * channel (NOTIFY_PROVIDER) and records the result. Fire-and-forget friendly:
 * returns a small result but never rejects.
 */
export async function sendOrderNotification(
  order: Order,
  event: NotificationEvent,
): Promise<{ sent: boolean; skipped?: string }> {
  if (!flags.notifications) {
    return { sent: false, skipped: 'notifications_disabled' };
  }
  if (!order.customer_phone) {
    return { sent: false, skipped: 'no_phone' };
  }

  const adapter = getAdapter();
  const admin = createAdminSupabaseClient();
  const { body } = renderNotification(order, event);
  const templateVars = templateVarsFor(order, event);

  return deliverAndLog(admin, order, event, adapter, {
    to: order.customer_phone,
    channel: adapter.channel,
    body,
    event,
    templateVars,
  });
}

/**
 * Sends the link-based e-bill (RCT-1/2) for a just-placed order across BOTH the
 * email and WhatsApp channels, each logged + idempotent (event 'bill'). Every
 * channel is independently dormant until its provider is configured:
 *   - email: needs an address on the order + RESEND_API_KEY + RESEND_FROM
 *   - whatsapp: needs WHATSAPP_TOKEN + WHATSAPP_PHONE_ID + an approved template
 *     name in WHATSAPP_TPL_BILL
 * Best-effort and never throws, so it can't block or fail order placement.
 */
export async function sendBillNotification(
  order: Order,
): Promise<{ email: boolean; whatsapp: boolean }> {
  const result = { email: false, whatsapp: false };
  if (!flags.notifications) return result;

  try {
    const admin = createAdminSupabaseClient();

    if (order.customer_email && process.env.RESEND_API_KEY && process.env.RESEND_FROM) {
      const { subject, html } = renderBillEmail(order);
      const { body } = renderNotification(order, 'bill');
      const r = await deliverAndLog(admin, order, 'bill', emailAdapter, {
        to: order.customer_email,
        channel: 'email',
        body,
        event: 'bill',
        subject,
        html,
      });
      result.email = r.sent;
    }

    if (
      order.customer_phone &&
      process.env.WHATSAPP_TOKEN &&
      process.env.WHATSAPP_PHONE_ID &&
      process.env.WHATSAPP_TPL_BILL
    ) {
      const { body } = renderNotification(order, 'bill');
      const templateVars = templateVarsFor(order, 'bill');
      const r = await deliverAndLog(admin, order, 'bill', whatsappAdapter, {
        to: order.customer_phone,
        channel: 'whatsapp',
        body,
        event: 'bill',
        templateVars,
      });
      result.whatsapp = r.sent;
    }
  } catch (err) {
    console.error('sendBillNotification failed', err);
  }

  return result;
}
