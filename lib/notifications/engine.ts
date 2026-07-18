// Notification engine (F4). Called from order transition Route Handlers when a
// lifecycle change should message the customer (accepted/ready/rejected/
// cancelled). Renders the template, sends via the active adapter, and logs the
// outcome to the `notifications` table with idempotency + one retry.
//
// Transactional order notifications ALWAYS send — marketing consent (XC-022)
// does not gate these. Never throws: a send failure must not fail the
// underlying status transition, so all errors are swallowed + logged.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAdapter } from '@/lib/notifications/adapters';
import { renderNotification, templateVarsFor } from '@/lib/notifications/templates';
import { flags } from '@/lib/flags';
import type { NotificationEvent, Order } from '@/lib/types';

const MAX_ATTEMPTS = 2; // initial try + one retry (NFR / F4 "retried >=1")

/**
 * Sends the customer notification for an order lifecycle event and records the
 * result. Idempotent per (order_id, event, channel) via a unique index — a
 * duplicate call for the same event no-ops instead of double-sending.
 *
 * Fire-and-forget friendly: returns a small result but never rejects.
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
  const channel = adapter.channel;
  const admin = createAdminSupabaseClient();

  // Idempotency guard: if a successful send for this (order,event,channel)
  // already exists, do nothing. The unique index is the hard backstop; this
  // check avoids a wasted send + a noisy conflict on the common path.
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

  const { body } = renderNotification(order, event);
  const templateVars = templateVarsFor(order, event);

  let lastError = '';
  let providerRef = '';
  let ok = false;
  let attempts = existing?.attempts ?? 0;

  for (let i = attempts; i < MAX_ATTEMPTS && !ok; i++) {
    attempts = i + 1;
    try {
      const res = await adapter.send({ to: order.customer_phone, channel, body, event, templateVars });
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

  // Upsert on the idempotency key so a retry after an earlier 'failed' row
  // updates it in place rather than violating the unique index.
  const { error: upsertError } = await admin
    .from('notifications')
    .upsert(row, { onConflict: 'order_id,event,channel' });

  if (upsertError) {
    console.error('sendOrderNotification: failed to log delivery', upsertError);
  }

  return { sent: ok };
}
