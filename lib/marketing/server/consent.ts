// Marketing consent — the ONLY writer of marketing_consent, its audit log, and the
// consent side effects (spec §2). Every path that changes whether a phone may be
// messaged goes through recordOptIn / recordOptOut, so the ledger, the legacy
// whatsapp_opt_outs table the feedback cron honours, the profile checkbox and the
// pending queue cannot drift apart.
//
//   marketing_consent         one row per phone: the source of truth. The agent only
//                             ever messages a phone whose row says 'opted_in'.
//   marketing_consent_events  append-only: every change, with where it came from.
//
// Consent is asymmetric on purpose (DPDP: withdrawing must be as easy as giving,
// and provable):
//   * opting OUT is total and immediate — the ledger, the shared opt-out table, the
//     verified profile's checkbox, and every not-yet-sent message to that phone;
//   * opting IN is only ever the customer's own act (a profile tap, a START message,
//     Meta's "resume") — there is NO owner path and no import of "consented" lists.
//
// The states, transitions and the "is this phone opted out?" predicate are in
// lib/marketing/consentState.ts. The writes here are ORDERED so that a write that
// fails part-way leaves the phone un-messageable rather than messageable: an
// opt-out writes the shared opt-out table FIRST (before the ledger), and an opt-in
// deletes it LAST (after everything else) — so between them, and after any partial
// failure, at least one store still says stop.
//
// A failure is reported, never thrown past this file: the webhook and the account
// PATCH must keep working when the ledger cannot be written (migration not applied,
// a transient DB error). The caller decides whether that matters.

import 'server-only';
import type { PostgrestLikeError } from '@/lib/api/postgrest';
import type { ConsentSource, ConsentStatus } from '@/lib/marketing/types';
import { canTransitionConsent, isOptedOut, sourceAllowedFor, type LedgerState } from '@/lib/marketing/consentState';
import {
  assertOk,
  isMigrationMissing,
  isMigrationMissingError,
  isUniqueViolation,
  marketingAdmin,
  phoneStorageForms,
  toE164,
  type Admin,
} from './repo';

// ---------------------------------------------------------------------------
// Keyword recognition
// ---------------------------------------------------------------------------

/** Words that opt a customer IN when sent as the WHOLE message (trimmed, case-insensitive). */
export const OPT_IN_KEYWORDS: readonly string[] = ['START', 'SUBSCRIBE', 'OFFERS', 'UNSTOP'];

/**
 * True when an inbound text is exactly START / SUBSCRIBE / OFFERS / UNSTOP. The
 * whole message, not a substring: "please start my order" must not subscribe
 * anyone to marketing. The mirror of isOptOutKeyword (lib/feedback/payload.ts).
 */
export function isOptInKeyword(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  return OPT_IN_KEYWORDS.includes(text.trim().toUpperCase());
}

/** Meta's marketing opt-out quick-reply button ("Stop promotions"), matched on its label. */
export function isStopPromotionsButton(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  return text.trim().toLowerCase() === 'stop promotions';
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type ConsentResult =
  | {
      ok: true;
      /** false when the ledger did not change (a `meta_resume` with no earlier opt-in, or a repeat opt-in). */
      changed: boolean;
      /** Why nothing was recorded, when changed is false. */
      skipped?: 'no_prior_opt_in' | 'already_opted_in';
      /** Side effects that failed AFTER the ledger was written (the consent itself did change). */
      warnings: string[];
    }
  | { ok: false; migration_missing: boolean; error: string };

export interface ConsentInput {
  /** Any recognisable phone; stored as E.164. */
  phone: string;
  /** The account behind the phone, when the caller knows it; otherwise the verified profile with that phone. */
  userId?: string | null;
  source: ConsentSource;
  /** Who made the change: the customer's own id (profile), the owner's (owner), null for a webhook. */
  actor?: string | null;
  /**
   * recordOptOut only: the `source` written on the shared whatsapp_opt_outs row. Defaults to
   * `marketing:<source>`. The STOP keyword passes 'stop_keyword' — that row predates marketing,
   * belongs to the feedback product, and has always carried that source.
   */
  optOutRowSource?: string;
  /** Test seam. */
  now?: Date;
  admin?: Admin;
}

const failure = (error: unknown): ConsentResult => ({
  ok: false,
  migration_missing: isMigrationMissingError(error),
  error: error instanceof Error ? error.message : 'consent write failed',
});

/** Runs one best-effort side effect: its failure becomes a warning, never an exception. */
async function sideEffect(name: string, warnings: string[], run: () => PromiseLike<{ error: PostgrestLikeError | null }>): Promise<void> {
  try {
    const { error } = await run();
    assertOk(name, error);
  } catch (err) {
    warnings.push(`${name}: ${err instanceof Error ? err.message : 'failed'}`);
  }
}

/** The one VERIFIED profile holding `phone` (profiles.phone is unique across verified accounts). */
async function verifiedUserIdFor(admin: Admin, phone: string): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('phone', phone)
      .eq('phone_verified', true)
      .limit(2);
    if (error) return null;
    const rows = (data ?? []) as { id: string }[];
    return rows.length === 1 ? rows[0].id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Opt in
// ---------------------------------------------------------------------------

/**
 * The customer said yes. Moves the ledger to opted_in (lib/marketing/consentState.ts),
 * mirrors profiles.marketing_consent = true on the verified profile with that phone,
 * appends an audit event, and — LAST — DELETES the phone's whatsapp_opt_outs rows: they
 * asked back in, and that table is what the feedback cron honours. Last, because until
 * that delete lands the phone stays opted out by isOptedOut(); a failure (or a STOP
 * racing this START) anywhere before it therefore leaves the customer un-messaged,
 * never messaged against a STOP.
 *
 * The ledger write is a compare-and-set against the state it read:
 *   none / opted_out → opted_in  a new consent: consented_at = now, source = this one;
 *   opted_in → opted_in          a repeat: the consent in force keeps ITS consented_at
 *                                and source (it used to be reset on every START), no
 *                                audit event (nothing changed), changed: false.
 *
 * `meta_resume` is the exception: Meta's "resume marketing" preference is not consent
 * TO US unless there is an earlier opt-in of ours to resume. With no earlier opt_in
 * event for the phone, nothing is recorded. An opt-out-only source (e.g. 'owner') is
 * refused outright: nobody opts a customer in on their behalf.
 */
export async function recordOptIn(input: ConsentInput): Promise<ConsentResult> {
  const phone = toE164(input.phone);
  if (!phone) return { ok: false, migration_missing: false, error: 'invalid phone' };
  if (!sourceAllowedFor('opt_in', input.source)) {
    return { ok: false, migration_missing: false, error: `${input.source} cannot opt a customer in` };
  }
  const admin = input.admin ?? marketingAdmin();
  const nowIso = (input.now ?? new Date()).toISOString();
  const warnings: string[] = [];

  try {
    if (input.source === 'meta_resume') {
      const { data, error } = await admin
        .from('marketing_consent_events')
        .select('id')
        .eq('phone', phone)
        .eq('action', 'opt_in')
        .limit(1);
      assertOk('marketing_consent_events read', error);
      if (!data || data.length === 0) return { ok: true, changed: false, skipped: 'no_prior_opt_in', warnings };
    }

    const userId = input.userId ?? (await verifiedUserIdFor(admin, phone));

    // 1. The ledger — the source of truth. Two passes at most: the second only when another
    //    writer moved the row between our read and our write, decided against what it wrote.
    let changed: boolean | null = null;
    for (let pass = 0; pass < 2 && changed === null; pass++) {
      const { data: current, error: readError } = await admin
        .from('marketing_consent')
        .select('status')
        .eq('phone', phone)
        .maybeSingle();
      assertOk('marketing_consent read', readError);
      const from: LedgerState = (current as { status?: ConsentStatus } | null)?.status ?? 'none';
      // hasPriorOptIn: true — the meta_resume guard was answered above, with a read of the event log.
      const check = canTransitionConsent(from, 'opt_in', { source: input.source, hasPriorOptIn: true });
      if (!check.ok) return { ok: false, migration_missing: false, error: check.message };

      if (check.repeat) {
        // Already opted in: the consent in force stands. Only the account link is refreshed, as
        // the upsert this replaced did (and only when known — null would wipe a link).
        if (userId) {
          await sideEffect('marketing_consent link', warnings, () =>
            admin.from('marketing_consent').update({ user_id: userId }).eq('phone', phone),
          );
        }
        changed = false;
        break;
      }

      const fields = {
        // Only set when known: a write that says user_id: null would wipe a link a previous write made.
        ...(userId ? { user_id: userId } : {}),
        status: 'opted_in' as const,
        source: input.source,
        consented_at: nowIso,
        withdrawn_at: null,
      };
      if (from === 'none') {
        const { error } = await admin.from('marketing_consent').insert({ phone, ...fields });
        if (!error) changed = true;
        else if (!isUniqueViolation(error) || pass > 0) assertOk('marketing_consent write', error);
      } else {
        const { data, error } = await admin
          .from('marketing_consent')
          .update(fields)
          .eq('phone', phone)
          .eq('status', from)
          .select('phone');
        assertOk('marketing_consent write', error);
        if ((data ?? []).length > 0) changed = true;
      }
    }
    if (changed === null) throw new Error('marketing_consent write: the row kept changing under the opt-in');

    // 2. The checkbox on their (verified) profile.
    await sideEffect('profiles mirror', warnings, () =>
      admin.from('profiles').update({ marketing_consent: true }).eq('phone', phone).eq('phone_verified', true),
    );
    // 3. The audit trail — it records changes, so only when the ledger actually changed.
    if (changed) {
      await sideEffect('marketing_consent_events write', warnings, () =>
        admin.from('marketing_consent_events').insert({
          phone,
          user_id: userId,
          action: 'opt_in',
          source: input.source,
          actor: input.actor ?? null,
          created_at: nowIso,
        }),
      );
    }
    // 4. LAST: the shared opt-out table. The customer asked back in, so their old STOP must not keep
    //    blocking them — in whichever spelling it was stored: older rows kept the number without its
    //    '+', or as the bare ten-digit number, and the audience read treats all of those as the same
    //    opt-out (so leaving one behind would keep a customer who said START blocked, silently). Only
    //    THIS number's spellings, never a neighbour's. Run on a repeat too: a stray row left by an
    //    earlier partial failure would otherwise keep blocking a customer the ledger says opted in.
    await sideEffect('whatsapp_opt_outs delete', warnings, () =>
      admin.from('whatsapp_opt_outs').delete().in('phone', phoneStorageForms(phone)),
    );
    return changed
      ? { ok: true, changed: true, warnings }
      : { ok: true, changed: false, skipped: 'already_opted_in', warnings };
  } catch (err) {
    return failure(err);
  }
}

// ---------------------------------------------------------------------------
// Opt out
// ---------------------------------------------------------------------------

/**
 * The customer said stop (or Meta told us they did, or the owner recorded it on their
 * behalf). FIRST upserts whatsapp_opt_outs (source `marketing:<source>` unless the
 * caller names the row's source), so the phone is opted out by isOptedOut() before
 * anything else can fail; then sets the ledger to opted_out (withdrawn_at now),
 * CANCELS the phone's pending and queued recipients (skip_reason 'opted_out'), sets
 * profiles.marketing_consent = false on the matching verified profile, and appends an
 * audit event.
 *
 * With the marketing migration missing the ledger write fails and that is reported —
 * but the opt-out row is already written, which is everything the STOP keyword ever
 * recorded before marketing existed (the webhook relies on this: it no longer writes
 * that row itself).
 *
 * A message already claimed by the sender ('sending') is not touched here; the sender
 * re-reads consent immediately before it sends, and that is where it is stopped.
 */
export async function recordOptOut(input: ConsentInput): Promise<ConsentResult> {
  const phone = toE164(input.phone);
  if (!phone) return { ok: false, migration_missing: false, error: 'invalid phone' };
  if (!sourceAllowedFor('opt_out', input.source)) {
    return { ok: false, migration_missing: false, error: `${input.source} cannot opt a customer out` };
  }
  const admin = input.admin ?? marketingAdmin();
  const nowIso = (input.now ?? new Date()).toISOString();
  const warnings: string[] = [];

  try {
    // 1. The shared opt-out table, FIRST: every sender honours it (isOptedOut), so from here on a
    //    failure anywhere below still leaves this phone un-messageable.
    await sideEffect('whatsapp_opt_outs write', warnings, () =>
      admin
        .from('whatsapp_opt_outs')
        .upsert({ phone, source: input.optOutRowSource ?? `marketing:${input.source}` }, { onConflict: 'phone' }),
    );

    const userId = input.userId ?? (await verifiedUserIdFor(admin, phone));

    // 2. The ledger. Opting out is allowed from every state (consentState.ts), so a plain upsert
    //    is already the compare-and-set: there is no state it could wrongly overwrite.
    const { error: ledgerError } = await admin.from('marketing_consent').upsert(
      {
        phone,
        ...(userId ? { user_id: userId } : {}),
        status: 'opted_out',
        source: input.source,
        withdrawn_at: nowIso,
      },
      { onConflict: 'phone' },
    );
    assertOk('marketing_consent write', ledgerError);

    // 3. Stop the queue next: a message must not leave between the opt-out and its cleanup.
    await sideEffect('marketing_recipients cancel', warnings, () =>
      admin
        .from('marketing_recipients')
        .update({ status: 'cancelled', skip_reason: 'opted_out' })
        .eq('phone', phone)
        .in('status', ['pending', 'queued']),
    );
    // 4. The profile checkbox.
    await sideEffect('profiles mirror', warnings, () =>
      admin.from('profiles').update({ marketing_consent: false }).eq('phone', phone).eq('phone_verified', true),
    );
    // 5. The audit trail.
    await sideEffect('marketing_consent_events write', warnings, () =>
      admin.from('marketing_consent_events').insert({
        phone,
        user_id: userId,
        action: 'opt_out',
        source: input.source,
        actor: input.actor ?? null,
        created_at: nowIso,
      }),
    );
    return { ok: true, changed: true, warnings };
  } catch (err) {
    return failure(err);
  }
}

// ---------------------------------------------------------------------------
// Reading consent (send time)
// ---------------------------------------------------------------------------

export interface ConsentState {
  /** marketing_consent.status === 'opted_in'. */
  opted_in: boolean;
  /** A whatsapp_opt_outs row exists — beats opted_in. */
  opt_out_listed: boolean;
}

/**
 * One phone's consent, read FRESH — the sender calls this immediately before each
 * message, because consent withdrawn between approval and send must win. Throws on a
 * failed read (the caller then fails the recipient rather than guessing "yes").
 */
export async function loadConsentState(admin: Admin, phoneInput: string): Promise<ConsentState> {
  const phone = toE164(phoneInput) ?? phoneInput;
  const [consent, optOut] = await Promise.all([
    admin.from('marketing_consent').select('status').eq('phone', phone).maybeSingle(),
    // Every spelling: a legacy opt-out row can be stored without its '+', or as the bare ten digits.
    admin.from('whatsapp_opt_outs').select('phone').in('phone', phoneStorageForms(phone)),
  ]);
  assertOk('marketing_consent read', consent.error);
  assertOk('whatsapp_opt_outs read', optOut.error);
  return {
    opted_in: (consent.data as { status?: string } | null)?.status === 'opted_in',
    opt_out_listed: (optOut.data ?? []).length > 0,
  };
}

/**
 * Which of `phones` are opted out (consentState.ts isOptedOut: a whatsapp_opt_outs row in
 * any stored spelling, OR a ledger that says opted_out). The feedback cron's check — it
 * used to read only whatsapp_opt_outs, and only the exact spelling it was handed.
 *
 * Returns the input strings, as given, that are opted out. A missing marketing ledger
 * (migration not applied) counts as "no ledger rows"; any other failed read THROWS, so
 * the caller does not message anyone it could not check.
 */
export async function loadOptedOutPhones(admin: Admin, phones: readonly string[]): Promise<Set<string>> {
  const e164ByInput = new Map<string, string | null>();
  for (const p of phones) e164ByInput.set(p, toE164(p));
  const spellingsOf = (raw: string, e164: string | null) => (e164 ? phoneStorageForms(e164) : [raw]);
  const forms = new Set<string>();
  for (const [raw, e164] of e164ByInput) for (const f of spellingsOf(raw, e164)) forms.add(f);
  if (forms.size === 0) return new Set();
  const ledgerKeys = [...new Set([...e164ByInput.values()].filter((e): e is string => Boolean(e)))];

  const [optOuts, ledger] = await Promise.all([
    admin.from('whatsapp_opt_outs').select('phone').in('phone', [...forms]),
    ledgerKeys.length > 0
      ? admin.from('marketing_consent').select('phone, status').in('phone', ledgerKeys)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  if (optOuts.error) throw new Error(`whatsapp_opt_outs read: ${optOuts.error.message ?? 'failed'}`);
  const ledgerMissing = Boolean(ledger.error) && isMigrationMissing(ledger.error);
  if (ledger.error && !ledgerMissing) throw new Error(`marketing_consent read: ${ledger.error.message ?? 'failed'}`);

  const listed = new Set(((optOuts.data ?? []) as { phone: string }[]).map((r) => r.phone));
  const ledgerRows = (ledger.error ? [] : (ledger.data ?? [])) as { phone: string; status: ConsentStatus }[];
  const ledgerByPhone = new Map(ledgerRows.map((r) => [r.phone, r.status]));

  const out = new Set<string>();
  for (const [raw, e164] of e164ByInput) {
    const facts = {
      ledger: (e164 ? ledgerByPhone.get(e164) : undefined) ?? null,
      optOutListed: spellingsOf(raw, e164).some((f) => listed.has(f)),
    };
    if (isOptedOut(facts)) out.add(raw);
  }
  return out;
}
