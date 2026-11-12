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
// who reasons about it (lib/notifications/engine.ts, app/api/webhooks/whatsapp —
// for marketing recipients' receipts too, via replaceableVia). A future
// migration that adds a rung edits this file and every guard moves with it —
// which is the property that was missing when WA-4 landed. Pure and
// client-safe: no server imports.

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

/**
 * The ladder rule itself, for any rank table: a status may be replaced by
 * `next` when it is ON the ladder (rank >= 0) and strictly below `next`.
 * Exposed so a second vocabulary (marketing recipients) climbs the SAME rule
 * instead of a private copy of it.
 */
export function replaceableIn<S extends string>(rank: Readonly<Record<S, number>>, next: S): S[] {
  return (Object.keys(rank) as S[]).filter((s) => rank[s] >= 0 && rank[s] < rank[next]);
}

/** The statuses a row may currently hold for `next` to be allowed to replace it. */
export function replaceableBy(next: NotificationStatus): NotificationStatus[] {
  return replaceableIn(STATUS_RANK, next);
}

/**
 * The same ladder for ANOTHER table's status vocabulary. `rungs` maps each of
 * that table's statuses to the notifications rung it stands on, or null when
 * it is not on the delivery ladder at all (nothing has left yet, or it was
 * deliberately never sent). Returns that table's statuses which the receipt
 * `next` may replace.
 *
 * An exhaustive Record is required on purpose: the two vocabularies share
 * words that mean different things (a marketing recipient's 'queued' is
 * "approved, not yet picked up", not this table's "claimed, sending"), so a
 * name-based mapping would silently put a pre-send row on the ladder.
 */
export function replaceableVia<S extends string>(
  rungs: Readonly<Record<S, NotificationStatus | null>>,
  next: NotificationStatus,
): S[] {
  const allowed = replaceableBy(next);
  return (Object.keys(rungs) as S[]).filter((s) => {
    const rung = rungs[s];
    return rung !== null && allowed.includes(rung);
  });
}

// ---------------------------------------------------------------------------
// The engine's own writes (lib/notifications/engine.ts)
// ---------------------------------------------------------------------------
//
// One row per (order_id, event, channel) — the table's unique key — and four
// writers besides the webhook. Before this table existed each of them read the
// row, did its work, and then UPSERTED its verdict unconditionally, so:
//   - two automatic sends racing (the bill fires at settle AND on 'completed')
//     could both reach Meta: the unique index only stopped the second LOG row,
//     after the second billable message had already gone;
//   - a skip landing while a send was in flight stamped 'skipped' over it;
//   - a forced resend that failed wrote 'failed' over a row the customer had
//     demonstrably READ.
//
// 'queued' is now the claim. An automatic send takes it (insert, or a
// compare-and-set on the row it read) BEFORE contacting the provider, and only
// the holder of the claim writes the verdict. While a row is 'queued', its
// `sent_at` holds WHEN the claim was taken (there is no other timestamp column
// to put it in, and a 'queued' row has, by definition, not been sent): a claim
// older than CLAIM_STALE_MS belonged to a run that died mid-send and may be
// taken over, so a crash cannot strand a bill (or a feedback request, whose
// cron re-claims on the same 10-minute clock) forever.
//
//   writer   from                                   to
//   claim    none | skipped | failed* | queued†     queued      automatic send, before contacting the provider
//   finish   queued (its own claim)                 sent|failed the claim holder's verdict
//   skip     none | skipped | failed | queued†      skipped     a channel deliberately not attempted
//   resend   any                                    sent        staff/owner forced resend that went out (new message id)
//   resend   none | queued† | skipped | failed      failed      forced resend that did not go out
//   resend   sent | delivered | read | live queued  (kept)      ...over a row that was already sent (that
//                                                               message still went) or is being sent (its
//                                                               holder records the verdict): only
//                                                               error/attempts record the failed resend
//   receipt  replaceableBy(next)                    next        Meta's status webhook
//
//   * failed: only while attempts < the engine's budget.
//   † queued: only once the claim is stale.

/** How long a 'queued' claim protects a send in flight before another caller may take it over. Same window as claim_feedback_requests(). */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

export type LogWriter = 'claim' | 'finish' | 'skip' | 'resend' | 'receipt';

/** The row as the engine reads it; null = no row yet. */
export interface LogRowState {
  status: NotificationStatus | string;
  attempts?: number | null;
  /** While 'queued': when the claim was taken. */
  sent_at?: string | null;
}

type FromState = NotificationStatus | 'none';
type Guard = 'under_attempt_budget' | 'stale_claim';

interface LogTransition {
  writer: LogWriter;
  from: readonly FromState[];
  to: NotificationStatus;
  /** Extra conditions on particular `from` states. */
  guards?: Partial<Record<FromState, Guard>>;
}

const ALL_FROM: readonly FromState[] = ['none', ...(Object.keys(STATUS_RANK) as NotificationStatus[])];

export const NOTIFICATION_TRANSITIONS: readonly LogTransition[] = [
  {
    writer: 'claim',
    from: ['none', 'skipped', 'failed', 'queued'],
    to: 'queued',
    guards: { failed: 'under_attempt_budget', queued: 'stale_claim' },
  },
  { writer: 'finish', from: ['queued'], to: 'sent' },
  { writer: 'finish', from: ['queued'], to: 'failed' },
  { writer: 'skip', from: ['none', 'skipped', 'failed', 'queued'], to: 'skipped', guards: { queued: 'stale_claim' } },
  { writer: 'resend', from: ALL_FROM, to: 'sent' },
  { writer: 'resend', from: ['none', 'queued', 'skipped', 'failed'], to: 'failed', guards: { queued: 'stale_claim' } },
  ...(['sent', 'delivered', 'read', 'failed'] as const).map(
    (next): LogTransition => ({ writer: 'receipt', from: replaceableBy(next), to: next }),
  ),
];

export interface LogContext {
  nowMs: number;
  /** The engine's attempt budget (initial try + retries). */
  maxAttempts: number;
}

export type TransitionCheck = { ok: true } | { ok: false; code: string; message: string };

/** True while a 'queued' row's claim is fresh enough that its holder may still be sending. */
export function isLiveClaim(row: LogRowState | null | undefined, nowMs: number): boolean {
  if (!row || row.status !== 'queued' || !row.sent_at) return false;
  const at = Date.parse(row.sent_at);
  return Number.isFinite(at) && nowMs - at < CLAIM_STALE_MS;
}

/** May `writer` move a row in state `row` (null = no row) to `to`? */
export function canWrite(
  writer: LogWriter,
  row: LogRowState | null | undefined,
  to: NotificationStatus,
  ctx: LogContext,
): TransitionCheck {
  const from = (row ? row.status : 'none') as FromState;
  const rule = NOTIFICATION_TRANSITIONS.find((t) => t.writer === writer && t.to === to && t.from.includes(from));
  if (!rule) {
    return { ok: false, code: 'illegal_transition', message: `${writer} may not move a ${from} row to ${to}` };
  }
  const guard = rule.guards?.[from];
  if (guard === 'under_attempt_budget' && (row?.attempts ?? 0) >= ctx.maxAttempts) {
    return { ok: false, code: 'attempts_exhausted', message: 'the attempt budget for this message is spent' };
  }
  if (guard === 'stale_claim' && isLiveClaim(row, ctx.nowMs)) {
    return { ok: false, code: 'in_flight', message: 'another caller is sending this message right now' };
  }
  return { ok: true };
}

export type SendDecision =
  | { kind: 'claim' }
  | { kind: 'skip'; reason: 'already_sent' | 'attempts_exhausted' | 'in_flight' };

/**
 * What an AUTOMATIC (non-forced) send should do with the row it read: take the
 * claim, or stand down and say why. Checked in this order because it is the
 * order of strength — a row that was already sent is 'already_sent' whatever
 * its attempt count says.
 */
export function sendDecision(row: LogRowState | null | undefined, ctx: LogContext): SendDecision {
  if (row && hasBeenSent(row.status)) return { kind: 'skip', reason: 'already_sent' };
  const check = canWrite('claim', row, 'queued', ctx);
  if (check.ok) return { kind: 'claim' };
  return { kind: 'skip', reason: check.code === 'attempts_exhausted' ? 'attempts_exhausted' : 'in_flight' };
}

/** May a deliberate skip be recorded over this row? Never over a send, and never over one in flight. */
export function skipMayReplace(row: LogRowState | null | undefined, nowMs: number): boolean {
  return canWrite('skip', row, 'skipped', { nowMs, maxAttempts: Number.POSITIVE_INFINITY }).ok;
}

/**
 * A forced resend did NOT go out: may the row become 'failed'? Not when it
 * already records a sent (or better) message — that message still went, and
 * a later failed attempt is not news about it — nor while an automatic send
 * holds a live claim on it, whose own verdict is about to land.
 */
export function failedResendMayReplace(row: LogRowState | null | undefined, nowMs: number): boolean {
  return canWrite('resend', row, 'failed', { nowMs, maxAttempts: Number.POSITIVE_INFINITY }).ok;
}
