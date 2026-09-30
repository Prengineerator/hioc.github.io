// Who may be messaged, and by which playbook (spec §1.4, §1.5). Pure: every
// function takes `now` and the facts it needs — never Date.now(), never a query —
// so each rule can be pinned down with a table of cases.
//
// Two layers, deliberately separate:
//   evaluateContact   is this PHONE messageable at all right now? (consent, staff,
//                     number validity, frequency caps, fatigue, in-flight). Rules 1–7.
//                     The same function runs again at SEND time with the plan-time
//                     rules that can go stale (consent, number, caps) — because a
//                     campaign can be approved days before it sends, and consent
//                     withdrawn in between must win.
//   assignPlaybooks   which playbook does each messageable contact belong to?
//                     One agent message per contact per day, from the highest-priority
//                     playbook they qualify for. Rule 8.

import { DAY_MS } from './ist';
import {
  IN_FLIGHT_STATUSES,
  SENT_STATUSES,
  UNREAD_PAUSE_MAX_AGE_DAYS,
} from './types';
import type {
  ContactStats,
  EligibilityReason,
  MarketingSettings,
  PlaybookKey,
  PlaybookRule,
  RecipientStatus,
  SendHistoryEntry,
} from './types';

/** The settings the frequency/fatigue rules read. */
export type EligibilitySettings = Pick<MarketingSettings, 'min_days_between' | 'max_per_30_days' | 'pause_after_unread'>;

export interface EligibilityContext {
  now: Date;
  settings: EligibilitySettings;
  /**
   * Have delivery/read receipts EVER flowed (any recipient reached delivered or
   * read)? When false the unread_pause rule is switched off — with no receipts
   * every message would look "unread" and everyone would be paused. Today that is
   * the real state whenever WHATSAPP_APP_SECRET is unset.
   */
  receipts_connected: boolean;
  /** At send time the recipient's OWN campaign is in flight; pass its id so rule 7 doesn't trip on itself. */
  ignore_campaign_id?: string;
}

/** The fields evaluateContact reads — a full ContactStats fits, and so does a bare send-time object. */
export type EligibilityContact = Pick<ContactStats, 'phone' | 'role' | 'consent_opted_in' | 'opt_out_listed'>;

export type Eligibility = { eligible: true } | { eligible: false; reason: EligibilityReason };

/** A valid Indian mobile in E.164: +91 then six-to-nine then nine digits. */
export function isMarketablePhone(phone: string): boolean {
  return /^\+91[6-9][0-9]{9}$/.test(phone);
}

/** Have receipts ever flowed? true once any entry reached delivered/read (or has a read_at). */
export function receiptsConnected(entries: readonly Pick<SendHistoryEntry, 'status' | 'read_at'>[]): boolean {
  return entries.some((e) => e.status === 'delivered' || e.status === 'read' || e.read_at !== null);
}

const isSentStatus = (s: RecipientStatus) => (SENT_STATUSES as readonly RecipientStatus[]).includes(s);
const isInFlightStatus = (s: RecipientStatus) => (IN_FLIGHT_STATUSES as readonly RecipientStatus[]).includes(s);

/** When an entry "happened": the send time, else the campaign start (holdout), else the row's creation. */
function entryMs(e: SendHistoryEntry): number {
  return Date.parse(e.sent_at ?? e.reference_at ?? e.created_at);
}

/** Messages that actually left, newest first, each with its send time. */
function sentMessages(history: readonly SendHistoryEntry[]): { entry: SendHistoryEntry; at: number }[] {
  const out: { entry: SendHistoryEntry; at: number }[] = [];
  for (const entry of history) {
    if (!isSentStatus(entry.status)) continue;
    const at = Date.parse(entry.sent_at ?? entry.reference_at ?? entry.created_at);
    if (Number.isFinite(at)) out.push({ entry, at });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Is this contact messageable right now? Returns the FIRST rule that fails, in
 * spec order, or {eligible: true}.
 *
 *   1 not_opted_in   no opted_in consent, or a whatsapp_opt_outs row (an opt-out always wins)
 *   2 staff          profile role is not 'customer' (no profile = a plain customer)
 *   3 invalid_phone  not a valid Indian mobile
 *   4 too_soon       a marketing message was sent in the last min_days_between days
 *   5 monthly_cap    max_per_30_days or more were sent in the last 30 days
 *   6 unread_pause   the last N messages all reached sent/delivered but never read, and
 *                    the latest was under 60 days ago — OFF while receipts aren't flowing
 *   7 in_flight      already pending/queued/sending in another open campaign
 *
 * phase 'send' applies only rules 1, 3, 4, 5: the ones that can change between
 * approval and send. (Rule 2 and 6 are decisions about who to pick, not about
 * whether a picked message is still allowed; rule 7 would trip on the recipient's
 * own campaign.) Times compare strictly: a message sent exactly 7 days ago no
 * longer counts as "in the last 7 days".
 */
export function evaluateContact(
  contact: EligibilityContact,
  history: readonly SendHistoryEntry[],
  ctx: EligibilityContext,
  opts: { phase?: 'plan' | 'send' } = {},
): Eligibility {
  const send = opts.phase === 'send';
  const nowMs = ctx.now.getTime();
  const fail = (reason: EligibilityReason): Eligibility => ({ eligible: false, reason });

  if (!contact.consent_opted_in || contact.opt_out_listed) return fail('not_opted_in');
  if (!send && contact.role !== null && contact.role !== 'customer') return fail('staff');
  if (!isMarketablePhone(contact.phone)) return fail('invalid_phone');

  const sent = sentMessages(history);

  const tooSoonSince = nowMs - ctx.settings.min_days_between * DAY_MS;
  if (sent.some((m) => m.at > tooSoonSince)) return fail('too_soon');

  const monthSince = nowMs - 30 * DAY_MS;
  if (sent.filter((m) => m.at > monthSince).length >= ctx.settings.max_per_30_days) return fail('monthly_cap');

  if (send) return { eligible: true };

  const n = ctx.settings.pause_after_unread;
  if (ctx.receipts_connected && n > 0 && sent.length >= n) {
    const lastN = sent.slice(0, n);
    const allUnread = lastN.every((m) => (m.entry.status === 'sent' || m.entry.status === 'delivered') && !m.entry.read_at);
    if (allUnread && nowMs - lastN[0].at < UNREAD_PAUSE_MAX_AGE_DAYS * DAY_MS) return fail('unread_pause');
  }

  const inFlight = history.some((e) => isInFlightStatus(e.status) && e.campaign_id !== ctx.ignore_campaign_id);
  if (inFlight) return fail('in_flight');

  return { eligible: true };
}

// ---------------------------------------------------------------------------
// Playbook qualification
// ---------------------------------------------------------------------------

/**
 * Was this contact already dealt with by `key` after `sinceMs`? "Dealt with"
 * means a message left OR the contact was picked into the holdout: a holdout
 * person must stay a holdout (re-picking them tomorrow would let a later run
 * message them and quietly ruin the lift measurement).
 */
function handledSince(history: readonly SendHistoryEntry[], key: PlaybookKey, sinceMs: number): boolean {
  return history.some((e) => {
    if (e.playbook_key !== key) return false;
    if (!isSentStatus(e.status) && e.status !== 'holdout') return false;
    return entryMs(e) > sinceMs;
  });
}

/** Stages the agent never messages on its own: lost customers, and contacts with no order history at all. */
const MANUAL_ONLY_STAGES = new Set(['lost', 'no_orders']);

/**
 * Does the contact fit the playbook's audience (spec §1.4)? This is ONLY the
 * playbook's own condition — consent and frequency rules are evaluateContact's.
 * `stats` must have been built with expiring_days_ahead = points_expiring's
 * days_ahead, or `expiring_points` answers a different question.
 *
 *   points_expiring  expiring_points ≥ min_points; no order in the last recent_order_days;
 *                    no points_expiring message/holdout within cooldown_days
 *   points_balance   points_balance ≥ min_points; last order ≥ min_days_since_order days ago;
 *                    no points_balance message/holdout within cooldown_days
 *   winback_N        stage is lapsed_N; no winback_N message/holdout since the last order
 *                    (one per lapse episode — a message from BEFORE the last order is
 *                    an earlier episode and doesn't count)
 *
 * Lost and no-order contacts qualify for nothing: the agent never messages them
 * automatically; they are reachable through manual campaigns only.
 */
export function qualifiesForPlaybook(
  stats: ContactStats,
  history: readonly SendHistoryEntry[],
  rule: PlaybookRule,
  now: Date,
): boolean {
  if (MANUAL_ONLY_STAGES.has(stats.stage)) return false;
  const nowMs = now.getTime();

  switch (rule.key) {
    case 'points_expiring': {
      const p = rule.params;
      if (stats.expiring_points < p.min_points) return false;
      if (p.recent_order_days > 0 && stats.days_since_last_order !== null && stats.days_since_last_order < p.recent_order_days) {
        return false;
      }
      return !handledSince(history, 'points_expiring', nowMs - p.cooldown_days * DAY_MS);
    }
    case 'points_balance': {
      const p = rule.params;
      if (stats.points_balance < p.min_points) return false;
      if (stats.days_since_last_order !== null && stats.days_since_last_order < p.min_days_since_order) return false;
      return !handledSince(history, 'points_balance', nowMs - p.cooldown_days * DAY_MS);
    }
    case 'winback_1':
    case 'winback_2':
    case 'winback_3': {
      const stage = `lapsed_${rule.key.slice(-1)}`;
      if (stats.stage !== stage || stats.last_order_at === null) return false;
      return !handledSince(history, rule.key, Date.parse(stats.last_order_at));
    }
  }
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** One contact with everything needed to plan for them. */
export interface PlanContact {
  stats: ContactStats;
  /** This phone's marketing_recipients rows: the last ~60 days, anything in flight, and any later than the last order. */
  history: readonly SendHistoryEntry[];
}

export interface SkippedContact {
  phone: string;
  /** The playbook the contact qualified for and did not get. */
  playbook_key: PlaybookKey;
  reason: EligibilityReason;
}

export interface PlaybookAssignment {
  /** The contacts each playbook will message, in input order. Every key is present; 'off' playbooks get []. */
  assigned: Record<PlaybookKey, ContactStats[]>;
  /**
   * Contacts that qualified for a playbook but were not assigned it: ineligible
   * under rules 1–7 (one entry per playbook they qualified for), or, when eligible,
   * beaten by a higher-priority playbook (rule 8, claimed_by_higher_priority).
   */
  skipped: SkippedContact[];
}

/**
 * Deals each contact to at most ONE playbook: the highest-priority (lowest
 * `priority` number) one that is not 'off' and that they qualify for. Playbooks
 * in mode 'off' take no part, so a disabled high-priority playbook does not
 * shadow an enabled one. Contacts that fail eligibility are skipped, with the
 * reason recorded against every playbook they would otherwise have joined.
 */
export function assignPlaybooks(
  contacts: readonly PlanContact[],
  playbooks: readonly PlaybookRule[],
  ctx: EligibilityContext,
): PlaybookAssignment {
  const assigned: Record<PlaybookKey, ContactStats[]> = {
    points_expiring: [],
    points_balance: [],
    winback_1: [],
    winback_2: [],
    winback_3: [],
  };
  const skipped: SkippedContact[] = [];

  const active = playbooks
    .filter((p) => p.mode !== 'off')
    .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));

  for (const { stats, history } of contacts) {
    const qualifying = active.filter((rule) => qualifiesForPlaybook(stats, history, rule, ctx.now));
    if (qualifying.length === 0) continue;

    const verdict = evaluateContact(stats, history, ctx);
    if (!verdict.eligible) {
      for (const rule of qualifying) skipped.push({ phone: stats.phone, playbook_key: rule.key, reason: verdict.reason });
      continue;
    }

    assigned[qualifying[0].key].push(stats);
    for (const rule of qualifying.slice(1)) {
      skipped.push({ phone: stats.phone, playbook_key: rule.key, reason: 'claimed_by_higher_priority' });
    }
  }

  return { assigned, skipped };
}
