'use client';

// Saved profile & preferences (ACC-3): name, phone (re-verify on change),
// default order-type, veg preference, and marketing consent (DPDP).
// Prefilled from + persisted via GET/PATCH /api/account/me.
//
// Phone changes use Supabase Auth's native `updateUser({ phone }) +
// verifyOtp({ type: 'phone_change' })` flow (client-side, cookie session) —
// this keeps the SAME account/identity rather than the sign-in semantics of
// /api/auth/customer/phone-otp/* (which is for logging IN with a phone,
// ACC-1). Once Supabase confirms the new phone, PATCH /api/account/me
// mirrors it into `profiles.phone`/`phone_verified` (the route only accepts
// a `phone` that already matches the caller's Supabase-Auth-verified phone).

import { useEffect, useState, type FormEvent } from 'react';
import { createClient } from '@/lib/supabase';
import { normalizeIndianMobile } from '@/lib/phone';
import { Spinner } from '@/components/ui/Spinner';
import type { OrderType } from '@/lib/types';

interface MeResponse {
  name: string;
  phone: string;
  phone_verified: boolean;
  marketing_consent: boolean;
  prefs: { default_order_type?: OrderType; veg_only?: boolean };
}

const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  takeaway: 'Takeaway',
  dine_in: 'Dine-in',
  delivery: 'Delivery',
};

export default function ProfilePage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [defaultOrderType, setDefaultOrderType] = useState<OrderType>('takeaway');
  const [vegOnly, setVegOnly] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveErr, setSaveErr] = useState('');

  // Phone-change sub-flow.
  const [phoneStep, setPhoneStep] = useState<'idle' | 'entering' | 'code'>('idle');
  const [newPhone, setNewPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneErr, setPhoneErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/account/me', { cache: 'no-store' });
        if (!res.ok) return;
        const data: MeResponse = await res.json();
        setMe(data);
        setName(data.name);
        setDefaultOrderType(data.prefs?.default_order_type ?? 'takeaway');
        setVegOnly(Boolean(data.prefs?.veg_only));
        setMarketingConsent(data.marketing_consent);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg('');
    setSaveErr('');
    try {
      const res = await fetch('/api/account/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          default_order_type: defaultOrderType,
          veg_only: vegOnly,
          marketing_consent: marketingConsent,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveErr(data.error ?? 'Could not save changes.');
        return;
      }
      setMe(data);
      setSaveMsg('Saved.');
    } catch {
      setSaveErr('Network error — please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handlePhoneRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPhoneErr('');
    const normalized = normalizeIndianMobile(newPhone);
    if (!normalized) {
      setPhoneErr('Enter a valid 10-digit Indian mobile number.');
      return;
    }
    setPhoneBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ phone: `+91${normalized}` });
      if (error) {
        setPhoneErr(error.message);
        return;
      }
      setPhoneStep('code');
    } finally {
      setPhoneBusy(false);
    }
  }

  async function handlePhoneVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPhoneErr('');
    const normalized = normalizeIndianMobile(newPhone);
    if (!normalized) {
      setPhoneErr('Enter a valid 10-digit Indian mobile number.');
      return;
    }
    setPhoneBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.verifyOtp({
        phone: `+91${normalized}`,
        token: phoneCode.trim(),
        type: 'phone_change',
      });
      if (error) {
        setPhoneErr('Invalid or expired code.');
        return;
      }
      const res = await fetch('/api/account/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: `+91${normalized}` }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMe(data);
        setPhoneStep('idle');
        setNewPhone('');
        setPhoneCode('');
      } else {
        setPhoneErr(data.error ?? 'Verified, but could not update your profile.');
      }
    } finally {
      setPhoneBusy(false);
    }
  }

  if (loading) {
    return <Spinner label="Loading your profile…" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-charcoal">Profile</h1>

      <form
        onSubmit={handleSave}
        className="flex flex-col gap-4 rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm"
      >
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
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          />
        </div>

        <div>
          <label htmlFor="orderType" className="mb-1 block text-sm font-bold text-charcoal">
            Default order type
          </label>
          <select
            id="orderType"
            value={defaultOrderType}
            onChange={(e) => setDefaultOrderType(e.target.value as OrderType)}
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          >
            {(Object.keys(ORDER_TYPE_LABEL) as OrderType[]).map((t) => (
              <option key={t} value={t}>
                {ORDER_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 text-sm text-charcoal">
          <input
            type="checkbox"
            checked={vegOnly}
            onChange={(e) => setVegOnly(e.target.checked)}
            className="h-4 w-4 accent-tan"
          />
          Show vegetarian items only
        </label>

        <label className="flex items-center gap-2 text-sm text-charcoal">
          <input
            type="checkbox"
            checked={marketingConsent}
            onChange={(e) => setMarketingConsent(e.target.checked)}
            className="h-4 w-4 accent-tan"
          />
          Send me offers & updates (you can opt out anytime)
        </label>

        {saveErr ? <p className="text-sm text-red-700">{saveErr}</p> : null}
        {saveMsg ? <p className="text-sm text-green-700">{saveMsg}</p> : null}

        <button
          type="submit"
          disabled={saving}
          className="mt-2 w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
        <h2 className="font-bold text-charcoal">Phone number</h2>
        <p className="mt-1 text-sm text-muted">
          {me?.phone ? (
            <>
              {me.phone} {me.phone_verified ? <span className="text-green-700">· Verified</span> : <span className="text-tan">· Unverified</span>}
            </>
          ) : (
            'No phone on file yet.'
          )}
        </p>

        {phoneStep === 'idle' ? (
          <button
            type="button"
            onClick={() => setPhoneStep('entering')}
            className="mt-3 text-sm font-bold text-tan hover:underline"
          >
            {me?.phone ? 'Change phone number' : 'Add a phone number'}
          </button>
        ) : null}

        {phoneStep === 'entering' ? (
          <form onSubmit={handlePhoneRequest} className="mt-3 flex flex-col gap-3">
            <input
              type="tel"
              inputMode="numeric"
              required
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="10-digit mobile number"
              className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
            {phoneErr ? <p className="text-sm text-red-700">{phoneErr}</p> : null}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={phoneBusy}
                className="rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream hover:bg-tan-dark disabled:opacity-60"
              >
                {phoneBusy ? 'Sending…' : 'Send code'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPhoneStep('idle');
                  setPhoneErr('');
                }}
                className="rounded-md border border-[#e5e5e5] px-4 py-2 text-sm font-bold text-charcoal"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {phoneStep === 'code' ? (
          <form onSubmit={handlePhoneVerify} className="mt-3 flex flex-col gap-3">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              required
              value={phoneCode}
              onChange={(e) => setPhoneCode(e.target.value)}
              placeholder="6-digit code"
              className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
            {phoneErr ? <p className="text-sm text-red-700">{phoneErr}</p> : null}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={phoneBusy}
                className="rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream hover:bg-tan-dark disabled:opacity-60"
              >
                {phoneBusy ? 'Verifying…' : 'Verify'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPhoneStep('idle');
                  setPhoneErr('');
                }}
                className="rounded-md border border-[#e5e5e5] px-4 py-2 text-sm font-bold text-charcoal"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
