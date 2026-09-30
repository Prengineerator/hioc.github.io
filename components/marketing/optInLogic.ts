// Which opt-in card (if any) the order page shows — the decision, separated from
// the fetching so it is unit-tested (tests/marketingDashboardOptIn.test.ts).
//
// Two ways a customer says yes (spec §2):
//   'profile'  a signed-in customer with a VERIFIED phone who has not opted in:
//              one tap turns on marketing_consent, and the server records the
//              opt-in against that verified number.
//   'wa_link'  everyone else: a wa.me link that opens WhatsApp with START ready to
//              send. The customer sends it and the webhook records the opt-in.
// Anything else shows nothing. In particular: never a pre-ticked box, never a card
// for someone who has already said yes, and never a link that isn't a WhatsApp one.

import type { PublicOptinResponse } from '@/lib/marketing/types';

/** The fields of GET /api/account/me this decision reads (shapeMe in app/api/account/me/route.ts). */
export interface AccountMe {
  phone?: unknown;
  phone_verified?: unknown;
  marketing_consent?: unknown;
}

export type MeVerdict =
  /** Signed in, verified phone, not opted in: ask with one tap. */
  | 'ask'
  /** Signed in and already opted in: say nothing. */
  | 'already_in'
  /** Not signed in, no verified phone, or the request failed: use the WhatsApp link. */
  | 'no_profile_path';

export function classifyMe(me: AccountMe | null | undefined): MeVerdict {
  if (!me || typeof me !== 'object') return 'no_profile_path';
  if (me.marketing_consent === true) return 'already_in';
  const phone = typeof me.phone === 'string' ? me.phone.trim() : '';
  return me.phone_verified === true && phone !== '' ? 'ask' : 'no_profile_path';
}

/** The WhatsApp link to render, or null. Only a real https://wa.me/ link is ever put in an href. */
export function usableWaLink(optin: PublicOptinResponse | null | undefined): string | null {
  if (!optin || optin.available !== true || typeof optin.wa_link !== 'string') return null;
  return /^https:\/\/wa\.me\/\d{6,15}(\?[^\s]*)?$/.test(optin.wa_link) ? optin.wa_link : null;
}

export type OptInMode = 'profile' | 'wa_link' | 'none';

/** Combines the two lookups. `optin` is only consulted when the profile path isn't available. */
export function chooseOptInMode(verdict: MeVerdict, optin: PublicOptinResponse | null | undefined): OptInMode {
  if (verdict === 'ask') return 'profile';
  if (verdict === 'already_in') return 'none';
  return usableWaLink(optin) ? 'wa_link' : 'none';
}
