'use client';

// "Deliver to" (docs/SHOP-V2-SPEC.md E3). Two parts:
//
//   useDelivery()    the state and the loading. For a signed-in customer it
//                    reads GET /api/account/addresses and GET /api/account/me
//                    (prefill). It decides the mode:
//                      saved  the customer has saved addresses: the default (or
//                             most recently used) is preselected, shown as a
//                             compact card with "Change". No address form unless
//                             they ask for one ("+ Add a new address").
//                      form   everyone else: a guest, or a signed-in customer
//                             with no saved address. Signed in, the form is
//                             prefilled (name, phone, email) and "Save this
//                             address to my account" is ticked, with the label
//                             chip Home. The server saves it only once the
//                             payment is captured. A guest gets the same form
//                             plus a slim sign-in link.
//   DeliverToStep    the view. `compact` renders only the saved-address
//                    summary (used at the top of Pay, where Deliver to shows
//                    when a saved address skips its own step).
//
// A saved address holds no email, so in saved mode a receipt email is asked for
// only when the account has none. Field errors from the server or from
// validateShopAddress arrive as `fieldError` and focus the field.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { AddressCard } from '@/components/shop/AddressCard';
import { AddressForm, emptyAddressForm, focusAddressField, type FormValues } from '@/components/shop/AddressForm';
import { LocationPin } from '@/components/shop/LocationPin';
import { MAX_SAVED_ADDRESSES, pickPreselectedAddress } from '@/lib/account/addressRules';
import { normalizeEmail } from '@/lib/email';
import type { DeliverySelection } from '@/lib/shop/checkoutFlow';
import type { ShopLocation } from '@/lib/shop/location';
import type { CustomerAddress, ShopAddress } from '@/lib/shop/types';

export const ADDRESS_ID_PREFIX = 'ship';

export interface FieldError {
  field: string;
  error: string;
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface Delivery {
  loadStatus: LoadStatus;
  retry: () => void;
  addresses: CustomerAddress[];
  max: number;
  selectedId: string | null;
  selected: CustomerAddress | null;
  mode: 'saved' | 'form';
  /** The list of saved addresses is open ("Change"). */
  choosing: boolean;
  setChoosing: (v: boolean) => void;
  selectAddress: (id: string) => void;
  /** "+ Add a new address" / "Use a saved address". */
  startNew: () => void;
  cancelNew: () => void;
  form: Partial<FormValues>;
  patchForm: (patch: Partial<FormValues>) => void;
  label: string;
  setLabel: (v: string) => void;
  saveToAccount: boolean;
  setSaveToAccount: (v: boolean) => void;
  receiptEmail: string;
  setReceiptEmail: (v: string) => void;
  pin: ShopLocation | null;
  setPin: (p: ShopLocation | null) => void;
  pinError: string | null;
  setPinError: (e: string | null) => void;
  fieldError: FieldError | null;
  setFieldError: (e: FieldError | null) => void;
  /** What the step machine and the checkout read. */
  selection: DeliverySelection;
  /** Pre-select / prefill from a stored cart (a reorder hand-off, or the sign-in round trip). */
  seed: (address: ShopAddress | null, addressId: string | null) => void;
}

export function useDelivery({ signedIn }: { signedIn: boolean }): Delivery {
  const [loadStatus, setLoadStatus] = useState<LoadStatus>(signedIn ? 'loading' : 'ready');
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [max, setMax] = useState(MAX_SAVED_ADDRESSES);
  const [preferredId, setPreferredId] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [addingNew, setAddingNew] = useState(false);
  const [form, setForm] = useState<Partial<FormValues>>(() => emptyAddressForm());
  const [label, setLabel] = useState('Home');
  const [saveToAccount, setSaveToAccount] = useState(true);
  const [receiptEmail, setReceiptEmail] = useState('');
  const [pin, setPin] = useState<ShopLocation | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const prefilled = useRef(false);
  const emailTouched = useRef(false);

  // The address book and the profile prefill.
  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    setLoadStatus('loading');
    (async () => {
      try {
        const res = await fetch('/api/account/addresses', { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { addresses?: CustomerAddress[]; max?: number };
        setAddresses(Array.isArray(data.addresses) ? data.addresses : []);
        if (typeof data.max === 'number') setMax(data.max);
        setLoadStatus('ready');
      } catch {
        if (!controller.signal.aborted) setLoadStatus('error');
      }
    })();
    (async () => {
      try {
        const res = await fetch('/api/account/me', { cache: 'no-store', signal: controller.signal });
        if (!res.ok) return;
        const me = (await res.json()) as { name?: string; phone?: string; email?: string; prefill?: { name?: string; email?: string } };
        const name = (me.prefill?.name || me.name || '').trim();
        const email = (me.prefill?.email || me.email || '').trim();
        if (email && !emailTouched.current) setReceiptEmail((cur) => cur || email);
        if (!prefilled.current) {
          prefilled.current = true;
          // Only empty fields are filled: a stored reorder address or anything typed wins.
          setForm((f) => ({
            ...f,
            customer_name: f.customer_name || name,
            phone: f.phone || emptyAddressForm({ phone: me.phone ?? '' }).phone,
            email: f.email || email,
          }));
        }
      } catch {
        // No prefill: the form is simply empty.
      }
    })();
    return () => controller.abort();
  }, [signedIn, attempt]);

  // The address in play, worked out as the book arrives (no effect, so the first render after load already has it):
  // the customer's own pick, else the one a stored cart named, else the default / most recently used.
  const selected = useMemo(() => {
    const byId = (id: string | null) => (id ? (addresses.find((a) => a.id === id) ?? null) : null);
    return byId(chosenId) ?? byId(preferredId) ?? pickPreselectedAddress(addresses);
  }, [addresses, chosenId, preferredId]);
  const selectedId = selected?.id ?? null;
  const mode: 'saved' | 'form' = signedIn && loadStatus === 'ready' && addresses.length > 0 && !addingNew && selected ? 'saved' : 'form';

  const patchForm = useCallback((patch: Partial<FormValues>) => {
    setForm((f) => ({ ...f, ...patch }));
    setFieldError((e) => (e && e.field in patch ? null : e));
  }, []);

  const selection: DeliverySelection = useMemo(
    () => ({ mode, addressId: mode === 'saved' ? selectedId : null, email: receiptEmail, form: form as Record<string, unknown> }),
    [mode, selectedId, receiptEmail, form],
  );

  return {
    loadStatus,
    retry: () => setAttempt((n) => n + 1),
    addresses,
    max,
    selectedId,
    selected,
    mode,
    choosing,
    setChoosing,
    selectAddress: (id) => {
      setChosenId(id);
      setAddingNew(false);
      setFieldError(null);
    },
    startNew: () => {
      setAddingNew(true);
      setChoosing(false);
      setFieldError(null);
    },
    cancelNew: () => {
      setAddingNew(false);
      setFieldError(null);
    },
    form,
    patchForm,
    label,
    setLabel,
    saveToAccount,
    setSaveToAccount,
    receiptEmail,
    setReceiptEmail: (v) => {
      emailTouched.current = true;
      setReceiptEmail(v);
      setFieldError((e) => (e && e.field === 'email' ? null : e));
    },
    pin,
    setPin,
    pinError,
    setPinError,
    fieldError,
    setFieldError,
    selection,
    seed: (address, addressId) => {
      if (addressId) setPreferredId(addressId);
      if (address) {
        prefilled.current = true;
        setForm(emptyAddressForm(address));
        // An address with no saved id (a reorder to a one-off address, or one a
        // guest typed before sign-in) must not be replaced by the default saved
        // address: open in form mode with it. "Use a saved address" is still there.
        if (!addressId) setAddingNew(true);
      }
    },
  };
}

/** One line for the Pay step's recap and the status line. */
export function addressSummary(d: Delivery): string {
  if (d.mode === 'saved' && d.selected) {
    return [d.selected.customer_name, d.selected.address_line1, d.selected.city].filter(Boolean).join(', ');
  }
  return [d.form.customer_name, d.form.address_line1, d.form.city].filter(Boolean).join(', ');
}

export function DeliverToStep({ delivery: d, signedIn, compact = false }: { delivery: Delivery; signedIn: boolean; compact?: boolean }) {
  const changeRef = useRef<HTMLButtonElement>(null);
  const wasChoosing = useRef(false);
  const [editingEmail, setEditingEmail] = useState(false);

  // After the list closes, keyboard focus goes back to "Change".
  useEffect(() => {
    if (wasChoosing.current && !d.choosing) changeRef.current?.focus();
    wasChoosing.current = d.choosing;
  }, [d.choosing]);

  // A field error moves focus to its field (the form's, or the receipt email).
  const errField = d.fieldError?.field ?? null;
  useEffect(() => {
    if (!errField) return;
    if (errField === 'email' && d.mode === 'saved') setEditingEmail(true);
    focusAddressField(ADDRESS_ID_PREFIX, errField);
  }, [errField, d.fieldError, d.mode]);

  if (d.loadStatus === 'loading') {
    return (
      <section aria-labelledby="deliver-heading" aria-busy="true">
        <h2 id="deliver-heading" className="text-xl font-bold text-charcoal">
          Deliver to
        </h2>
        <p className="sr-only" role="status">
          Loading your saved addresses
        </p>
        <Skeleton className="mt-4 h-32 w-full" />
      </section>
    );
  }

  if (d.mode === 'saved' && d.selected) {
    const emailOk = Boolean(normalizeEmail(d.receiptEmail));
    const canAddMore = d.addresses.length < d.max;
    return (
      <section aria-labelledby="deliver-heading">
        <h2 id="deliver-heading" className="text-xl font-bold text-charcoal">
          Deliver to
        </h2>
        <div className="mt-3">
          {d.choosing ? (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-charcoal">Choose an address</legend>
              <ul className="space-y-3">
                {d.addresses.map((a) => (
                  <li key={a.id}>
                    <label className="block cursor-pointer">
                      <input
                        type="radio"
                        name="deliver-address"
                        className="peer sr-only"
                        checked={a.id === d.selectedId}
                        onChange={() => {
                          d.selectAddress(a.id);
                          d.setChoosing(false);
                        }}
                      />
                      <AddressCard address={a} selected={a.id === d.selectedId} className="peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-tan" />
                    </label>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                {canAddMore ? (
                  <Button variant="ghost" onClick={d.startNew}>
                    + Add a new address
                  </Button>
                ) : (
                  <p className="text-sm text-muted">You&apos;ve saved {d.max} addresses. Delete one in your account to add another.</p>
                )}
                <Button variant="ghost" onClick={() => d.setChoosing(false)}>
                  Done
                </Button>
              </div>
            </fieldset>
          ) : (
            <AddressCard address={d.selected}>
              <Button ref={changeRef} variant="ghost" size="sm" onClick={() => d.setChoosing(true)} aria-label="Change delivery address">
                Change
              </Button>
            </AddressCard>
          )}
        </div>

        {emailOk && !editingEmail ? (
          <p className="mt-3 text-sm text-muted">
            Receipt and tracking go to <strong className="text-charcoal">{normalizeEmail(d.receiptEmail)}</strong>{' '}
            <button
              type="button"
              onClick={() => setEditingEmail(true)}
              className="min-h-[44px] px-1 font-semibold text-tan-dark underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
            >
              Change
            </button>
          </p>
        ) : (
          <div className="mt-3">
            <Input
              id={`${ADDRESS_ID_PREFIX}-email`}
              label="Email for your receipt and tracking link"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={d.receiptEmail}
              onChange={(e) => d.setReceiptEmail(e.target.value)}
              error={d.fieldError?.field === 'email' ? d.fieldError.error : undefined}
            />
          </div>
        )}
      </section>
    );
  }

  if (compact) return null;

  const canSave = signedIn && d.addresses.length < d.max;
  return (
    <section aria-labelledby="deliver-heading">
      <h2 id="deliver-heading" className="text-xl font-bold text-charcoal">
        Deliver to
      </h2>
      <p className="mt-1 text-sm text-muted">We ship anywhere in India. The courier may call this number.</p>

      {d.loadStatus === 'error' ? (
        <p role="status" className="mt-3 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
          We couldn&apos;t load your saved addresses. You can type one below, or{' '}
          <button type="button" onClick={d.retry} className="min-h-[44px] font-semibold text-tan-dark underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan">
            try again
          </button>
          .
        </p>
      ) : null}

      {signedIn && d.addresses.length > 0 ? (
        <Button variant="ghost" className="mt-2" onClick={d.cancelNew}>
          Use a saved address
        </Button>
      ) : null}

      {!signedIn ? (
        <p className="mt-2 text-sm">
          <Link href="/login?next=/shop" className="inline-flex min-h-[44px] items-center font-semibold text-tan-dark underline">
            Have an account? Sign in to use saved addresses and Beanies
          </Link>
        </p>
      ) : null}

      {canSave ? (
        <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-3 text-sm font-semibold text-charcoal">
          <input
            type="checkbox"
            checked={d.saveToAccount}
            onChange={(e) => d.setSaveToAccount(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-tan-dark"
          />
          Save this address to my account
        </label>
      ) : null}

      <div className="mt-4">
        <AddressForm
          idPrefix={ADDRESS_ID_PREFIX}
          value={d.form}
          onChange={d.patchForm}
          errors={d.fieldError}
          withEmail
          withLabel={canSave && d.saveToAccount}
          labelValue={d.label}
          onLabelChange={d.setLabel}
        />
      </div>

      <LocationPin
        value={d.pin}
        onChange={(loc) => {
          d.setPin(loc);
          d.setPinError(null);
        }}
        error={d.pinError ?? undefined}
      />
    </section>
  );
}
