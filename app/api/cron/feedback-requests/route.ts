import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { getStoreSettings } from '@/lib/store/settings';
import { sendFeedbackTemplate } from '@/lib/feedback/send';
import { deliveryFromStates, type FeedbackSendOutcome } from '@/lib/feedback/deliveryState';
import { loadOptedOutPhones } from '@/lib/marketing/server/consent';
import type { FeedbackRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

// GET or POST /api/cron/feedback-requests — polled by pg_cron every 5 minutes
// (supabase/2026-10-order-feedback.sql), only when feedback is on and a
// request is due (supabase/2026-11-feedback-cron-guard.sql; keep that check in
// step with claim_feedback_requests()), via `net.http_post`, which issues a
// POST — so POST is exported alongside GET (GET for a manual curl / a
// Vercel-style trigger); both run the identical handler. NOT Vercel Cron:
// Vercel's plan here only runs crons daily, which cannot express "30 minutes
// after an arbitrary completion time". Protected by CRON_SECRET (Bearer),
// same fail-CLOSED posture as every other /api/cron/* route — an unset secret
// disables the endpoint outright rather than leaving it runnable by anyone
// who finds it.
//
// Picks due `feedback_requests` (status='pending', scheduled_for <= now) in
// small batches, claimed atomically via claim_feedback_requests() (FOR UPDATE
// SKIP LOCKED + a staleness window) so two overlapping runs never both send
// the same request — the "idempotent per order" guarantee the spec calls for
// lives in THREE independent places: this row-claim, the unique index on
// feedback_requests.order_id (one request per order, ever), and the
// notifications table's own (order_id, event, channel) uniqueness that
// deliverAndLog enforces on the actual send.
//
// Every skip rule is re-checked here even though enqueueFeedbackRequest()
// already checked most of them at completion time — 30 minutes is long enough
// for the world to change: the order could have been cancelled since, the
// customer could have replied STOP in the meantime, or the owner could have
// turned the whole feature off.
const BATCH_SIZE = 25;

type ClaimedRow = FeedbackRequest;

/**
 * Shared by GET and POST (see the exports below): pg_cron's `net.http_post`
 * issues a POST, while a manual curl or a Vercel-style cron trigger typically
 * issues a GET — both are accepted so this can be triggered either way
 * without caring which the caller happens to use.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const settings = await getStoreSettings();
  if (!settings.feedback_enabled) {
    // Deliberately does NOT claim (let alone skip) anything: a temporary
    // toggle-off must not permanently mark due requests 'skipped' — they stay
    // 'pending' and are simply picked up on the first run after the owner
    // turns feedback back on, whenever that is.
    return NextResponse.json({ enabled: false, claimed: 0, sent: 0, skipped: 0, failed: 0 });
  }

  const admin = createAdminSupabaseClient();

  const { data: claimedRaw, error: claimError } = await admin.rpc('claim_feedback_requests', {
    p_limit: BATCH_SIZE,
  });
  if (claimError) {
    console.error('feedback-requests cron: claim failed', claimError);
    return errorResponse(500, 'Failed to claim due feedback requests');
  }

  const claimed = (claimedRaw ?? []) as ClaimedRow[];
  if (claimed.length === 0) {
    return NextResponse.json({ enabled: true, claimed: 0, sent: 0, skipped: 0, failed: 0 });
  }

  const orderIds = claimed.map((r) => r.order_id);
  const phones = [...new Set(claimed.map((r) => r.phone).filter(Boolean))];

  // "Opted out?" is the ONE predicate every non-transactional sender uses
  // (lib/marketing/consentState.ts isOptedOut, read by consent.ts): the STOP
  // table in any stored spelling OR a ledger that says opted_out. A failed read
  // fails the run closed — the claims expire and the next tick retries — rather
  // than messaging people whose STOP could not be checked (this used to treat a
  // failed read as "nobody opted out").
  const [{ data: orderRows }, optOutRead] = await Promise.all([
    admin.from('orders').select('id, status, order_number, customer_phone').in('id', orderIds),
    loadOptedOutPhones(admin, phones).then(
      (set) => ({ ok: true as const, set }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
  ]);
  if (!optOutRead.ok) {
    console.error('feedback-requests cron: opt-out read failed — sending nothing this run', optOutRead.err);
    return errorResponse(500, 'Failed to read opt-outs');
  }
  const optedOut = optOutRead.set;

  const ordersById = new Map((orderRows ?? []).map((o) => [o.id as string, o]));
  // Only a request still 'pending' may be skipped by the cron (deliveryState.ts): one an
  // owner resend moved on since the claim keeps what that resend recorded.
  const skippableFrom = deliveryFromStates('skipped', 'cron');

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let deferred = 0;

  for (const req of claimed) {
    const order = ordersById.get(req.order_id) as
      | { id: string; status: string; order_number: number; customer_phone: string | null }
      | undefined;

    const skipReason = !order
      ? 'order_not_found'
      : (order.status === 'cancelled' || order.status === 'rejected')
        ? 'order_cancelled'
        : !req.phone
          ? 'no_phone'
          : optedOut.has(req.phone)
            ? 'opted_out'
            : '';

    if (skipReason) {
      const { data: moved, error } = await admin
        .from('feedback_requests')
        .update({ status: 'skipped', skip_reason: skipReason })
        .eq('id', req.id)
        .in('status', skippableFrom)
        .select('id');
      if (error) console.error('feedback-requests cron: failed to record skip', error);
      else if ((moved ?? []).length === 0) console.info(`feedback-requests cron: ${req.id} moved on before its skip landed`);
      else skipped++;
      continue;
    }

    const result = await sendFeedbackTemplate(
      { id: req.id, order_id: req.order_id, phone: req.phone, customer_name: req.customer_name },
      order!.order_number,
      { admin },
    );
    const outcome = result.outcome ?? legacyOutcome(result);
    if (outcome === 'sent' || outcome === 'already_sent') sent++;
    else if (outcome === 'skipped') skipped++;
    else if (outcome === 'deferred') deferred++;
    else failed++;
  }

  return NextResponse.json({ enabled: true, claimed: claimed.length, sent, skipped, failed, deferred });
}

/** For a result that does not carry its outcome: the classification this route always used. */
function legacyOutcome(result: { sent: boolean; reason: string }): FeedbackSendOutcome {
  if (result.sent) return 'sent';
  if (result.reason.startsWith('not_configured:') || result.reason === 'notifications_disabled') return 'skipped';
  return 'failed';
}

// GET — manual triggering (curl, a Vercel-style cron trigger, an owner "run it
// now" button if one is ever added).
export async function GET(request: Request) {
  return handle(request);
}

// POST — what pg_cron's `net.http_post` actually issues (supabase/
// 2026-10-order-feedback.sql's scheduled job). Without this export every tick
// 405s and nothing ever sends — GET alone was not enough.
export async function POST(request: Request) {
  return handle(request);
}
