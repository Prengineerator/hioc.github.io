// Single source of truth for business/legal/contact details shown on the
// policy pages (Terms, Privacy, Refund & Cancellation, Shipping/Delivery) and
// the Contact page. Payment gateways (Razorpay etc.) require these to be
// accurate and publicly visible before activation.

import { CAFE_ADDRESS, CAFE_PHONE_DISPLAY, CAFE_PHONE_HREF } from '@/lib/constants';

export const BUSINESS = {
  // Customer-facing brand name.
  name: 'HIOC',
  // Registered legal entity that operates the HIOC brand — shown on Terms.
  legalName: 'Arry Foods',
  // Operational address (from lib/constants.ts).
  address: CAFE_ADDRESS,
  // Contact phone (from lib/constants.ts).
  phoneDisplay: CAFE_PHONE_DISPLAY,
  phoneHref: CAFE_PHONE_HREF,
  // Business support email.
  email: 'business.highoncaff@gmail.com',
  emailHref: 'mailto:business.highoncaff@gmail.com',
  // GST registration (shown on policy/contact pages).
  gstin: '09AGJPA9390E1Z9',
  // FSSAI food business license (shown on the printed customer receipt).
  fssaiLicense: '22723576000183',
  // Governing-law jurisdiction for Terms.
  jurisdiction: 'Agra, Uttar Pradesh, India',
  // Shown as "Last updated" on each policy page.
  lastUpdated: '18 July 2026',
} as const;

/**
 * "Last updated" on the pages that carry the HIOC Ritual wording (Refund &
 * Cancellation, Terms), from the day the wording is added. The pages show it only
 * while the feature is on: until then their text is what it was on
 * BUSINESS.lastUpdated, and a newer date over unchanged terms would be untrue.
 */
export const RITUAL_POLICY_UPDATED = '30 September 2026';

/**
 * "Last updated" on the pages that carry the Instant Coffee shop wording
 * (Shipping & Delivery, Refund & Cancellation, Terms), shown only while the shop
 * is switched on (NEXT_PUBLIC_FLAG_SHOP), for the same reason as above.
 */
export const SHOP_POLICY_UPDATED = '12 November 2026';

/** The "Last updated" date for a page that has Ritual and/or shop wording. */
export function policyUpdated(flagsOn: { shop: boolean; coffeePass: boolean }): string | undefined {
  if (flagsOn.shop) return SHOP_POLICY_UPDATED;
  if (flagsOn.coffeePass) return RITUAL_POLICY_UPDATED;
  return undefined;
}
