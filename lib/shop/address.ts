// Delivery address checks for the Instant Coffee shop. Pure, and shared by the
// /shop form (to point at the field before anything is sent) and
// POST /api/shop/checkout (which never trusts the form), so the two agree.
//
// A saved address (the customer's account book) holds the same fields minus
// the email, plus a short label (Home, Work, Other).
//
// Shiprocket needs a real Indian address: a name, a 10-digit mobile the courier
// can call, an email, a street line, a city, a state and a 6-digit pincode.

import { normalizeEmail } from '@/lib/email';
import { normalizeIndianMobile } from '@/lib/phone';
import type { SavedAddressFields, ShopAddress } from './types';

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

export type SavedAddressResult =
  | { ok: true; address: SavedAddressFields & { label: string } }
  | { ok: false; field: keyof SavedAddressFields | 'label'; error: string };

/** The labels the account page offers as one-tap choices. */
export const SAVED_ADDRESS_LABELS = ['Home', 'Work', 'Other'] as const;

const PINCODE_RE = /^[1-9]\d{5}$/;

/** Trims and folds runs of whitespace (newlines from a pasted address) into one space. */
function clean(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

type Raw = Record<string, unknown>;
type Fail<F extends string> = { ok: false; field: F; error: string };
type Core = SavedAddressFields;

/**
 * The checks the order form and the saved-address form share: everything but
 * the email. The first problem found is returned with the field it belongs to.
 */
function validateCore(
  r: Raw,
  afterContact?: () => Fail<'email'> | null,
): { ok: true; core: Core } | Fail<keyof SavedAddressFields> {
  const customer_name = clean(r.customer_name);
  if (customer_name.length < 2) return { ok: false, field: 'customer_name', error: 'Enter the name to deliver to' };
  if (customer_name.length > 60) return { ok: false, field: 'customer_name', error: 'Name is too long (60 characters at most)' };

  const mobile = normalizeIndianMobile(clean(r.phone));
  if (!mobile) return { ok: false, field: 'phone', error: 'Enter a 10-digit Indian mobile number' };

  const late = afterContact?.();
  if (late) return late as Fail<never>;

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

  const landmark = clean(r.landmark);
  if (landmark.length > 80) {
    return { ok: false, field: 'landmark', error: 'Landmark is too long (80 characters at most)' };
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
    core: { customer_name, phone: `+91${mobile}`, address_line1, address_line2, landmark, city, state, pincode },
  };
}

function asRaw(raw: unknown): Raw {
  return (typeof raw === 'object' && raw !== null ? raw : {}) as Raw;
}

/**
 * Validates the form's fields and returns them in the stored form: phone as
 * +91XXXXXXXXXX, email lowercased, everything trimmed. The first problem found
 * is returned with the field it belongs to. The email is checked after the
 * name and phone and before the street, as the form orders its fields.
 */
export function validateShopAddress(raw: unknown): AddressResult {
  const r = asRaw(raw);
  const email = normalizeEmail(clean(r.email));
  const core = validateCore(r, () => (email ? null : { ok: false, field: 'email', error: 'Enter a valid email address' }));
  if (!core.ok) return core;
  return { ok: true, address: { ...core.core, email: email as string } };
}

/** A label for a saved address: trimmed, 1 to 20 characters, 'Home' when blank. */
export function normalizeAddressLabel(raw: unknown): string {
  return clean(raw) || 'Home';
}

/** Validates a saved address: the order form's rules without the email, plus the label. */
export function validateSavedAddress(raw: unknown): SavedAddressResult {
  const r = asRaw(raw);
  const label = normalizeAddressLabel(r.label);
  if (label.length > 20) return { ok: false, field: 'label', error: 'Label is too long (20 characters at most)' };
  const core = validateCore(r);
  if (!core.ok) return core;
  return { ok: true, address: { ...core.core, label } };
}

const fold = (v: unknown) => clean(v).toLowerCase();

/**
 * Is this the same place to deliver? Phone and pincode match exactly; the two
 * street lines and the city match ignoring case and spacing. Used by reorder
 * and by the capture step's de-dupe, so a saved address is not saved twice.
 */
export function sameDeliveryAddress(
  a: Pick<SavedAddressFields, 'phone' | 'pincode' | 'address_line1' | 'address_line2' | 'city'>,
  b: Pick<SavedAddressFields, 'phone' | 'pincode' | 'address_line1' | 'address_line2' | 'city'>,
): boolean {
  return (
    clean(a.phone) === clean(b.phone) &&
    clean(a.pincode) === clean(b.pincode) &&
    fold(a.address_line1) === fold(b.address_line1) &&
    fold(a.address_line2) === fold(b.address_line2) &&
    fold(a.city) === fold(b.city)
  );
}
