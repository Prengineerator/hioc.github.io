# OTP / phone verification + WhatsApp marketing link

## Part 1 — Phone OTP: what's built, what's missing

**Good news: the code is already done.** These routes exist and are correct:

- `app/api/auth/customer/phone-otp/request/route.ts` → `supabase.auth.signInWithOtp({ phone })`
- `app/api/auth/customer/phone-otp/verify/route.ts` → `supabase.auth.verifyOtp({ type: 'sms' })`,
  then stamps `profiles.phone` + `phone_verified`.

Both normalize to E.164 (`+91XXXXXXXXXX`), are rate-limited, and never touch `role`.
**The only missing piece is an SMS provider wired into Supabase Auth.** Until that's
configured, `signInWithOtp({ phone })` returns an error and no SMS goes out. No app
code needs to change.

### Provider recommendation (India)

For an Indian café sending OTPs to Indian numbers, **MSG91 is the default choice** —
~₹0.15 per OTP vs ~₹0.45 for Twilio (USD pricing + forex margin), and it has
**pre-registered DLT entities** with all four telcos, so you're not stuck doing
Twilio's manual DLT onboarding.

| Provider | ~Cost/OTP (India) | DLT handling | Supabase support |
|----------|-------------------|--------------|------------------|
| **MSG91** (recommended) | ~₹0.15 | Pre-registered, fast | Via **Send SMS Hook** (small Edge Function) |
| Gupshup | ~₹0.17 | Pre-registered | Via Send SMS Hook |
| Twilio Verify | ~₹0.45 | **You** register DLT (3–7 days) | **Native** (zero custom code) |
| Firebase Phone Auth | bundled/opaque | You handle DLT | N/A (would replace Supabase Auth — don't) |

> **DLT is mandatory** for any commercial/OTP SMS to Indian numbers (TRAI rule).
> You must register a Principal Entity, a sender header (e.g. `HIOCAF`), and the OTP
> message template regardless of provider. MSG91/Gupshup shortcut the telco side.

### Two ways to wire it

**Option A — Twilio, native, zero code (fastest to ship):**
Supabase Dashboard → Authentication → Providers → Phone → enable, choose **Twilio**,
paste Account SID / Auth Token / Message Service SID. Do your own DLT registration
first. Nothing in this repo changes. Pick this if you want it live today and accept
the higher per-SMS cost.

**Option B — MSG91 via Supabase "Send SMS Hook" (recommended for cost):**
Supabase generates the OTP; a hook forwards it to MSG91 for delivery. Steps:

1. **DLT + MSG91:** register your entity/header/template on MSG91, get an `AUTHKEY`
   and the approved OTP template id.
2. **Create the hook** (Supabase Dashboard → Authentication → Hooks → *Send SMS*),
   pointing at a Supabase Edge Function:

```ts
// supabase/functions/send-sms/index.ts  (Deno Edge Function)
import { createHmac } from 'node:crypto';

Deno.serve(async (req) => {
  // Verify the hook signature (secret shown in the Supabase Hooks UI).
  const secret = Deno.env.get('SEND_SMS_HOOK_SECRET')!;
  const payload = await req.text();
  const sig = req.headers.get('x-supabase-signature') ?? '';
  const expected = createHmac('sha256', secret).update(payload).digest('base64');
  if (sig !== expected) return new Response('bad signature', { status: 401 });

  const { user, sms } = JSON.parse(payload);   // sms.otp = the code, user.phone = +91...
  const phone = String(user.phone).replace('+', '');

  const res = await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey: Deno.get('MSG91_AUTHKEY')! },
    body: JSON.stringify({
      template_id: Deno.env.get('MSG91_TEMPLATE_ID'),
      mobile: phone,
      otp: sms.otp,               // use Supabase's OTP so verifyOtp() still matches
    }),
  });
  if (!res.ok) return new Response('sms send failed', { status: 500 });
  return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
});
```

3. Set `MSG91_AUTHKEY`, `MSG91_TEMPLATE_ID`, `SEND_SMS_HOOK_SECRET` as function secrets.
4. Test: `POST /api/auth/customer/phone-otp/request` → SMS arrives →
   `POST /api/auth/customer/phone-otp/verify` → `phone_verified = true`.

> Also run `supabase/2026-07-phone-unique.sql` (review finding S4) so one verified
> number maps to exactly one account.

**Recommendation:** Option A to unblock this week, migrate to Option B (MSG91) before
volume grows — the switch is provider-config only, no app-code change either way.

---

## Part 2 — WhatsApp marketing link (click-to-chat)

No API or WhatsApp Business account needed for a basic marketing link. Format:

```
https://wa.me/<countrycode+number, digits only>?text=<URL-encoded message>
```

- **Number:** country code + number, **no** `+`, spaces, or dashes. India example for
  `+91 98765 43210` → `919876543210`.
- **Message:** URL-encode it (spaces → `%20`).

**Ready-to-use for HIOC** (swap in the café's real WhatsApp number):

```
https://wa.me/919876543210?text=Hi%20HIOC%20Cafe%2C%20I%27d%20like%20to%20place%20an%20order
```

Clicking it opens WhatsApp with that message pre-typed to your number — the customer
just hits send.

### Practical marketing tips
- **QR code:** generate a QR of the `wa.me` link for table tents / posters / bills. A
  scan opens the pre-filled chat.
- **Campaign tracking:** vary the `text=` per channel (e.g. `...order%20(from%20Instagram)`)
  so you can see which channel drove the chat.
- **"Broadcast" marketing** (sending offers *out* to customers) is different: that needs
  the **WhatsApp Business Platform (Cloud API)** with pre-approved message templates and
  explicit opt-in. The `marketing_consent` column already exists on `profiles` for this —
  only message customers who set it true (DPDP compliance). Start with click-to-chat
  (inbound); add the Business API later if you want outbound campaigns.
- **Do not** put the `wa.me` link behind the opaque order UUID or leak phone numbers in
  query strings.

### Optional: add it to the site
A floating WhatsApp button is a plain anchor — no dependency:

```tsx
<a href="https://wa.me/919876543210?text=Hi%20HIOC%20Cafe"
   target="_blank" rel="noopener noreferrer" aria-label="Chat with us on WhatsApp">
  Chat on WhatsApp
</a>
```

Put the number in an env var (`NEXT_PUBLIC_WHATSAPP_NUMBER`) so it's not hard-coded.
