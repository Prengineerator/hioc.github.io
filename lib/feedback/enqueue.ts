// Enqueues the post-order feedback request when an order completes. Called
// from the order-status transition route (and any other path that completes
// an order) exactly like the other "on completed" hooks there — best-effort,
// after the transition has already committed, never able to fail it.
//
// The request is created PENDING with `scheduled_for` = now + the store's
// configured delay (default 30 min); the actual send happens later, driven by
// the pg_cron poll → GET /api/cron/feedback-requests (Vercel Cron on this plan
// is daily-only, so it cannot express a 30-minute delay itself).

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStoreSettings } from '@/lib/store/settings';
import { computeScheduledFor } from '@/lib/feedback/window';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export interface EnqueueFeedbackInput {
  orderId: string;
  customerPhone: string | null;
  customerName: string;
}

export type EnqueueFeedbackResult =
  | { queued: true }
  | { queued: false; reason: 'feedback_disabled' | 'no_phone' | 'already_queued' | 'error' };

/**
 * Best-effort — every error path is swallowed and logged, never thrown. The
 * unique index on feedback_requests.order_id is the actual idempotency
 * backstop (a duplicate-key error here is treated as "already queued", not a
 * failure); a second completion of the same order (e.g. a re-opened and
 * re-completed dine-in tab, if that ever becomes possible) must not queue a
 * second request or issue a second token.
 */
export async function enqueueFeedbackRequest(
  input: EnqueueFeedbackInput,
  admin: Admin = createAdminSupabaseClient(),
): Promise<EnqueueFeedbackResult> {
  try {
    if (!input.customerPhone) {
      return { queued: false, reason: 'no_phone' };
    }

    const settings = await getStoreSettings();
    if (!settings.feedback_enabled) {
      return { queued: false, reason: 'feedback_disabled' };
    }

    const scheduledFor = computeScheduledFor(new Date(), settings.feedback_delay_min);

    // No token minted here — see the column comment on feedback_requests.token_hash
    // in the migration. One is generated when the template is actually about
    // to send (the cron), because that is the only moment the raw value is
    // needed and it may need to be minted again later (an owner resend).
    const { error } = await admin.from('feedback_requests').insert({
      order_id: input.orderId,
      phone: input.customerPhone,
      customer_name: input.customerName ?? '',
      scheduled_for: scheduledFor.toISOString(),
    });

    if (error) {
      // 23505 = unique_violation — feedback_requests.order_id is unique. This
      // is exactly the "already asked" guard the spec calls for, not a fault.
      if ((error as { code?: string }).code === '23505') {
        return { queued: false, reason: 'already_queued' };
      }
      console.error('enqueueFeedbackRequest: insert failed', error);
      return { queued: false, reason: 'error' };
    }

    return { queued: true };
  } catch (err) {
    console.error('enqueueFeedbackRequest failed', err);
    return { queued: false, reason: 'error' };
  }
}
