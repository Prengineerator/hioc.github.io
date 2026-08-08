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
import {
  blockedProviderVars,
  emailBillHealth,
  providerSkipReason,
  warnIfMisconfigured,
  whatsappBillHealth,
} from '@/lib/notifications/health';
import { hasBeenSent } from '@/lib/notifications/status';
import { flags } from '@/lib/flags';
import type { NotificationChannel, NotificationEvent, Order } from '@/lib/types';

const MAX_ATTEMPTS = 2; // initial try + one retry (NFR / F4 "retried >=1")

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/**
 * BILL-3: records that a channel was deliberately NOT attempted, and why.
 *
 * A skip used to write nothing at all, which made "why didn't this customer get
 * their bill?" unanswerable — the absence of a row was ambiguous between "never
 * tried" and "tried and vanished". Never overwrites a successful send, and never
 * throws: observability must not be able to break delivery.
 */
async function logSkip(
  admin: Admin,
  order: Order,
  event: NotificationEvent,
  channel: NotificationChannel,
  reason: string,
): Promise<void> {
  try {
    const { data: existing } = await admin
      .from('notifications')
      .select('status')
      .eq('order_id', order.id)
      .eq('event', event)
      .eq('channel', channel)
      .maybeSingle();

    // A bill already delivered (e.g. sent at placement, skipped at settle
    // because the channel went dormant since) must keep what it achieved.
    // hasBeenSent, not `=== 'sent'`: WA-4 added 'delivered' and 'read' above
    // 'sent', and a row the customer demonstrably OPENED is the last thing that
    // may be overwritten with "never attempted".
    if (hasBeenSent(existing?.status)) return;

    await admin.from('notifications').upsert(
      {
        order_id: order.id,
        channel,
        event,
        status: 'skipped' as const,
        provider_ref: '',
        error: '',
        skip_reason: reason,
        attempts: 0,
        sent_at: null,
      },
      { onConflict: 'order_id,event,channel' },
    );
  } catch (err) {
    console.error('logSkip failed', err);
  }
}

/**
 * Sends one message via one adapter and records the result, idempotent per
 * (order_id, event, channel): a prior successful send no-ops, and a retry after
 * an earlier failure updates the row in place. Never throws.
 *
 * `force` (staff "Resend bill", RCT-1) bypasses the already-sent short-circuit
 * and resets the attempt budget so a logged prior send re-delivers; the outcome
 * still upserts on the idempotency key, so the log stays one row per channel.
 */
async function deliverAndLog(
  admin: Admin,
  order: Order,
  event: NotificationEvent,
  adapter: NotificationAdapter,
  input: SendInput,
  force = false,
): Promise<{ sent: boolean; skipped?: string; error?: string }> {
  const channel = adapter.channel;

  // Idempotency guard: skip a channel that already sent for this (order,event).
  // The unique index is the hard backstop; this avoids a wasted send. A forced
  // resend deliberately skips this so it re-delivers.
  const { data: existing } = await admin
    .from('notifications')
    .select('id, status, attempts')
    .eq('order_id', order.id)
    .eq('event', event)
    .eq('channel', channel)
    .maybeSingle();

  // hasBeenSent, not `=== 'sent'`: a row Meta's webhook promoted to 'delivered'
  // or 'read' (WA-4) is MORE proof of a completed send, not less. Testing the
  // literal would re-fire a billable template at a customer who already read
  // their bill, and overwrite the receipt that proved it.
  if (!force && hasBeenSent(existing?.status)) {
    return { sent: true, skipped: 'already_sent' };
  }

  // The attempt budget was already spent by an earlier call for this same
  // (order, event, channel) — the bill fires at settle AND again on the
  // 'completed' transition, so this is the ordinary path, not an edge case.
  //
  // Falling through here would loop ZERO times (i starts at MAX_ATTEMPTS), leave
  // lastError as '', and then upsert that empty string over the previous
  // attempt's message — destroying the only record of WHY the send failed. That
  // is precisely how a genuine Meta rejection became a blank `failed` row in
  // production, and it is the same class of bug as the stub reporting success:
  // the system erasing the evidence of its own failure.
  if (!force && existing?.status === 'failed' && (existing?.attempts ?? 0) >= MAX_ATTEMPTS) {
    return { sent: false, skipped: 'attempts_exhausted' };
  }

  let lastError = '';
  let providerRef = '';
  let ok = false;
  // A forced resend starts a fresh attempt budget so a previously-maxed row can
  // still send again; otherwise resume from the prior attempt count.
  let attempts = force ? 0 : (existing?.attempts ?? 0);

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
    // WA-4: these are receipts for a SPECIFIC message id. This row is about to
    // carry a new provider_ref, so the previous message's receipts are no longer
    // evidence about it — leaving them would render "delivered" for a message
    // that has not been delivered (a forced resend is exactly this case).
    // PostgREST's ON CONFLICT DO UPDATE only touches columns present here, so
    // they have to be named explicitly to be cleared.
    delivered_at: null,
    read_at: null,
  };

  // Upsert on the idempotency key so a retry after a 'failed' row updates it in
  // place rather than violating the unique index.
  const { error: upsertError } = await admin
    .from('notifications')
    .upsert(row, { onConflict: 'order_id,event,channel' });

  if (upsertError) {
    console.error('deliverAndLog: failed to log delivery', upsertError);
  }

  // WA-3: the provider's own words travel back with the verdict, not only into
  // `notifications.error`. A caller that cannot read that row (the owner's test
  // send writes no row at all) would otherwise be left with the constant
  // 'send_failed' — which renders an expired token and a paused template as the
  // same sentence, and those have completely different remedies.
  return { sent: ok, error: ok ? '' : lastError };
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
  // D7 (FND3-5): a dine-in 'ready' means "walk the food to the table" — the
  // ready WhatsApp is suppressed. The settle receipt (the 'bill' event via
  // sendBillNotification) still sends when a phone was captured.
  if (event === 'ready' && order.order_type === 'dine_in') {
    return { sent: false, skipped: 'dine_in_ready_suppressed' };
  }

  // WA-1: a real provider was asked for and its credentials are absent, so
  // getAdapter() would hand back the stub — which reports SUCCESS. Record the
  // skip with the exact missing variables instead of writing a `sent` row that
  // nobody can distinguish from a delivered message.
  const blocked = blockedProviderVars();
  if (blocked.length > 0) {
    const reason = providerSkipReason();
    await logSkip(createAdminSupabaseClient(), order, event, 'whatsapp', reason);
    return { sent: false, skipped: reason };
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
 * Per-channel outcome of a bill send. The booleans are what existing callers
 * read; `reasons` (BILL-3) carries WHY a channel didn't send — '' when it did —
 * so the resend action and the owner log can state the cause instead of
 * rendering a silent failure as success.
 */
export interface BillResult {
  email: boolean;
  whatsapp: boolean;
  reasons: { email: string; whatsapp: string };
  /**
   * WA-3: the PROVIDER's verbatim complaint, per channel — '' unless that
   * channel's reason is 'send_failed'.
   *
   * `reasons` is a fixed machine vocabulary, so every provider-side rejection
   * collapses into the single token 'send_failed'. That is the wrong resolution
   * for the failures this phase is hunting: "Session has expired" (regenerate
   * the System User token) and "Template name does not exist in the translation"
   * (resubmit the template) are the same word to `reasons` and completely
   * different jobs for the owner. Meta's text is the shortest path from symptom
   * to remedy, so it rides along instead of only landing in a DB column the
   * caller may not be able to read.
   */
  errors: { email: string; whatsapp: string };
}

/**
 * Sends the link-based e-bill (RCT-1/2) for a just-placed order across BOTH the
 * email and WhatsApp channels, each logged + idempotent (event 'bill'). Every
 * channel is independently dormant until its provider is configured:
 *   - email: needs an address on the order + RESEND_API_KEY + RESEND_FROM
 *   - whatsapp: needs WHATSAPP_TOKEN + WHATSAPP_PHONE_ID + an approved template
 *     name in WHATSAPP_TPL_BILL
 * Best-effort and never throws, so it can't block or fail order placement.
 *
 * `opts.force` (staff "Resend bill", RCT-1) re-delivers on both channels even
 * when a prior send is already logged.
 */
export async function sendBillNotification(
  order: Order,
  opts: { force?: boolean } = {},
): Promise<BillResult> {
  const force = opts.force ?? false;
  const result: BillResult = {
    email: false,
    whatsapp: false,
    reasons: { email: '', whatsapp: '' },
    errors: { email: '', whatsapp: '' },
  };

  if (!flags.notifications) {
    result.reasons.email = 'notifications_disabled';
    result.reasons.whatsapp = 'notifications_disabled';
    return result;
  }

  // BILL-3: one warning per process naming exactly which variables are missing,
  // so a half-configured deploy announces itself instead of quietly no-op'ing.
  warnIfMisconfigured();

  try {
    const admin = createAdminSupabaseClient();

    // --- Email ------------------------------------------------------------
    const emailHealth = emailBillHealth();
    const emailSkip = !order.customer_email
      ? 'no_email'
      : !emailHealth.configured
        ? `not_configured:${emailHealth.missing.join(',')}`
        : '';

    if (emailSkip) {
      result.reasons.email = emailSkip;
      await logSkip(admin, order, 'bill', 'email', emailSkip);
    } else {
      const { subject, html } = renderBillEmail(order);
      const { body } = renderNotification(order, 'bill');
      const r = await deliverAndLog(
        admin,
        order,
        'bill',
        emailAdapter,
        {
          to: order.customer_email as string,
          channel: 'email',
          body,
          event: 'bill',
          subject,
          html,
        },
        force,
      );
      result.email = r.sent;
      if (!r.sent) {
        result.reasons.email = 'send_failed';
        result.errors.email = r.error ?? '';
      }
    }

    // --- WhatsApp ---------------------------------------------------------
    const waHealth = whatsappBillHealth();
    const waSkip = !order.customer_phone
      ? 'no_phone'
      : !waHealth.configured
        ? `not_configured:${waHealth.missing.join(',')}`
        : '';

    if (waSkip) {
      result.reasons.whatsapp = waSkip;
      await logSkip(admin, order, 'bill', 'whatsapp', waSkip);
    } else {
      const { body } = renderNotification(order, 'bill');
      const templateVars = templateVarsFor(order, 'bill');
      const r = await deliverAndLog(
        admin,
        order,
        'bill',
        whatsappAdapter,
        {
          to: order.customer_phone as string,
          channel: 'whatsapp',
          body,
          event: 'bill',
          templateVars,
          // Brand logo on the bill message. Sent only when the approved template
          // declares an IMAGE header — and MANDATORY when it does (Meta rejects a
          // send that omits a declared header). whatsappBillHealth() warns when
          // this is unset; see docs/WHATSAPP-BILL-TEMPLATE.md §3.
          headerImageUrl: process.env.WHATSAPP_TPL_BILL_HEADER_IMAGE || undefined,
        },
        force,
      );
      result.whatsapp = r.sent;
      if (!r.sent) {
        result.reasons.whatsapp = 'send_failed';
        result.errors.whatsapp = r.error ?? '';
      }
    }
  } catch (err) {
    console.error('sendBillNotification failed', err);
  }

  return result;
}
