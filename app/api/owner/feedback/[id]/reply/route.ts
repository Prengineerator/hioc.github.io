import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { whatsappAdapter } from '@/lib/notifications/adapters';
import { withinCustomerServiceWindow } from '@/lib/feedback/window';
import type { FeedbackRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };
const MAX_BODY_LENGTH = 4096;

// POST /api/owner/feedback/[id]/reply — the owner's chat-back. Free-form
// WhatsApp text, which Meta only allows within 24h of the CUSTOMER's most
// recent inbound message (the "customer service window"). Outside it this
// 409s with a clear reason — the thread UI disables the reply box for the
// same reason and offers the resend-template action instead.
export async function POST(request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text) return errorResponse(400, 'body is required');
  if (text.length > MAX_BODY_LENGTH) return errorResponse(400, `body must be at most ${MAX_BODY_LENGTH} characters`);

  const admin = createAdminSupabaseClient();
  const { data: req, error } = await admin.from('feedback_requests').select('*').eq('id', params.id).maybeSingle();
  if (error) return errorResponse(500, error.message);
  if (!req) return notFound();
  const feedbackRequest = req as FeedbackRequest;

  // Cap owner-sent replies per thread (mirrors resend-bill's own rate limit) —
  // guards against a fat-fingered loop, not against legitimate back-and-forth.
  const allowed = await rateLimitOk(`feedback-reply:${feedbackRequest.id}`, 20, 600);
  if (!allowed) return errorResponse(429, 'Too many replies sent — please wait a moment.');

  const { data: lastInboundRow } = await admin
    .from('feedback_messages')
    .select('created_at')
    .eq('request_id', feedbackRequest.id)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!withinCustomerServiceWindow(lastInboundRow?.created_at ?? null)) {
    return errorResponse(
      409,
      "Outside WhatsApp's 24-hour reply window — the customer hasn't messaged recently enough for a free-text reply. Resend the feedback template instead.",
    );
  }

  const result = await whatsappAdapter.send({ to: feedbackRequest.phone, channel: 'whatsapp', body: text });

  const { data: message, error: insertError } = await admin
    .from('feedback_messages')
    .insert({
      request_id: feedbackRequest.id,
      order_id: feedbackRequest.order_id,
      phone: feedbackRequest.phone,
      direction: 'out',
      body: text,
      wa_message_id: result.providerRef || null,
      status: result.ok ? 'sent' : 'failed',
      error: result.ok ? '' : result.error,
      sent_by: owner.id,
    })
    .select('*')
    .maybeSingle();

  if (insertError) {
    console.error('feedback reply: failed to log message', insertError);
  }

  if (!result.ok) {
    return errorResponse(502, `WhatsApp send failed: ${result.error || 'unknown error'}`);
  }

  return NextResponse.json({ ok: true, message });
}
