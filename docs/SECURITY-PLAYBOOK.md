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

## Attendance & payroll invariants (Phase 5)

These guard a surface where a bug costs someone their pay or leaks their location.
They are **review rules, not scanner rules** — the scanner cannot see most of them —
so they apply to any PR touching `app/api/attendance/**`, `app/api/payroll/**`,
`lib/attendance/**`, or `lib/payroll/**`. Spec: `docs/PHASE-5-SPEC.md §9`.

### A-1 — the punch time must come from the database (CRITICAL)
**Meaning:** a route sets `clock_in_at` / `clock_out_at` from a request body, a
client-supplied ISO string, or the Node process clock instead of the DB's `now()`.
**Why:** a phone's clock is attacker-controlled. If the client can name the time, the
whole attendance record is fiction.
**Fix:** let the column default (`default now()`) supply it, or set it in SQL. A
client-supplied time field is **ignored, not validated** — do not "sanity check" it
and then trust it.

### A-2 — the geofence verdict must be computed server-side (CRITICAL)
**Meaning:** a route reads `in_range`, `distance_m`, or any pass/fail signal from the
request body.
**Fix:** the client sends **only** raw readings (`lat`, `lng`, `accuracy_m`,
`fix_age_ms`). The server computes distance via `lib/attendance/geofence.ts` and
decides. If a verdict field arrives from the client, drop it.

### A-3 — the geofence configuration must never reach the client (CRITICAL)
**Meaning:** a response, a Server Component prop, or a public route exposes
`geofence_radius_m`, `store_lat/lng`, `max_accuracy_m`, or any `attendance_settings`
row to a staff session.
**Why:** knowing the radius is most of what you need to fake being inside it.
**Fix:** return only accept/refuse and the staffer's own distance. `attendance_settings`
has **no** staff-readable RLS policy; it is service-role only.

### A-4 — clocking in/out must NOT be `hasPermission()`-gated (CRITICAL)
**Meaning:** the punch route calls `hasPermission(user, 'attendance_punch')` or any
new key.
**Why:** `hasPermission()` fails **closed to manager** for any key whose
`role_permissions` row is missing (`lib/permissions.ts`). A missing seed row would
therefore stop the entire team from marking attendance. Phase 4's TAB-1 hit exactly
this trap and deliberately reused an existing key.
**Fix:** gate punching on a valid staff session only (`getStaffOrOwner()`). Only
`attendance_edit` and `attendance_approve` are matrix keys — and both must be seeded
in the migration **and** added to `KNOWN_PERMISSION_KEYS` + `DEFAULT_MIN_ROLE` + the
`PermissionKey` union in the same PR.

### A-5 — one staffer must not read another's attendance (CRITICAL)
**Meaning:** an attendance read route filters by a client-supplied `user_id`, or the
RLS policy is broader than `auth.uid() = user_id`.
**Fix:** RLS restricts staff to their own rows, and the route re-checks rather than
trusting RLS alone. `staff_employment` and `payroll_*` are **not staff-readable at
all** — salary is owner-only, including one's own, in this phase. Every PR touching
these gets an explicit RLS assertion in its tests.

### A-6 — payroll money must be integer paise (CRITICAL)
**Meaning:** a float, a `parseFloat`, or a `toFixed` appears in a pay calculation.
**Fix:** all intermediate maths in integer paise, rounded **once** (half-up) to whole
₹ at `net_pay_inr`. The standing assertion: perfect attendance nets **exactly** the
monthly salary — a rounding rule that leaks ₹1 is a bug, not a preference.

### A-7 — a finalized payroll run is immutable (WARN → treat as high)
**Meaning:** an attendance edit, a rule change, or a salary change can alter a run
already marked `finalized`.
**Fix:** refuse the edit and point at the run. Reversal is a recorded action with a
reason — never a delete, never an in-place recompute. `payroll_runs.rules_snapshot`
freezes the rule set and rate that were actually used.

### A-8 — the auto-close cron must fail closed (CRITICAL)
Same shape as **C-4**. Unset `CRON_SECRET` → the endpoint is disabled (401), never
runnable by anyone. The job must also be idempotent: running it twice must not
re-close a session or double-flag it.

### A-9 — CSV export must be formula-injection safe (WARN)
**Meaning:** a payroll export writes a field beginning `=`, `+`, `-`, or `@` unescaped.
**Fix:** prefix such fields with `'` (or wrap and escape) before writing. Staff names
are attacker-influenced text that lands in the owner's Excel.

---

## Device & operator invariants (Phase 6)

These guard the layer added by DEV-2/DEV-3 (and extended by PIN-1..5): a machine
identity that lives in a long-lived cookie. The danger of that shape is not the
cookie leaking — it is the cookie quietly becoming a credential. Apply to any PR
touching `lib/api/device.ts`, `lib/api/deviceCookie.ts`, `app/api/device/**`,
`app/api/owner/devices/**`. Spec: `docs/PHASE-6-SPEC.md §5`.

### D-1 — a device cookie must never authorise anything (CRITICAL)
**Meaning:** a route treats `getEnrolledDevice()` returning non-null as permission to
read or write. Any gate of the shape "if the request comes from a known device, allow
it".
**Why:** the cookie is a year-long bearer secret sitting in a browser profile on a
machine several people use and nobody logs out of. It answers "which till is this",
not "who is allowed to do this". Authority comes from a staff session, or (PIN-3) from
an operator who entered a PIN on this device — never from the device alone.
**Fix:** gate on `getStaffUser()` / `getOwnerUser()` / `getCounterActor()` first, and
read the device only after that has passed. `/api/device/context` is the reference
shape: staff-gated, then device-aware.

### D-2 — the device secret must never be readable (CRITICAL)
**Meaning:** `token_hash` appears in a `select`, a response body, a Server Component
prop, or a log line; or `pos_devices` gains an RLS policy.
**Why:** the qr_token lesson (Phase-3 §11) — a secret that can be read back is a secret
that leaks through some future `select *`. The plaintext token exists for exactly one
HTTP response and is never stored at all.
**Fix:** every read goes through `DEVICE_COLUMNS`, which omits `token_hash` by
construction; the only query allowed to mention it filters BY it. `pos_devices` keeps
RLS enabled with **no policies** (service-role only), asserted by `verify:db`.

### D-3 — revocation must take effect on the next request (CRITICAL)
**Meaning:** a device lookup omits `revoked_at is null`, or a resolved device is cached
across requests (module scope, `unstable_cache`, a cookie carrying settings rather than
just the secret).
**Why:** revoke is the owner's answer to a machine that walked out of the building. A
kill switch with a lag is not a kill switch.
**Fix:** resolve the device from the row on every request; the cookie carries the secret
and nothing else. Re-enrolling issues a fresh secret rather than reviving the old row —
there is no un-revoke.

### D-4 — a device default must never become a lock (WARN)
**Meaning:** a per-device setting is read with `||` instead of `??`, or the POS applies
a device default over a choice a person already made.
**Why:** `false` is an answer ("this stand never prints"), and `||` reads it as an
absence — the event stand prints KOTs it has no kitchen for. And a default that
overwrites a staffer's tap mid-order is the same class of bug as FLOW-1's payment
takeover: the machine arguing with the person using it.
**Fix:** resolve through `lib/pos/deviceSettings.ts` (`??` throughout, unit-tested for
the false case), and seed a control only when the person has not already set it.
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
3. `npm run verify:db` → `RESULT: PASS`. This probes the **live** database with the
   anon key and is the only check that proves RLS, CHECK constraints and triggers are
   actually deployed — the vitest suite mocks Supabase and is blind to all of it.
   A **SKIPPED** probe is not a pass; use `--strict` for a gate that refuses to pass
   on unproven ground. (`scripts/verify-security-migrations.sql` is the older, weaker
   SQL-only version of this check.)
4. Env set: `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_ID/SECRET`,
   `RAZORPAY_WEBHOOK_SECRET`, `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`.
5. Vercel Cron points at `/api/cron/expire-orders`.

---

## Extending the scanner

When a review finds a **new** class of bug, add a rule to `scripts/security-scan.sh`
(a labelled grep + a `crit`/`warn` call) and a fix template here. That is what keeps
the cheap-model loop accurate over time: the model's accuracy comes from the rules
being explicit, not from the model being clever.
