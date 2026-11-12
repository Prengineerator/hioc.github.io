// The one write for "the customer just said something on this thread" — a
// WhatsApp message or button tap (app/api/webhooks/whatsapp) or a web-form
// rating (app/api/feedback/[token]). Server-only.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { REOPENED_BY_INBOUND } from '@/lib/feedback/threadState';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/**
 * Marks the thread unread with `patch` (last_inbound_at, a rating, …) and then
 * reopens it if it was resolved (lib/feedback/threadState.ts: the customer's
 * one transition). The reopen is its own guarded UPDATE — `thread_status in
 * (resolved)` — rather than a status read earlier in the request, so an owner
 * resolving the thread at the same moment cannot have the reopen decided on a
 * status that is no longer true.
 *
 * Returns the first write's error (the caller decides whether that matters);
 * a failed reopen is only logged — the message itself is already recorded.
 */
export async function recordInboundOnThread(
  admin: Admin,
  requestId: string,
  patch: Record<string, unknown>,
): Promise<{ error: { message?: string } | null }> {
  const { error } = await admin
    .from('feedback_requests')
    .update({ ...patch, unread: true })
    .eq('id', requestId);
  if (error) return { error };

  const { error: reopenError } = await admin
    .from('feedback_requests')
    .update({ thread_status: 'open' })
    .eq('id', requestId)
    .in('thread_status', [...REOPENED_BY_INBOUND]);
  if (reopenError) console.error('recordInboundOnThread: reopen failed', requestId, reopenError);
  return { error: null };
}
