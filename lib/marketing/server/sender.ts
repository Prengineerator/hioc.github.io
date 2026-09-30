// The sender — turns queued recipients into WhatsApp messages (spec §6 "Sender
// algorithm"). Driven every 5 minutes by pg_cron (POST /api/cron/marketing-send) and
// once by the nightly planner as a fallback.
//
// This is the one place money and consent meet, so its rules are ordered by what a
// mistake costs:
//
//   * CONSENT WINS. Approval can be days before sending. Immediately before EACH message
//     the sender re-reads that phone's consent and recent sends (rules 1, 3, 4, 5 of §1.5)
//     and the campaign's status. Withdrawn consent, a cancelled campaign, a message sent
//     to the same phone a minute ago — the message does not go.
//   * NEVER SEND TWICE. A claimed row is 'sending' and is NEVER reclaimed: a run that
//     crashed mid-send may already have handed the message to Meta, so a retry could
//     message (and bill) the customer twice. The sender marks a stale 'sending' row failed
//     with error 'interrupted' instead. Losing one message is the lesser harm.
//   * NEVER THE STUB. Marketing calls whatsappAdapter directly, never getAdapter(): the
//     stub reports success for a message nobody received. Without WhatsApp credentials a
//     recipient is skipped 'not_configured'.
//   * COUPONS ARE ISSUED AT SEND, and deactivated if the send fails, so a skipped or
//     rejected message leaves no live code behind.
//   * BUDGET AND CAPS ARE HARD. The month's spend, the daily cap and the send window are
//     checked before anything is claimed; a batch is at most 50 messages.

import 'server-only';
import { evaluateContact } from '@/lib/marketing/eligibility';
import { isWithinSendWindow, istDayStart, istMonthStart } from '@/lib/marketing/ist';
import {
  couponFieldsFor,
  couponPrefixFor,
  generateCouponCode,
  needsCoupon,
  secureRng,
  validTill,
  validityDays,
} from '@/lib/marketing/offers';
import { buildVars, formatShortDate, renderPreview, type TemplateValues } from '@/lib/marketing/templates';
import { COUPON_CODE_MAX_ATTEMPTS, STALE_SENDING_MINUTES } from '@/lib/marketing/types';
import type { MarketingSettings, SendCronResult } from '@/lib/marketing/types';
import { whatsappAdapter } from '@/lib/notifications/adapters';
import { whatsappReminderHealth } from '@/lib/notifications/health';
import { loadConsentState, recordOptOut } from './consent';
import {
  assertOk,
  countSentSince,
  isMigrationMissingError,
  isUniqueViolation,
  loadCampaign,
  loadRecentSendsForPhone,
  loadSettings,
  marketingAdmin,
  sumSpendSince,
  toRecipientRow,
  type Admin,
  type CampaignRow,
  type RecipientDbRow,
} from './repo';

/** Most messages one run may send. */
export const MAX_BATCH = 50;
/** Rows claimed per RPC call: a run that hits its time limit strands at most this many. */
const CLAIM_CHUNK = 10;
/** Stop starting new chunks after this long — leaves headroom under the route's 60s limit. */
const RUN_BUDGET_MS = 35_000;
/** A row released back to the queue after a transient pre-send failure is failed for good on this attempt. */
const MAX_ATTEMPTS = 3;
/** Meta: the customer tapped "Stop promotions". */
export const META_STOP_PROMOTIONS = '131050';

export interface SendBatchOptions {
  admin?: Admin;
  /** Test seam: a monotonic millisecond clock (defaults to Date.now). */
  clock?: () => number;
}

const zero = (over: Partial<SendCronResult> = {}): SendCronResult => ({
  enabled: true,
  claimed: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
  interrupted: 0,
  ...over,
});

/**
 * Meta puts its code in the error text — "(#131049) This message was not delivered to
 * maintain healthy ecosystem engagement" — and the adapter returns that text as-is. '' when there is none.
 */
export function parseMetaErrorCode(error: string): string {
  const m = /\(#(\d{3,7})\)/.exec(error) ?? /\bcode[:\s]+(\d{3,7})\b/i.exec(error);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Step 2: 'sending' rows claimed long ago never finished — fail them, never re-send them. */
async function markInterrupted(admin: Admin, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_SENDING_MINUTES * 60_000).toISOString();
  const { data, error } = await admin
    .from('marketing_recipients')
    .update({ status: 'failed', error: 'interrupted', error_code: '', cost_inr: 0 })
    .eq('status', 'sending')
    .lt('claimed_at', cutoff)
    .select('id');
  assertOk('marketing_recipients write', error);
  return (data ?? []).length;
}

/**
 * Step 8b: a campaign with nothing left pending / queued / sending is complete. Swept
 * over every approved or sending campaign (not only the ones touched this run), so a
 * campaign whose last queued messages were cancelled by an opt-out still closes.
 */
async function completeFinishedCampaigns(admin: Admin, now: Date): Promise<void> {
  const { data, error } = await admin.from('marketing_campaigns').select('id').in('status', ['approved', 'sending']);
  assertOk('marketing_campaigns read', error);
  for (const c of (data ?? []) as { id: string }[]) {
    const { count, error: countError } = await admin
      .from('marketing_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id)
      .in('status', ['pending', 'queued', 'sending']);
    assertOk('marketing_recipients count', countError);
    if ((count ?? 0) > 0) continue;
    const { error: doneError } = await admin
      .from('marketing_campaigns')
      .update({ status: 'completed', completed_at: now.toISOString() })
      .eq('id', c.id)
      .in('status', ['approved', 'sending']);
    if (doneError) console.error('marketing sender: could not complete campaign', doneError.message);
  }
}

/** First send of a campaign: it is now 'sending', has a start time, and its holdout's attribution clock starts. */
async function markCampaignStarted(admin: Admin, campaign: CampaignRow, nowIso: string): Promise<void> {
  const { data: stamped } = await admin
    .from('marketing_campaigns')
    .update({ started_at: nowIso })
    .eq('id', campaign.id)
    .is('started_at', null)
    .select('started_at');
  await admin.from('marketing_campaigns').update({ status: 'sending' }).eq('id', campaign.id).eq('status', 'approved');

  const startedAt = (stamped as { started_at?: string }[] | null)?.[0]?.started_at ?? campaign.started_at ?? nowIso;
  // A holdout recipient's clock starts when the campaign does (set once: `reference_at is null`).
  const { error } = await admin
    .from('marketing_recipients')
    .update({ reference_at: startedAt })
    .eq('campaign_id', campaign.id)
    .eq('arm', 'holdout')
    .is('reference_at', null);
  if (error) console.error('marketing sender: holdout reference_at failed', error.message);
}

/** The recipient row outcome the batch tallies. */
type Outcome = 'sent' | 'skipped' | 'failed';

interface RunContext {
  admin: Admin;
  settings: MarketingSettings;
  now: () => Date;
  configured: boolean;
  startedCampaigns: Set<string>;
}

async function setRecipient(admin: Admin, id: string, patch: Record<string, unknown>): Promise<void> {
  // Guarded on 'sending': a row that something else already moved (an opt-out, a cancel) is left alone.
  const { error } = await admin.from('marketing_recipients').update(patch).eq('id', id).eq('status', 'sending');
  if (error) console.error('marketing sender: recipient update failed', error.message);
}

async function skip(ctx: RunContext, row: RecipientDbRow, reason: string): Promise<Outcome> {
  await setRecipient(ctx.admin, row.id, { status: 'skipped', skip_reason: reason });
  return 'skipped';
}

async function fail(ctx: RunContext, row: RecipientDbRow, error: string, code = '', couponId: string | null = null): Promise<Outcome> {
  await setRecipient(ctx.admin, row.id, { status: 'failed', error: error.slice(0, 300), error_code: code, cost_inr: 0 });
  // A code that never reached the customer must not stay live.
  if (couponId) {
    const { error: couponError } = await ctx.admin.from('coupons').update({ active: false }).eq('id', couponId);
    if (couponError) console.error('marketing sender: could not deactivate coupon', couponError.message);
  }
  return 'failed';
}

/**
 * Issues the recipient's coupon: single-use, locked to their phone, valid through the end
 * of the IST day `validity_days` from now. A unique violation on the code (two recipients
 * drew the same 6 characters) retries with a fresh code, up to 3 times.
 */
async function issueCoupon(
  admin: Admin,
  campaign: CampaignRow,
  row: RecipientDbRow,
  now: Date,
): Promise<{ id: string; code: string } | null> {
  const fields = couponFieldsFor(campaign.offer);
  if (!fields) return null;
  const days = validityDays(campaign.offer);
  const prefix = couponPrefixFor(campaign.playbook_key);
  for (let attempt = 0; attempt < COUPON_CODE_MAX_ATTEMPTS; attempt++) {
    const code = generateCouponCode(prefix, secureRng);
    const { data, error } = await admin
      .from('coupons')
      .insert({
        code,
        description: `Marketing: ${campaign.name}`,
        discount_type: fields.discount_type,
        discount_value: fields.discount_value,
        max_discount_inr: fields.max_discount_inr,
        min_order_inr: fields.min_order_inr,
        scope: fields.scope,
        valid_from: now.toISOString(),
        valid_to: validTill(now, days).toISOString(),
        usage_limit: 1,
        per_user_limit: 1,
        is_auto: false,
        active: true,
        campaign_id: campaign.id,
        assigned_phone: row.phone,
      })
      .select('id')
      .single();
    if (!error && data) return { id: (data as { id: string }).id, code };
    if (isUniqueViolation(error)) continue;
    // Anything else — including the phone-lock column missing — must NOT fall back to an unlocked code.
    throw new Error(error?.message ?? 'coupon insert failed');
  }
  return null;
}

/** One claimed row, start to finish. Never throws. */
async function processRow(ctx: RunContext, row: RecipientDbRow): Promise<Outcome> {
  const { admin, settings } = ctx;
  const now = ctx.now();
  // Tracked outside the try so an unexpected exception can still clean up: a coupon issued for a
  // message that never left must be deactivated; one for a message that DID leave must not be.
  let couponId: string | null = null;
  let messageLeft = false;

  try {
    // ---- the campaign is still live? ---------------------------------------
    const campaign = await loadCampaign(admin, row.campaign_id);
    if (!campaign || (campaign.status !== 'approved' && campaign.status !== 'sending')) {
      await setRecipient(admin, row.id, { status: 'cancelled', skip_reason: '' });
      return 'skipped';
    }

    // ---- WhatsApp credentials (never the stub) -----------------------------
    if (!ctx.configured) return await skip(ctx, row, 'not_configured');

    // ---- consent, number and caps, re-read NOW (rules 1, 3, 4, 5) ----------
    let verdict;
    try {
      const [state, recent] = await Promise.all([
        loadConsentState(admin, row.phone),
        loadRecentSendsForPhone(admin, row.phone, now, row.id),
      ]);
      verdict = evaluateContact(
        { phone: row.phone, role: null, consent_opted_in: state.opted_in, opt_out_listed: state.opt_out_listed },
        recent,
        { now, settings, receipts_connected: true },
        { phase: 'send' },
      );
    } catch (err) {
      // We do not know whether they consented, and "unknown" is not "yes". Nothing has been sent, so it is
      // safe to put the row back for the next tick — a few times, then give up.
      if (isMigrationMissingError(err)) throw err;
      if (row.attempts < MAX_ATTEMPTS) {
        await admin.from('marketing_recipients').update({ status: 'queued', claimed_at: null }).eq('id', row.id).eq('status', 'sending');
        return 'skipped';
      }
      return await fail(ctx, row, 'consent_check_failed');
    }
    if (!verdict.eligible) return await skip(ctx, row, verdict.reason);

    // ---- the template -------------------------------------------------------
    const template = campaign.template;
    if (!template.name.trim()) return await fail(ctx, row, 'no_template');
    if (template.url_button && !row.click_token) return await fail(ctx, row, 'no_click_token');

    // ---- the coupon (only now) ---------------------------------------------
    const values: TemplateValues = { ...row.vars };
    if (needsCoupon(campaign.offer)) {
      let issued: { id: string; code: string } | null;
      try {
        issued = await issueCoupon(admin, campaign, row, now);
      } catch (err) {
        return await fail(ctx, row, `coupon_failed: ${err instanceof Error ? err.message : 'unknown'}`);
      }
      if (!issued) return await fail(ctx, row, couponFieldsFor(campaign.offer) ? 'coupon_failed: code collision' : 'offer_not_issuable');
      couponId = issued.id;
      values.code = issued.code;
      values.valid_till = formatShortDate(validTill(now, validityDays(campaign.offer)));
      // Recorded BEFORE the send, so a run that dies mid-send still leaves the code traceable to its recipient.
      await admin.from('marketing_recipients').update({ coupon_id: issued.id, coupon_code: issued.code }).eq('id', row.id);
    }

    const vars = buildVars(template.vars, values);

    // ---- the send -----------------------------------------------------------
    let result: { ok: boolean; providerRef: string; error: string };
    try {
      result = await whatsappAdapter.send({
        to: row.phone,
        channel: 'whatsapp',
        body: renderPreview(template.body_preview, vars),
        templateName: template.name,
        templateLang: template.lang,
        templateVars: vars,
        templateButtons: template.url_button && row.click_token ? [{ index: 0, text: row.click_token }] : undefined,
      });
    } catch (err) {
      result = { ok: false, providerRef: '', error: err instanceof Error ? err.message : 'send failed' };
    }

    if (!result.ok) {
      const code = parseMetaErrorCode(result.error);
      // 131049 (Meta's per-user marketing cap) is an ordinary failure: cost 0, and no retry — the row is 'failed', not 'queued'.
      const outcome = await fail(ctx, row, result.error || 'send failed', code, couponId);
      if (code === META_STOP_PROMOTIONS) {
        // The customer tapped Meta's "Stop promotions". That is an opt-out like any other.
        const r = await recordOptOut({ phone: row.phone, userId: row.user_id, source: 'meta_131050', admin });
        if (!r.ok) console.error('marketing sender: 131050 opt-out not recorded', r.error);
      }
      return outcome;
    }

    // ---- recorded ------------------------------------------------------------
    messageLeft = true;
    const sentAt = now.toISOString();
    const patch = {
      status: 'sent',
      sent_at: sentAt,
      // The attribution clock starts when the message left.
      reference_at: sentAt,
      provider_ref: result.providerRef,
      cost_inr: settings.message_cost_inr,
      error: '',
      error_code: '',
    };
    let { error: updateError } = await admin.from('marketing_recipients').update(patch).eq('id', row.id).eq('status', 'sending');
    if (updateError) {
      // The message IS sent. Losing this write would leave a sent row 'sending' (later marked interrupted), so try once more.
      ({ error: updateError } = await admin.from('marketing_recipients').update(patch).eq('id', row.id).eq('status', 'sending'));
      if (updateError) console.error('marketing sender: SENT but the row could not be updated', row.id, updateError.message);
    }

    if (!ctx.startedCampaigns.has(campaign.id)) {
      ctx.startedCampaigns.add(campaign.id);
      // Bookkeeping AFTER a real send: a failure here is logged, never allowed to turn a sent message into a failed one.
      try {
        await markCampaignStarted(admin, campaign, sentAt);
      } catch (err) {
        console.error('marketing sender: could not mark the campaign started', campaign.id, err);
      }
    }
    return 'sent';
  } catch (err) {
    if (isMigrationMissingError(err) && !messageLeft) throw err;
    console.error('marketing sender: row failed', row.id, err);
    if (messageLeft) return 'sent';
    return await fail(ctx, row, err instanceof Error ? err.message : 'unexpected error', '', couponId);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * One sender run. `now` is the run's start; a long run's later chunks see a `now` advanced
 * by the real elapsed time, so the send-window check and every timestamp stay honest.
 * A missing migration is a no-op (`enabled:false, migration_missing:true`), never an error.
 */
export async function runSendBatch(now: Date = new Date(), opts: SendBatchOptions = {}): Promise<SendCronResult> {
  try {
    return await run(now, opts);
  } catch (err) {
    if (isMigrationMissingError(err)) return zero({ enabled: false, migration_missing: true });
    throw err;
  }
}

async function run(startNow: Date, opts: SendBatchOptions): Promise<SendCronResult> {
  const admin = opts.admin ?? marketingAdmin();
  const clock = opts.clock ?? Date.now;
  const t0 = clock();
  const nowFn = () => new Date(startNow.getTime() + (clock() - t0));

  // 1. Kill switch.
  const settings = await loadSettings(admin);
  if (!settings || !settings.enabled) return zero({ enabled: false });

  // 2. Never-finished sends.
  const interrupted = await markInterrupted(admin, startNow);

  // 3. The IST send window.
  if (!isWithinSendWindow(startNow, settings.send_window_start_hour, settings.send_window_end_hour)) {
    await completeFinishedCampaigns(admin, startNow);
    return zero({ outside_window: true, interrupted });
  }

  // 4–5. What the month's budget and the day's cap still allow. Read before the first claim…
  const allowance = async (at: Date) => {
    // The month's budget (IST month).
    const spent = await sumSpendSince(admin, istMonthStart(at).toISOString());
    const budgetLeft = settings.monthly_budget_inr - spent;
    const affordable = settings.message_cost_inr > 0 ? Math.floor((budgetLeft + 1e-9) / settings.message_cost_inr) : Infinity;
    // The day's cap (IST day).
    const sentToday = await countSentSince(admin, istDayStart(at).toISOString());
    return { affordable, todayLeft: settings.daily_send_cap - sentToday };
  };

  const result = zero({ interrupted });
  const first = await allowance(startNow);
  if (first.affordable <= 0) result.budget_exhausted = true;

  const ctx: RunContext = {
    admin,
    settings,
    now: nowFn,
    configured: whatsappReminderHealth().configured,
    startedCampaigns: new Set(),
  };

  // 6–7. Claim a few rows at a time and process them. Claiming in small chunks (not one
  // 50-row grab) means a run cut off by the platform's time limit strands at most one
  // chunk in 'sending', and everything not yet claimed simply waits for the next tick.
  //
  // The allowance is RE-READ before every chunk. Two runs can overlap (a slow pg_cron tick
  // and the planner's fallback nudge): each still could not claim the same row, but each
  // reading the budget once at the start could together overshoot it. Re-reading keeps the
  // overshoot to what the other run had claimed but not yet sent — a chunk.
  let claimedTotal = 0;
  let allow = first;
  while (claimedTotal < MAX_BATCH && clock() - t0 < RUN_BUDGET_MS) {
    // A long run must not carry on past the end of the window it started in.
    if (claimedTotal > 0) {
      const at = nowFn();
      if (!isWithinSendWindow(at, settings.send_window_start_hour, settings.send_window_end_hour)) break;
      allow = await allowance(at);
    }
    const take = Math.min(CLAIM_CHUNK, MAX_BATCH - claimedTotal, allow.affordable, allow.todayLeft);
    if (take <= 0) {
      if (allow.affordable <= 0) result.budget_exhausted = true;
      break;
    }
    const { data, error } = await admin.rpc('claim_marketing_recipients', { p_limit: take });
    assertOk('claim_marketing_recipients', error);
    const claimed = ((data ?? []) as Record<string, unknown>[]).map(toRecipientRow);
    if (claimed.length === 0) break;

    claimedTotal += claimed.length;
    result.claimed += claimed.length;
    for (const row of claimed) {
      const outcome = await processRow(ctx, row);
      if (outcome === 'sent') result.sent += 1;
      else if (outcome === 'skipped') result.skipped += 1;
      else result.failed += 1;
    }
    if (claimed.length < take) break;
  }

  // 8. Close out campaigns with nothing left to send.
  await completeFinishedCampaigns(admin, nowFn());
  return result;
}
