// Marketing consent as an explicit machine, and the ONE answer to "may this
// phone be messaged?" (spec §2). Pure and client-safe: lib/marketing/server/
// consent.ts (the only writer) and every sender that reads consent import it.
//
// Consent lives in two stores that must agree but can be caught disagreeing
// (a best-effort write that failed, or a START racing a STOP):
//   marketing_consent   the ledger, one row per phone: 'opted_in' | 'opted_out',
//                       or no row at all ('none' below)
//   whatsapp_opt_outs   the older STOP table the feedback cron has always honoured
//
// So the composite state is explicit, and a disagreement always resolves
// towards NOT messaging:
//
//   ledger      opt-out row   composite     marketing?  feedback/other WhatsApp?
//   any         yes           opted_out     no          no
//   opted_out   no            opted_out     no          no
//   opted_in    no            opted_in      yes         yes
//   none        no            no_consent    no          yes
//
// The ledger's own transitions (who may move it, and from where):
//
//   none | opted_out ── opt-in source ──→ opted_in   consented_at = now: a NEW consent
//   opted_in ────────── opt-in source ──→ opted_in   a repeat: nothing changes — consented_at
//                                                    and source keep the consent in force
//   any ─────────────── opt-out source ─→ opted_out  withdrawn_at = now
//
// An opt-in is only ever the customer's own act; there is no owner source for
// it (the owner may only record an opt-out the customer asked for). Meta's
// 'meta_resume' is an opt-in only when we already hold an earlier opt-in of our
// own for the phone — "they turned marketing back on" is not consent TO US.

import type { ConsentSource, ConsentStatus } from './types';

export const CONSENT_LEDGER_STATUSES = ['opted_in', 'opted_out'] as const satisfies readonly ConsentStatus[];

/** The ledger row's state; 'none' when the phone has no row yet. */
export type LedgerState = ConsentStatus | 'none';

export type ConsentAction = 'opt_in' | 'opt_out';

/** Sources that may OPT IN: the customer's own acts (and the migration's backfill of them). */
export const OPT_IN_SOURCES = [
  'profile',
  'whatsapp_keyword',
  'meta_resume',
  'backfill_profile',
] as const satisfies readonly ConsentSource[];

/** Sources that may OPT OUT: anything that says stop — including the owner, on the customer's behalf. */
export const OPT_OUT_SOURCES = [
  'profile',
  'stop_keyword',
  'stop_promotions',
  'meta_131050',
  'meta_stop',
  'owner',
  'backfill_opt_out',
] as const satisfies readonly ConsentSource[];

interface ConsentTransition {
  action: ConsentAction;
  from: readonly LedgerState[];
  to: ConsentStatus;
  sources: readonly ConsentSource[];
  /** Nothing in the ledger changes: the consent (or withdrawal) already in force stands. */
  repeat?: true;
}

export const CONSENT_TRANSITIONS: readonly ConsentTransition[] = [
  { action: 'opt_in', from: ['none', 'opted_out'], to: 'opted_in', sources: OPT_IN_SOURCES },
  { action: 'opt_in', from: ['opted_in'], to: 'opted_in', sources: OPT_IN_SOURCES, repeat: true },
  { action: 'opt_out', from: ['none', 'opted_in', 'opted_out'], to: 'opted_out', sources: OPT_OUT_SOURCES },
];

export type ConsentTransitionCheck =
  | { ok: true; to: ConsentStatus; repeat: boolean }
  | { ok: false; code: 'source_not_allowed' | 'no_prior_opt_in'; message: string };

export function canTransitionConsent(
  from: LedgerState,
  action: ConsentAction,
  ctx: { source: ConsentSource; hasPriorOptIn?: boolean },
): ConsentTransitionCheck {
  const rule = CONSENT_TRANSITIONS.find((t) => t.action === action && t.from.includes(from));
  if (!rule || !rule.sources.includes(ctx.source)) {
    return { ok: false, code: 'source_not_allowed', message: `${ctx.source} cannot ${action.replace('_', ' ')}` };
  }
  if (action === 'opt_in' && ctx.source === 'meta_resume' && !ctx.hasPriorOptIn) {
    return { ok: false, code: 'no_prior_opt_in', message: 'Meta resuming marketing is not consent without an earlier opt-in of ours' };
  }
  return { ok: true, to: rule.to, repeat: rule.repeat === true };
}

/** May this source be used for this action at all (independent of the ledger's current state)? */
export function sourceAllowedFor(action: ConsentAction, source: ConsentSource): boolean {
  return CONSENT_TRANSITIONS.some((t) => t.action === action && t.sources.includes(source));
}

// ---------------------------------------------------------------------------
// The composite state, and the one predicate every sender asks
// ---------------------------------------------------------------------------

export interface ConsentFacts {
  /** The ledger row's status; 'none' or null when there is no row. */
  ledger: LedgerState | null;
  /** A whatsapp_opt_outs row exists for the phone (in any stored spelling). */
  optOutListed: boolean;
}

export type CompositeConsent = 'opted_in' | 'opted_out' | 'no_consent';

export function compositeConsent(f: ConsentFacts): CompositeConsent {
  if (f.optOutListed || f.ledger === 'opted_out') return 'opted_out';
  if (f.ledger === 'opted_in') return 'opted_in';
  return 'no_consent';
}

/**
 * "Is this phone opted out?" — for EVERY non-transactional WhatsApp message
 * (feedback requests as well as marketing). Either store saying stop is enough:
 * the feedback cron used to read only whatsapp_opt_outs, so a STOP whose opt-out
 * row was lost (a failed write, or deleted by a racing START) while the ledger
 * still said opted_out was messaged anyway.
 */
export function isOptedOut(f: ConsentFacts): boolean {
  return compositeConsent(f) === 'opted_out';
}

/** May the marketing agent message this phone? Only a standing opt-in that no opt-out contradicts. */
export function mayMarketTo(f: ConsentFacts): boolean {
  return compositeConsent(f) === 'opted_in';
}

/**
 * The same facts in the shape the audience/eligibility code carries them
 * (ContactStats.consent_opted_in / opt_out_listed). `mayMarketTo(factsFromContact(c))`
 * is exactly evaluateContact's rule 1 (lib/marketing/eligibility.ts).
 */
export function factsFromContact(c: { consent_opted_in: boolean; opt_out_listed: boolean }): ConsentFacts {
  return { ledger: c.consent_opted_in ? 'opted_in' : null, optOutListed: c.opt_out_listed };
}
