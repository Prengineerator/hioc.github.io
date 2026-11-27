// Saved-address book rules (docs/SHOP-V2-SPEC.md E3). Pure: no database, no
// React. The API routes, the account page and checkout all read the book the
// same way, so "which address is preselected" and "who becomes default after a
// delete" never disagree between screens.

import type { CustomerAddress } from '@/lib/shop/types';
import { stateForPincode } from '@/lib/shop/pincode';

/** At most this many saved addresses per account (the SQL trigger is the backstop). */
export const MAX_SAVED_ADDRESSES = 10;

export const ADDRESS_LIMIT_MESSAGE = 'You can save up to 10 addresses. Delete one to add another.';

/** Can one more address be saved when `count` are already saved? */
export function canAddAddress(count: number): boolean {
  return Number.isFinite(count) && count < MAX_SAVED_ADDRESSES;
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** Larger first; a missing value (NaN) sorts last. */
function newestFirst(a: string | null | undefined, b: string | null | undefined): number {
  const x = ms(a);
  const y = ms(b);
  if (Number.isNaN(x) && Number.isNaN(y)) return 0;
  if (Number.isNaN(x)) return 1;
  if (Number.isNaN(y)) return -1;
  return y - x;
}

/** Default first, then most recently used (never-used last), then newest created. Returns a new array. */
export function sortAddresses<T extends Pick<CustomerAddress, 'is_default' | 'last_used_at' | 'created_at'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    return newestFirst(a.last_used_at, b.last_used_at) || newestFirst(a.created_at, b.created_at);
  });
}

/** The address checkout preselects: the default, else the most recently used, else the newest. */
export function pickPreselectedAddress<T extends Pick<CustomerAddress, 'is_default' | 'last_used_at' | 'created_at'>>(
  list: readonly T[],
): T | null {
  return sortAddresses(list)[0] ?? null;
}

/**
 * Who becomes the default when `deletedId` is removed. null when the deleted
 * one was not the default (nothing changes), or when nothing is left.
 */
export function nextDefaultAfterDelete(
  list: readonly Pick<CustomerAddress, 'id' | 'is_default' | 'last_used_at' | 'created_at'>[],
  deletedId: string,
): string | null {
  const deleted = list.find((a) => a.id === deletedId);
  if (!deleted || !deleted.is_default) return null;
  const rest = list.filter((a) => a.id !== deletedId).map((a) => ({ ...a, is_default: false }));
  return sortAddresses(rest)[0]?.id ?? null;
}

/**
 * What a pincode edit may do to the State field. Returns the state to fill, or
 * null to leave the field alone. It fills only an empty State, or one the form
 * filled itself (`lastAutoFilled`); a hand-picked or prefilled state (a saved
 * address loaded into the form, a profile prefill) is never replaced. An
 * invalid or unknown pincode changes nothing.
 */
export function pincodeStatePatch(
  currentState: string | null | undefined,
  pincode: string,
  lastAutoFilled: string | null,
): string | null {
  const guess = stateForPincode(pincode);
  if (!guess) return null;
  if (!currentState || currentState === lastAutoFilled) return guess;
  return null;
}
