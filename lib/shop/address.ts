// Delivery address checks for the Instant Coffee shop. Pure, and shared by the
// /shop form (to point at the field before anything is sent) and
// POST /api/shop/checkout (which never trusts the form), so the two agree.
//
// Shiprocket needs a real Indian address: a name, a 10-digit mobile the courier
// can call, an email, a street line, a city, a state and a 6-digit pincode.

import { normalizeEmail } from '@/lib/email';
import { normalizeIndianMobile } from '@/lib/phone';
import type { ShopAddress } from './types';

/** The 28 states and 8 union territories, as Shiprocket and couriers spell them. */
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

export type AddressField = keyof ShopAddress;

export type AddressResult =
  | { ok: true; address: ShopAddress }
  | { ok: false; field: AddressField; error: string };

const PINCODE_RE = /^[1-9]\d{5}$/;

/** Trims and folds runs of whitespace (newlines from a pasted address) into one space. */
function clean(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Validates the form's fields and returns them in the stored form: phone as
 * +91XXXXXXXXXX, email lowercased, everything trimmed. The first problem found
 * is returned with the field it belongs to.
 */
export function validateShopAddress(raw: unknown): AddressResult {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const customer_name = clean(r.customer_name);
  if (customer_name.length < 2) return { ok: false, field: 'customer_name', error: 'Enter the name to deliver to' };
  if (customer_name.length > 60) return { ok: false, field: 'customer_name', error: 'Name is too long (60 characters at most)' };

  const mobile = normalizeIndianMobile(clean(r.phone));
  if (!mobile) return { ok: false, field: 'phone', error: 'Enter a 10-digit Indian mobile number' };

  const email = normalizeEmail(clean(r.email));
  if (!email) return { ok: false, field: 'email', error: 'Enter a valid email address' };

  const address_line1 = clean(r.address_line1);
  if (address_line1.length < 5) {
    return { ok: false, field: 'address_line1', error: 'Enter the house number and street' };
  }
  if (address_line1.length > 120) {
    return { ok: false, field: 'address_line1', error: 'Address line is too long (120 characters at most)' };
  }

  const address_line2 = clean(r.address_line2);
  if (address_line2.length > 120) {
    return { ok: false, field: 'address_line2', error: 'Address line is too long (120 characters at most)' };
  }

  const city = clean(r.city);
  if (city.length < 2 || city.length > 50) return { ok: false, field: 'city', error: 'Enter the town or city' };

  const stateInput = clean(r.state);
  const state = INDIAN_STATES.find((s) => s.toLowerCase() === stateInput.toLowerCase());
  if (!state) return { ok: false, field: 'state', error: 'Choose the state' };

  const pincode = clean(r.pincode).replace(/\s/g, '');
  if (!PINCODE_RE.test(pincode)) return { ok: false, field: 'pincode', error: 'Enter the 6-digit pincode' };

  return {
    ok: true,
    address: {
      customer_name,
      phone: `+91${mobile}`,
      email,
      address_line1,
      address_line2,
      city,
      state,
      pincode,
    },
  };
}
