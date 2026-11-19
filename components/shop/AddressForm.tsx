'use client';

// The delivery-address fields, shared by checkout (/shop) and Account →
// Addresses so the two never drift apart (docs/SHOP-V2-SPEC.md E3).
//
// Friction rules baked in:
//   - phone-first order: name, phone, (email), pincode, street, apt, landmark, city, state
//   - every field has the right type / inputMode / autoComplete, so the phone
//     keyboard and the browser's address autofill do the typing
//   - typing a 6-digit pincode fills the State from the static table in
//     lib/shop/pincode.ts (no network). It fills only an empty State or one it
//     filled itself, and never overwrites a state the customer picked by hand
//     or one that came from a saved address / prefill (rule: pincodeStatePatch).
//   - errors sit under their field (Input/Select link them with aria-describedby)
//
// Controlled: the parent owns `value`; `onChange` receives a PATCH of the
// fields that changed (a pincode edit may patch pincode and state together).
// Validation stays in lib/shop/address.ts; pass its `{ field, error }` back as
// `errors` and call focusAddressField() to move focus to the field.

import { useRef, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { INDIAN_STATES, SAVED_ADDRESS_LABELS } from '@/lib/shop/address';
import { pincodeStatePatch } from '@/lib/account/addressRules';
import type { SavedAddressFields } from '@/lib/shop/types';

export type FormValues = SavedAddressFields & { email: string };
export type AddressFormField = keyof FormValues | 'label';

export interface AddressFormProps {
  value: Partial<FormValues>;
  /** A patch of the changed fields. */
  onChange: (patch: Partial<FormValues>) => void;
  errors?: { field: string; error: string } | null;
  withEmail?: boolean;
  /** Leave the mobile number out when the page asks for it elsewhere (the owner's New order page asks first). */
  hidePhone?: boolean;
  withLabel?: boolean;
  labelValue?: string;
  onLabelChange?: (label: string) => void;
  /** Prefix for the field ids, so two forms on one page stay distinct. */
  idPrefix: string;
  disabled?: boolean;
}

/** A blank form, optionally prefilled (e.g. from the profile). A +91 phone is shown as 10 digits. */
export function emptyAddressForm(prefill: Partial<FormValues> = {}): FormValues {
  return {
    customer_name: '',
    email: '',
    address_line1: '',
    address_line2: '',
    landmark: '',
    city: '',
    state: '',
    pincode: '',
    ...prefill,
    phone: tenDigits(prefill.phone ?? ''),
  };
}

/** Moves focus to a field by name (after a validation error). Returns whether it was found. */
export function focusAddressField(idPrefix: string, field: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.getElementById(`${idPrefix}-${field}`);
  if (!el) return false;
  el.focus();
  return true;
}

const tenDigits = (raw: string) => raw.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '').slice(-10);

const PRESETS: readonly string[] = SAVED_ADDRESS_LABELS;
const STATE_OPTIONS = INDIAN_STATES.map((s) => ({ value: s, label: s }));

export function AddressForm({
  value,
  onChange,
  errors,
  withEmail = false,
  hidePhone = false,
  withLabel = false,
  labelValue = 'Home',
  onLabelChange,
  idPrefix,
  disabled,
}: AddressFormProps) {
  // The state value WE filled in (null if none). Only that exact value may be replaced by a later pincode.
  const autoFilled = useRef<string | null>(null);
  // 'Custom' stays open once chosen, even while its text is still empty or reads 'Home'.
  const [customOpen, setCustomOpen] = useState(false);
  const isCustom = customOpen || !PRESETS.includes(labelValue);

  const id = (f: string) => `${idPrefix}-${f}`;
  const err = (f: string) => (errors && errors.field === f ? errors.error : undefined);
  const v = (f: keyof FormValues) => value[f] ?? '';

  const onPincode = (raw: string) => {
    const pincode = raw.replace(/\D/g, '').slice(0, 6);
    const patch: Partial<FormValues> = { pincode };
    const fill = pincodeStatePatch(value.state, pincode, autoFilled.current);
    if (fill) {
      patch.state = fill;
      autoFilled.current = fill;
    }
    onChange(patch);
  };

  return (
    <div className="flex flex-col gap-4">
      {withLabel ? (
        <fieldset className="flex flex-col gap-2" aria-describedby={err('label') ? id('label-error') : undefined}>
          <legend className="mb-1 text-sm font-semibold text-charcoal">Save as</legend>
          <div className="flex flex-wrap gap-2">
            {[...PRESETS, 'Custom'].map((name) => {
              const checked = name === 'Custom' ? isCustom : !isCustom && labelValue === name;
              return (
                <label
                  key={name}
                  className={[
                    'inline-flex min-h-[44px] cursor-pointer items-center rounded-full border px-4 text-sm font-semibold transition-colors',
                    'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-tan',
                    checked ? 'border-tan-dark bg-tan-dark text-cream' : 'border-muted/80 bg-cream text-charcoal hover:bg-surface',
                    disabled ? 'cursor-not-allowed opacity-60' : '',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name={`${idPrefix}-label-kind`}
                    className="sr-only"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => {
                      if (name === 'Custom') {
                        setCustomOpen(true);
                        onLabelChange?.(PRESETS.includes(labelValue) ? '' : labelValue);
                      } else {
                        setCustomOpen(false);
                        onLabelChange?.(name);
                      }
                    }}
                  />
                  {name}
                </label>
              );
            })}
          </div>
          {isCustom ? (
            <Input
              id={id('label')}
              label="Custom label"
              value={labelValue}
              onChange={(e) => onLabelChange?.(e.target.value.slice(0, 20))}
              maxLength={20}
              autoComplete="off"
              placeholder="e.g. Mum's place"
              error={err('label')}
              disabled={disabled}
            />
          ) : err('label') ? (
            <p id={id('label-error')} role="alert" className="text-sm font-semibold text-red-700">
              {err('label')}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <Input
        id={id('customer_name')}
        label="Full name"
        type="text"
        autoComplete="name"
        value={v('customer_name')}
        onChange={(e) => onChange({ customer_name: e.target.value })}
        error={err('customer_name')}
        disabled={disabled}
      />
      {hidePhone ? null : (
      <Input
        id={id('phone')}
        label="Mobile number"
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        maxLength={10}
        value={v('phone')}
        onChange={(e) => onChange({ phone: e.target.value.replace(/\D/g, '').slice(0, 10) })}
        hint="10-digit mobile"
        error={err('phone')}
        disabled={disabled}
      />
      )}
      {withEmail ? (
        <Input
          id={id('email')}
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={v('email')}
          onChange={(e) => onChange({ email: e.target.value })}
          error={err('email')}
          disabled={disabled}
        />
      ) : null}
      <Input
        id={id('pincode')}
        label="Pincode"
        type="text"
        inputMode="numeric"
        autoComplete="postal-code"
        maxLength={6}
        value={v('pincode')}
        onChange={(e) => onPincode(e.target.value)}
        error={err('pincode')}
        disabled={disabled}
      />
      <Input
        id={id('address_line1')}
        label="House no. and street"
        type="text"
        autoComplete="address-line1"
        value={v('address_line1')}
        onChange={(e) => onChange({ address_line1: e.target.value })}
        error={err('address_line1')}
        disabled={disabled}
      />
      <Input
        id={id('address_line2')}
        label="Apartment, area (optional)"
        type="text"
        autoComplete="address-line2"
        value={v('address_line2')}
        onChange={(e) => onChange({ address_line2: e.target.value })}
        error={err('address_line2')}
        disabled={disabled}
      />
      <Input
        id={id('landmark')}
        label="Landmark (optional)"
        type="text"
        autoComplete="off"
        maxLength={80}
        value={v('landmark')}
        onChange={(e) => onChange({ landmark: e.target.value })}
        hint="Helps the courier find you"
        error={err('landmark')}
        disabled={disabled}
      />
      <Input
        id={id('city')}
        label="Town or city"
        type="text"
        autoComplete="address-level2"
        value={v('city')}
        onChange={(e) => onChange({ city: e.target.value })}
        error={err('city')}
        disabled={disabled}
      />
      <Select
        id={id('state')}
        label="State"
        autoComplete="address-level1"
        placeholder="Choose the state"
        options={STATE_OPTIONS}
        value={v('state')}
        onChange={(e) => {
          autoFilled.current = null; // a hand-picked state is never overwritten
          onChange({ state: e.target.value });
        }}
        error={err('state')}
        disabled={disabled}
      />
    </div>
  );
}
