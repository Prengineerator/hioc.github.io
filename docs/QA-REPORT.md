# HIOC — QA Bug Report

**Branch:** `phase-2-value-retention` · **Date:** 2026-07-18 · **Method:** 4 parallel
read-only QA audits (payments/money, accounts/security, loyalty/promotions,
frontend/integration) + static analysis + read-only Supabase REST probes.

**Build gates — all green:** `tsc` clean · `next build` clean (28 routes) ·
`npm test` 36/36 · `lint` clean (1 pre-existing intentional warning). No broken
links/dead routes; all cross-pillar API contracts verified consistent.

**Severity summary:** 1 Critical (systemic) · 8 High · 13 Medium · 7 Low.
The single Critical is the top priority and is **production-blocking**.

---

## 🔴 CRITICAL

### C1 — RLS policies grant every logged-in customer direct read/write on staff-only tables
**Files:** `supabase/schema.sql:148-180`, `supabase/phase1-migration.sql` (store_settings),
`supabase/phase2-migration.sql:264-293`
**Confirmed independently by 3 of 4 audits.**

Every "staff/owner" RLS policy is written `to authenticated using (true)` /
`with check (true)`. In Supabase, `authenticated` = *any valid session*, not a
role. Phase 1 was safe (only staff had accounts); **Phase 2 phone-OTP login gives
every customer a real `authenticated` JWT**, and the app ships a browser client
with the public anon key (`lib/supabase.ts`). So any signed-in customer can call
PostgREST directly and bypass every Next.js route guard:

| Policy | Table | Customer can… |
|---|---|---|
| `orders_staff_update` (schema.sql:176) | orders | **UPDATE any order** — hijack onto own account (`user_id`), flip `status`/`payment_status`/`total_inr`; bypasses `canTransition`, version guard, notifications, loyalty |
| `orders_staff_read` (schema.sql:175) | orders/order_items | read **all** customers' names, phones, totals |
| `coupons_staff_write/update` (phase2:274-276) | coupons | insert a `FREE100` 100%-off coupon, then redeem it (server trusts the table) |
| `loyalty_config_staff_write` (phase2:288) | loyalty_config | rewrite **global** `inr_per_point`/`points_per_inr` → mass discount fraud |
| `menu_items_*` (schema.sql:148-169) | menu_items etc. | change prices, 86 items, delete items |
| `payments/refunds_staff_read` (phase2:264-265) | payments/refunds | read every customer's payment/refund PII |
| `reviews_staff_update` (phase2:293) | reviews | edit/hide/forge any review + staff_response |
| `announcements_staff_write/update` (phase2:281-282) | announcements | deface homepage banner |
| `store_settings_staff_write` (phase1) | store_settings | change hours/GST/pause |

**Repro:** sign up a customer → in browser console `createClient().from('coupons').insert({code:'FREE100',discount_type:'percent',discount_value:100,active:true})` → use `FREE100` at checkout.
**Fix:** replace every `to authenticated using(true)` staff/owner policy with a
role predicate, e.g. `using (exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('staff','manager','owner')))`, and **drop the blanket
`authenticated` write policies** on orders/coupons/menu/loyalty_config/
announcements/store_settings (those writes are service-role only in the app).
The app-layer route guards are already correct — this is purely an RLS fix (one
SQL patch + re-run on the DB).

---

## 🟠 HIGH

### H1 — Coupon `usage_limit` & loyalty balance are check-then-act (double-spend race)
`lib/promotions/coupons.ts:99-137`, `lib/loyalty/ledger.ts:72-121,198-240`, `app/api/orders/route.ts:341-388`
Validation `count()`s / sums, then a separate later `insert` writes the redemption —
no `FOR UPDATE`/serializable tx/RPC. Two concurrent checkouts can both pass a
`usage_limit=1` coupon or both redeem the same points (ledger goes negative). The
`coupons.ts` header comment claims this is done atomically — it isn't.
**Fix:** move check+write into a single Postgres function (`SELECT … FOR UPDATE` /
`UPDATE … WHERE … RETURNING`) called via `.rpc()`.

### H2 — Payment retry can mint multiple gateway intents → double-charge
`app/api/payments/[orderId]/status/route.ts:95-108`, `lib/payments/gateway.ts:63-103`
`retry` only blocks when already `paid`; it doesn't cancel/reuse an existing
`payment_pending` row, and `createPaymentIntent` always mints a fresh Razorpay
order. Two tabs / double-click → two intents; if both are paid, both webhooks mark
`paid` (idempotency keyed per `gateway_order_id`, not per HIOC order) → customer
charged twice, undetected. **Fix:** reuse/cancel any open pending payment before
minting; or a partial-unique constraint of ≤1 pending payment per order.

### H3 — Customer self-cancel doesn't reverse loyalty points or flag refund
`app/api/orders/[id]/cancel/route.ts` (whole file)
The staff status route calls `reverseForOrder(id)` on cancel; the customer
self-cancel route does not (and doesn't touch `payment_status`). A customer who
redeemed points (or paid online, then self-cancels while `received`) loses the
points and the paid order is never flagged for refund. **Fix:** call
`reverseForOrder(id)` here too and surface a refund-needed flag.

### H4 — State machine can't cancel `ready` or `placed` orders
`lib/orders/stateMachine.ts:37-52`
No `ready → cancelled` or `placed → cancelled` rule. A ready order nobody collects
can only go to `completed` (wrongly earns loyalty) or stay stuck; an abandoned
`placed` online order can't be cancelled at all. Spec §F1 wants "any non-terminal →
cancelled (manager override)". **Fix:** add those transitions (owner/manager,
reason required).

### H5 — No auto-expiry for abandoned `placed`/`payment_pending` orders (DoD violation)
repo-wide: no cron/scheduled route exists.
Phase-2 DoD: "failed/abandoned online payments … auto-expire." They never enter the
queue (good) but never expire (bad) — they sit forever. **Fix:** a scheduled route
(Vercel Cron) that cancels `placed` orders past a TTL (~30 min) + reaps stray
`payments` rows (needs H4's `placed → cancelled`).

### H6 — Reviews: no ownership check + "one per order" broken (NULL defeats unique)
`app/api/reviews/route.ts:44-92`, `supabase/phase2-migration.sql:210-223`
`POST /api/reviews` only checks `status==='completed'` — anyone who knows a
completed order's UUID can post reviews for it. And `unique(order_id, menu_item_id)`
never fires for the overall-order review (`menu_item_id IS NULL`; SQL NULLs are
distinct), so unlimited overall reviews per order → review-bombing corrupts owner
rating averages. **Fix:** verify caller owns the order (or a per-order review
token); enforce one overall review via a partial unique index
`(order_id) where menu_item_id is null`.

### H7 — `coupon_redemptions` never released on cancel/reject/refund
repo-wide: `coupon_redemptions` is only inserted, never deleted/filtered by status.
`usage_limit`/`per_user_limit` counts include redemptions from cancelled/refunded
orders → a capped coupon can be exhausted by apply-then-cancel (operational bug +
trivial DoS on a promo). **Fix:** exclude redemptions of cancelled/rejected/refunded
orders from the limit counts, or delete the row on reversal.

### H8 — Partial refund fully reverses loyalty (not proportional)
`app/api/orders/[id]/refund/route.ts:148-150`, `lib/loyalty/ledger.ts:242-289`
`reverseForOrder` runs after any refund, full or partial, zeroing the order's whole
earn/redeem history. A ₹10 refund on a ₹1000 order wipes ~1000 earned points.
**Fix:** reverse proportionally to the refunded fraction (or only on full refund).

---

## 🟡 MEDIUM

- **M1** Coupon/announcement/loyalty-config mutation APIs use `getStaffUser()` not `getManagerUser()`/`getOwnerUser()` — plain staff can create 100%-off coupons. FND-5 inconsistency. `app/api/coupons/*`, `announcements/*`, `loyalty/config`.
- **M2** `reviews_own_read` RLS clause `auth.uid() = user_id or auth.uid() is not null` collapses to "any authenticated" and exposes `hidden` reviews. phase2:291. Fix: `… or user_id is null` + filter hidden.
- **M3** Refund route read-then-write race on `refundable` amount (double-click) — only Razorpay saves us. `refund/route.ts:62-92`. Fix: `FOR UPDATE`/constraint `sum(refunds) ≤ payments.amount_inr`.
- **M4** Reconcile treats `authorized` (not captured) as paid; `createPaymentIntent` doesn't set `payment_capture:1`. `lib/payments/reconcile.ts:50`. Fix: only `captured` = paid.
- **M5** No cross-check of captured amount vs `payments.amount_inr` (no defense-in-depth). `reconcile.ts`, `webhook/route.ts`.
- **M6** `PATCH /api/orders/[id]/payment` can overwrite a gateway-verified payment record (no guard vs `method:'online'`). `payment/route.ts:23-66`.
- **M7** Fully-discounted (₹0) orders get `payment_status:'unpaid'` + active "mark payment" buttons → staff may re-charge. `orders/route.ts:399-402`.
- **M8** No "needs refund" queue/flag for staff-cancelled paid orders (PAY-3 "flagged for manager"); only visible if a manager reopens the order. `status/route.ts:139-145`.
- **M9** Percent-coupon >100% cap bypassable on a `PATCH` that omits `discount_type` (never re-fetches current type). `lib/promotions/validate.ts:64-73`. Cosmetic (clamped at checkout) but stores "500% off".
- **M10** No app-level rate limiting on OTP request/verify (SMS-bomb + brute-force risk). `app/api/auth/customer/*otp*`.
- **M11** `/rewards` page built but unlinked from any nav (orphan). Add to account nav.
- **M12** Owner customers table lacks `overflow-x-auto` wrapper → mobile overflow. `app/owner/customers/page.tsx:159`.
- **M13** Three staff modals (`MenuItemFormModal`, `ConfirmDialog`, `OrderDetailModal`) hand-roll `fixed inset-0` instead of the shared portaled `Modal` — no Escape, no scroll-lock, some missing `role="dialog"`.

## ⚪ LOW

- **L1** Staff `OrderCard` is a clickable `<div>` — not keyboard/AT accessible. `components/staff/OrderCard.tsx:38`.
- **L2** Index-as-`key` on removable variant rows → focus can jump after mid-list delete. `MenuItemFormModal.tsx:290`.
- **L3** UI primitives `Input`/`Select`/`Textarea`/`Badge` are unused dead code (forms hand-roll inputs). Wire in or remove.
- **L4** `createPaymentIntent` doesn't set `payment_capture:1` explicitly (see M4).
- **L5** `loyalty_config` PATCH has no upper bound on `max_redeem_pct`/rates → points can be "spent" beyond the clamped applied discount (accounting mismatch). `loyalty/config/route.ts:40`.
- **L6** `LoyaltyConfig` numeric columns likely serialize as strings → Rewards page renders untrimmed "1.000"/"₹0.250". Wrap with `Number(...)`+format. `app/rewards/page.tsx:81`.
- **L7** `v_payment_mix.refunded_inr_total` is a repeated grand total per row (fragile; easy to double-count in a future edit).

---

## 💡 Feature requests (not bugs)

- **FR1 — Staff menu search** (raised by owner): the staff menu (~120 items) had no way to find an item quickly. **Implemented** — a name/category search box on `/staff/menu` now filters the table live.
- **FR2 — Customer menu text search:** the customer menu (`/menu`) has category tabs but no free-text search; worth adding for parity as the menu grows.

## ✅ Verified clean (explicitly checked, no bug)
GST/packaging/discount math (no negative/over-bill); `user_id` always server-derived
(never body-trusted); Razorpay **webhook signature verification** (HMAC over raw
body, constant-time); **version-guard / optimistic concurrency** on status + capture
(no double transition/double event); **idempotent webhook+poll capture**; all
`app/api/account/**` routes (JWT-validated, session-scoped, role never writable,
phone-verified guest-claim); no `getSession()` misuse; `middleware.ts` role gating;
build gates; cross-pillar API contracts; the 3 recent fixes (Modal portal, store
badge refresh, inline sold-out buttons) all hold.

---

## Recommended fix order
1. **C1 RLS** (production-blocking security) — one SQL patch, immediately.
2. **H2 double-charge, H1 double-spend, H6 review abuse** — money/abuse.
3. **H3/H4/H5** — cancel/refund/expiry correctness for the online-payment loop.
4. **H7/H8, M1–M10** — promo/refund integrity + hardening.
5. **M11–M13, L1–L7** — UX/a11y/cleanup.
