# HIOC — Principal Security & Code Review (2026-07-18)

**Reviewer:** Principal engineer (independent pass, on top of the existing `QA-REPORT.md`).
**Branch:** `phase-2-value-retention`
**Scope:** all 44 API route handlers, auth/session layer, payments (Razorpay), loyalty/coupons,
Supabase RLS + hardening SQL, cron, file upload, client/server boundary.

## Executive summary

The codebase is in good shape. Money paths compute prices **server-side** (never trust the
client), payments verify the webhook **HMAC over the raw body** with a constant-time compare,
redemption of coupons/points is **atomic under advisory locks**, order writes go exclusively
through the **service-role key** behind route guards, and the C1 RLS hole from the prior QA is
closed by `security-rls-fix.sql`. No service-role key leaks into any `'use client'` file, and
`.env.local` is correctly git-ignored. There are **no SQL-injection or XSS sinks** (no raw query
string building, no `dangerouslySetInnerHTML`).

This review found **1 High, 3 Medium, 3 Low/Informational** issues the prior QA pass did not
cover. The High is a real, exploitable gap.

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| S1 | **High** | No rate limiting on password login & signup | Fix in this batch |
| S2 | Medium | Cron endpoint is public when `CRON_SECRET` is unset (fails open) | Fix in this batch |
| S3 | Medium | Rate limiter & RLS hardening fail **open** and depend on operator-run SQL | Deploy gate + doc |
| S4 | Medium | `profiles.phone` has no uniqueness constraint | Fix in this batch (SQL) |
| S5 | Low | OTP verify brute-force window is generous (defense-in-depth) | Documented |
| S6 | Info | Order UUID is a bearer capability (PII to anyone with the link) | Accepted / documented |
| S7 | Info | Positive confirmations (no key leak, no XSS/SQLi, atomic money) | — |

---

## S1 — No rate limiting on password login & signup (**High**)

**Files:** `app/api/auth/login/route.ts`, `app/api/auth/customer/signup/route.ts`

The OTP routes are throttled via `rateLimitOk(...)` (QA item M10), but the **password** login and
signup routes are not. `POST /api/auth/login` calls `signInWithPassword` with no per-identity /
per-IP throttle.

**Why it matters more here than usual:** every login hits Supabase Auth (GoTrue) *from the Vercel
server*, so GoTrue's built-in per-IP limiting sees only a handful of Vercel egress IPs — it cannot
distinguish an attacker from normal traffic. Our own app-level throttle is therefore the *only*
effective control. Staff/owner accounts (the high-value target — refunds, menu, settings) log in
through exactly this route.

**Attack:** unlimited credential-stuffing / password brute-force against staff/owner emails.

**Fix (applied):** wrap both routes with `rateLimitOk` keyed on `email + IP`, mirroring the OTP
routes. Suggested budgets:
- login: `10` attempts / `600s` per `login:{email}:{ip}` → 429 "Too many attempts."
- signup: `5` / `3600s` per `signup:{email}:{ip}` (also curbs account-spam / email-bombing).

---

## S2 — Cron endpoint is public when `CRON_SECRET` is unset (**Medium**)

**File:** `app/api/cron/expire-orders/route.ts`

```ts
const secret = process.env.CRON_SECRET;
if (secret) {                       // ← fails OPEN when unset
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }
}
```

If `CRON_SECRET` is not configured, the whole auth check is skipped and *anyone* can `GET
/api/cron/expire-orders`. It's a state-changing, service-role endpoint: it cancels every order
sitting at `placed` for >30 min, writes events, reverses loyalty, and broadcasts. An anonymous
caller can force those cancellations and hammer the DB.

**Fix (applied):** fail **closed** — if `CRON_SECRET` is unset, return `401` (endpoint disabled
until configured) rather than running unauthenticated. This is also Vercel's documented cron
pattern.

---

## S3 — Rate limiter & RLS hardening fail **open** and depend on operator-run SQL (**Medium, process**)

**Files:** `lib/api/rateLimit.ts`, `supabase/security-rls-fix.sql`, `supabase/phase2-hardening.sql`

`rateLimitOk` returns `true` (**allow**) whenever the `check_rate_limit` RPC is missing or errors.
That's a deliberate "don't break auth before the SQL is applied" choice — but it means a deploy
where the operator forgot to run `phase2-hardening.sql` has **no rate limiting at all**, silently.
The same operator step (`security-rls-fix.sql`) is what closes the C1 RLS hole. So a forgotten
migration simultaneously removes rate limiting *and* re-opens critical RLS.

**Fix (this batch):** a deploy checklist + a `scripts/verify-security-migrations.sql` probe
(bundled with the playbook) that asserts `is_staff()`, `check_rate_limit`, `try_redeem_coupon`,
`try_redeem_points`, and the `orders_staff_read`/no-update policies all exist. Run it as a
post-deploy gate. The fail-open behavior is retained in code (correct for resilience) but is no
longer *silent* — the gate makes a missing migration a loud, blocking failure.

---

## S4 — `profiles.phone` has no uniqueness constraint (**Medium**)

**File:** `supabase/phase2-migration.sql` (`alter table profiles add column ... phone text default ''`)

Two distinct Supabase Auth accounts can each verify and hold the **same** phone number
(`phone_verified = true`). Guest-order claim (`lib/account/claim.ts`) matches guest orders by
`customer_phone`; with duplicate verified phones the association becomes ambiguous, and the
empty-string default means many rows share `phone = ''`.

**Fix (applied, SQL):** partial unique index so a verified phone belongs to exactly one account:

```sql
create unique index if not exists idx_profiles_phone_verified_unique
  on profiles (phone) where phone_verified = true and phone <> '';
```

The phone-OTP verify route should surface the resulting `23505` as "This number is already linked
to another account."

---

## S5 — OTP verify brute-force window (**Low, defense-in-depth**)

`otp/verify` and `phone-otp/verify` allow `10` attempts / `600s` per `identity + IP` against a
6-digit code. Supabase itself caps verification attempts and expires codes, so this is layered, not
the sole control — acceptable. If SMS cost/abuse becomes a concern, tighten to `5 / 900s` and add a
per-identity (IP-independent) counter so IP rotation doesn't multiply the budget.

## S6 — Order UUID is a bearer capability (**Informational, by design**)

`GET /api/orders/[id]`, `/cancel`, `/payments/[orderId]/status`, and `POST /api/reviews` are gated
only by the unguessable order UUID (guest checkout with no login). Anyone with the link sees the
customer name + phone and can cancel/review. This is an accepted product tradeoff. Keep order links
out of logs/analytics query strings and treat them as secrets (don't render them in shared/SEO
contexts).

## S7 — Positive confirmations

- **No service-role key reaches the client.** No `'use client'` file imports `createAdminSupabaseClient`; owner Server Components that use it are middleware-gated to `role = 'owner'`.
- **No XSS / SQLi sinks.** No `dangerouslySetInnerHTML`, `eval`, or string-built SQL; all DB access is parameterized through supabase-js.
- **Money is trustworthy.** Prices, tax, discounts recomputed server-side; webhook HMAC verified over the raw body with `timingSafeEqual`; refunds capped by both app logic and a DB trigger (`guard_refund_total`); coupon/points redemption atomic under advisory locks.
- **Session checks are correct.** Everything uses `getUser()` (re-validates the JWT), never the unverified `getSession()`.

---

## Operator deploy gate (must be true in production)

1. `supabase/security-rls-fix.sql` applied (closes C1).
2. `supabase/phase2-hardening.sql` applied (rate limiter, atomic redemption, refund guard).
3. `supabase/2026-07-phone-unique.sql` applied (S4).
4. `CRON_SECRET` set **and** the Vercel Cron pointed at `/api/cron/expire-orders`.
5. `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID/SECRET`, `SUPABASE_SERVICE_ROLE_KEY` set.
6. Run `scripts/verify-security-migrations.sql` — all checks must return `true`.
</content>
</invoke>
