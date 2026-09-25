import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { sendFeedbackTemplate } from '@/lib/feedback/send';
import { templateResendAllowed } from '@/lib/feedback/window';
import type { FeedbackRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/owner/feedback/[id]/resend — re-sends order_feedback_1 for a
// thread whose reply window has closed and the customer hasn't picked a
// rating yet (or the owner just wants another nudge). Only allowed when the
// template wasn't ALREADY sent in the last 24h — the same rule the thread UI
// enforces before offering the button — so this can't be used to spam a
// customer with repeated templates.
export async function POST(_request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  if (!isUuid(params.id)) return notFound();

  const admin = createAdminSupabaseClient();
  const { data: req, error } = await admin.from('feedback_requests').select('*').eq('id', params.id).maybeSingle();
  if (error) return errorResponse(500, error.message);
  if (!req) return notFound();
  const feedbackRequest = req as FeedbackRequest;

  if (!templateResendAllowed(feedbackRequest.sent_at)) {
    return errorResponse(409, 'The feedback template was already sent in the last 24 hours.');
  }

  const allowed = await rateLimitOk(`feedback-resend:${feedbackRequest.id}`, 3, 600);
  if (!allowed) return errorResponse(429, 'Too many resends for this order — please wait a moment.');

  const { data: order } = await admin
    .from('orders')
    .select('order_number')
    .eq('id', feedbackRequest.order_id)
    .maybeSingle();
  if (!order) return errorResponse(409, 'The order for this thread no longer exists.');

  const result = await sendFeedbackTemplate(
    {
      id: feedbackRequest.id,
      order_id: feedbackRequest.order_id,
      phone: feedbackRequest.phone,
      customer_name: feedbackRequest.customer_name,
    },
    order.order_number as number,
    { force: true, admin },
  );

  if (!result.sent) {
    return errorResponse(502, `Resend failed: ${result.reason || 'unknown error'}`);
  }
  return NextResponse.json({ ok: true });
}
