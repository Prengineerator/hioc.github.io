# HIOC — Marketing Agent (WhatsApp) — Spec

**Companion to:** `docs/WHATSAPP-BILL-TEMPLATE.md` (template mechanics), `docs/WHATSAPP-FEEDBACK-TEMPLATE.md` (webhook + STOP), `docs/PHASE-2-SPEC.md` (loyalty, coupons)
**Version:** 1.0
**Date:** 2026-09-30
**Owner:** Product
**Scope:** A marketing agent that uses WhatsApp to bring customers back. It reminds customers to spend loyalty points before they expire, wins back lapsed customers with staged offers, and alerts the owner when customer counts drop. Every campaign is priced first: WhatsApp message cost, offer cost and product cost (COGS) are weighed against the profit it should bring back. **The owner controls everything from `/owner/marketing`**: on/off, budget, caps, offers, templates, product costs, and approve-before-send.

---

## 0. Goal & definition of done

**Goal:** More repeat orders and more profit per rupee spent on WhatsApp. The owner sees what the agent wants to send, what it will cost and what it should earn, and it never messages anyone who hasn't said yes.

### Research that shaped this design

| # | Finding | Design consequence |
|---|---|---|
| R1 | India WhatsApp **marketing** template: **₹0.8631/message + 18% GST ≈ ₹1.02**. Utility ₹0.115 (≈ ₹0.14 with GST). Meta raised marketing rates ~10% in 2026. From **1 Oct 2026** service and in-window utility messages are also charged per message. | `message_cost_inr` is an owner setting (default **1.02**) rather than a hard-coded number. Every projection and budget uses it. |
| R2 | Meta applies an adaptive **per-user marketing frequency cap** across all businesses. A blocked send fails with **error 131049**, is not charged, and should not be retried for 24h+. | Our own caps sit below Meta's (default 1 per 7 days, 4 per 30 days). A 131049 is recorded as `failed` with cost 0 and no retry. |
| R3 | **131050** means the user tapped Meta's "Stop promotions". The `user_preferences` webhook reports stop/resume. | Both become an opt-out in our consent ledger. |
| R4 | Meta requires explicit opt-in naming the business, opt-out on every marketing template, and opt-outs honoured within 24h. Block/report rates above ~0.5% degrade number quality. | We keep a consent ledger with an audit trail. We only send with `opted_in` status, every template has STOP + "Stop promotions", and fatigue rules (pause after N unread) protect number quality. |
| R5 | India's **DPDP Act 2023 / Rules 2025** require consent that is free, specific, informed, unambiguous and given by a clear affirmative action. Withdrawal must be as easy as giving consent. Notice/consent rules are in force from **13 May 2027**. | No pre-ticked boxes and no owner bulk import of "opted-in" numbers. Opt-in is one tap or one keyword, and so is opt-out. Every change is logged with its source. |
| R6 | A points-expiry reminder is **utility** only when purely informational. Any "use them" nudge is **marketing**, and Meta will re-categorise a miscategorised template. | All agent templates are submitted as **Marketing** and costed at the marketing rate. We don't risk re-categorisation. |
| R7 | Restaurant win-back benchmarks: **30 days** of absence is the lapse signal for coffee shops. Staged offers get **~12–18%** return at 30d with a small offer, **8–12%** at 60d with a stronger offer (free item / credit), and **4–7%** at 90d as a last chance. 60% of restaurant revenue comes from repeat guests. | Three win-back stages with these as starting conversion rates. The threshold is personalised by each customer's own visit rhythm. |
| R8 | Campaign "conversions" include people who would have come anyway. The standard fix is a **holdout group**. | Default 10% holdout per campaign. The dashboard reports **measured lift** (treated vs holdout), not just raw returns. |

Sources: myoperator.com/blog/whatsapp-business-api-pricing-india-2026 · chatmaxima.com/whatsapp-api-pricing/india · developers.facebook.com (per-user marketing limits) · help.wanotifier.com (131049) · help.hello-charles.com (131050) · infobip.com (opt-in policy) · law.asia / hoganlovells.com (DPDP) · chowly.com, engage.purple.ai (win-back benchmarks) · ycloud.com, chakrahq.com (template categories).

### Current-state facts (verified in code, 2026-09-30)

| # | Fact | Evidence |
|---|---|---|
| F1 | WhatsApp sends go through `whatsappAdapter.send(SendInput)`. The template name is picked **only** from a fixed `event → env var` map, so a caller cannot pass an arbitrary template name. | `lib/notifications/adapters.ts:41-60, 201-335` |
| F2 | `notifications.order_id` is NOT NULL and the log is keyed `(order_id,event,channel)`. It cannot log a non-order message. | `supabase/phase1-migration.sql:112-128` |
| F3 | The webhook verifies the HMAC and handles inbound messages. STOP writes `whatsapp_opt_outs`. **START is promised in the reply text but is not handled.** Status receipts only update `notifications`. `WHATSAPP_APP_SECRET` is not set in production, so every POST is currently rejected. | `app/api/webhooks/whatsapp/route.ts:25-32, 217-471, 524-562` |
| F4 | Consent today is `profiles.marketing_consent` (bool, logged-in users only, no audit trail). Nothing reads it for sending. Petpooja customers were never asked. | `phase2-migration.sql:104`, `app/api/account/me/route.ts:135` |
| F5 | Loyalty: 10% back as points, 1 pt = ₹1, min redeem 20, max 50% of bill, **points expire 30 days after earning** (FIFO). There is no "expiring soon" logic anywhere. | `lib/loyalty/ledger.ts`, `lib/loyalty/expiry.ts` |
| F6 | Coupons cannot be tied to a customer. `per_user_limit` keys on auth user. Scope is an eligibility check, and the discount is computed on the whole subtotal. | `lib/promotions/coupons.ts`, `phase2-migration.sql:121-152` |
| F7 | **There is no cost/COGS data anywhere.** `menu_items` is publicly readable, so a cost column there would leak margins to anyone. | `supabase/schema.sql:16-39`, RLS public menu read |
| F8 | "Lapsed" logic exists only for imported Petpooja history (60 days). App customers have no lifecycle/RFM logic. | `lib/legacy/ownerStats.ts:50-68` |
| F9 | Vercel crons are daily-only on this plan. Sub-daily work runs on `pg_cron` + `pg_net` with the secret in Vault, and the route exports GET and POST. | `supabase/2026-10-order-feedback.sql:300-344` |
| F10 | Owner-only config pattern: a singleton table with RLS on, no policies, and its own `getOwnerUser` route that returns 409 when the migration is missing. | `supabase/2026-10-owner-report-emails.sql`, `app/api/owner/report-emails/route.ts` |
| F11 | Identified customers are auth users. Counter customers get an auth user created from a verified phone. Orders link through `user_id` / `customer_user_id`, and `orderMatchFilter` also matches by phone. | `lib/loyalty/customerLink.ts`, `lib/analytics/customerSegments.ts` |
| F12 | Pre-existing bug, **out of scope**: `'feedback'` is not in the `notifications_event_check`, so feedback-request log writes are rejected by the DB. | grep of `supabase/*.sql` |

### Definition of done

- [ ] Owner applies one migration, turns the flag on, and sees `/owner/marketing` with Overview, Approvals, Playbooks, Campaigns, Audience, Product costs and Settings.
- [ ] Owner enters product costs; the dashboard shows food-cost % and margin per item and ranks the best "free item" offers.
- [ ] With the kill switch **off** (default), nothing is ever sent.
- [ ] With a playbook in **Review**, the daily agent run creates a campaign in Approvals showing audience, holdout, offer, message cost, expected returning orders, revenue, offer cost, profit, ROI, break-even rate and guardrail warnings. Nothing sends until the owner taps Approve.
- [ ] With a playbook in **Auto**, campaigns that pass every guardrail send without approval; any that fail one fall back to Approvals.
- [ ] Only phones with `opted_in` consent and no opt-out are messaged, within the send window, under the monthly budget, daily cap and frequency caps.
- [ ] STOP, "Stop promotions", 131050 and Meta `user_preferences: stop` all opt the customer out; START opts them back in. Every change is logged.
- [ ] Each treated recipient with an offer gets a unique single-use coupon locked to their phone, which nobody else can redeem.
- [ ] Returns are attributed (by coupon, else by any valid order within the attribution window) for both treated and holdout, and the dashboard shows measured lift and ROI.
- [ ] A customer-drop alert fires when last week's active customers fall ≥ `drop_alert_pct` below the prior 4-week average.
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test` and `npm run build` are clean. `verify:db` probes the new migration.

---

## 1. How the agent works

The agent is deterministic. It is **not** an LLM: WhatsApp copy must be a Meta-approved template, and money and consent decisions must be predictable and testable. It runs this loop:

```
 nightly (Vercel cron, 09:45 IST)                every 5 min (pg_cron → route)
┌──────────────────────────────────────────┐    ┌──────────────────────────────────┐
│ 1 MEASURE  attribute returns (treated +   │    │ SEND  claim queued recipients     │
│            holdout), update learned rates │    │   ├ window? budget? daily cap?    │
│ 2 OBSERVE  orders, points, consent, caps  │    │   ├ re-check consent + caps       │
│ 3 SEGMENT  lifecycle stage per customer   │    │   ├ issue phone-locked coupon     │
│ 4 DECIDE   playbooks by priority, one     │    │   ├ send template (URL = /r/tok)  │
│            message per customer per day,  │    │   └ log ref, cost, status         │
│            economics + guardrails         │    └──────────────────────────────────┘
│ 5 ACT      Review → Approvals inbox       │    webhook: delivered/read/failed,
│            Auto   → queue (if guardrails) │    STOP/START/Stop promotions/131050
└──────────────────────────────────────────┘
 on dashboard load: REPORT — KPIs, lift, spend, drop alert, insights
```

### 1.1 Customer model (who can be targeted)

A **contact** is an E.164 Indian mobile (`+91XXXXXXXXXX`) with a `marketing_consent` row with `status='opted_in'` and no `whatsapp_opt_outs` row. The contact joins to an auth user through `profiles.phone` where `phone_verified = true`, which gives order history and loyalty. Staff/manager/owner profiles are always excluded.

For each contact we compute these stats from **valid orders** (not `cancelled`/`rejected`) over the last 365 days. An order belongs to a contact if `user_id` or `customer_user_id` is the contact's user, **or** `customer_phone` matches, using the same matching as `orderMatchFilter`:

- `order_count`, `total_spend_inr`, `aov_inr` (mean `total_inr`), `first_order_at`, `last_order_at`, `days_since_last_order`
- `typical_gap_days`: median gap between consecutive order days, only when `order_count ≥ 3`, clamped to [2, 60]; otherwise null
- `points_balance`, `expiring_points` + `expiry_date` (from §1.3)
- `vip`: in the top 20% by `total_spend_inr` among contacts with `order_count ≥ 3`

### 1.2 Lifecycle stages (personalised lapse)

```
stage1_days = typical_gap_days ? clamp(round(gap_multiplier × typical_gap_days), min_days, max_days)
                               : default_days                    // winback_1.params: 2.5, 14, 45, 30
stage2_days = stage1_days + winback_2.params.offset_days          // default +30
stage3_days = stage1_days + winback_3.params.offset_days          // default +60
lost_after  = winback_3.params.max_days                           // default 180
```

| Stage | Condition (d = days since last order) |
|---|---|
| `new` | 1 order and d < stage1_days |
| `active` | d < 0.8 × stage1_days |
| `at_risk` | 0.8 × stage1_days ≤ d < stage1_days |
| `lapsed_1` | stage1_days ≤ d < stage2_days |
| `lapsed_2` | stage2_days ≤ d < stage3_days |
| `lapsed_3` | stage3_days ≤ d < lost_after |
| `lost` | d ≥ lost_after — the agent never messages these automatically |
| `no_orders` | opted in but no valid orders — manual campaigns only |

A daily regular (gap 2 days) counts as lapsed after 14 days; a monthly visitor only after 45. A fixed 30-day rule wastes messages on the second group and misses the first.

### 1.3 Points expiring soon

Points expire FIFO `points_expiry_days` after they are earned (`lib/loyalty/expiry.ts`). The points that will expire within the next `k` days are:

```
expiringWithin(rows, now, expiryDays, k) = pointsToExpire(rows, cutoff = now + k days − expiryDays)
expiry_date = (oldest unconsumed credit's created_at) + expiryDays   // shown to the customer
```

This reuses `pointsToExpire` unchanged. Only customers with `expiring ≥ params.min_points` (default 20 = the minimum redemption) qualify, because anything smaller can't be redeemed anyway.

### 1.4 Playbooks (the agent's automated campaigns)

Seeded in `marketing_playbooks`, all `mode='off'`. Priority 1 is highest. A contact gets **at most one** agent message per day, from the highest-priority playbook it qualifies for.

| Key | Pri | Who qualifies (all also pass §1.5) | Default offer | Prior conv. |
|---|---|---|---|---|
| `points_expiring` | 1 | `expiring_points ≥ min_points(20)` within `days_ahead(5)`; no order in last `recent_order_days(2)`; no `points_expiring` message in `cooldown_days(14)` | none (points are the offer) | 15% |
| `winback_3` | 2 | stage `lapsed_3`; no `winback_3` message since last order | 20% off, cap ₹120, min ₹200, valid 7d | 5% |
| `winback_2` | 3 | stage `lapsed_2`; no `winback_2` message since last order | **free item** (auto-picked, §1.6), min ₹200 other items, valid 10d | 8% |
| `winback_1` | 4 | stage `lapsed_1`; no `winback_1` message since last order | 10% off, cap ₹60, min ₹150, valid 10d | 12% |
| `points_balance` | 5 | `points_balance ≥ min_points(50)`; `days_since_last_order ≥ min_days_since_order(10)`; no `points_balance` message in `cooldown_days(21)` | none | 8% |

"Since last order" is what makes win-back stages one per lapse episode. Once a customer orders again, the stages reset.

**Manual campaigns** are for the owner's own pushes, like a new item launch or a slow-day offer. The audience filter is `{ stages?: Stage[], vip_only?: bool, min_orders?: int, min_spend_inr?: int, last_order_from_days?: int, last_order_to_days?: int, min_points?: int }`, and an empty filter means "all opted-in contacts". The rest of the flow (offer, template, projection, approval) is the same.

### 1.5 Eligibility & fatigue rules (checked at plan time **and again at send time**)

A contact is skipped, with a reason recorded, when any of these hold:

1. `not_opted_in` — no `opted_in` consent, or a `whatsapp_opt_outs` row exists.
2. `staff` — profile role is not `customer`.
3. `invalid_phone` — not a valid Indian mobile.
4. `too_soon` — any marketing message (any campaign) was sent to this phone in the last `min_days_between` days (default 7).
5. `monthly_cap` — `max_per_30_days` (default 4) or more marketing messages were sent in the last 30 days.
6. `unread_pause` — the last `pause_after_unread` (default 3) marketing messages all reached `sent`/`delivered` without `read`, and the latest was less than 60 days ago. **This rule is disabled automatically when read receipts aren't flowing** (no recipient has ever reached `delivered` or `read`). Otherwise everyone would be paused while `WHATSAPP_APP_SECRET` is unset.
7. `in_flight` — the phone already has a `pending`/`queued`/`sending` recipient in another open campaign.
8. `claimed_by_higher_priority` — a higher-priority playbook took this contact in today's run.

Send-time re-checks cover rules 1, 3, 4 and 5. Consent can be withdrawn between approval and send, and it must win.

### 1.6 Economics (every campaign is priced before it is approved)

The inputs:
- `N` eligible, `h = holdout_pct`, `treated = N − round(N·h/100)`
- `c = message_cost_inr`
- `d = deliverability`: learned delivered÷sent when receipts flow, else 0.9
- `r = blended conversion rate` (see "Learning" below)
- `A = basket value`: median of the recipients' `aov_inr`, falling back to the store's 90-day AOV
- `f = blended food-cost ratio`: Σ line cost ÷ Σ line revenue over the last 90 days of non-voided `order_items` on valid orders. Line cost is `menu_item_costs.cost_inr × quantity` (by `variant_id`) where known, else `line_total_inr × default_food_cost_pct/100`

**Offer cost per returning order** (`offer_cost`) and **revenue lost to the discount** (`discount`) depend on the offer type:

| Offer | `discount` | `offer_cost` | Customer sees |
|---|---|---|---|
| `none` | 0 | 0 | — |
| `points` (points playbooks) | min(points_value, A × max_redeem_pct/100) | = discount | "₹X of points" |
| `percent` p, cap K | min(A·p/100, K or ∞) | = discount | "p% off (up to ₹K) on orders above ₹M" |
| `flat` F | min(F, A) | = discount | "₹F off on orders above ₹M" |
| `free_item` i (a variant) | 0 (the item isn't revenue) | **cost_i (COGS of that variant)** | "a FREE {item} with any order above ₹M" |

**This is why product costs matter.** A free Cold Coffee priced ₹180 that costs ₹45 to make is worth ₹180 to the customer but costs the cafe ₹45. A 10% discount on a ₹320 basket costs ₹32 and feels like ₹32. The agent ranks free-item candidates, one per **variant** of an available item with a real cost row (a default-% cost ranks everything equally, so it isn't used), by `price ÷ cost` (perceived value per rupee of cost), breaking ties by lower cost. The offer is `{type:'free_item', item_id, variant_id, max_item_price, min_order_inr, validity_days}`. With `variant_id = null` the planner auto-picks the top candidate whose price is ≤ `max_item_price` (default ₹250) and freezes that choice on the campaign. If there is no candidate, the campaign gets the `no_free_item` guardrail flag.

```
conversions      = treated × d × r
profit_per_conv  = A × (1 − f) − offer_cost
revenue          = conversions × (A − discount)
offer_spend      = conversions × offer_cost
message_spend    = treated × c
expected_profit  = conversions × profit_per_conv − message_spend
roi              = expected_profit ÷ (message_spend + offer_spend)          // null if denominator 0
margin_after_pct = 100 × profit_per_conv ÷ A
break_even_rate  = message_spend ÷ (treated × d × profit_per_conv)          // null if profit_per_conv ≤ 0
```

**Guardrails.** A campaign gets a `guardrail_flags` entry for each rule it breaks. **Auto mode never sends a flagged campaign**; it goes to Approvals instead.

- `negative_profit`: `expected_profit ≤ 0`
- `low_margin`: `margin_after_pct < min_margin_pct` (default 30)
- `over_budget`: `message_spend` > remaining monthly budget
- `missing_costs`: fewer than 50% of the last 90 days' item revenue has a real cost entered (the projection is then using the default food-cost %)
- `no_template`: template name is empty
- `no_free_item`: a free-item offer with no pickable variant (no costs entered, or none under the price cap)

**Learning.** Once a campaign's attribution window has closed, its treated delivered count and conversions are added to its playbook's `observed_treated` / `observed_conversions`. The rate used for projections is a Bayesian blend, which moves from the research prior toward what this cafe actually achieves:

```
r = (prior_pct/100 × 50 + observed_conversions) ÷ (50 + observed_treated)
```

Manual campaigns use a prior of 5%.

**Worked example** (win-back stage 1, 200 eligible): 20 holdout, 180 treated, c = ₹1.02 → message spend ₹184. With d = 0.9 and r = 12%: 19.4 returning orders. With A = ₹320 and f = 0.35: 10% off (cap ₹60) gives discount ₹32 and profit_per_conv = 320 × 0.65 − 32 = ₹176. That makes expected profit ≈ ₹3,230, revenue ≈ ₹5,590, and break-even at only **0.65%** conversion. The dashboard shows the owner exactly this.

### 1.7 Offers become phone-locked coupons

When a treated recipient is **sent** (not at plan time, so skipped or rejected campaigns leave no orphans), the sender inserts a `coupons` row:

- `code`: prefix (`PT` for points playbooks, `WB` for win-back, `OF` for manual) + 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Retry on a unique violation, up to 3 times.
- `discount_type` / `discount_value` / `max_discount_inr` / `min_order_inr` / `scope`:
  - `percent`: (`percent`, p, K, M, `{}`)
  - `flat`: (`flat`, F, 0, M, `{}`)
  - `free_item`: (`flat`, price_v, price_v, **M + price_v**, `{item_ids:[item_id]}`), where price_v is the chosen variant's price. The min order includes the free item, so "free X with ₹200 of other items" holds. Scope is by item, so a larger variant also qualifies, with the discount capped at the chosen variant's price.
- `valid_from` = now, `valid_to` = end of the IST day `validity_days` from now, `usage_limit` = 1, `per_user_limit` = 1, `active` = true, `is_auto` = false
- `campaign_id`, `assigned_phone` = the recipient's phone, `description` = `Marketing: <campaign name>`

`validateAndComputeCoupon` gets one new rule. When `coupon.assigned_phone` is set, the redeemer must be a signed-in or counter-linked user (`ctx.userId`) whose `profiles.phone` is **verified** and equal to `assigned_phone`. Otherwise it returns ok:false with "This code is linked to another phone number. Log in with the number it was sent to, or show it at the counter." The callers stay the same: every caller already passes the redeemer's user (counter = linked customer).

The existing coupon list (`GET /api/coupons`, `CouponManager`) must **hide `campaign_id is not null` rows by default**. Otherwise the promotions screen fills with per-recipient codes.

Points playbooks issue no coupon. The customer redeems points as usual.

### 1.8 Attribution & lift

The attribution clock starts at `reference_at`: `sent_at` for treated recipients, and the campaign's `started_at` for holdout recipients (stamped when the campaign starts sending). A recipient is converted by, in order:

1. **coupon**: a `coupon_redemptions` row for the recipient's coupon, on a valid order
2. **order**: the first valid order by that contact (user or phone match) with `created_at` in (`reference_at`, `reference_at + attribution_days`]

The run stamps `converted_order_id`, `converted_at`, `conversion_revenue_inr` (the order's `total_inr`) and `attributed_via`.

```
lift_pp            = 100 × (treated_conv ÷ treated_delivered − holdout_conv ÷ holdout_n)
incremental_orders = max(0, lift_pp/100) × treated_delivered
```

Here `treated_delivered` counts sent/delivered/read treated recipients. The dashboard shows lift only when the holdout has at least 20 people; below that it says "not enough data yet".

### 1.9 Customer-drop alert & insights

- **Weekly active customers:** distinct identified customers (user id, or normalised phone) with a valid order in each IST week (Mon–Sun), for the last 9 complete weeks, plus weekly order counts.
- **Drop alert** when `last_week < (1 − drop_alert_pct/100) × mean(previous 4 weeks)`. The alert gives the size of the drop and recommends a win-back push.
- **Insights** (computed on load, each with a call to action):
  1. "₹X of points (Y customers) expire in the next 7 days" when `points_expiring` is off → enable it.
  2. "Z customers became lapsed this month" when every win-back playbook is off → enable win-back.
  3. "Only P% of your active customers can receive offers" when consent coverage is under 30% → put the opt-in QR on tables and the counter.
  4. "Costs missing for items making Q% of revenue" → go to Product costs.
  5. "Best free-item offer: {item} (worth ₹price, costs ₹cost)" → shown when costs exist.
  6. "Receipts not connected" when nothing has ever been delivered or read → set `WHATSAPP_APP_SECRET`. Without it STOP/START and delivery tracking don't work.

---

## 2. Consent (how customers opt in and out)

`marketing_consent` (one row per phone) is the source of truth. `marketing_consent_events` is an append-only audit log. All writes go through `lib/marketing/server/consent.ts`:

- `recordOptIn({ phone, userId?, source, actor? })` sets `status='opted_in'`, `consented_at=now()`, clears `withdrawn_at`, and **deletes** the phone's `whatsapp_opt_outs` row. The customer has explicitly asked back in, and the opt-out table is what the feedback cron honours. It also sets `profiles.marketing_consent=true` on the verified profile with that phone, and appends an event.
- `recordOptOut({ phone, userId?, source, actor? })` sets `status='opted_out'` and `withdrawn_at=now()`, **upserts** `whatsapp_opt_outs` (`source` prefixed `marketing:`), sets `profiles.marketing_consent=false` on the matching verified profile, cancels the phone's `pending`/`queued` recipients (`status='cancelled'`, `skip_reason='opted_out'`), and appends an event.

| Where | Action | `source` |
|---|---|---|
| Account → Profile toggle (existing) | PATCH `/api/account/me` `marketing_consent` → also records opt-in/out when the profile phone is verified | `profile` |
| Order confirmation page (logged-in, verified phone, not opted in) | Card: "Get offers & points reminders from HIOC on WhatsApp — at most one a week. Reply STOP anytime." Button **Yes, send me offers** → PATCH `/api/account/me {marketing_consent:true}` | `profile` |
| Order confirmation page (everyone else) and the printable QR card | Link `https://wa.me/<whatsapp_business_number>?text=START`. The customer sends START and the webhook opts them in | `whatsapp_keyword` |
| WhatsApp inbound `START` / `SUBSCRIBE` / `OFFERS` / `UNSTOP` (whole message, trimmed, case-insensitive) | opt-in + reply "You're subscribed to HIOC offers on WhatsApp — at most one message a week. Reply STOP anytime to unsubscribe." | `whatsapp_keyword` |
| WhatsApp inbound STOP keywords (existing `isOptOutKeyword`) | existing behaviour **plus** `recordOptOut`. Reply text changes to "You're unsubscribed from HIOC offers and feedback messages. You'll still get updates about orders you place. Reply START any time to opt back in." | `stop_keyword` |
| Button reply with text "Stop promotions" (Meta's marketing opt-out button) | opt-out, no reply (Meta confirms to the user) | `stop_promotions` |
| Status webhook error code **131050** | opt-out | `meta_131050` |
| `user_preferences` webhook, `category: marketing_messages`, `value: stop` / `resume` | stop → opt-out. resume → opt-in **only if** the phone has an earlier `opt_in` event (resume alone isn't consent to us) | `meta_stop` / `meta_resume` |
| Owner: Audience tab "Record an opt-out" (customer asked in person) | opt-out | `owner` |

**The owner cannot opt anyone in.** There is no import of phone lists as consented. This is deliberate (R4, R5), and the UI says so.

**Backfill** (in the migration): verified profiles with `marketing_consent=true` and an Indian phone become `opted_in` (`backfill_profile`), unless the phone is in `whatsapp_opt_outs`. Every `whatsapp_opt_outs` phone becomes `opted_out` (`backfill_opt_out`).

---

## 3. Data model — `supabase/2026-10-marketing-agent.sql`

Follow the house style: a header block (purpose, "Idempotent: safe to re-run", "Apply BEFORE deploying the code"), `if not exists` / `create or replace`, and a `-- Verify:` block at the end. **Every new table gets RLS on, no policies, and `revoke all … from anon, authenticated`.** Only the service-role client touches them.

```sql
-- 1. Product costs — owner-only, PER VARIANT (prices live on menu_item_variants,
--    every item has ≥1 variant; order_items carries variant_id). NEVER a column on
--    menu_items / menu_item_variants (public read = leaked margins).
create table if not exists public.menu_item_costs (
  variant_id   uuid primary key references public.menu_item_variants(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  cost_inr     numeric(10,2) not null check (cost_inr >= 0),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);
create index if not exists idx_menu_item_costs_item on public.menu_item_costs(menu_item_id);
-- An order line with no variant_id (legacy) or no cost row uses default_food_cost_pct.

-- 2. Settings (singleton, owner-only)
create table if not exists public.marketing_settings (
  is_singleton            boolean primary key default true check (is_singleton),
  enabled                 boolean not null default false,             -- master kill switch
  monthly_budget_inr      int not null default 1000 check (monthly_budget_inr between 0 and 1000000),
  message_cost_inr        numeric(6,3) not null default 1.020 check (message_cost_inr between 0 and 100),
  send_window_start_hour  int not null default 11 check (send_window_start_hour between 0 and 23),
  send_window_end_hour    int not null default 20 check (send_window_end_hour between 1 and 24),
  daily_send_cap          int not null default 200 check (daily_send_cap between 0 and 10000),
  min_days_between        int not null default 7 check (min_days_between between 1 and 60),
  max_per_30_days         int not null default 4 check (max_per_30_days between 1 and 30),
  holdout_pct             int not null default 10 check (holdout_pct between 0 and 50),
  attribution_days        int not null default 7 check (attribution_days between 1 and 30),
  min_margin_pct          int not null default 30 check (min_margin_pct between 0 and 90),
  default_food_cost_pct   int not null default 35 check (default_food_cost_pct between 1 and 95),
  drop_alert_pct          int not null default 15 check (drop_alert_pct between 1 and 90),
  pause_after_unread      int not null default 3 check (pause_after_unread between 0 and 20), -- 0 = off
  whatsapp_business_number text not null default '',                   -- E.164, for wa.me opt-in link
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users(id) on delete set null,
  check (send_window_end_hour > send_window_start_hour)
);
insert into public.marketing_settings (is_singleton) values (true) on conflict do nothing;

-- 3. Consent ledger + audit log
create table if not exists public.marketing_consent (
  phone        text primary key check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  user_id      uuid references auth.users(id) on delete set null,
  status       text not null check (status in ('opted_in','opted_out')),
  source       text not null default '',
  consented_at timestamptz,
  withdrawn_at timestamptz,
  updated_at   timestamptz not null default now()
);
create index if not exists idx_marketing_consent_status on public.marketing_consent(status);
create table if not exists public.marketing_consent_events (
  id         uuid primary key default gen_random_uuid(),
  phone      text not null,
  user_id    uuid,
  action     text not null check (action in ('opt_in','opt_out')),
  source     text not null default '',
  actor      uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_marketing_consent_events_phone on public.marketing_consent_events(phone, created_at desc);
-- backfill (see §2) — insert … on conflict (phone) do nothing, plus matching events.

-- 4. Playbooks (seeded, all off)
create table if not exists public.marketing_playbooks (
  key                  text primary key check (key in ('points_expiring','points_balance','winback_1','winback_2','winback_3')),
  mode                 text not null default 'off' check (mode in ('off','review','auto')),
  priority             int  not null,
  params               jsonb not null default '{}'::jsonb,
  offer                jsonb not null default '{"type":"none"}'::jsonb,
  template             jsonb not null default '{}'::jsonb,
  prior_conversion_pct numeric(5,2) not null default 10 check (prior_conversion_pct between 0 and 100),
  observed_treated     int not null default 0,
  observed_conversions int not null default 0,
  last_planned_at      timestamptz,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users(id) on delete set null
);
-- seed rows exactly as §1.4 / §5 defaults, `on conflict (key) do nothing`.

-- 5. Campaigns
create table if not exists public.marketing_campaigns (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('playbook','manual')),
  playbook_key    text references public.marketing_playbooks(key),
  name            text not null,
  status          text not null default 'draft' check (status in
                    ('draft','pending_approval','approved','sending','completed','cancelled','expired')),
  planned_for     date not null default ((now() at time zone 'Asia/Kolkata')::date),
  send_after      timestamptz,
  audience        jsonb not null default '{}'::jsonb,
  offer           jsonb not null default '{"type":"none"}'::jsonb,
  template        jsonb not null default '{}'::jsonb,
  projection      jsonb not null default '{}'::jsonb,
  guardrail_flags text[] not null default '{}',
  priority        int  not null default 10,
  treated_count   int  not null default 0,
  holdout_count   int  not null default 0,
  started_at      timestamptz,
  completed_at    timestamptz,
  approved_by     uuid references auth.users(id) on delete set null,
  approved_at     timestamptz,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists uq_marketing_campaigns_playbook_day
  on public.marketing_campaigns(playbook_key, planned_for) where kind = 'playbook';
create index if not exists idx_marketing_campaigns_status on public.marketing_campaigns(status, created_at desc);

-- 6. Recipients
create table if not exists public.marketing_recipients (
  id                     uuid primary key default gen_random_uuid(),
  campaign_id            uuid not null references public.marketing_campaigns(id) on delete cascade,
  phone                  text not null,
  user_id                uuid references auth.users(id) on delete set null,
  first_name             text not null default '',
  arm                    text not null default 'treatment' check (arm in ('treatment','holdout')),
  status                 text not null default 'pending' check (status in
                           ('pending','queued','sending','sent','delivered','read','failed','skipped','holdout','cancelled')),
  skip_reason            text not null default '',
  vars                   jsonb not null default '{}'::jsonb,   -- token values frozen at plan time
  coupon_id              uuid references public.coupons(id) on delete set null,
  coupon_code            text not null default '',
  click_token            text unique,                          -- base64url, 12 chars, treatment only
  provider_ref           text not null default '',
  error                  text not null default '',
  error_code             text not null default '',
  cost_inr               numeric(8,3) not null default 0,
  attempts               int not null default 0,
  claimed_at             timestamptz,
  sent_at                timestamptz,
  delivered_at           timestamptz,
  read_at                timestamptz,
  clicked_at             timestamptz,
  reference_at           timestamptz,
  converted_order_id     uuid references public.orders(id) on delete set null,
  converted_at           timestamptz,
  conversion_revenue_inr int not null default 0,
  attributed_via         text not null default '' check (attributed_via in ('','coupon','order')),
  created_at             timestamptz not null default now(),
  unique (campaign_id, phone)
);
create index if not exists idx_mkt_recipients_queue on public.marketing_recipients(status) where status in ('queued','sending');
create index if not exists idx_mkt_recipients_phone_sent on public.marketing_recipients(phone, sent_at desc);
create index if not exists idx_mkt_recipients_provider_ref on public.marketing_recipients(provider_ref) where provider_ref <> '';
create index if not exists idx_mkt_recipients_reference on public.marketing_recipients(reference_at) where converted_at is null;

-- 7. Coupons: link + phone lock
alter table public.coupons add column if not exists campaign_id uuid references public.marketing_campaigns(id) on delete set null;
alter table public.coupons add column if not exists assigned_phone text;
create index if not exists idx_coupons_campaign on public.coupons(campaign_id) where campaign_id is not null;

-- 8. Claim RPC — NO reclaim of stale 'sending' rows (a resend after a crash
--    mid-send would double-message and double-charge; losing one message is
--    the lesser harm — the sender marks stale rows failed/'interrupted').
create or replace function public.claim_marketing_recipients(p_limit int)
returns setof public.marketing_recipients
language sql security definer set search_path = public as $$
  update public.marketing_recipients r
     set status = 'sending', claimed_at = now(), attempts = r.attempts + 1
   where r.id in (
     select r2.id from public.marketing_recipients r2
       join public.marketing_campaigns c on c.id = r2.campaign_id
      where r2.status = 'queued'
        and c.status in ('approved','sending')
        and (c.send_after is null or c.send_after <= now())
      order by c.priority, r2.created_at
      limit greatest(0, least(p_limit, 200))
      for update of r2 skip locked)
  returning r.*;
$$;
revoke all on function public.claim_marketing_recipients(int) from public, anon, authenticated;
grant execute on function public.claim_marketing_recipients(int) to service_role;

-- 9. RLS on + revoke for: menu_item_costs, marketing_settings, marketing_consent,
--    marketing_consent_events, marketing_playbooks, marketing_campaigns, marketing_recipients.

-- 10. pg_cron 'marketing-send-poll' every 5 min → POST https://hioc.in/api/cron/marketing-send
--     (copy the feedback-requests block: same Vault secret 'cron_secret', same unschedule-if-exists guard).
```

---

## 4. Code layout

```
lib/marketing/                    (pure, client-safe — no 'server-only', no supabase)
  types.ts        all marketing types, constants, defaults, API response shapes (§6)
  segments.ts     buildContactStats, lifecycleStage, stageThresholds, weeklyActive, detectDrop
  points.ts       expiringWithin, expiryDateFor
  economics.ts    offerCost, project, blendedRate, rankFreeItems, blendedFoodCost, guardrailFlags
  eligibility.ts  evaluateContact (rules §1.5), assignPlaybooks (priority + dedupe)
  offers.ts       offerText, couponFieldsFor, generateCouponCode(rng), validTill
  templates.ts    TEMPLATE_TOKENS, buildVars, sanitizeParam, renderPreview, firstName
  parse.ts        parseSettingsPatch, parsePlaybookPatch, parseManualCampaign, parseCostsPut
lib/marketing/server/             ('server-only')
  repo.ts         loaders: settings, playbooks, consent, opt-outs, profiles, orders(365d), loyalty rows, recent recipients, costs
  consent.ts      recordOptIn / recordOptOut / optInKeyword
  audience.ts     buildContacts(now) — joins repo data → ContactStats[]
  planner.ts      runDailyPlan(now) — attribution, learning, playbook campaigns
  campaigns.ts    createManualDraft, approveCampaign, cancelCampaign, projectCampaign, expireStale
  sender.ts       runSendBatch(now) — claim → re-check → coupon → send → log
  attribution.ts  attributeRecipients(now)
  overview.ts     getOverview, getAudienceSummary
  costs.ts        listCosts, putCosts
```

**Adapter change (F1):** add optional `templateName?: string; templateLang?: string` to `SendInput`. When `templateName` is set, `whatsappAdapter` uses it (and `templateLang ?? WHATSAPP_TPL_LANG ?? 'en'`) **instead of** the event map, and still sends a template even when `event` is absent, as long as `templateVars` is present. Existing event-based callers must behave byte-for-byte the same, and the `#132001` language fallback still applies. Marketing sends call `whatsappAdapter` directly (not `getAdapter()`). If `blockedProviderVars()` reports WhatsApp as not configured, recipients are `skipped` with `not_configured`. They are never sent through the stub.

---

## 5. Templates (owner creates these in Meta; the dashboard maps them)

A template config lives in `playbook.template` / `campaign.template`:

```ts
{ name: string; lang: string; vars: TemplateToken[]; url_button: boolean; body_preview: string }
```

- `vars` is the ordered list of tokens filling `{{1}}..{{n}}`.
- With `url_button: true`, the recipient's `click_token` is sent as the URL button's dynamic suffix at `index: 0`.
- `body_preview` is the owner's copy of the approved body, with `{{n}}`, used only for the dashboard preview.

Tokens: `first_name` (first word of the profile name, max 20 chars, fallback "there") · `points` · `points_value_inr` · `expiring_points` · `expiring_value_inr` · `expiry_date` ("5 Oct") · `offer_text` · `code` · `valid_till` ("12 Oct") · `days_since_visit` · `headline` (manual campaigns only, owner-typed, max 60 chars).

`sanitizeParam` does the following, because Meta rejects params with these:
1. Strips `\n`, `\r` and `\t`.
2. Collapses runs of spaces.
3. Trims.
4. Caps the length at 100.
5. Replaces an empty result with `-`.

Default templates (full submission guide: `docs/WHATSAPP-MARKETING-TEMPLATES.md`). **Category Marketing, language `en`**, footer "Reply STOP to unsubscribe". Buttons: URL "Order now" → `https://hioc.in/r/{{1}}` and Meta's **Marketing opt-out** quick reply ("Stop promotions").

| Name | Body | vars |
|---|---|---|
| `hioc_points_expiring_1` | Hi {{1}}, {{2}} of your HIOC reward points (worth ₹{{3}}) expire on {{4}}. Use them on your next coffee or waffle: just share your number at the counter, or log in when you order online. See you soon! | first_name, expiring_points, expiring_value_inr, expiry_date |
| `hioc_points_balance_1` | Hi {{1}}, you have {{2}} HIOC reward points worth ₹{{3}} waiting for you. Redeem them on your next visit: just share your number at the counter, or log in when you order online. See you soon! | first_name, points, points_value_inr |
| `hioc_winback_1` | Hi {{1}}, we've missed you at HIOC! Here's {{2}} on your next visit. Use code {{3}} at the counter or online, valid till {{4}}. Your favourites are waiting! | first_name, offer_text, code, valid_till |
| `hioc_offer_1` | Hi {{1}}, {{2}} at HIOC! Enjoy {{3}} with code {{4}}, valid till {{5}}. See you soon. | first_name, headline, offer_text, code, valid_till |

Default mapping: `points_expiring → hioc_points_expiring_1`, `points_balance → hioc_points_balance_1`, and all three win-back stages → `hioc_winback_1`. Manual campaigns default to `hioc_offer_1`.

---

## 6. APIs

Every owner route calls `getOwnerUser()` (401 otherwise), uses `createAdminSupabaseClient`, and returns **409 `{error:'migration_missing'}`** when a marketing table is absent (Postgres `42P01` / PostgREST `PGRST205`). Response types live in `lib/marketing/types.ts`.

| Method & path | Body / query | Response |
|---|---|---|
| GET `/api/owner/marketing/overview` | — | `MarketingOverview` |
| GET `/api/owner/marketing/audience` | — | `AudienceSummary` |
| GET / PATCH `/api/owner/marketing/settings` | `Partial<MarketingSettings>` | `{ settings: MarketingSettings }` |
| GET `/api/owner/marketing/playbooks` | — | `{ playbooks: PlaybookView[] }` |
| PATCH `/api/owner/marketing/playbooks/[key]` | `{ mode?, params?, offer?, template?, prior_conversion_pct? }` | `{ playbook: PlaybookView }` |
| GET `/api/owner/marketing/campaigns` | `?status=pending_approval\|active\|history` | `{ campaigns: CampaignSummary[] }` |
| POST `/api/owner/marketing/campaigns` | `ManualCampaignInput` (`{name, audience, offer, template, headline?, send_after?}`) | `{ campaign: CampaignDetail }` (status `draft` with projection) |
| POST `/api/owner/marketing/campaigns/preview` | `ManualCampaignInput` | `{ eligible, projection: Projection, guardrail_flags, samples: RecipientPreview[] }` (not saved) |
| GET `/api/owner/marketing/campaigns/[id]` | `?page=` | `CampaignDetail` (with `recipients` page of 50 + `results: CampaignResults`) |
| POST `/api/owner/marketing/campaigns/[id]/approve` | — | `{ campaign }`. Only from `draft` / `pending_approval` → recipients `pending→queued`, campaign `approved` |
| POST `/api/owner/marketing/campaigns/[id]/cancel` | — | `{ campaign }`. From any non-terminal status → `pending`/`queued` recipients `cancelled` |
| POST `/api/owner/marketing/test-send` | `{ template, phone? }` (default: the owner's profile phone) | `{ ok, error?, provider_ref? }`. Rate limit `rateLimitOk('mkt-test:<uid>',5,3600)`. Sample var values. Not logged as a recipient |
| GET / PUT `/api/owner/marketing/costs` | PUT `{ costs: {variant_id, cost_inr: number\|null}[] }` (null deletes; server looks up `menu_item_id`) | `{ items: CostRow[], default_food_cost_pct, coverage_pct, free_item_ranking: FreeItemCandidate[] }` |
| POST `/api/owner/marketing/consent/opt-out` | `{ phone }` | `{ ok: true }` |
| GET/POST `/api/cron/marketing-plan` | `CRON_SECRET` bearer | `{ enabled, attributed, planned: {key, status, eligible}[], expired }` |
| GET/POST `/api/cron/marketing-send` | `CRON_SECRET` bearer | `{ enabled, outside_window?, budget_exhausted?, claimed, sent, skipped, failed, interrupted }` |
| GET `/r/[token]` (page route, public) | — | stamps `clicked_at` (first click only), then 302 to `/menu`. An unknown token also goes to `/menu`. No PII in the URL |

`vercel.json` adds `{ "path": "/api/cron/marketing-plan", "schedule": "15 4 * * *" }` (09:45 IST). As a fallback when pg_cron isn't set up, the plan route calls `runSendBatch` once at the end if it is inside the send window.

**Sender algorithm (`runSendBatch`):**
1. If settings are missing or `enabled=false`, stop.
2. Mark `sending` rows with `claimed_at` older than 15 minutes as `failed` (`error='interrupted'`, cost 0).
3. If the current IST hour is outside [start, end), stop.
4. Compute month spend = Σ `cost_inr` of recipients with `sent_at` in the current IST month. Compute `budget_left = monthly_budget_inr − spend` and `affordable = floor(budget_left ÷ message_cost_inr)` (∞ if the cost is 0).
5. Compute `today_left = daily_send_cap − sent today` (IST).
6. Claim `min(50, affordable, today_left)` rows.
7. For each claimed row:
   1. Re-check §1.5 rules 1, 3, 4 and 5; if one fails, mark it `skipped` with the reason.
   2. Issue a coupon if the offer needs one.
   3. Build the vars.
   4. Call `whatsappAdapter.send({ to, channel:'whatsapp', body: renderPreview(...), templateName, templateLang, templateVars, templateButtons: url_button ? [{index:0, text: click_token}] : undefined })`.
   5. If ok: `sent`, `sent_at`, `reference_at = sent_at`, `provider_ref`, `cost_inr = message_cost_inr`.
   6. If not ok: `failed` with `error` / `error_code` (parse `(#NNNNNN)`), cost 0, and **deactivate the coupon** (`active=false`). If the code is `131050`, also `recordOptOut`.
8. Set the campaign to `sending` and stamp `started_at` (plus holdout recipients' `reference_at` if null) on the first send. Set it to `completed` + `completed_at` once it has no `pending`/`queued`/`sending` rows left.

**Planner (`runDailyPlan`):**
1. Attribution (§1.8) for recipients whose `reference_at` is within the last `attribution_days + 1` days and not converted.
2. Learning (§1.6): for campaigns whose window closed since the last run, add counts to the playbook's observed counters **once**, guarded by `projection.learned_at`.
3. Expire campaigns still in `pending_approval` after more than 2 days (`status='expired'`, recipients `cancelled`).
4. If `enabled=false`, stop here and return.
5. `buildContacts(now)` → `assignPlaybooks` by priority (§1.4, §1.5).
6. For each playbook with `mode ≠ off` and ≥ 1 eligible contact, insert a campaign. The unique `(playbook_key, planned_for)` makes a re-run a no-op: catch `23505` and skip.
   1. Freeze offer, template and a params snapshot on the campaign, and compute the projection and flags.
   2. Randomly assign `holdout_pct` of contacts to `arm='holdout'` / `status='holdout'`. Use a deterministic shuffle seeded by the campaign id so tests are stable.
   3. Treated recipients get a `click_token` and `vars` frozen at plan time.
   4. `mode='auto'` with no guardrail flags → campaign `approved`, recipients `queued`. Otherwise → campaign `pending_approval`, recipients `pending`.

**Webhook changes** (`app/api/webhooks/whatsapp/route.ts`):
- (a) When a status update matches no `notifications` row, apply it to `marketing_recipients` by `provider_ref`. It is forward-only: `sent < delivered < read`, and `failed` is only accepted from `sending`/`sent`. On `failed`, set `cost_inr=0` and store the code; on 131050, call `recordOptOut`.
- (b) Handle the consent keywords, button text and `user_preferences` field from §2 **before** the feedback-thread logic. Inbound messages are still stored the way STOP stores them today.
- (c) Update the STOP reply text.
- (d) Change nothing else in the feedback flow.

---

## 7. Owner dashboard — `/owner/marketing`

Gated by `flags.marketing` (`NEXT_PUBLIC_FLAG_MARKETING`, default **false**). When it is off, the nav link is hidden and the page shows "Marketing isn't enabled". The page is a client component with tabs held in `?tab=`. On a 409 it shows "Apply `supabase/2026-10-marketing-agent.sql` in Supabase → SQL editor, then reload". Styling follows the owner pages: `mx-auto max-w-7xl px-4 py-6`, cards `rounded-md border border-line bg-cream p-5 shadow-sm`, `ToggleSwitch`, `DataTable`, `inr()`.

1. **Overview**
   - Kill-switch banner: "Sending is OFF" with a turn-on button, or "Sending is ON".
   - KPI tiles:
     - Opted-in customers (and % of active)
     - This month's spend vs budget (progress bar)
     - Messages sent (30d), delivered % and read %
     - Returning orders (30d) and revenue
     - Measured lift vs holdout
     - Est. ROI
   - Drop-alert banner and the insights list with CTA buttons.
   - Weekly active customers chart (9 bars, inline SVG) with an orders line.
   - Recent campaigns table.
2. **Approvals**
   - One card per `pending_approval` / `draft` campaign.
   - Each card shows the name, stage, audience (treated + holdout), offer text and template name.
   - It also shows the projection grid: message cost, expected returning orders, revenue, offer cost, expected profit, ROI and break-even conversion.
   - Guardrail flags appear as red chips with plain-English explanations.
   - Up to 3 sample message previews.
   - Buttons: **Approve & send**, **Skip**.
3. **Playbooks**: one card per playbook in priority order, each with:
   - Off / Review / Auto segmented control, with Auto explained as "sends automatically only when every guardrail passes".
   - Params fields.
   - Offer editor: type none / percent / flat / free_item. For free_item, a variant picker showing price, cost and value-per-₹, with "Auto (best value)" as the default. Min order, cap and validity fields.
   - Template editor: name, lang, ordered token list, URL-button toggle, body preview, **Send test to my phone** button.
   - Conversion: prior %, learned % and observed counts.
   - Last runs.
   - Save.
4. **Campaigns**
   - Active and history tables (status, sent, delivered, read, clicked, returned, revenue, spend, lift).
   - Row → detail drawer with a recipients table, including skip reasons.
   - **New campaign** wizard, with a live projection via `/preview` as fields change (debounced 400ms), then **Create draft** → the draft appears in Approvals. The steps:
     1. Name + headline
     2. Audience filter, with a live eligible count
     3. Offer
     4. Template
     5. Schedule: now or date/time
5. **Audience**
   - Counts per lifecycle stage (all identified customers vs opted in).
   - Points: customers with a balance, ₹ outstanding, ₹ expiring within 7 days.
   - Consent: opted in / out, by source, and the last 30 days of events.
   - **Opt-in link + QR** (`qrcode` package, already a dependency) for `wa.me/<number>?text=START`, a printable "Scan to get HIOC offers on WhatsApp" card, and a notice if `whatsapp_business_number` is empty.
   - "Record an opt-out" form.
   - A note that owners can't add opt-ins.
6. **Product costs**
   - Table with one row per variant: category, item, variant label, price, cost input (₹), food-cost %, margin ₹. Rows with food cost above 50% are highlighted.
   - Bulk save.
   - Coverage % and the default food-cost %.
   - "Best free-item offers" top 5.
7. **Settings**: every `marketing_settings` field with help text. The kill switch is the first field, and the message cost says "Meta marketing rate + 18% GST, ₹1.02 as of 2026".

Also:
- An `OwnerHeader` link "Marketing" after Promotions, when the flag is on.
- An `/owner` overview card (flag on): pending approvals, month spend / budget and the drop alert, linking to `/owner/marketing`.
- The customer opt-in card on `/order-confirmation/[orderId]` (§2), shown only when the flag is on.

---

## 8. Build slices

The Sonnet engineers build in three slices. Each slice lands with `npx tsc --noEmit`, `npm run lint` and `npm test` green.

| Slice | Contents | Files owned |
|---|---|---|
| **S1 — Foundation** | Migration (§3); `lib/marketing/*` pure modules + types incl. API response shapes (§4, §6); `lib/flags.ts` `marketing`; `verify-db` `checkMarketingAgent` (columns; anon sees 0 rows of `menu_item_costs` + `marketing_consent`); unit tests for segments, points, economics, eligibility, offers, templates, parse | `supabase/2026-10-marketing-agent.sql`, `lib/marketing/*.ts`, `lib/flags.ts`, `scripts/verify-db.mjs`, `tests/marketing*.test.ts`, `.env.local.example` |
| **S2 — Engine & APIs** | `lib/marketing/server/*`; adapter `templateName`; coupon phone-lock + hide campaign coupons; account/me consent sync; webhook changes; crons; owner APIs; `/r/[token]`; `vercel.json`; route + server tests | `lib/marketing/server/**`, `lib/notifications/adapters.ts`, `lib/promotions/coupons.ts`, `app/api/coupons/route.ts`, `app/api/account/me/route.ts`, `app/api/webhooks/whatsapp/route.ts`, `app/api/owner/marketing/**`, `app/api/cron/marketing-*/**`, `app/r/[token]/**`, `vercel.json`, `tests/marketing*Route.test.ts` etc. |
| **S3 — Dashboard & docs** | `/owner/marketing` + components; nav link; `/owner` card; order-confirmation opt-in card; `docs/WHATSAPP-MARKETING-TEMPLATES.md`; `docs/MARKETING-AGENT-SETUP.md` (owner runbook) | `app/owner/marketing/**`, `components/owner/marketing/**`, `components/owner/OwnerHeader.tsx`, `app/owner/page.tsx`, `app/order-confirmation/[orderId]/**`, `components/marketing/**`, `docs/WHATSAPP-MARKETING-TEMPLATES.md`, `docs/MARKETING-AGENT-SETUP.md` |

S2 and S3 run in parallel after S1. The contract between them is `lib/marketing/types.ts` plus §6.

### Traps (read before coding)

1. **Costs must never be publicly readable.** No column on `menu_items`/`menu_item_variants`, and no cost field in any public API (`/api/menu`).
2. **No stub sends.** Marketing never goes through `getAdapter()`'s log fallback. Not configured means skipped.
3. **Consent is re-checked at send time.** Approval can be days before sending.
4. **Never reclaim `sending` rows.** Mark them `interrupted`.
5. **Coupons are issued at send, and deactivated on send failure.** Campaign coupons are hidden from the promotions list.
6. **The adapter change must not alter existing sends.** The existing adapter tests must stay green unchanged.
7. **The webhook is a security boundary.** Don't touch HMAC verification, and don't trust a phone from anywhere but the signed payload.
8. **All dates/hours are IST** (`Asia/Kolkata`). Month budget and daily cap reset at IST midnight.
9. **Money is integer rupees** in coupons/orders. Projections may be decimals but are rounded for display.
10. **Degrade, don't crash**, when the migration isn't applied: 409 from owner APIs, a no-op `{enabled:false, migration_missing:true}` from crons, and the webhook falls through to existing behaviour.
11. **Tests must not hit the network.** Mock `whatsappAdapter` and Supabase the way existing tests do (`vi.mock('@/lib/supabase-server', …)`, `tests/helpers/fakeAdmin.ts`).

---

## 9. What the owner must do to go live

These steps are also in `docs/MARKETING-AGENT-SETUP.md`.

1. Apply `supabase/2026-10-marketing-agent.sql` in the SQL editor, then run `npm run verify:db`.
2. Set `NEXT_PUBLIC_FLAG_MARKETING=true` in Vercel and redeploy.
3. **Set `WHATSAPP_APP_SECRET`** and subscribe the webhook to the `messages` **and** `user_preferences` fields. Without this, STOP/START, receipts and lift measurement don't work.
4. Create the 4 templates in WhatsApp Manager (`docs/WHATSAPP-MARKETING-TEMPLATES.md`) and wait for approval.
5. `/owner/marketing` → Settings: enter the WhatsApp business number and budget. Product costs: enter costs.
6. Print the opt-in QR card for tables and the counter.
7. Playbooks: **Send test to my phone** for each, then set `points_expiring` and `winback_1` to **Review**.
8. Turn **Sending ON**. Approve the first campaigns by hand for a week or two, then move proven playbooks to **Auto**.

## 10. Out of scope (next)

- Staff-recorded counter consent on the POS
- Birthday/anniversary playbook (DOB exists in `profiles`)
- Slow-hour/slow-day boosters
- Double-points offers
- LLM-written weekly insight narrative
- Utility-category transactional points statements
- Fixing F12 (the `'feedback'` notifications CHECK)
