// The owner's feedback THREAD (feedback_requests.thread_status + unread,
// supabase/2026-10-order-feedback.sql), as one explicit machine — and the one
// "needs attention" rule the inbox list and the dashboard count both use.
// Pure and client-safe.
//
//   actor      from                         to
//   owner      open | in_progress | resolved  open | in_progress | resolved
//              (the thread page's status picker offers all three from any state)
//   customer   resolved                     open   a new inbound message, button tap,
//                                                  or web-form rating on a resolved
//                                                  thread reopens it
//
// The customer rule is the bug it fixes: an inbound event only ever set
// unread=true, and "needs attention" excludes resolved threads — so a customer
// writing back (or rating 1★) after the owner had resolved the thread was
// hidden from the attention view for good.

import type { FeedbackThreadStatus } from '@/lib/types';

export const FEEDBACK_THREAD_STATUSES = ['open', 'in_progress', 'resolved'] as const;

type Listed = (typeof FEEDBACK_THREAD_STATUSES)[number];
const _sameVocabulary: [Exclude<FeedbackThreadStatus, Listed>, Exclude<Listed, FeedbackThreadStatus>] extends [
  never,
  never,
]
  ? true
  : never = true;
void _sameVocabulary;

export const THREAD_STATUS_LABELS: Record<FeedbackThreadStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
};

/** The status picker's options, in order. */
export const THREAD_STATUS_OPTIONS: readonly { value: FeedbackThreadStatus; label: string }[] =
  FEEDBACK_THREAD_STATUSES.map((value) => ({ value, label: THREAD_STATUS_LABELS[value] }));

export type ThreadActor = 'owner' | 'customer';

interface ThreadTransition {
  actor: ThreadActor;
  from: readonly FeedbackThreadStatus[];
  to: readonly FeedbackThreadStatus[];
}

export const THREAD_TRANSITIONS: readonly ThreadTransition[] = [
  { actor: 'owner', from: FEEDBACK_THREAD_STATUSES, to: FEEDBACK_THREAD_STATUSES },
  { actor: 'customer', from: ['resolved'], to: ['open'] },
];

export function isThreadStatus(value: unknown): value is FeedbackThreadStatus {
  return typeof value === 'string' && (FEEDBACK_THREAD_STATUSES as readonly string[]).includes(value);
}

export type TransitionCheck = { ok: true } | { ok: false; code: string; message: string };

export function canTransitionThread(
  from: FeedbackThreadStatus,
  to: FeedbackThreadStatus,
  ctx: { actor: ThreadActor },
): TransitionCheck {
  const allowed = THREAD_TRANSITIONS.some((t) => t.actor === ctx.actor && t.from.includes(from) && t.to.includes(to));
  return allowed
    ? { ok: true }
    : { ok: false, code: 'illegal_transition', message: `A ${from} thread cannot be moved to ${to} by the ${ctx.actor}.` };
}

/** The thread statuses an inbound customer event reopens — what the reopen write filters on. */
export const REOPENED_BY_INBOUND: readonly FeedbackThreadStatus[] = FEEDBACK_THREAD_STATUSES.filter(
  (from) => canTransitionThread(from, 'open', { actor: 'customer' }).ok,
);

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

/** A rating at or below this is a low one: it needs a human whether or not it is read. */
export const LOW_RATING_MAX = 3;

/** An unread inbound message OR a low rating, on a thread that isn't resolved. */
export function needsAttention(row: {
  thread_status: FeedbackThreadStatus | string;
  unread: boolean;
  rating: number | null;
}): boolean {
  if (row.thread_status === 'resolved') return false;
  return row.unread || (row.rating !== null && row.rating <= LOW_RATING_MAX);
}

interface AttentionFilterable {
  neq(column: string, value: string): AttentionFilterable;
  or(filters: string): AttentionFilterable;
}

/**
 * The PostgREST shape of needsAttention — the ONLY place the query is spelled out.
 * Typed loosely on purpose: supabase-js's builder generics are too deep for a
 * structural constraint (TS2589), and the two methods are all this needs.
 */
export function whereNeedsAttention<Q extends { neq: unknown; or: unknown }>(query: Q): Q {
  const q = query as unknown as AttentionFilterable;
  return q.neq('thread_status', 'resolved').or(`unread.eq.true,rating.lte.${LOW_RATING_MAX}`) as unknown as Q;
}
