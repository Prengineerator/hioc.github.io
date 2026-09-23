// The delivery ladder, in ONE place.
//
// WA-4 widened `NotificationStatus` from queued/sent/failed/skipped to include
// 'delivered' and 'read'. That widening silently broke every `status === 'sent'`
// test in the codebase: each of them meant "has this already been sent?" and each
// of them started answering "no" for the two statuses that are the strongest
// possible evidence that it WAS. Two of those live in the engine and guard
// against re-sending a billable template and against stamping 'skipped' over a
// delivered row.
//
// So the vocabulary and its ordering are defined here and imported by everyone
// who reasons about it (lib/notifications/engine.ts, app/api/webhooks/whatsapp).
// A future migration that adds a rung edits this file and every guard moves with
// it — which is the property that was missing when WA-4 landed.

import type { NotificationStatus } from '@/lib/types';

/**
 * How far along the delivery ladder each status sits.
 *
 * Two placements are deliberate:
 *   - 'failed' outranks 'sent' (a failure is news worth overwriting an
 *     acceptance with) but ranks BELOW 'delivered'/'read'. Proof that the
 *     handset got the message beats a claim that it could not be sent.
 *   - 'skipped' is off the ladder at -1 and therefore never a candidate for
 *     replacement: a deliberate non-attempt is a different fact, not an early
 *     rung.
 */
export const STATUS_RANK: Record<NotificationStatus, number> = {
  skipped: -1,
  queued: 0,
  sent: 1,
  failed: 2,
  delivered: 3,
  read: 4,
};

/**
 * The statuses that all mean "a provider accepted this message" — the send has
 * already happened, whether or not the handset has confirmed it since.
 *
 * This is the set every "already sent?" guard must test against. Testing
 * `=== 'sent'` is the bug this module exists to prevent.
 */
export const SENT_OR_BETTER: readonly NotificationStatus[] = ['sent', 'delivered', 'read'];

/** True when this row records a message a provider already accepted. */
export function hasBeenSent(status: string | null | undefined): boolean {
  return SENT_OR_BETTER.includes((status ?? '') as NotificationStatus);
}

/** The statuses a row may currently hold for `next` to be allowed to replace it. */
export function replaceableBy(next: NotificationStatus): NotificationStatus[] {
  return (Object.keys(STATUS_RANK) as NotificationStatus[]).filter(
    (s) => STATUS_RANK[s] >= 0 && STATUS_RANK[s] < STATUS_RANK[next],
  );
}
