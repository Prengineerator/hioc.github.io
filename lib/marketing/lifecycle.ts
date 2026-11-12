// The two linked state machines of the marketing agent, in ONE place:
//
//   marketing_campaigns.status   draft / pending_approval → approved → sending → completed,
//                                with cancelled and expired as the other two ends.
//   marketing_recipients.status  pending → queued → sending → sent → delivered → read,
//                                with failed / skipped / cancelled / holdout off the main path.
//
// They are linked: a recipient can only move forward while its campaign is in a state that
// allows it (pending rows wait for approval, queued rows are only claimable under a live
// campaign, and a campaign that ends takes its unsent rows with it). Before this module each
// writer re-declared its own idea of "approvable", "cancellable", "in flight" and "live", and
// the copies drifted: an unguarded cancel, a UI that listed the cancellable statuses by hand,
// and an eligibility rule that kept counting the unsent rows of a cancelled campaign as "in
// flight" forever. Every writer, reader and UI now asks this module.
//
// Pure and client-safe: no server-only imports, nothing but `import type` from ./types (which
// itself derives its status groupings from here, so there is no runtime import cycle).
//
// Spec: docs/MARKETING-AGENT-SPEC.md §1.5 (rule 7), §6 (planner and sender), the API table in §6.

import type { CampaignStatus, RecipientStatus } from './types';

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

/**
 * Who moves a campaign. 'owner' is a person on /owner/marketing; 'planner' is the nightly
 * run; 'sender' the 5-minute send run; 'system' a compensating write inside the lib (putting
 * an approval back when its recipients could not be queued, cancelling a half-made campaign).
 */
export type CampaignActor = 'owner' | 'planner' | 'sender' | 'system';

export type CampaignAction =
  /** A new row: a manual draft (owner) or a planned campaign (planner; an Auto one is inserted here too). */
  | 'create'
  /** Auto mode's final flip, once every recipient is in (lib/marketing/server/campaigns.ts insertCampaign). */
  | 'auto_approve'
  /** The owner says "send it". Recipients pending → queued. */
  | 'approve'
  /** approveCampaign's compensation: the recipients could not be queued, so the approval is put back. */
  | 'unapprove'
  /** Stop: any campaign that has not ended. Recipients pending/queued → cancelled. */
  | 'cancel'
  /** Nobody decided in time (APPROVAL_EXPIRY_DAYS / DRAFT_EXPIRY_DAYS). Unsent recipients → cancelled. */
  | 'expire'
  /** The first message actually left. */
  | 'start'
  /** Nothing left pending / queued / sending. */
  | 'complete';

/** Facts a guard may consult. Optional, so a UI asking "is this a legal move?" can omit them. */
export interface CampaignTransitionContext {
  actor?: CampaignActor;
  /** How many of the campaign's recipients are still pending / queued / sending (the 'complete' guard). */
  inFlight?: number;
}

export interface CampaignTransition {
  /** null = the row is being created. */
  from: CampaignStatus | null;
  to: CampaignStatus;
  action: CampaignAction;
  actors: readonly CampaignActor[];
  guard?: (ctx: CampaignTransitionContext) => TransitionVerdict;
}

export type TransitionCode = 'not_allowed' | 'forbidden_actor' | 'recipients_in_flight';
export type TransitionVerdict = { ok: true } | { ok: false; code: TransitionCode; message: string };

/** Every campaign status, with what it means. A Record, so adding a status to CampaignStatus fails to compile until it is described here. */
export const CAMPAIGN_STATE_MEANING: Record<CampaignStatus, string> = {
  draft: 'A manual campaign saved but not sent for approval; nothing can send from it.',
  pending_approval: 'Planned and priced, waiting for the owner.',
  approved: 'Approved; its recipients are queued for the sender.',
  sending: 'At least one message has left.',
  completed: 'Nothing left to send.',
  cancelled: 'Stopped by the owner (or a half-made campaign tidied away).',
  expired: 'Nobody approved it in time.',
};

const NOT_ENDED: readonly CampaignStatus[] = ['draft', 'pending_approval', 'approved', 'sending'];

/**
 * The allowed campaign transitions. Anything not listed is refused. Each writer's
 * compare-and-set (`.in('status', campaignFrom(action))`) is built from this table, so the
 * table and the SQL guards cannot disagree.
 */
export const CAMPAIGN_TRANSITIONS: readonly CampaignTransition[] = [
  // Entry. insertCampaign writes an Auto campaign as pending_approval and flips it only after
  // all its recipients exist, so the sender never sees an approved campaign with half its rows.
  { from: null, to: 'draft', action: 'create', actors: ['owner'] },
  { from: null, to: 'pending_approval', action: 'create', actors: ['planner'] },
  { from: 'pending_approval', to: 'approved', action: 'auto_approve', actors: ['planner'] },

  // The owner's decision.
  { from: 'draft', to: 'approved', action: 'approve', actors: ['owner'] },
  { from: 'pending_approval', to: 'approved', action: 'approve', actors: ['owner'] },
  // …undone by the lib only, and only back to where it came from, when queueing failed.
  { from: 'approved', to: 'draft', action: 'unapprove', actors: ['system'] },
  { from: 'approved', to: 'pending_approval', action: 'unapprove', actors: ['system'] },

  // Stop: any campaign that has not ended.
  ...NOT_ENDED.map((from): CampaignTransition => ({ from, to: 'cancelled', action: 'cancel', actors: ['owner', 'system'] })),

  // Undecided too long (the planner's tidy step).
  { from: 'draft', to: 'expired', action: 'expire', actors: ['planner'] },
  { from: 'pending_approval', to: 'expired', action: 'expire', actors: ['planner'] },

  // The sender.
  { from: 'approved', to: 'sending', action: 'start', actors: ['sender'] },
  ...(['approved', 'sending'] as const).map(
    (from): CampaignTransition => ({
      from,
      to: 'completed',
      action: 'complete',
      actors: ['sender'],
      guard: (ctx) =>
        ctx.inFlight === undefined || ctx.inFlight === 0
          ? { ok: true }
          : { ok: false, code: 'recipients_in_flight', message: `${ctx.inFlight} message(s) are still waiting to go out.` },
    }),
  ),
];

/** The rule for from → to, if there is one (the first, when two actions share a pair). */
export function findCampaignTransition(from: CampaignStatus | null, to: CampaignStatus, action?: CampaignAction): CampaignTransition | undefined {
  return CAMPAIGN_TRANSITIONS.find((t) => t.from === from && t.to === to && (action === undefined || t.action === action));
}

/** Is from → to legal (for this actor, under these facts)? */
export function canTransitionCampaign(
  from: CampaignStatus | null,
  to: CampaignStatus,
  ctx: CampaignTransitionContext = {},
): TransitionVerdict {
  const rules = CAMPAIGN_TRANSITIONS.filter((t) => t.from === from && t.to === to);
  if (rules.length === 0) {
    return { ok: false, code: 'not_allowed', message: `A ${from ?? 'new'} campaign cannot become ${to}.` };
  }
  const allowed = ctx.actor ? rules.filter((t) => t.actors.includes(ctx.actor as CampaignActor)) : rules;
  if (allowed.length === 0) {
    return { ok: false, code: 'forbidden_actor', message: `The ${ctx.actor} may not move a ${from ?? 'new'} campaign to ${to}.` };
  }
  // Legal if any matching rule's guard passes; otherwise the first guard's reason.
  let blocked: TransitionVerdict | null = null;
  for (const rule of allowed) {
    const g: TransitionVerdict = rule.guard?.(ctx) ?? { ok: true };
    if (g.ok) return g;
    blocked ??= g;
  }
  return blocked ?? { ok: true };
}

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/** The statuses `action` may start from — the `.in('status', …)` of that action's guarded UPDATE. */
export function campaignFrom(action: CampaignAction): CampaignStatus[] {
  return uniq(CAMPAIGN_TRANSITIONS.filter((t) => t.action === action && t.from !== null).map((t) => t.from as CampaignStatus));
}

/** Statuses from which nothing more will happen: derived — no transition leaves them. */
export const TERMINAL_CAMPAIGN_STATUSES: readonly CampaignStatus[] = (Object.keys(CAMPAIGN_STATE_MEANING) as CampaignStatus[]).filter(
  (s) => !CAMPAIGN_TRANSITIONS.some((t) => t.from === s),
);

/** Awaiting the owner's decision: the Approvals list, its count, and the sample messages. */
export const AWAITING_APPROVAL_STATUSES: readonly CampaignStatus[] = campaignFrom('approve');

/**
 * Live: the sender may claim this campaign's queued rows and send them (the same list
 * claim_marketing_recipients joins on in SQL — supabase/2026-10-marketing-agent.sql). Only a
 * live campaign can complete.
 */
export const LIVE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = campaignFrom('complete');

/** Not ended: may still be cancelled. */
export const CANCELLABLE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = campaignFrom('cancel');

/**
 * A campaign whose pending/queued/sending rows hold their phone "in flight" (spec §1.5 rule 7):
 * one that has not ended, except a DRAFT — nothing is going out from a draft, and one forgotten
 * "everyone" draft must not freeze the agent (spec B3). A pending_approval campaign does count:
 * its message is one tap from going out. A cancelled, expired or completed campaign never does,
 * even if a failed cascade left its unsent rows behind (the sweep tidies those).
 */
export const IN_FLIGHT_CAMPAIGN_STATUSES: readonly CampaignStatus[] = CANCELLABLE_CAMPAIGN_STATUSES.filter((s) => s !== 'draft');

const has = <T>(list: readonly T[], v: T | null | undefined): boolean => v !== null && v !== undefined && list.includes(v);

export const isTerminalCampaign = (s: CampaignStatus): boolean => has(TERMINAL_CAMPAIGN_STATUSES, s);
export const isLiveCampaign = (s: CampaignStatus | null | undefined): boolean => has(LIVE_CAMPAIGN_STATUSES, s);
/** The Approve button / POST …/approve. */
export const canApproveCampaign = (s: CampaignStatus): boolean => has(AWAITING_APPROVAL_STATUSES, s);
/** The Stop button / POST …/cancel. */
export const canCancelCampaign = (s: CampaignStatus): boolean => has(CANCELLABLE_CAMPAIGN_STATUSES, s);
/** Awaiting a decision (shows sample messages, counts as a pending approval). */
export const isAwaitingApproval = canApproveCampaign;

/**
 * Do this campaign's unsent rows hold the phone in flight? An unknown status (the loader did
 * not see the campaign) is treated as live: the careful answer when we cannot tell.
 */
export function holdsRecipientsInFlight(s: CampaignStatus | null | undefined): boolean {
  return s === null || s === undefined || IN_FLIGHT_CAMPAIGN_STATUSES.includes(s);
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

export type RecipientAction =
  /** Inserted with the campaign: pending (awaiting approval), queued (born approved) or holdout. */
  | 'plan'
  /** The campaign was approved (approveCampaign). */
  | 'queue'
  /** Unsent and recallable: the campaign was cancelled/expired/discarded, the phone opted out, or the orphan sweep. */
  | 'cancel'
  /** The sender took it (SQL claim_marketing_recipients, FOR UPDATE SKIP LOCKED; campaign must be live). */
  | 'claim'
  /** The provider accepted the message. */
  | 'send'
  /** Not sent: the provider refused, the coupon/template failed, or the run died mid-send ('interrupted'). */
  | 'fail'
  /** Not sent on purpose at send time: consent, caps or WhatsApp not configured (skip_reason says which). */
  | 'skip'
  /** Claimed, but its campaign is no longer live: dropped without sending. */
  | 'drop'
  /** Claimed, but a transient pre-send failure (the consent read): back to the queue, a few attempts only. */
  | 'release'
  /** A delivery/read/failure receipt from Meta (app/api/webhooks/whatsapp/route.ts). */
  | 'receipt';

export interface RecipientTransition {
  from: RecipientStatus | null;
  to: RecipientStatus;
  action: RecipientAction;
}

/** Every recipient status, with what it means. A Record, so a new RecipientStatus fails to compile until it is described here. */
export const RECIPIENT_STATE_MEANING: Record<RecipientStatus, string> = {
  pending: 'Planned; the campaign awaits approval.',
  queued: 'Approved; waiting for the sender.',
  sending: 'Claimed by the sender. Never reclaimed (spec trap 4): a crash here may already have messaged the customer.',
  sent: 'Accepted by WhatsApp.',
  delivered: 'Reached the handset.',
  read: 'Opened.',
  failed: 'Did not go out, or WhatsApp reported it undeliverable.',
  skipped: 'Dropped at send time; see skip_reason.',
  holdout: 'Deliberately not messaged: the control group.',
  cancelled: 'Recalled before it was sent.',
};

export const RECIPIENT_TRANSITIONS: readonly RecipientTransition[] = [
  { from: null, to: 'pending', action: 'plan' },
  { from: null, to: 'queued', action: 'plan' },
  { from: null, to: 'holdout', action: 'plan' },

  { from: 'pending', to: 'queued', action: 'queue' },
  { from: 'pending', to: 'cancelled', action: 'cancel' },
  { from: 'queued', to: 'cancelled', action: 'cancel' },

  { from: 'queued', to: 'sending', action: 'claim' },

  { from: 'sending', to: 'sent', action: 'send' },
  { from: 'sending', to: 'failed', action: 'fail' },
  { from: 'sending', to: 'skipped', action: 'skip' },
  { from: 'sending', to: 'cancelled', action: 'drop' },
  { from: 'sending', to: 'queued', action: 'release' },

  // Receipts, as the WhatsApp webhook applies them (its RECIPIENT_RUNGS, on the shared
  // lib/notifications/status.ts ladder): forward-only along sending < sent < failed < delivered < read.
  // A 'delivered'/'read' after a 'failed' is applied — proof the handset got it beats a report that it
  // could not be sent — so 'failed' is not terminal here. (A 'sending' row has no provider_ref yet, so
  // its receipt edges are what the guard permits rather than something a callback can match today.)
  { from: 'sending', to: 'failed', action: 'receipt' },
  { from: 'sent', to: 'failed', action: 'receipt' },
  { from: 'sending', to: 'delivered', action: 'receipt' },
  { from: 'sent', to: 'delivered', action: 'receipt' },
  { from: 'failed', to: 'delivered', action: 'receipt' },
  { from: 'sending', to: 'read', action: 'receipt' },
  { from: 'sent', to: 'read', action: 'receipt' },
  { from: 'failed', to: 'read', action: 'receipt' },
  { from: 'delivered', to: 'read', action: 'receipt' },
];

export function canTransitionRecipient(from: RecipientStatus | null, to: RecipientStatus): TransitionVerdict {
  return RECIPIENT_TRANSITIONS.some((t) => t.from === from && t.to === to)
    ? { ok: true }
    : { ok: false, code: 'not_allowed', message: `A ${from ?? 'new'} recipient cannot become ${to}.` };
}

/** The statuses `action` may start from — the `.in('status', …)` of that action's guarded UPDATE. */
export function recipientFrom(action: RecipientAction): RecipientStatus[] {
  return uniq(RECIPIENT_TRANSITIONS.filter((t) => t.action === action && t.from !== null).map((t) => t.from as RecipientStatus));
}

/** Statuses no transition leaves. */
export const TERMINAL_RECIPIENT_STATUSES: readonly RecipientStatus[] = (Object.keys(RECIPIENT_STATE_MEANING) as RecipientStatus[]).filter(
  (s) => !RECIPIENT_TRANSITIONS.some((t) => t.from === s),
);

/** Still in a campaign's pipeline: the message may yet go out (every status from which 'sent' is reachable). */
export const IN_FLIGHT_RECIPIENT_STATUSES: readonly RecipientStatus[] = ['pending', 'queued', 'sending'];

/** Unsent and recallable: what a campaign's end (or an opt-out) cancels. A 'sending' row is past recall. */
export const CANCELLABLE_RECIPIENT_STATUSES: readonly RecipientStatus[] = recipientFrom('cancel');

/** Approved for sending and not yet sent — spend already promised against the month's budget. */
export const COMMITTED_RECIPIENT_STATUSES: readonly RecipientStatus[] = uniq([...recipientFrom('claim'), ...recipientFrom('send')]);

export const isInFlightRecipient = (s: RecipientStatus): boolean => IN_FLIGHT_RECIPIENT_STATUSES.includes(s);
