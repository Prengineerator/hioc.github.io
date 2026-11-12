// The post-order feedback REQUEST's delivery machine (feedback_requests.status,
// supabase/2026-10-order-feedback.sql), in one place. Pure and client-safe.
//
//   pending ─┬─ cron / owner resend ─→ sent      the template went out (or, for the
//            │                                    cron, had already gone: see 'already_sent')
//            ├─ cron / owner resend ─→ skipped   deliberately not sent (order cancelled,
//            │                                    opted out, channel not configured, …)
//            └─ cron / owner resend ─→ failed    the provider refused it
//   failed | skipped ── owner resend ─→ sent | skipped | failed
//   sent ────────────── owner resend ─→ sent     a fresh link; the old one goes dead
//
// Two rules the writers used to break:
//   * Once a request leaves 'pending' the CRON never touches it again. Its skip
//     write had no guard at all, so a skip decided on a stale read could stamp
//     'skipped' over the 'sent' an owner resend had just recorded.
//   * 'sent' is never undone. A forced resend that FAILS is not news about the
//     message that already went: sent_at stays set, so writing 'failed' over it
//     made the summary (which counts status='sent') quietly drop a request the
//     customer had actually received.
//
// The claim sub-state: a 'pending' row with a fresh claimed_at is held by one
// cron run (claim_feedback_requests(), FOR UPDATE SKIP LOCKED); a claim older
// than FEEDBACK_CLAIM_STALE_MS belonged to a run that died and is re-claimable.

import type { FeedbackRequestStatus } from '@/lib/types';

export const FEEDBACK_DELIVERY_STATUSES = ['pending', 'sent', 'skipped', 'failed'] as const;

// Exhaustiveness: the array and lib/types.ts must name exactly the same statuses.
type Listed = (typeof FEEDBACK_DELIVERY_STATUSES)[number];
const _sameVocabulary: [Exclude<FeedbackRequestStatus, Listed>, Exclude<Listed, FeedbackRequestStatus>] extends [
  never,
  never,
]
  ? true
  : never = true;
void _sameVocabulary;

/**
 * Who moves a request: the scheduled cron (GET/POST /api/cron/feedback-requests)
 * or the owner's explicit "resend the template" (POST /api/owner/feedback/[id]/resend).
 */
export type FeedbackDeliveryActor = 'cron' | 'owner_resend';

interface DeliveryTransition {
  from: FeedbackRequestStatus;
  to: FeedbackRequestStatus;
  actors: readonly FeedbackDeliveryActor[];
}

const BOTH: readonly FeedbackDeliveryActor[] = ['cron', 'owner_resend'];
const OWNER: readonly FeedbackDeliveryActor[] = ['owner_resend'];

export const FEEDBACK_DELIVERY_TRANSITIONS: readonly DeliveryTransition[] = [
  { from: 'pending', to: 'sent', actors: BOTH },
  { from: 'pending', to: 'skipped', actors: BOTH },
  { from: 'pending', to: 'failed', actors: BOTH },
  { from: 'failed', to: 'sent', actors: OWNER },
  { from: 'failed', to: 'skipped', actors: OWNER },
  { from: 'failed', to: 'failed', actors: OWNER },
  { from: 'skipped', to: 'sent', actors: OWNER },
  { from: 'skipped', to: 'skipped', actors: OWNER },
  { from: 'skipped', to: 'failed', actors: OWNER },
  // A resend that went out re-mints the link; one that did not leaves 'sent' alone.
  { from: 'sent', to: 'sent', actors: OWNER },
];

/** Statuses the cron never moves a request out of. */
export const CRON_TERMINAL_STATUSES: readonly FeedbackRequestStatus[] = FEEDBACK_DELIVERY_STATUSES.filter(
  (s) => !FEEDBACK_DELIVERY_TRANSITIONS.some((t) => t.from === s && t.actors.includes('cron')),
);

export type TransitionCheck = { ok: true } | { ok: false; code: string; message: string };

export function canTransitionDelivery(
  from: FeedbackRequestStatus,
  to: FeedbackRequestStatus,
  ctx: { actor: FeedbackDeliveryActor },
): TransitionCheck {
  const rule = FEEDBACK_DELIVERY_TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (!rule) return { ok: false, code: 'illegal_transition', message: `A ${from} feedback request cannot become ${to}.` };
  if (!rule.actors.includes(ctx.actor)) {
    return { ok: false, code: 'not_allowed', message: `The ${ctx.actor} may not move a ${from} feedback request to ${to}.` };
  }
  return { ok: true };
}

/** The statuses `actor` may move a request to `to` FROM — what a compare-and-set write filters on. */
export function deliveryFromStates(to: FeedbackRequestStatus, actor: FeedbackDeliveryActor): FeedbackRequestStatus[] {
  return FEEDBACK_DELIVERY_STATUSES.filter((from) => canTransitionDelivery(from, to, { actor }).ok);
}

/** claim_feedback_requests() re-claims a pending row whose claim is older than this. Keep in step with the SQL. */
export const FEEDBACK_CLAIM_STALE_MS = 10 * 60 * 1000;

/** True while a pending request is held by a cron run that may still be sending it. */
export function isClaimed(row: { status: string; claimed_at: string | null }, nowMs: number): boolean {
  if (row.status !== 'pending' || !row.claimed_at) return false;
  const at = Date.parse(row.claimed_at);
  return Number.isFinite(at) && nowMs - at < FEEDBACK_CLAIM_STALE_MS;
}

/**
 * What one send attempt came to, from the notification engine's answer:
 *   sent          a template went out now, carrying the token just minted
 *   already_sent  the engine's log shows one went out EARLIER (a cron run that died after
 *                 sending, re-claimed): a request may be marked sent, but the token minted
 *                 for THIS attempt was never delivered and must not replace the stored one
 *   skipped       deliberately not sent; the reason says why
 *   failed        the provider refused it
 *   deferred      another caller is sending it right now: write nothing, the cron's claim
 *                 expires and the next run sees the outcome
 */
export type FeedbackSendOutcome = 'sent' | 'already_sent' | 'skipped' | 'failed' | 'deferred';

export function outcomeOfEngineResult(r: { sent: boolean; skipped?: string; error?: string }): {
  outcome: FeedbackSendOutcome;
  reason: string;
} {
  if (r.sent) return r.skipped === 'already_sent' ? { outcome: 'already_sent', reason: '' } : { outcome: 'sent', reason: '' };
  if (r.skipped === 'in_flight') return { outcome: 'deferred', reason: 'in_flight' };
  if (r.skipped) return { outcome: 'skipped', reason: r.skipped };
  return { outcome: 'failed', reason: r.error || 'send_failed' };
}

/** The status an outcome records, or null for one that records nothing. */
export function statusForOutcome(outcome: FeedbackSendOutcome): FeedbackRequestStatus | null {
  switch (outcome) {
    case 'sent':
    case 'already_sent':
      return 'sent';
    case 'skipped':
      return 'skipped';
    case 'failed':
      return 'failed';
    case 'deferred':
      return null;
  }
}
