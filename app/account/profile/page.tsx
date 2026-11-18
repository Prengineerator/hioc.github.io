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
//
// Email works the same way: `updateUser({ email })` + `verifyOtp({ type:
// 'email_change' })` adds a verified email to the SAME account (typically a
// WhatsApp-code login that has none), so orders placed with that email —
// and bills sent to it — join this account (lib/account/history.ts). Needs
// Supabase's "Change Email Address" template to show {{ .Token }}.

import { useEffect, useState, type FormEvent } from 'react';
import { createClient } from '@/lib/supabase';
import { normalizeIndianMobile } from '@/lib/phone';
import { normalizeEmail } from '@/lib/email';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { OrderType } from '@/lib/types';

interface MeResponse {
  name: string;
  phone: string;
  phone_verified: boolean;
  marketing_consent: boolean;
  prefs: { default_order_type?: OrderType; veg_only?: boolean };
  date_of_birth?: string | null;
  date_of_anniversary?: string | null;
  // GET-only extras (a PATCH response omits them — merged, never replaced).
  email?: string;
  email_verified?: boolean;
  prefill?: { name?: string; email?: string };
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
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [dateOfAnniversary, setDateOfAnniversary] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveErr, setSaveErr] = useState('');

  // Phone-change sub-flow.
  const [phoneStep, setPhoneStep] = useState<'idle' | 'entering' | 'code'>('idle');
  const [newPhone, setNewPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneErr, setPhoneErr] = useState('');

  // Email-link sub-flow (same shape as the phone one above).
  const [emailStep, setEmailStep] = useState<'idle' | 'entering' | 'code'>('idle');
  const [newEmail, setNewEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailErr, setEmailErr] = useState('');
  const [emailMsg, setEmailMsg] = useState('');

  // PATCH responses carry only the stable profile shape; keep the GET extras.
  const mergeMe = (data: MeResponse) => setMe((prev) => ({ ...(prev ?? {}), ...data }));

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/account/me', { cache: 'no-store' });
        if (!res.ok) return;
        const data: MeResponse = await res.json();
        setMe(data);
        // A WhatsApp-code login starts with no profile name — offer the name
        // from their last order instead of an empty box.
        setName(data.name || data.prefill?.name || '');
        setDefaultOrderType(data.prefs?.default_order_type ?? 'takeaway');
        setVegOnly(Boolean(data.prefs?.veg_only));
        setMarketingConsent(data.marketing_consent);
        setDateOfBirth(data.date_of_birth || '');
        setDateOfAnniversary(data.date_of_anniversary || '');
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
      // Validate dates: they must be YYYY-MM-DD format or empty, and birthdays can't be in the future
      const today = new Date().toISOString().split('T')[0];

      if (dateOfBirth && dateOfBirth > today) {
        setSaveErr('Birth date cannot be in the future.');
        setSaving(false);
        return;
      }

      const res = await fetch('/api/account/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          default_order_type: defaultOrderType,
          veg_only: vegOnly,
          marketing_consent: marketingConsent,
          date_of_birth: dateOfBirth || null,
          date_of_anniversary: dateOfAnniversary || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveErr(data.error ?? 'Could not save changes.');
        return;
      }
      mergeMe(data);
      setSaveMsg('Saved.');
    } catch {
      setSaveErr('No connection. Check your internet and try again.');
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
        mergeMe(data);
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

  async function handleEmailRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEmailErr('');
    setEmailMsg('');
    const normalized = normalizeEmail(newEmail);
    if (!normalized) {
      setEmailErr('Enter a valid email address.');
      return;
    }
    setEmailBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ email: normalized });
      if (error) {
        setEmailErr(
          /already|registered|exists/i.test(error.message)
            ? 'This email already has its own login. Log in with it instead, or use a different email.'
            : error.message,
        );
        return;
      }
      setEmailStep('code');
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleEmailVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEmailErr('');
    const normalized = normalizeEmail(newEmail);
    if (!normalized) {
      setEmailErr('Enter a valid email address.');
      return;
    }
    setEmailBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.verifyOtp({
        email: normalized,
        token: emailCode.trim(),
        type: 'email_change',
      });
      if (error) {
        setEmailErr('Invalid or expired code.');
        return;
      }
      // Pull in any past orders placed with this email (best-effort).
      await fetch('/api/account/claim', { method: 'POST' }).catch(() => undefined);
      setMe((prev) => (prev ? { ...prev, email: normalized, email_verified: true } : prev));
      setEmailStep('idle');
      setNewEmail('');
      setEmailCode('');
      setEmailMsg('Email linked. Orders placed with it now show in your order history.');
    } finally {
      setEmailBusy(false);
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
        className="flex flex-col gap-4 rounded-md border border-line bg-cream p-5 shadow-sm"
      >
        <Input
          id="name"
          label="Name"
          type="text"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="!border-muted/80 text-base"
        />

        <Input
          id="dateOfBirth"
          label="Date of birth (optional)"
          type="date"
          autoComplete="bday"
          value={dateOfBirth}
          onChange={(e) => setDateOfBirth(e.target.value)}
          className="!border-muted/80 text-base"
        />

        <Input
          id="dateOfAnniversary"
          label="Anniversary date (optional)"
          type="date"
          value={dateOfAnniversary}
          onChange={(e) => setDateOfAnniversary(e.target.value)}
          className="!border-muted/80 text-base"
        />

        <Select
          id="orderType"
          label="Default order type"
          value={defaultOrderType}
          onChange={(e) => setDefaultOrderType(e.target.value as OrderType)}
          options={(Object.keys(ORDER_TYPE_LABEL) as OrderType[]).map((t) => ({ value: t, label: ORDER_TYPE_LABEL[t] }))}
          className="!border-muted/80 text-base"
        />

        <label className="flex min-h-[44px] items-center gap-3 text-base text-charcoal">
          <input
            type="checkbox"
            checked={vegOnly}
            onChange={(e) => setVegOnly(e.target.checked)}
            className="h-5 w-5 accent-tan-dark"
          />
          Show vegetarian items only
        </label>

        <label className="flex min-h-[44px] items-center gap-3 text-base text-charcoal">
          <input
            type="checkbox"
            checked={marketingConsent}
            onChange={(e) => setMarketingConsent(e.target.checked)}
            className="h-5 w-5 accent-tan-dark"
          />
          Send me offers and updates (you can opt out anytime)
        </label>

        {saveErr ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {saveErr}
          </p>
        ) : null}
        {saveMsg ? (
          <p role="status" className="text-sm font-semibold text-green-700">
            {saveMsg}
          </p>
        ) : null}

        <Button type="submit" size="lg" fullWidth loading={saving} className="mt-2">
          {saving ? 'Saving' : 'Save changes'}
        </Button>
      </form>

      <div className="rounded-md border border-line bg-cream p-5 shadow-sm">
        <h2 className="font-semibold text-charcoal">Phone number</h2>
        <p className="mt-1 text-sm text-muted">
          {me?.phone ? (
            <>
              {me.phone}{' '}
              {me.phone_verified ? (
                <span className="font-semibold text-green-700">Verified</span>
              ) : (
                <span className="font-semibold text-tan-dark">Not verified</span>
              )}
            </>
          ) : (
            'No phone on file yet.'
          )}
        </p>

        {phoneStep === 'idle' ? (
          <button
            type="button"
            onClick={() => setPhoneStep('entering')}
            className="mt-3 inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline"
          >
            {me?.phone ? 'Change phone number' : 'Add a phone number'}
          </button>
        ) : null}

        {phoneStep === 'entering' ? (
          <form onSubmit={handlePhoneRequest} className="mt-3 flex flex-col gap-3">
            <Input
              label="New mobile number (10 digits)"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              required
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="98765 43210"
              className="!border-muted/80 text-base"
            />
            {phoneErr ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {phoneErr}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={phoneBusy}
                className="min-h-[44px] rounded-md bg-tan-dark px-4 py-2 text-sm font-semibold text-cream transition-colors hover:bg-tan-darker disabled:opacity-60"
              >
                {phoneBusy ? 'Sending…' : 'Send code'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPhoneStep('idle');
                  setPhoneErr('');
                }}
                className="min-h-[44px] rounded-md border border-muted/80 px-4 py-2 text-sm font-semibold text-charcoal"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {phoneStep === 'code' ? (
          <form onSubmit={handlePhoneVerify} className="mt-3 flex flex-col gap-3">
            <Input
              label="6-digit code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              value={phoneCode}
              onChange={(e) => setPhoneCode(e.target.value)}
              placeholder="123456"
              className="!border-muted/80 text-base"
            />
            {phoneErr ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {phoneErr}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={phoneBusy}
                className="min-h-[44px] rounded-md bg-tan-dark px-4 py-2 text-sm font-semibold text-cream transition-colors hover:bg-tan-darker disabled:opacity-60"
              >
                {phoneBusy ? 'Verifying…' : 'Verify'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPhoneStep('idle');
                  setPhoneErr('');
                }}
                className="min-h-[44px] rounded-md border border-muted/80 px-4 py-2 text-sm font-semibold text-charcoal"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </div>

      <div className="rounded-md border border-line bg-cream p-5 shadow-sm">
        <h2 className="font-semibold text-charcoal">Email</h2>
        <p className="mt-1 text-sm text-muted">
          {me?.email ? (
            <>
              {me.email}{' '}
              {me.email_verified ? (
                <span className="font-semibold text-green-700">Verified</span>
              ) : (
                <span className="font-semibold text-tan-dark">Not verified</span>
              )}
            </>
          ) : (
            'No email linked yet. Link one to see orders you placed with it and get bills by email.'
          )}
        </p>
        <p role="status" className="mt-2 text-sm font-semibold text-green-700">
          {emailMsg}
        </p>

        {emailStep === 'idle' ? (
          <button
            type="button"
            onClick={() => {
              setEmailStep('entering');
              setEmailMsg('');
            }}
            className="mt-3 inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline"
          >
            {me?.email ? 'Change email' : 'Link an email'}
          </button>
        ) : null}

        {emailStep === 'entering' ? (
          <form onSubmit={handleEmailRequest} className="mt-3 flex flex-col gap-3">
            <Input
              label="Email address"
              type="email"
              autoComplete="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="you@example.com"
              className="!border-muted/80 text-base"
            />
            {emailErr ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {emailErr}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={emailBusy}
                className="min-h-[44px] rounded-md bg-tan-dark px-4 py-2 text-sm font-semibold text-cream transition-colors hover:bg-tan-darker disabled:opacity-60"
              >
                {emailBusy ? 'Sending…' : 'Send code'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEmailStep('idle');
                  setEmailErr('');
                }}
                className="min-h-[44px] rounded-md border border-muted/80 px-4 py-2 text-sm font-semibold text-charcoal"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {emailStep === 'code' ? (
          <form onSubmit={handleEmailVerify} className="mt-3 flex flex-col gap-3">
            <p className="text-sm text-charcoal">
              Enter the 6-digit code we emailed to <span className="font-bold">{newEmail}</span>.
            </p>
            <Input
              label="6-digit code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value)}
              placeholder="123456"
              className="!border-muted/80 text-base"
            />
            {emailErr ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {emailErr}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={emailBusy}
                className="min-h-[44px] rounded-md bg-tan-dark px-4 py-2 text-sm font-semibold text-cream transition-colors hover:bg-tan-darker disabled:opacity-60"
              >
                {emailBusy ? 'Verifying…' : 'Verify'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEmailStep('idle');
                  setEmailErr('');
                }}
                className="min-h-[44px] rounded-md border border-muted/80 px-4 py-2 text-sm font-semibold text-charcoal"
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
