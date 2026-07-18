# HIOC Phase 2 — Deploy / Setup Runbook

Steps to take the Phase-2 "Value & Retention" code (payments, accounts, loyalty,
promotions, reviews, retention analytics) live. Assumes Phase 1 is applied.

## 1. Apply the database migration

Run `supabase/phase2-migration.sql` in the Supabase SQL editor **after**
`phase1-migration.sql`. Two steps (same reason as Phase 1 — new enum-adjacent
values must commit first):
1. Run **SECTION 1** on its own (it's a no-op placeholder this phase — safe).
2. Run **the rest** (Sections 2–10).

Adds: `orders.user_id`; `payments` + `refunds`; profile fields (name, phone,
phone_verified, marketing_consent, prefs) + `favorites`; `coupons` +
`coupon_redemptions` + `announcements`; `loyalty_accounts` +
`loyalty_transactions` + `loyalty_config` (seeded); `reviews`; the `manager`
role; per-user RLS (customers read their own loyalty/reviews/favorites); and the
retention/payment analytics views. `lib/types.ts` already mirrors it.

## 2. Payment gateway (Razorpay)

Online payment is **off until configured** — checkout stays pay-at-counter and the
online UI is hidden (safe default). To enable (see `.env.local.example`):
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` — API key pair.
- `NEXT_PUBLIC_RAZORPAY_KEY_ID` — public key for the client checkout widget.
- `RAZORPAY_WEBHOOK_SECRET` — HMAC secret for the webhook.
- In the Razorpay dashboard, add a **webhook** → `https://<your-domain>/api/payments/webhook`, events `payment.captured`, `order.paid`, `payment.failed`.

Online orders are created at `placed` / `payment_pending` and only enter the
staff queue (`received`) once the webhook (or the bounded reconcile poll)
confirms capture — failed/abandoned payments never reach staff. Refunds are
manager-gated (`/api/orders/[id]/refund`).

**Gateway activation prerequisite:** the legal pages are live at `/terms`,
`/privacy`, `/refund-cancellation`, `/shipping-delivery`, and `/contact` (footer-
linked on every page). Confirm the business details in `lib/legal.ts` are correct
and enter these URLs in the Razorpay dashboard.

## 3. Phone-OTP login (ACC-1)

Enable the **Phone** auth provider in Supabase (Authentication → Providers) and
configure an SMS sender (Supabase supports Twilio/MessageBird, or your own). The
login page's "Phone Code" tab uses Supabase's native phone OTP.

## 4. Roles

Promote a manager (refund/override powers, FND-5):
```sql
update profiles set role = 'manager' where id = '<auth-user-uuid>';
```
`owner` still has everything; `manager` adds refunds to `staff`.

## 5. Loyalty & promotions config

- Tune earn/redeem rates in the seeded `loyalty_config` row (or via the owner UI):
  `points_per_inr`, `inr_per_point`, `min_redeem_points`, `max_redeem_pct`,
  `points_expiry_days`.
- Create coupons + announcements from **/owner/promotions**; moderate reviews at
  **/owner/reviews**.

## Verify

- `npx tsc --noEmit` clean · `npm run build` succeeds · `npm test` green (36).
- Logged-in order → pay online (test key) → webhook flips it to `received` →
  complete → points earned (Rewards page) → refund from staff modal (as manager)
  → `payment_status` = refunded. Owner sees it under /owner/payments, /customers,
  /promotions, /reviews.
