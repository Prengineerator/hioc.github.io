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
  whatsappReminderHealth,
} from '@/lib/notifications/health';
import {
  canWrite,
  failedResendMayReplace,
  hasBeenSent,
  sendDecision,
  skipMayReplace,
  type LogRowState,
} from '@/lib/notifications/status';
import { FEEDBACK_BUTTONS, formatFeedbackButtonPayload } from '@/lib/feedback/payload';
import { flags } from '@/lib/flags';
import type { NotificationChannel, NotificationEvent, NotificationStatus, Order } from '@/lib/types';

const MAX_ATTEMPTS = 2; // initial try + one retry (NFR / F4 "retried >=1")

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/** The delivery-log row, as every writer here reads it before deciding (lib/notifications/status.ts). */
interface LogRow extends LogRowState {
  id?: string;
  status: NotificationStatus;
  attempts: number | null;
  provider_ref: string | null;
  sent_at: string | null;
}

const LOG_COLUMNS = 'id, status, attempts, provider_ref, sent_at';

interface LogKey {
  orderId: string;
  event: NotificationEvent;
  channel: NotificationChannel;
}

const isUniqueViolation = (error: { code?: string } | null | undefined) => error?.code === '23505';

async function readLog(admin: Admin, key: LogKey): Promise<LogRow | null> {
  const { data } = await admin
    .from('notifications')
    .select(LOG_COLUMNS)
    .eq('order_id', key.orderId)
    .eq('event', key.event)
    .eq('channel', key.channel)
    .maybeSingle();
  return (data as LogRow | null) ?? null;
}

/**
 * An UPDATE of this key's row that only lands while the row is still exactly
 * what `seen` says it was — the compare-and-set every writer here goes through.
 * A 'queued' row is matched on its claim time too: re-claiming a stale claim
 * leaves the status 'queued', so the status alone could not tell two
 * re-claimers apart.
 */
function updateIfUnchanged(admin: Admin, key: LogKey, seen: LogRow, patch: Record<string, unknown>) {
  let q = admin
    .from('notifications')
    .update(patch)
    .eq('order_id', key.orderId)
    .eq('event', key.event)
    .eq('channel', key.channel)
    .eq('status', seen.status);
  if (seen.status === 'queued') q = seen.sent_at ? q.eq('sent_at', seen.sent_at) : q.is('sent_at', null);
  return q.select('id');
}

/**
 * BILL-3: records that a channel was deliberately NOT attempted, and why.
 *
 * A skip used to write nothing at all, which made "why didn't this customer get
 * their bill?" unanswerable — the absence of a row was ambiguous between "never
 * tried" and "tried and vanished". Never overwrites a successful send — or one
 * still in flight — and never throws: observability must not be able to break
 * delivery.
 *
 * The write is a compare-and-set against the row it read (an insert when there
 * was none), so a send that lands between the read and the write wins: it used
 * to be an unconditional upsert, which stamped 'skipped' over the 'sent' that
 * had just been recorded.
 */
async function logSkip(
  admin: Admin,
  order: Order,
  event: NotificationEvent,
  channel: NotificationChannel,
  reason: string,
): Promise<void> {
  const key: LogKey = { orderId: order.id, event, channel };
  try {
    const fields = {
      status: 'skipped' as const,
      provider_ref: '',
      error: '',
      skip_reason: reason,
      attempts: 0,
      sent_at: null,
    };
    // Two passes at most: the second only runs when another writer changed the
    // row between our read and our write, and is decided against what it wrote.
    for (let pass = 0; pass < 2; pass++) {
      const existing = await readLog(admin, key);

      // A bill already delivered (e.g. sent at placement, skipped at settle
      // because the channel went dormant since) must keep what it achieved —
      // and a send in flight must be left to finish. hasBeenSent, not
      // `=== 'sent'`: a row the customer demonstrably OPENED is the last thing
      // that may be overwritten with "never attempted" (status.ts).
      if (!skipMayReplace(existing, Date.now())) return;

      if (!existing) {
        const { error } = await admin
          .from('notifications')
          .insert({ order_id: order.id, channel, event, ...fields });
        if (!error) return;
        if (isUniqueViolation(error)) continue; // someone wrote the row meanwhile
        console.error('logSkip: insert failed', error);
        return;
      }

      const { data, error } = await updateIfUnchanged(admin, key, existing, fields);
      if (error) {
        console.error('logSkip: update failed', error);
        return;
      }
      if ((data ?? []).length > 0) return;
    }
  } catch (err) {
    console.error('logSkip failed', err);
  }
}

type Claim =
  | { kind: 'claimed'; attempts: number; claimedAt: string }
  /** Another caller holds or changed the row; re-read to say why. */
  | { kind: 'lost' }
  /** The log could not be written at all (a DB fault, or an order id the table rejects). */
  | { kind: 'unlogged' };

/**
 * Takes the (order, event, channel) row as 'queued' BEFORE anything is sent —
 * the claim the double-send window needed. No row: insert one, and a unique
 * violation means another caller got there first. A row: compare-and-set from
 * exactly what was read.
 */
async function claimLogRow(admin: Admin, key: LogKey, existing: LogRow | null, nowIso: string): Promise<Claim> {
  // provider_ref is cleared because the claim is for a NEW message: a late
  // webhook callback for the previous attempt's message id must not land on
  // (and fail) the attempt in flight. skip_reason goes too — a queued row was
  // not skipped, and a stale reason would later describe a failure wrongly.
  const claimFields = { status: 'queued' as const, provider_ref: '', skip_reason: '', sent_at: nowIso };
  if (!existing) {
    const { error } = await admin.from('notifications').insert({
      order_id: key.orderId,
      channel: key.channel,
      event: key.event,
      error: '',
      attempts: 0,
      ...claimFields,
    });
    if (!error) return { kind: 'claimed', attempts: 0, claimedAt: nowIso };
    if (isUniqueViolation(error)) return { kind: 'lost' };
    console.error('deliverAndLog: could not claim the log row', error);
    return { kind: 'unlogged' };
  }

  const { data, error } = await updateIfUnchanged(admin, key, existing, claimFields);
  if (error) {
    console.error('deliverAndLog: could not claim the log row', error);
    return { kind: 'unlogged' };
  }
  if ((data ?? []).length === 0) return { kind: 'lost' };
  return { kind: 'claimed', attempts: existing.attempts ?? 0, claimedAt: nowIso };
}

type DeliveryResult = { sent: boolean; skipped?: string; error?: string; providerRef?: string };

/** Initial try + retries, resuming from `startAt` spent attempts. Never throws. */
async function attemptSend(
  adapter: NotificationAdapter,
  input: SendInput,
  startAt: number,
): Promise<{ ok: boolean; providerRef: string; lastError: string; attempts: number }> {
  let lastError = '';
  let providerRef = '';
  let ok = false;
  let attempts = startAt;
  for (let i = startAt; i < MAX_ATTEMPTS && !ok; i++) {
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
  return { ok, providerRef, lastError, attempts };
}

/** The verdict columns of a send that just happened (a fresh message id, so its receipts start empty). */
function verdictRow(ok: boolean, providerRef: string, lastError: string, attempts: number) {
  return {
    status: ok ? ('sent' as const) : ('failed' as const),
    provider_ref: providerRef,
    error: ok ? '' : lastError,
    skip_reason: '',
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
}

/**
 * The provider's own words, to the console as well as the row. Until now the
 * rejection existed in exactly ONE place — `notifications.error` — so the
 * moment anything overwrote that column the reason was gone for good, which
 * is precisely what happened to a real bill failure here. A log line costs
 * nothing and means the diagnosis survives losing the row.
 */
function logFailure(event: NotificationEvent, channel: NotificationChannel, orderId: string, attempts: number, lastError: string) {
  console.error(
    `[notify] ${event}/${channel} FAILED for order ${orderId} after ${attempts} attempt(s): ${
      lastError || '(provider returned no message)'
    }`,
  );
}

/**
 * Records a FORCED resend's outcome. A success replaces the row whatever it
 * held — it is a new message, with its own id and (so far) no receipts. A
 * failure only becomes 'failed' over a row that never recorded a send; over a
 * sent/delivered/read row the status, provider_ref and receipts stay (that
 * earlier message still went) and the failed attempt is recorded in `error`
 * and `attempts` instead.
 */
async function recordForcedOutcome(
  admin: Admin,
  key: LogKey,
  outcome: { ok: boolean; providerRef: string; lastError: string; attempts: number },
): Promise<void> {
  const row = verdictRow(outcome.ok, outcome.providerRef, outcome.lastError, outcome.attempts);
  if (outcome.ok) {
    const { error } = await admin
      .from('notifications')
      .upsert({ order_id: key.orderId, channel: key.channel, event: key.event, ...row }, { onConflict: 'order_id,event,channel' });
    if (error) console.error('deliverAndLog: failed to log delivery', error);
    return;
  }

  for (let pass = 0; pass < 2; pass++) {
    const current = await readLog(admin, key);
    if (!current) {
      const { error } = await admin
        .from('notifications')
        .insert({ order_id: key.orderId, channel: key.channel, event: key.event, ...row });
      if (!error) return;
      if (isUniqueViolation(error)) continue;
      console.error('deliverAndLog: failed to log delivery', error);
      return;
    }
    const patch = failedResendMayReplace(current, Date.now())
      ? row
      : { error: `Resend failed: ${outcome.lastError || '(provider returned no message)'}`, attempts: outcome.attempts };
    const { data, error } = await updateIfUnchanged(admin, key, current, patch);
    if (error) {
      console.error('deliverAndLog: failed to log delivery', error);
      return;
    }
    if ((data ?? []).length > 0) return;
  }
  console.error(`deliverAndLog: ${key.event}/${key.channel} for order ${key.orderId} kept changing; resend failure not logged`);
}

/**
 * Sends one message via one adapter and records the result, idempotent per
 * (order_id, event, channel). Never throws.
 *
 * An automatic send CLAIMS the row ('queued', lib/notifications/status.ts)
 * before contacting the provider, so two concurrent calls for the same key —
 * the bill at settle and again on 'completed' — cannot both send: the loser
 * answers 'in_flight' (or 'already_sent' once the winner has finished). A prior
 * successful send no-ops, and a retry after an earlier failure re-claims the
 * row in place.
 *
 * `force` (staff "Resend bill", RCT-1; the pickup reminder; the owner's feedback
 * resend) bypasses the already-sent short-circuit and the claim, and resets the
 * attempt budget so a logged prior send re-delivers. Those callers are an
 * explicit human action with their own rate limits; the outcome still lands on
 * the idempotency key, so the log stays one row per channel.
 */
async function deliverAndLog(
  admin: Admin,
  order: Order,
  event: NotificationEvent,
  adapter: NotificationAdapter,
  input: SendInput,
  force = false,
): Promise<DeliveryResult> {
  const channel = adapter.channel;
  const key: LogKey = { orderId: order.id, event, channel };

  if (force) {
    const outcome = await attemptSend(adapter, input, 0);
    if (!outcome.ok) logFailure(event, channel, order.id, outcome.attempts, outcome.lastError);
    await recordForcedOutcome(admin, key, outcome);
    return resultOf(outcome);
  }

  const existing = await readLog(admin, key);

  // hasBeenSent, not `=== 'sent'`: a row Meta's webhook promoted to 'delivered'
  // or 'read' (WA-4) is MORE proof of a completed send, not less. Testing the
  // literal would re-fire a billable template at a customer who already read
  // their bill, and overwrite the receipt that proved it.
  //
  // 'attempts_exhausted': the budget was already spent by an earlier call for
  // this same key. Falling through would loop ZERO times, leave lastError '',
  // and write that empty string over the previous attempt's message — which is
  // precisely how a genuine Meta rejection became a blank `failed` row in
  // production.
  const decision = sendDecision(existing, { nowMs: Date.now(), maxAttempts: MAX_ATTEMPTS });
  if (decision.kind === 'skip') return standDown(decision.reason, existing);

  const claim = await claimLogRow(admin, key, existing, new Date().toISOString());
  if (claim.kind === 'lost') {
    // Someone else took or finished the row between our read and our claim.
    const now = await readLog(admin, key);
    return standDown(hasBeenSent(now?.status) ? 'already_sent' : 'in_flight', now);
  }

  // 'unlogged': the log refused even the claim. Delivery still goes ahead — the
  // log is observability and must not be able to stop a bill (the owner's test
  // send has no real order row at all) — and the verdict is upserted as before.
  const outcome = await attemptSend(adapter, input, claim.kind === 'claimed' ? claim.attempts : existing?.attempts ?? 0);
  if (!outcome.ok) logFailure(event, channel, order.id, outcome.attempts, outcome.lastError);
  const row = verdictRow(outcome.ok, outcome.providerRef, outcome.lastError, outcome.attempts);

  if (claim.kind === 'claimed') {
    // Only the claim holder writes the verdict: if a forced resend (or a stale
    // take-over) replaced the claim meanwhile, ITS record stands.
    const held: LogRow = { status: 'queued', attempts: claim.attempts, provider_ref: '', sent_at: claim.claimedAt };
    if (!canWrite('finish', held, row.status, { nowMs: Date.now(), maxAttempts: MAX_ATTEMPTS }).ok) return resultOf(outcome);
    const { data, error } = await updateIfUnchanged(admin, key, held, row);
    if (error) console.error('deliverAndLog: failed to log delivery', error);
    else if ((data ?? []).length === 0) {
      console.warn(`deliverAndLog: ${event}/${channel} claim for order ${order.id} was taken over before its verdict landed`);
    }
  } else {
    const { error } = await admin
      .from('notifications')
      .upsert({ order_id: order.id, channel, event, ...row }, { onConflict: 'order_id,event,channel' });
    if (error) console.error('deliverAndLog: failed to log delivery', error);
  }

  return resultOf(outcome);
}

function standDown(reason: 'already_sent' | 'attempts_exhausted' | 'in_flight', row: LogRow | null): DeliveryResult {
  if (reason === 'already_sent') return { sent: true, skipped: 'already_sent', providerRef: row?.provider_ref ?? '' };
  return { sent: false, skipped: reason };
}

/**
 * WA-3: the provider's own words travel back with the verdict, not only into
 * `notifications.error`. A caller that cannot read that row (the owner's test
 * send writes no row at all) would otherwise be left with the constant
 * 'send_failed' — which renders an expired token and a paused template as the
 * same sentence, and those have completely different remedies.
 */
function resultOf(outcome: { ok: boolean; providerRef: string; lastError: string }): DeliveryResult {
  return { sent: outcome.ok, error: outcome.ok ? '' : outcome.lastError, providerRef: outcome.ok ? outcome.providerRef : '' };
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
  // sendBillNotification) still sends when a phone was captured. A website
  // dine-in has no table — it is collected at the counter — so it still gets it.
  if (event === 'ready' && order.order_type === 'dine_in' && order.table_id) {
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
 * Staff "Send pickup reminder": re-sends the approved 'ready' WhatsApp to the
 * customer of an order that is sitting on the counter.
 *
 * The normal 'ready' send is idempotent per (order, event, channel), so a second
 * one is a no-op by design — this is the ONE deliberate bypass, and it exists as
 * its own function rather than a flag on sendOrderNotification so the automatic
 * lifecycle path can never pick it up. It also refuses the log stub: a reminder
 * the customer never receives, reported as sent, is worse than an honest error.
 * The caller owns the rate limit (POST /api/orders/[id]/remind).
 *
 * Never throws. The forced outcome lands on the order's one 'ready' row, like a
 * forced bill resend — and a reminder that fails never steps a sent/delivered/read
 * 'ready' row back to 'failed' (lib/notifications/status.ts).
 */
export async function sendReadyReminder(
  order: Order,
): Promise<{ sent: boolean; skipped?: string; error?: string }> {
  if (!flags.notifications) {
    return { sent: false, skipped: 'notifications_disabled' };
  }
  if (!order.customer_phone) {
    return { sent: false, skipped: 'no_phone' };
  }
  const health = whatsappReminderHealth();
  if (!health.configured) {
    return { sent: false, skipped: `not_configured:${health.missing.join(',')}` };
  }

  const { body } = renderNotification(order, 'ready');
  const r = await deliverAndLog(
    createAdminSupabaseClient(),
    order,
    'ready',
    whatsappAdapter,
    {
      to: order.customer_phone,
      channel: 'whatsapp',
      body,
      event: 'ready',
      templateVars: templateVarsFor(order, 'ready'),
    },
    true,
  );
  return { sent: r.sent, error: r.error };
}

/**
 * Sends the post-order feedback request (order_feedback_1): 2 body vars
 * (name, order number) + the 3 quick-reply rating buttons + the dynamic URL
 * button carrying the feedback-page token. Logged in `notifications` under
 * event 'feedback' — same idempotency key shape as every other event
 * (order_id, event, channel) — so the delivery-status webhook's receipts
 * apply to it exactly like a bill or status message.
 *
 * This is deliberately NOT layered on sendOrderNotification: that function's
 * templateVars come from a single generic path with no button support, and
 * 'feedback' is not one of the lifecycle events it (or the D7 dine-in
 * suppression) reasons about. Callers (the feedback cron) have already
 * decided this order is eligible — opted-out/skip-reason checks happen there,
 * against feedback_requests, not here.
 */
export async function sendFeedbackRequestNotification(
  params: {
    orderId: string;
    phone: string;
    customerName: string;
    orderNumber: number;
    requestId: string;
    token: string;
  },
  opts: { force?: boolean } = {},
): Promise<{ sent: boolean; skipped?: string; error?: string; providerRef?: string }> {
  if (!flags.notifications) {
    return { sent: false, skipped: 'notifications_disabled' };
  }

  const blocked = blockedProviderVars();
  // Minimal Order-shaped object: deliverAndLog only reads `.id`, and
  // templateVarsFor only reads customer_name/order_number for this event.
  const orderStub = {
    id: params.orderId,
    customer_name: params.customerName,
    order_number: params.orderNumber,
  } as Order;

  if (blocked.length > 0) {
    const reason = providerSkipReason();
    await logSkip(createAdminSupabaseClient(), orderStub, 'feedback', 'whatsapp', reason);
    return { sent: false, skipped: reason };
  }

  const adapter = getAdapter();
  const admin = createAdminSupabaseClient();
  const templateVars = templateVarsFor(orderStub, 'feedback');
  const templateButtons = [
    ...FEEDBACK_BUTTONS.map((b) => ({
      index: b.index,
      payload: formatFeedbackButtonPayload(params.requestId, b.rating),
    })),
    { index: 3, text: params.token },
  ];

  return deliverAndLog(
    admin,
    orderStub,
    'feedback',
    adapter,
    {
      to: params.phone,
      channel: adapter.channel,
      body: renderNotification(orderStub, 'feedback').body,
      event: 'feedback',
      templateVars,
      templateButtons,
    },
    opts.force ?? false,
  );
}

/**
 * The machine reason for a channel that did not send. Everything is
 * 'send_failed' as before, except a send another request is already making
 * (the settle and 'completed' bills racing): that one is not a failure, and
 * calling it one would tell the counter to resend a bill that is on its way.
 */
function billReasonFor(r: DeliveryResult): string {
  return r.skipped === 'in_flight' ? 'in_flight' : 'send_failed';
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
        result.reasons.email = billReasonFor(r);
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
        result.reasons.whatsapp = billReasonFor(r);
        result.errors.whatsapp = r.error ?? '';
      }
    }
  } catch (err) {
    console.error('sendBillNotification failed', err);
  }

  return result;
}
