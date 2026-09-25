// Shared "actually send the order_feedback_1 template for this request" path
// — used by the cron (the scheduled 30-min-later send) and by the owner
// inbox's "resend the feedback template" action, so both mint the token the
// same way and update feedback_requests the same way.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { newFeedbackToken, hashFeedbackToken } from '@/lib/feedback/token';
import { sendFeedbackRequestNotification } from '@/lib/notifications/engine';
import type { FeedbackRequest } from '@/lib/types';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export interface SendFeedbackTemplateResult {
  sent: boolean;
  /** Skip/failure reason, '' when sent. */
  reason: string;
}

/**
 * Mints a fresh raw token (see the migration's comment on
 * feedback_requests.token_hash for why it is minted here, at send time, and
 * not earlier), sends the template, and writes the outcome back onto the
 * request row. Never throws — every branch resolves to a result the caller
 * can log or report.
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

  if (result.sent) {
    const { error } = await admin
      .from('feedback_requests')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        provider_ref: result.providerRef ?? '',
        token_hash: tokenHash,
        skip_reason: '',
      })
      .eq('id', request.id);
    if (error) console.error('sendFeedbackTemplate: failed to record sent status', error);
    return { sent: true, reason: '' };
  }

  const reason = result.skipped ?? result.error ?? 'send_failed';
  const { error } = await admin
    .from('feedback_requests')
    .update({
      status: result.skipped ? 'skipped' : 'failed',
      skip_reason: reason,
    })
    .eq('id', request.id);
  if (error) console.error('sendFeedbackTemplate: failed to record skip/failure', error);
  return { sent: false, reason };
}
