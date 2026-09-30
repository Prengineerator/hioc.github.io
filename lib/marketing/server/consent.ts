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
// A failure is reported, never thrown past this file: the webhook and the account
// PATCH must keep working when the ledger cannot be written (migration not applied,
// a transient DB error). The caller decides whether that matters.

import 'server-only';
import type { PostgrestLikeError } from '@/lib/api/postgrest';
import type { ConsentSource } from '@/lib/marketing/types';
import {
  assertOk,
  isMigrationMissingError,
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
      /** false when nothing was recorded (a `meta_resume` with no earlier opt-in). */
      changed: boolean;
      /** Why nothing was recorded, when changed is false. */
      skipped?: 'no_prior_opt_in';
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
 * The customer said yes. Sets the ledger to opted_in (consented_at now, withdrawn_at
 * cleared), DELETES the phone's whatsapp_opt_outs row — they asked back in, and that
 * table is what the feedback cron honours — mirrors profiles.marketing_consent = true
 * on the verified profile with that phone, and appends an audit event.
 *
 * `meta_resume` is the exception: Meta's "resume marketing" preference is not consent
 * TO US unless there is an earlier opt-in of ours to resume. With no earlier opt_in
 * event for the phone, nothing is recorded.
 */
export async function recordOptIn(input: ConsentInput): Promise<ConsentResult> {
  const phone = toE164(input.phone);
  if (!phone) return { ok: false, migration_missing: false, error: 'invalid phone' };
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

    // 1. The ledger — the source of truth. Everything after this is a side effect of it.
    const { error: ledgerError } = await admin.from('marketing_consent').upsert(
      {
        phone,
        // Only set when known: an upsert that says user_id: null would wipe a link a previous write made.
        ...(userId ? { user_id: userId } : {}),
        status: 'opted_in',
        source: input.source,
        consented_at: nowIso,
        withdrawn_at: null,
      },
      { onConflict: 'phone' },
    );
    assertOk('marketing_consent write', ledgerError);

    // 2. The shared opt-out table. The customer asked back in, so their old STOP must not keep blocking them —
    //    in whichever spelling it was stored: older rows kept the number without its '+', or as the bare ten
    //    digits, and the audience read treats all of those as the same opt-out (so leaving one behind would
    //    keep a customer who said START blocked, silently). Only THIS number's spellings, never a neighbour's.
    await sideEffect('whatsapp_opt_outs delete', warnings, () =>
      admin.from('whatsapp_opt_outs').delete().in('phone', phoneStorageForms(phone)),
    );
    // 3. The checkbox on their (verified) profile.
    await sideEffect('profiles mirror', warnings, () =>
      admin.from('profiles').update({ marketing_consent: true }).eq('phone', phone).eq('phone_verified', true),
    );
    // 4. The audit trail.
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
    return { ok: true, changed: true, warnings };
  } catch (err) {
    return failure(err);
  }
}

// ---------------------------------------------------------------------------
// Opt out
// ---------------------------------------------------------------------------

/**
 * The customer said stop (or Meta told us they did, or the owner recorded it on their
 * behalf). Sets the ledger to opted_out (withdrawn_at now), UPSERTS whatsapp_opt_outs
 * (source prefixed 'marketing:') so the feedback cron stops too, sets
 * profiles.marketing_consent = false on the matching verified profile, CANCELS the
 * phone's pending and queued recipients (skip_reason 'opted_out'), and appends an
 * audit event.
 *
 * A message already claimed by the sender ('sending') is not touched here; the sender
 * re-reads consent immediately before it sends, and that is where it is stopped.
 */
export async function recordOptOut(input: ConsentInput): Promise<ConsentResult> {
  const phone = toE164(input.phone);
  if (!phone) return { ok: false, migration_missing: false, error: 'invalid phone' };
  const admin = input.admin ?? marketingAdmin();
  const nowIso = (input.now ?? new Date()).toISOString();
  const warnings: string[] = [];

  try {
    const userId = input.userId ?? (await verifiedUserIdFor(admin, phone));

    // 1. The ledger.
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

    // 2. Stop the queue FIRST among the side effects: a message must not leave between the opt-out and its cleanup.
    await sideEffect('marketing_recipients cancel', warnings, () =>
      admin
        .from('marketing_recipients')
        .update({ status: 'cancelled', skip_reason: 'opted_out' })
        .eq('phone', phone)
        .in('status', ['pending', 'queued']),
    );
    // 3. The shared opt-out table (the feedback cron reads it).
    await sideEffect('whatsapp_opt_outs write', warnings, () =>
      admin.from('whatsapp_opt_outs').upsert({ phone, source: `marketing:${input.source}` }, { onConflict: 'phone' }),
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
