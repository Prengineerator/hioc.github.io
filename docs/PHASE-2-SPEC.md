# HIOC Revamp — Phase 2 "Value & Retention" — Detailed Spec

**Companion to:** `docs/REVAMP-REQUIREMENTS.md`, `docs/RICE-PRIORITIZATION.md`, `docs/PHASE-1-SPEC.md`
**Version:** 0.1 (Draft for grooming)
**Date:** 2026-07-17
**Owner:** Product (Senior PM)
**Scope:** The Phase-2 release — three pillars: **Payments**, **Accounts**, **Loyalty & Promotions** — plus the retention analytics that make them measurable. Assumes Phase 1 "Connected Ordering" is live.

---

## 0. Phase-2 goal & definition of done

**Goal:** Once orders flow and customers are notified (Phase 1), Phase 2 makes each order **worth more** and each customer **come back** — take payment online, give people an identity + history + reorder, and reward repeat business.

**Why now:** Phase 1's order state machine already reserves payment sub-states, its notification engine can send receipts/points/promos, and its analytics pipeline can feed customer metrics — so Phase 2 is mostly *building on* those foundations rather than laying new ones.

**Release-level Definition of Done**
- [ ] Online payment (UPI-first + cards) works end-to-end; **pay-at-counter still available** as a choice.
- [ ] Failed/abandoned online payments **never enter the staff queue** and auto-expire.
- [ ] Refunds (full + partial) are processable, **manager-gated**, and reconciled against gateway settlements.
- [ ] Customers can log in with **phone-OTP**, see **order history**, **reorder**, save a profile, and **claim past guest orders** by phone.
- [ ] **Loyalty** points earn & redeem correctly; **coupons** validate and apply; both show in the bill breakup and in owner metrics.
- [ ] **Ratings** are collected after completion; the owner can view and respond.
- [ ] Owner **customer / payment / promo analytics** + **exports** are live.
- [ ] **No card data is ever stored by us** (PCI via hosted gateway flows, XC-032); all new tables RLS-covered.
- [ ] Automated tests for payment webhooks, refund math, and coupon/loyalty calculations.

**Conventions:** Same as Phase-1 spec — AC in Given/When/Then; integer ₹; times UTC-stored, IST-displayed; server/RLS-enforced authorization.

---

## 1. Foundations for Phase 2

### FND-1 — Payment gateway integration (XC-030, XC-032)
**Story:** As the platform, I integrate a hosted payment gateway (UPI-first, e.g. Razorpay) so customers can pay online without us ever touching card data.

**Acceptance criteria**
- **Given** a checkout with "Pay online" chosen, **when** the customer proceeds, **then** a gateway order is created server-side and the customer completes payment via the gateway's hosted/SDK flow (UPI intent/collect, cards, wallets, netbanking).
- **Given** a successful payment, **then** the gateway **webhook** (server-verified signature) marks the order `paid` and transitions it into the staff queue (`received`).
- **Given** a failed/cancelled payment, **then** the order stays `payment_pending` and is **not** shown to staff.
- **Given** the webhook is delayed, **then** a server-side status poll reconciles within a bounded window (no order lost or double-charged).
- **Given** any payment, **then** **no PAN/CVV is stored** by HIOC — only gateway references (XC-032).

**Edge cases:** duplicate webhooks (idempotent by gateway ref), payment success but webhook never arrives (reconciliation poll), customer pays twice (dedupe), partial gateway outage (fall back to pay-at-counter with a clear message).
**Deps:** Phase-1 state machine (payment sub-states), store settings (payment config). **Open Q:** provider + fee structure (§7).

### FND-2 — Refunds & reconciliation (XC-031)
**Story:** As the platform, I can refund paid orders and reconcile what the gateway actually settled.

**Acceptance criteria**
- **Given** a paid order is cancelled/rejected, **when** a manager triggers a refund, **then** a full or partial refund is issued via the gateway, `payment_status` → `refunded`/`partially_refunded`, and a `refunds` record is written.
- **Given** daily settlements, **then** a reconciliation view matches gateway settlement reports to our `payments`/`refunds` and flags mismatches.
- **Given** a refund fails at the gateway, **then** it's retried and surfaced to the manager (never silently lost).

**Edge cases:** partial refund > paid amount (block), refund on a partially-consumed order (manager sets amount), refund after settlement vs before.
**Deps:** FND-1, RBAC manager role (FND-5).

### FND-3 — Promotions / coupon engine (backend for CUS-029, OWN-035)
**Story:** As the platform, I evaluate coupon codes and promotions consistently at checkout and record their cost.

**Acceptance criteria**
- **Given** a coupon code at checkout, **when** applied, **then** the engine validates: active, within date window, min-order met, usage-limit + per-user-limit not exceeded, item/category eligibility — and returns the computed discount or a clear reason it's invalid.
- **Given** a valid coupon, **then** the discount shows in the bill breakup (extends Phase-1 C5) and is snapshotted on the order with a `coupon_redemptions` row.
- **Given** an auto-promotion (e.g. "10% off before noon"), **then** it applies without a code per its rules.

**Edge cases:** stacking rules (default: one coupon per order unless configured), coupon + loyalty redemption together (define precedence), race on last remaining use (atomic decrement).
**Deps:** Phase-1 bill breakup (C5), store settings.

### FND-4 — Loyalty ledger (backend for CUS-067)
**Story:** As the platform, I maintain a points ledger so earning and redeeming are auditable and never drift.

**Acceptance criteria**
- **Given** a completed, paid order by a logged-in customer, **then** points are **earned** per the configured rate and written as a `loyalty_transactions` (earn) row updating the balance.
- **Given** a customer redeems points at checkout, **then** the redemption is validated against balance + rules, converted to a discount, and written as a (redeem) row.
- **Given** any adjustment/expiry, **then** it's an explicit ledger entry — the balance is always the sum of the ledger (no free-floating counter).
- **Given** a refunded/cancelled order, **then** earned points for it are reversed.

**Edge cases:** points expiry, redemption on an order that's later refunded (claw back), concurrency on balance (ledger + row-lock).
**Deps:** Accounts (ACC-1), Phase-1 state machine (earn on `completed`).

### FND-5 — RBAC: manager role + permissions (STF-050, STF-051)
**Story:** As the business, I introduce a `manager` role so sensitive actions (refunds, price changes, comping) aren't available to every staff member.

**Acceptance criteria**
- **Given** the role set from Phase 1 (`customer/staff/owner`), **then** add `manager` (and optionally `cashier`/`kitchen`) with a permission matrix.
- **Given** a refund/cancel-with-refund/discount-override, **when** a plain `staff` attempts it, **then** it's blocked; a `manager`/`owner` is allowed.
- **Given** any gated action, **then** it's attributed in the audit trail (extends Phase-1 events).

**Deps:** Phase-1 RBAC (F3). **Note:** required by FND-2 refunds.

---

## 2. Pillar A — Payments (customer + staff)

### PAY-1 — Online payment at checkout (CUS-041)
**Story:** As a customer, I can pay online (UPI/card/wallet) instead of at the counter, so pickup is faster.

**Acceptance criteria**
- **Given** checkout, **then** I choose **Pay online** or **Pay at counter**; online shows the gateway flow (FND-1).
- **Given** I pay successfully, **then** I land on the live-status page (Phase-1 C1) with the order already `received` and a payment receipt.
- **Given** payment fails, **then** I see a clear retry option and my cart is preserved; the order isn't queued until paid.
- **Given** the bill, **then** it reflects item subtotal, GST, packaging, **coupon discount** (FND-3), **points redemption** (FND-4), and grand total — each a labeled line.

**Edge cases:** back-button mid-payment, app-switch to UPI app and return, session timeout, store closes while paying (block + refund if charged).
**Deps:** FND-1, FND-3, FND-4, Phase-1 C5.

### PAY-2 — Payment status & retry (CUS-042)
**Story:** As a customer, I always know whether my payment went through, and I can retry if it didn't.

**Acceptance criteria**
- **Given** a pending/failed payment, **then** the status page shows the payment state distinctly from the fulfillment state, with a **Retry payment** action.
- **Given** a successful retry, **then** the order proceeds normally; **given** repeated failure, **then** I can switch to pay-at-counter.

**Deps:** PAY-1.

### PAY-3 — Refund from staff/manager (STF-047, STF-007 wiring)
**Story:** As a manager, when I cancel or reject a paid order, I can refund the customer.

**Acceptance criteria**
- **Given** a paid order being cancelled/rejected, **when** a manager confirms, **then** they choose full or partial refund; the refund issues (FND-2) and the customer is **notified** (Phase-1 notification engine) of the refund + reason.
- **Given** a `staff` (non-manager) cancels a paid order, **then** it's flagged for manager refund approval rather than auto-refunded.

**Deps:** FND-2, FND-5, Phase-1 state machine + notifications.

### PAY-4 — Wallet / prepaid credits (CUS-043) — *Could (stretch)*
**Story:** As a frequent customer, I can preload a wallet and pay from it.
**AC (if included):** load via gateway → `wallet_transactions` credit; pay from balance at checkout; refunds can go to wallet (instant) or source. **Deps:** FND-1, ACC-1, FND-4 (shared ledger pattern). *Recommend deferring unless demand is clear.*

---

## 3. Pillar B — Accounts

### ACC-1 — Phone-OTP authentication (CUS-061, XC-004)
**Story:** As a customer, I log in with my phone number and an OTP — the most natural flow in India.

**Acceptance criteria**
- **Given** the login screen, **when** I enter my mobile number, **then** I receive an OTP (via the Phase-1 SMS/WhatsApp channel) and logging in verifies the number.
- **Given** a verified login, **then** my `profiles`/customer record stores the verified phone; existing email OTP/password (Phase-1 CUS-060) still works.
- **Given** I'm logged in, **then** checkout pre-fills my name + phone.

**Edge cases:** OTP rate-limiting/abuse, number change, same phone as a prior guest order (→ ACC-4 claim).
**Deps:** Phase-1 notification channel.

### ACC-2 — Order history (CUS-062)
**Story:** As a logged-in customer, I see my past orders.

**Acceptance criteria**
- **Given** I'm logged in, **then** an **Orders** page lists my orders (newest first) with date, items, total, status, and a link to each order's detail/receipt.
- **Given** a past order, **then** I can view its full itemized receipt (from snapshots) and its final status.

**Edge cases:** guest orders not yet claimed (→ ACC-4), long history (pagination).
**Deps:** ACC-1, `orders.user_id` (data model §5).

### ACC-3 — Saved profile & preferences (CUS-063)
**Story:** As a customer, I save my details and preferences so I don't re-enter them.
**AC:** edit name, phone (re-verify on change), default order-type, veg preference, and **notification/marketing consent** (DPDP); pre-fills at checkout. **Deps:** ACC-1.

### ACC-4 — Reorder & guest-order claim (CUS-064, CUS-066)
**Story:** As a returning customer, I re-order a past order in a tap, and my old guest orders show up once I log in with the same number.

**Acceptance criteria**
- **Given** a past order, **when** I tap **Order again**, **then** its items+customizations load into the cart (skipping now-unavailable items with a notice), and I proceed to checkout.
- **Given** I log in with a phone that matches prior **guest** orders, **then** those orders are linked to my account (ACC-2 shows them).

**Edge cases:** menu/price changed since (use current menu + prices, warn on removed items), variant/addon no longer offered (drop with notice).
**Deps:** ACC-1, ACC-2.

### ACC-5 — Favorites (CUS-065) — *Should*
**Story:** As a customer, I save favorite items for quick access.
**AC:** heart an item → appears in a Favorites rail; add-to-cart from there. **Deps:** ACC-1.

---

## 4. Pillar C — Loyalty & Promotions

### LOY-1 — Loyalty program (CUS-067)
**Story:** As a customer, I earn points on orders and redeem them for discounts, so I'm rewarded for coming back.

**Acceptance criteria**
- **Given** I'm logged in and complete a paid order, **then** I earn points (FND-4) and see my new balance + a notification ("You earned X points").
- **Given** checkout with a balance, **then** I can redeem points for a discount within configured limits; the bill reflects it.
- **Given** my account, **then** a **Rewards** page shows balance, earn/redeem history, and how points work.

**Edge cases:** earn on refunded order (reverse), redemption + coupon precedence (FND-3), minimum redemption threshold, expiry reminders (notification).
**Deps:** FND-4, ACC-1, Phase-1 notifications.

### LOY-2 — Coupons / promo codes (CUS-029)
**Story:** As a customer, I enter a promo code and get the discount.
**AC:** enter code at checkout → validated by FND-3 → discount shown in bill or a clear invalid reason; applied discount snapshotted on the order. **Deps:** FND-3.

### LOY-3 — Ratings, reviews & feedback (CUS-069, OWN-036)
**Story:** As a customer, I rate my order after pickup; as the owner, I read and respond.

**Acceptance criteria**
- **Given** an order reaches `completed`, **then** the customer is invited (status page + optional notification) to rate it (1–5) and optionally comment, per item and/or overall.
- **Given** a submitted review, **then** it's stored (`reviews`) and surfaces in the owner's ratings summary (RET-4).
- **Given** the owner views a review, **then** they can post a response.

**Edge cases:** one review per order (edit within a window), abusive content (owner can hide), no-login guest reviews (allow via order link, attribute to phone).
**Deps:** Phase-1 state machine (`completed` trigger), notifications.

### LOY-4 — Referral program (CUS-068) — *Could*
**Story:** As a customer, I refer a friend and we both get a reward.
**AC:** each account gets a referral code/link; a first order by a referee credits both per config; `referrals` tracks status. **Deps:** ACC-1, FND-4/LOY-2 (reward mechanic). *Recommend after LOY-1/LOY-2 prove out.*

### LOY-5 — Campaign & announcement management (OWN-035, CUS-071)
**Story:** As the owner, I create coupons/promotions, schedule broadcasts, and post homepage banners/announcements.

**Acceptance criteria**
- **Given** the owner promo tools, **then** they can create/activate/expire coupons + auto-promotions (feeding FND-3), with usage limits.
- **Given** a homepage banner/announcement, **then** the owner can schedule and publish it to the customer site.
- **Given** a marketing broadcast, **then** it sends **only to consented** customers (DPDP) via the Phase-1 channels, and is logged.

**Deps:** FND-3, Phase-1 notifications, consent (ACC-3).

---

## 5. Pillar D — Retention & payment analytics (Owner)

> Extends the Phase-1 owner dashboard using the same analytics pipeline.

### RET-1 — Customer analytics (OWN-010)
**AC:** new vs returning split, **repeat rate** (30/60/90-day), cohort retention, top customers by spend/orders, avg orders per customer, **LTV** estimate. **Deps:** ACC-1 (identity), analytics pipeline.

### RET-2 — Payment analytics (OWN-009)
**AC:** payment-method mix (UPI/cash/card/online), online vs pay-at-counter share, collected vs pending, refund totals & rate. **Deps:** FND-1/FND-2.

### RET-3 — Promotions analytics (OWN-012)
**AC:** coupon usage & redemption rate, total discount given, **promo ROI** (incremental revenue vs discount cost), loyalty enrollment & redemption. **Deps:** FND-3/FND-4.

### RET-4 — Ratings & feedback summary (OWN-013)
**AC:** average rating over time, review volume, distribution, and surfacing of low-rated orders/items with themes. **Deps:** LOY-3.

### RET-5 — Exports & scheduled reports (OWN-018)
**AC:** export any dashboard/range to CSV/Excel/PDF; schedule a daily/weekly summary emailed/WhatsApp'd to the owner. **Deps:** Phase-1 pipeline, notifications.

### RET-6 — Audit log viewer + payment settings (OWN-039, OWN-033)
**AC:** owner views the staff/config/refund audit trail; owner configures payment gateway keys, accepted methods, and tax. **Deps:** FND-5, FND-1.

### RET-7 — Cart abandonment funnel (OWN-014) — *Could*
**AC:** cart → checkout → payment → order conversion, with drop-off step. **Deps:** analytics event pipeline (may need extra funnel events).

---

## 6. Data-model changes for Phase 2

On top of Phase-1's schema; keep `lib/types.ts` in sync; preserve snapshotting.

| Change | Serves |
|---|---|
| New `payments (id, order_id, gateway, gateway_order_id, gateway_payment_id, amount_inr, status, method, created_at)` | FND-1, PAY-1 |
| New `refunds (id, payment_id, order_id, amount_inr, reason, status, gateway_ref, created_by, created_at)` | FND-2, PAY-3 |
| `orders` add `user_id` (nullable FK → customers), wire payment sub-states (reserved in P1) | ACC-2/4, PAY-1 |
| Extend `profiles`/new `customers`: `name`, `phone`, `phone_verified`, `marketing_consent`, `prefs jsonb` | ACC-1/3 |
| New `customer_addresses` *(only if delivery is in scope)* | CUS-024 (deferred) |
| New `coupons (code, type, value, min_order_inr, max_discount_inr, valid_from, valid_to, usage_limit, per_user_limit, item/category scope, active)` | FND-3, LOY-2 |
| New `coupon_redemptions (coupon_id, order_id, user_id, discount_inr, created_at)` | FND-3 |
| New `loyalty_accounts (user_id, points_balance)` + `loyalty_transactions (user_id, order_id, type, points, created_at)` + `loyalty_config` | FND-4, LOY-1 |
| New `reviews (id, order_id, menu_item_id?, user_id?, rating, comment, staff_response, responded_at, hidden, created_at)` | LOY-3 |
| New `promotions` + `announcements/banners` | LOY-5 |
| New `referrals (referrer, referee, code, status, reward)` *(if LOY-4)* | LOY-4 |
| New `wallet_accounts` + `wallet_transactions` *(if PAY-4)* | PAY-4 |
| Extend `profiles.role` to add `manager` (+ optional cashier/kitchen); permission checks | FND-5 |
| Analytics views: customer cohort/repeat/LTV, payment mix, promo ROI, ratings rollups | RET-1..4 |
| RLS: customers read **their own** orders/loyalty/reviews (introduces per-user policies, unlike Phase-1's staff-only reads) | NFR-004 |

> **New RLS pattern:** Phase 1 kept all order reads server-side (service role). Phase 2 introduces **logged-in customers reading their own data** → add `auth.uid() = user_id` policies for orders/loyalty/reviews, carefully scoped.

---

## 7. Open questions blocking Phase 2

1. **Payment provider & fees** — Razorpay vs PhonePe/Cashfree vs direct UPI? Per-transaction fee acceptable? (Blocks FND-1.)
2. **Loyalty mechanic** — points-per-₹ (and redemption value), stamps ("buy 9 get 1"), or tiers? Expiry policy? (Blocks FND-4/LOY-1.)
3. **Coupon ↔ loyalty stacking** — allowed together? Precedence order? (Blocks FND-3.)
4. **Delivery** — still out of scope? If yes, `customer_addresses` stays out. (Affects ACC/data model.)
5. **Guest reviews** — allow ratings without login (via order link), or members-only? (LOY-3.)
6. **Refund policy** — who approves, within what window, partials allowed? (FND-2/PAY-3.)
7. **Marketing consent** — confirm DPDP-compliant consent copy + channel for broadcasts. (LOY-5.)

---

## 8. Suggested build order (pillar-sequenced)

Payments first (revenue + refunds), then Accounts (identity is a prerequisite for loyalty), then Loyalty/Promotions, with owner analytics trailing each pillar.

1. **Foundations:** FND-1 gateway + FND-5 manager role → FND-2 refunds
2. **Payments pillar:** PAY-1 online checkout → PAY-2 retry → PAY-3 refund → RET-2 payment analytics
3. **Accounts pillar:** ACC-1 phone-OTP → ACC-2 history → ACC-4 reorder/claim → ACC-3 profile → ACC-5 favorites → RET-1 customer analytics
4. **Promotions:** FND-3 coupon engine → LOY-2 coupons → LOY-3 ratings → RET-3/RET-4 analytics
5. **Loyalty:** FND-4 ledger → LOY-1 program → (LOY-4 referral, PAY-4 wallet — stretch)
6. **Owner tooling:** LOY-5 campaigns → RET-5 exports → RET-6 audit/payment settings → RET-7 funnel (stretch)
7. **Gates:** payment webhook/refund tests, coupon/loyalty math tests, PCI/RLS review, DPDP consent.

> Re-run RICE on this set at Phase-2 planning to confirm the pillar order against the numbers, and produce a Phase-2 sprint plan the way we did for Phase 1.

---

## 9. Out of this spec (parallel staff-ops track)

The remaining Phase-2 items from the roadmap are **staff-facing ops**, not part of the payments/accounts/loyalty theme you scoped here — track them separately (a "Phase 2b — Counter efficiency" mini-epic) or fold selectively:
- **STF-020 KOT thermal printing** + XC-043 printer integration
- **STF-040 walk-in / manual POS-lite** order entry
- **STF-024/042 reprint & receipt/token printing**
- Broader **staff role granularity** beyond the `manager` role introduced here (FND-5)

Flagging so they're not lost — but they don't gate the three revenue/retention pillars above.
