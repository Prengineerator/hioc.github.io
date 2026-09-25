import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { withinCustomerServiceWindow } from '@/lib/feedback/window';
import type { FeedbackMessage, FeedbackRequest, FeedbackThreadStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

const THREAD_STATUSES: FeedbackThreadStatus[] = ['open', 'in_progress', 'resolved'];

// GET /api/owner/feedback/[id] — one thread: the request, the order it's
// about, and the full message history (chat order, oldest first).
export async function GET(_request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  if (!isUuid(params.id)) return notFound();

  const admin = createAdminSupabaseClient();

  const { data: req, error } = await admin.from('feedback_requests').select('*').eq('id', params.id).maybeSingle();
  if (error) return errorResponse(500, error.message);
  if (!req) return notFound();

  const request = req as FeedbackRequest;

  const [{ data: orderRow }, { data: msgRows }] = await Promise.all([
    admin
      .from('orders')
      .select('id, order_number, total_inr, subtotal_inr, order_items(id, name_snapshot, quantity, voided)')
      .eq('id', request.order_id)
      .maybeSingle(),
    admin
      .from('feedback_messages')
      .select('*')
      .eq('request_id', request.id)
      .order('created_at', { ascending: true }),
  ]);

  // The authoritative 24h customer-service-window check reads the message log
  // directly rather than trusting feedback_requests.last_inbound_at, which is
  // a convenience cache for the list view's sort/filter, not the source of
  // truth a send decision should hinge on.
  const lastInbound = [...(msgRows ?? [])].reverse().find((m) => m.direction === 'in');
  const canReplyFreeform = withinCustomerServiceWindow(lastInbound?.created_at ?? null);

  return NextResponse.json({
    request,
    order: orderRow ?? null,
    messages: (msgRows ?? []) as FeedbackMessage[],
    canReplyFreeform,
  });
}

// PATCH /api/owner/feedback/[id] — owner-side thread controls: status, notes,
// assignee, mark read. Any subset of these fields; nothing else is writable.
export async function PATCH(request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const patch: Record<string, unknown> = {};
  if (body.thread_status !== undefined) {
    if (!THREAD_STATUSES.includes(body.thread_status as FeedbackThreadStatus)) {
      return errorResponse(400, 'thread_status must be one of open, in_progress, resolved');
    }
    patch.thread_status = body.thread_status;
  }
  if (body.owner_notes !== undefined) {
    if (typeof body.owner_notes !== 'string') return errorResponse(400, 'owner_notes must be a string');
    patch.owner_notes = body.owner_notes.slice(0, 4000);
  }
  if (body.assignee_id !== undefined) {
    if (body.assignee_id !== null && !isUuid(body.assignee_id)) {
      return errorResponse(400, 'assignee_id must be a uuid or null');
    }
    patch.assignee_id = body.assignee_id;
  }
  if (body.unread !== undefined) {
    if (typeof body.unread !== 'boolean') return errorResponse(400, 'unread must be a boolean');
    patch.unread = body.unread;
  }

  if (Object.keys(patch).length === 0) {
    return errorResponse(400, 'No writable fields provided');
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('feedback_requests')
    .update(patch)
    .eq('id', params.id)
    .select('*')
    .maybeSingle();

  if (error) return errorResponse(500, error.message);
  if (!data) return notFound();

  return NextResponse.json({ request: data as FeedbackRequest });
}
