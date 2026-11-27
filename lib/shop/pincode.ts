// Pincode helps (docs/SHOP-V2-SPEC.md E3): typing a 6-digit pincode fills in
// the state, so the customer has one field fewer to touch. Pure, client-safe
// and offline: a static table, no network, no lookup service.
//
// The table is India Post's postal circles read at the first three digits of
// the PIN (the sorting district). The first digit is the region, the first two
// the sub-region or circle, the first three the sorting district. Most
// districts sit wholly inside one state, but some do not. A prefix that two
// states or union territories share (for example 396: Gujarat and Dadra and
// Nagar Haveli and Daman and Diu; 362: Gujarat and Diu, which is in Dadra and
// Nagar Haveli and Daman and Diu; 605 and 607: Tamil Nadu and Puducherry;
// 682: Kerala and Lakshadweep; 673: Kerala and Mahe; 533: Andhra Pradesh and
// Yanam; 244, 246, 247 and 262: Uttar Pradesh and Uttarakhand; 194: Ladakh and
// Jammu and Kashmir) returns null rather than guess; the form then leaves the
// state for the customer to choose. 160 is split by full PIN: Chandigarh's own
// sectors are 160001 to 160036 and 160101 to 160103, and the rest of 160xxx
// (Mohali and Zirakpur side, in Punjab) returns null.

import type { INDIAN_STATES } from './address';

type State = (typeof INDIAN_STATES)[number];

/** Inclusive ranges of the first three digits, one state each, sorted and
 * non-overlapping (a test enforces it; the first match wins). */
export const PREFIX_RANGES: readonly (readonly [number, number, State])[] = [
  [110, 110, 'Delhi'],
  [121, 136, 'Haryana'],
  [140, 159, 'Punjab'],
  [171, 177, 'Himachal Pradesh'],
  [180, 193, 'Jammu and Kashmir'],
  [201, 243, 'Uttar Pradesh'],
  [245, 245, 'Uttar Pradesh'],
  [248, 249, 'Uttarakhand'],
  [250, 261, 'Uttar Pradesh'],
  [263, 263, 'Uttarakhand'],
  [264, 285, 'Uttar Pradesh'],
  [301, 345, 'Rajasthan'],
  [360, 361, 'Gujarat'],
  [363, 395, 'Gujarat'],
  [400, 402, 'Maharashtra'],
  [403, 403, 'Goa'],
  [410, 445, 'Maharashtra'],
  [450, 488, 'Madhya Pradesh'],
  [490, 497, 'Chhattisgarh'],
  [500, 509, 'Telangana'],
  [515, 532, 'Andhra Pradesh'],
  [534, 535, 'Andhra Pradesh'],
  [560, 591, 'Karnataka'],
  [600, 604, 'Tamil Nadu'],
  [606, 606, 'Tamil Nadu'],
  [608, 608, 'Tamil Nadu'],
  [610, 643, 'Tamil Nadu'],
  [670, 672, 'Kerala'],
  [674, 681, 'Kerala'],
  [683, 695, 'Kerala'],
  [700, 736, 'West Bengal'],
  [737, 737, 'Sikkim'],
  [738, 743, 'West Bengal'],
  [744, 744, 'Andaman and Nicobar Islands'],
  [751, 770, 'Odisha'],
  [781, 788, 'Assam'],
  [790, 792, 'Arunachal Pradesh'],
  [793, 794, 'Meghalaya'],
  [795, 795, 'Manipur'],
  [796, 796, 'Mizoram'],
  [797, 798, 'Nagaland'],
  [799, 799, 'Tripura'],
  [800, 813, 'Bihar'],
  [814, 816, 'Jharkhand'],
  [821, 821, 'Bihar'],
  [822, 822, 'Jharkhand'],
  [823, 824, 'Bihar'],
  [825, 829, 'Jharkhand'],
  [831, 835, 'Jharkhand'],
  [841, 855, 'Bihar'],
];

/** Chandigarh's own PINs inside the shared 160 prefix. */
function isChandigarhPin(pin: number): boolean {
  return (pin >= 160001 && pin <= 160036) || (pin >= 160101 && pin <= 160103);
}

/**
 * The state or union territory a 6-digit pincode belongs to, or null when the
 * input isn't a pincode or the prefix is shared by more than one place.
 */
export function stateForPincode(pin: string): State | null {
  const p = typeof pin === 'string' ? pin.replace(/\s/g, '') : '';
  if (!/^[1-9]\d{5}$/.test(p)) return null;
  if (p.startsWith('160')) return isChandigarhPin(Number(p)) ? 'Chandigarh' : null;
  const prefix = Number(p.slice(0, 3));
  for (const [from, to, state] of PREFIX_RANGES) {
    if (prefix >= from && prefix <= to) return state;
  }
  return null;
}
