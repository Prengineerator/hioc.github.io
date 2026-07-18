# HIOC Security Playbook (for automated / cheap-model review)

This playbook lets a **low-cost model** (Haiku-class) run a security pass and fix
findings at **95–98% accuracy**, because it removes judgement: the model runs one
deterministic script, reads labelled output, and applies a fixed fix template per
rule id. It does **not** free-read the codebase looking for vibes.

> Golden rule for the automated reviewer: **only act on what `security-scan.sh`
> prints.** Do not invent findings. Do not "improve" unrelated code. If a WARN is
> an intentional public route, say so and stop — do not force a fix.

---

## The loop (run this exactly)

```bash
# 1. Static scan — deterministic, no judgement.
bash scripts/security-scan.sh          # exits 1 if any CRITICAL

# 2. Typecheck + tests must stay green after any fix.
npx tsc --noEmit
npm test
```

- **CRITICAL** → must be fixed before deploy. Apply the matching fix template below.
- **WARN** → review against the "intentional?" note. Fix only if it is a real gap.
- **PASS, 0 findings** → done. Report "scan clean, tsc clean, N tests pass."

A fix is only complete when **all three** are green: scan (no new criticals),
`tsc --noEmit`, and `npm test`.

---

## Rule reference + fix templates

Each rule maps to a copy-paste fix. The model should change **only** the file the
scanner named, at the pattern shown.

### C-1 — service-role key in a client component (CRITICAL)
**Meaning:** a `'use client'` file imports `createAdminSupabaseClient`, which would
ship the service-role key to the browser.
**Fix:** move all admin-client usage out of the client file into a Route Handler
(`app/api/.../route.ts`) or a Server Component, and have the client call that route.
Never add `'use client'` to a file that imports the admin client.

### C-2 — auth route missing rate limit (WARN → treat as high)
**Meaning:** a POST handler under `app/api/auth/**` has no `rateLimitOk()`.
**Fix template** (place after input validation, before the supabase client is created):
```ts
import { rateLimitOk, clientIp } from '@/lib/api/rateLimit';
// ...
if (!(await rateLimitOk(`<action>:${email.trim().toLowerCase()}:${clientIp(request)}`, MAX, WINDOW_SECS))) {
  return errorResponse(429, 'Too many attempts. Please wait a few minutes and try again.');
}
```
Budgets: login `10 / 600`, signup `5 / 3600`, OTP request `5 / 600`, OTP verify `10 / 600`.
`logout` is exempt (no credential surface).

### C-3 — admin-client route with no recognised gate (WARN)
**Meaning:** a route uses the service-role client without `getStaffUser` /
`getOwnerUser` / `getManagerUser` / `getAuthUser` / `getStaffOrOwner` / a
`CRON_SECRET` check / an `isUuid()` opaque-id lookup / a `verifyOtp()` success.
**Fix:** add the correct gate for the route's sensitivity. Staff data →
`getStaffUser()`; refunds/coupons → `getManagerUser()`; owner dashboard →
`getOwnerUser()`; a public-by-opaque-id route must at least `isUuid()`-validate the
id and do a single-row lookup (never a listing).
**If intentionally public** (e.g. `GET /api/orders/[id]`): leave it, and note "public
by opaque UUID — intentional (see S6)."

### C-4 — fail-open secret check (CRITICAL)
**Meaning:** `if (secret) { ...check... }` skips the check when the secret is unset.
**Fix:**
```ts
const secret = process.env.SOME_SECRET;
if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
  return errorResponse(401, 'Unauthorized');
}
```

### C-5 — getSession() used for authorization (WARN)
**Fix:** replace `supabase.auth.getSession()` with `supabase.auth.getUser()` for any
decision that grants access. `getUser()` re-validates the JWT server-side.

### C-6 — XSS / eval sink (CRITICAL)
**Fix:** remove `dangerouslySetInnerHTML` / `eval` / `new Function`. Render text as
React children (auto-escaped). If HTML is truly required, sanitize server-side first.

### C-7 — string-built SQL (WARN)
**Fix:** never interpolate untrusted input into a SQL string. Use the supabase-js
query builder (`.eq()`, `.in()`, `.rpc(name, params)`), which parameterizes.

### C-8 — committed secret (CRITICAL)
**Fix:** remove the literal, move it to an env var, and `git rm --cached` any tracked
`.env*.local`. Rotate the exposed secret.

---

## When the scan can't decide (escalate, don't guess)

If a WARN is ambiguous (is this route meant to be public?), the cheap model should
**stop and escalate** rather than force a change: leave a one-line note
`NEEDS-HUMAN: <file> <rule> <question>` and move on. Escalating beats a wrong fix —
that is how the 95–98% band is held. A senior model / human resolves the residual
2–5%.

---

## Deploy gate (must pass before production)

1. `bash scripts/security-scan.sh` → PASS, 0 CRITICAL.
2. `npx tsc --noEmit` clean, `npm test` green.
3. In Supabase, run `scripts/verify-security-migrations.sql` → every row `ok = true`.
4. Env set: `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_ID/SECRET`,
   `RAZORPAY_WEBHOOK_SECRET`, `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`.
5. Vercel Cron points at `/api/cron/expire-orders`.

---

## Extending the scanner

When a review finds a **new** class of bug, add a rule to `scripts/security-scan.sh`
(a labelled grep + a `crit`/`warn` call) and a fix template here. That is what keeps
the cheap-model loop accurate over time: the model's accuracy comes from the rules
being explicit, not from the model being clever.
