'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart/CartContext';
import { normalizeIndianMobile } from '@/lib/phone';

const ASAP_LABEL = 'ASAP (15-20 min)';

export function CheckoutForm() {
  const router = useRouter();
  const { items, clearCart } = useCart();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [pickupOption, setPickupOption] = useState<'asap' | 'custom'>('asap');
  const [customTime, setCustomTime] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  function validatePhone(value: string): boolean {
    const ok = normalizeIndianMobile(value) !== null;
    setPhoneError(
      ok
        ? null
        : 'Please enter a valid 10-digit Indian mobile number (e.g. 98765 43210).',
    );
    return ok;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError(null);

    const phoneOk = validatePhone(phone);
    if (!phoneOk) return;

    const pickup_time = pickupOption === 'asap' ? ASAP_LABEL : customTime;
    if (pickupOption === 'custom' && customTime.trim().length === 0) {
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: name,
          customer_phone: phone,
          pickup_time,
          notes,
          items: items.map((i) => ({
            menu_item_id: i.menuItemId,
            variant_id: i.variantId,
            quantity: i.qty,
            addon_option_ids: i.addons.map((a) => a.optionId),
          })),
        }),
      });

      if (res.status === 201) {
        const data = await res.json();
        clearCart();
        router.push(`/order-confirmation/${data.order.id}`);
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
          Something went wrong — {serverError}. Please try again.
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
          <label htmlFor="pickup" className="mb-1 block text-sm font-bold text-charcoal">
            Pickup Time
          </label>
          <select
            id="pickup"
            value={pickupOption}
            onChange={(e) =>
              setPickupOption(e.target.value === 'asap' ? 'asap' : 'custom')
            }
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          >
            <option value="asap">{ASAP_LABEL}</option>
            <option value="custom">Choose a time</option>
          </select>
          {pickupOption === 'custom' ? (
            <input
              type="text"
              required
              value={customTime}
              onChange={(e) => setCustomTime(e.target.value)}
              placeholder="e.g. 6:30 PM"
              aria-label="Pickup time"
              className="mt-2 w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
          ) : null}
        </div>

        <div>
          <label htmlFor="notes" className="mb-1 block text-sm font-bold text-charcoal">
            Notes (optional)
          </label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any special requests? e.g. no sugar, extra chocolate"
            rows={3}
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          />
        </div>

        <div className="rounded-md bg-[#f6efe9] px-4 py-3 text-sm text-charcoal">
          Pay at the counter on pickup — no online payment required.
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Placing Order…' : 'Place Order'}
        </button>
      </form>
    </div>
  );
}
