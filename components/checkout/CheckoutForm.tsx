'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart/CartContext';
import { normalizeIndianMobile } from '@/lib/phone';
import { generatePickupSlots } from '@/lib/store/hours';
import type { StoreOpenState } from '@/lib/store/hours';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { MenuItem, OrderType, StoreSettings } from '@/lib/types';

// Takeaway + dine-in for Phase-1. Both are pickup-at-counter flows (dine-in
// just means eating in), so they share the same checkout. 'delivery' stays out
// until Phase-2 adds an address/dispatch flow.
const ORDER_TYPE_OPTIONS: { value: OrderType; label: string }[] = [
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'dine_in', label: 'Dine-in' },
];

export function CheckoutForm({
  settings,
  openState,
}: {
  settings: StoreSettings | null;
  openState: StoreOpenState | null;
}) {
  const router = useRouter();
  const { items, clearCart } = useCart();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [orderType, setOrderType] = useState<OrderType>('takeaway');
  const [slotStart, setSlotStart] = useState<string | null>(null); // null = not yet picked
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [unavailableNames, setUnavailableNames] = useState<string[]>([]);

  const slots = useMemo(
    () => (settings ? generatePickupSlots(settings) : []),
    [settings],
  );

  // Default to the first slot (ASAP) once slots load; re-pick if the
  // previously-selected slot has scrolled out of the list (e.g. it's no
  // longer in the future after a slow checkout).
  useEffect(() => {
    if (slots.length === 0) {
      setSlotStart(null);
      return;
    }
    if (slotStart === null || !slots.some((s) => s.start === slotStart)) {
      setSlotStart(slots[0].start);
    }
  }, [slots, slotStart]);

  // Re-validate cart item availability at checkout (C3): an item can get 86'd
  // between being added to the cart and reaching this page. This is a
  // best-effort UX check — the POST /api/orders call is still the
  // authoritative gate and will reject with a clear error either way.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/menu?includeUnavailable=true')
      .then((res) => res.json())
      .then((data: { items?: MenuItem[] }) => {
        if (cancelled) return;
        const byId = new Map((data.items ?? []).map((i) => [i.id, i]));
        const names: string[] = [];
        for (const line of items) {
          const menuItem = byId.get(line.menuItemId);
          if (!menuItem || !isMenuItemAvailable(menuItem)) {
            names.push(line.name);
          }
        }
        setUnavailableNames(names);
      })
      .catch(() => {
        // Fail open on this best-effort check — the server still validates.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function validatePhone(value: string): boolean {
    const ok = normalizeIndianMobile(value) !== null;
    setPhoneError(
      ok
        ? null
        : 'Please enter a valid 10-digit Indian mobile number (e.g. 98765 43210).',
    );
    return ok;
  }

  const storeAcceptingOrders = !openState || openState.acceptingOrders;
  const canSubmit =
    storeAcceptingOrders && unavailableNames.length === 0 && (slots.length === 0 || slotStart !== null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError(null);

    const phoneOk = validatePhone(phone);
    if (!phoneOk || !canSubmit) return;

    const selectedSlot = slots.find((s) => s.start === slotStart) ?? slots[0];

    setSubmitting(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: name,
          customer_phone: phone,
          order_type: orderType,
          pickup_slot_label: selectedSlot?.label ?? 'ASAP',
          pickup_slot_start:
            selectedSlot && !selectedSlot.isAsap ? selectedSlot.start : undefined,
          notes,
          items: items.map((i) => ({
            menu_item_id: i.menuItemId,
            variant_id: i.variantId,
            quantity: i.qty,
            addon_option_ids: i.addons.map((a) => a.optionId),
            special_instructions: i.specialInstructions,
          })),
        }),
      });

      if (res.status === 201) {
        const data = await res.json();
        clearCart();
        // Redirect to the live order-status page (not just the confirmation
        // page) so the customer can track accept/prep/ready in real time.
        router.push(`/order/${data.order.id}`);
        return;
      }

      const data = await res.json().catch(() => ({ error: 'Unknown error' }));
      setServerError(data.error ?? 'Unknown error');
    } catch {
      setServerError('Network error — please check your connection.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-md border border-[#e5e5e5] bg-cream p-6 shadow-sm">
      <h2 className="mb-4 text-lg font-bold text-charcoal">Your Details</h2>

      {serverError ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-tan bg-[#f6efe9] px-4 py-3 text-sm text-charcoal"
        >
          {serverError}
        </div>
      ) : null}

      {unavailableNames.length > 0 ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-tan bg-[#f6efe9] px-4 py-3 text-sm text-charcoal"
        >
          <p className="font-bold">
            {unavailableNames.join(', ')} {unavailableNames.length === 1 ? 'is' : 'are'} no
            longer available.
          </p>
          <p className="mt-1">Please remove {unavailableNames.length === 1 ? 'it' : 'them'} from your cart to continue.</p>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-bold text-charcoal">
            Name
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Priya Sharma"
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          />
        </div>

        <div>
          <label htmlFor="phone" className="mb-1 block text-sm font-bold text-charcoal">
            Phone
          </label>
          <input
            id="phone"
            type="tel"
            required
            maxLength={16}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={(e) => validatePhone(e.target.value)}
            placeholder="e.g. 98765 43210"
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          />
          {phoneError ? (
            <p className="mt-1 text-sm text-charcoal">{phoneError}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="order-type" className="mb-1 block text-sm font-bold text-charcoal">
            Order Type
          </label>
          <select
            id="order-type"
            value={orderType}
            onChange={(e) => setOrderType(e.target.value as OrderType)}
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          >
            {ORDER_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="pickup" className="mb-1 block text-sm font-bold text-charcoal">
            Pickup Time
          </label>
          {slots.length === 0 ? (
            <p className="text-sm text-muted">
              {settings ? 'No pickup slots available right now.' : 'Loading pickup times…'}
            </p>
          ) : (
            <select
              id="pickup"
              value={slotStart ?? ''}
              onChange={(e) => setSlotStart(e.target.value)}
              className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
            >
              {slots.map((slot) => (
                <option key={slot.start || 'asap'} value={slot.start}>
                  {slot.label}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label htmlFor="notes" className="mb-1 block text-sm font-bold text-charcoal">
            Notes (optional)
          </label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any special requests for the whole order"
            rows={3}
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          />
        </div>

        <div className="rounded-md bg-[#f6efe9] px-4 py-3 text-sm text-charcoal">
          Pay at the counter on pickup — no online payment required.
        </div>

        {/* DPDP transactional-consent notice (F3t/NFR-005). Order updates are
            transactional, not marketing, so no opt-in checkbox is required —
            but we disclose the use of the number clearly at the point of entry. */}
        <p className="text-xs text-muted">
          By placing this order you agree to receive order-status updates (accepted, ready,
          etc.) on this number via WhatsApp/SMS. We use it only for this order — never for
          marketing.
        </p>

        <button
          type="submit"
          disabled={submitting || !canSubmit}
          className="w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting
            ? 'Placing Order…'
            : !storeAcceptingOrders
              ? 'Checkout Unavailable'
              : 'Place Order'}
        </button>
      </form>
    </div>
  );
}
