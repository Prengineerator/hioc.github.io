// Shared "actually send the order_feedback_1 template for this request" path
// — used by the cron (the scheduled 30-min-later send) and by the owner
// inbox's "resend the feedback template" action, so both mint the token the
// same way and update feedback_requests the same way: through the delivery
// machine in lib/feedback/deliveryState.ts, as a compare-and-set.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { newFeedbackToken, hashFeedbackToken } from '@/lib/feedback/token';
import { sendFeedbackRequestNotification } from '@/lib/notifications/engine';
import {
  deliveryFromStates,
  outcomeOfEngineResult,
  statusForOutcome,
  type FeedbackSendOutcome,
} from '@/lib/feedback/deliveryState';
import type { FeedbackRequest } from '@/lib/types';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export interface SendFeedbackTemplateResult {
  sent: boolean;
  /** Skip/failure reason, '' when sent. */
  reason: string;
  /** What the attempt came to (deliveryState.ts) — the cron counts by this. */
  outcome: FeedbackSendOutcome;
}

/**
 * Mints a fresh raw token (see the migration's comment on
 * feedback_requests.token_hash for why it is minted here, at send time, and
 * not earlier), sends the template, and writes the outcome back onto the
 * request row. Never throws — every branch resolves to a result the caller
 * can log or report.
 *
 * The write only lands from a status this actor may move (deliveryFromStates):
 * the cron only from 'pending', so a run racing an owner resend — or a second
 * run that re-claimed the row after the first stalled — cannot overwrite what
 * the other recorded; and nobody moves 'sent' to 'failed'/'skipped'.
 *
 * The token hash is written ONLY with a send that carried that token. When the
 * engine answers 'already_sent' the message that went out carried some EARLIER
 * token: storing this attempt's hash over it would turn the customer's working
 * link into a 404 (app/api/feedback/[token] looks rows up by it).
 *
 * `force` re-delivers past the notifications table's own (order_id, event,
 * channel) idempotency guard — only the owner's explicit "resend" action
 * should ever pass it.
 */
export async function sendFeedbackTemplate(
  request: Pick<FeedbackRequest, 'id' | 'order_id' | 'phone' | 'customer_name'>,
  orderNumber: number,
  opts: { force?: boolean; admin?: Admin } = {},
): Promise<SendFeedbackTemplateResult> {
  const admin = opts.admin ?? createAdminSupabaseClient();
  const actor = opts.force ? 'owner_resend' : 'cron';
  const token = newFeedbackToken();
  const tokenHash = hashFeedbackToken(token);

  const result = await sendFeedbackRequestNotification(
    {
      orderId: request.order_id,
      phone: request.phone,
      customerName: request.customer_name,
      orderNumber,
      requestId: request.id,
      token,
    },
    { force: opts.force },
  );

  const { outcome, reason } = outcomeOfEngineResult(result);
  const to = statusForOutcome(outcome);
  const sent = outcome === 'sent' || outcome === 'already_sent';
  // Someone else is mid-send: leave the row exactly as it is (still pending and
  // claimed), and let the next cron run read the outcome off the engine's log.
  if (to === null) return { sent: false, reason, outcome };

  const patch: Record<string, unknown> =
    outcome === 'sent'
      ? {
          status: 'sent',
          sent_at: new Date().toISOString(),
          provider_ref: result.providerRef ?? '',
          token_hash: tokenHash,
          skip_reason: '',
        }
      : outcome === 'already_sent'
        ? // No token_hash: see above. sent_at is "now" because the engine does not
          // say when the earlier send happened; a pending row has none to keep.
          { status: 'sent', sent_at: new Date().toISOString(), provider_ref: result.providerRef ?? '', skip_reason: '' }
        : { status: to, skip_reason: reason };

  const { data, error } = await admin
    .from('feedback_requests')
    .update(patch)
    .eq('id', request.id)
    .in('status', deliveryFromStates(to, actor))
    .select('id');
  if (error) {
    console.error(`sendFeedbackTemplate: failed to record ${outcome}`, error);
  } else if ((data ?? []).length === 0) {
    // Not an error: the row moved on before this write (an owner resend landed
    // first, or this is a failed resend over a request that was already sent —
    // which keeps its 'sent').
    console.info(`sendFeedbackTemplate: ${request.id} not moved to ${to} (${actor}); it had already moved on`);
  }
  return { sent, reason, outcome };
}
