# HIOC Revamp — Phase 2 RICE Re-score

**Companion to:** `docs/PHASE-2-SPEC.md`, `docs/RICE-PRIORITIZATION.md`
**Version:** 0.1 (Draft for Phase-2 planning)
**Date:** 2026-07-17
**Owner:** Product (Senior PM)
**Purpose:** Re-score the Phase-2 ticket set (from `PHASE-2-SPEC.md`) so the **pillar order and within-pillar sequence are confirmed by the numbers**, and the stretch items are cleanly separated from the committed scope.

---

## 1. Method (unchanged from Phase 1)

**RICE = (Reach × Impact × Confidence) ÷ Effort.** Same fixed scales as `docs/RICE-PRIORITIZATION.md §1`:

| Factor | Scale |
|---|---|
| **Reach (R)** | 1–10 — breadth within the target audience per day |
| **Impact (I)** | 0.25 / 0.5 / 1 / 2 / 3 |
| **Confidence (C)** | 0.5 / 0.8 / 1.0 |
| **Effort (E)** | person-weeks (1 dev-week = 1.0) |

**🔑 Enabler** = pillar foundation whose *direct* RICE understates its value (the whole pillar rides on it) → sequenced first regardless of raw score, exactly as in Phase 1.

**Note on re-scoring vs Phase 1:** several Phase-1 scores rose here because the **backend was split out into a foundation ticket**. E.g. coupons (CUS-029) scored 1.8 in Phase 1 *with* its backend bundled in; here the engine is FND-3 and the **LOY-2 coupon UI** on top is cheap → 7.2. This is expected and correct — it's why we score at the ticket level.

---

## 2. Scored Phase-2 tickets (sorted by RICE ↓)

### 2.1 Foundations
| Ticket | Requirement | R | I | C | E | **RICE** | Flag |
|---|---|--:|--:|--:|--:|--:|---|
| FND-5 | Manager role + permissions | 5 | 1.5 | 0.8 | 1.5 | **4.0** | Gates refunds |
| FND-3 | Coupon / promo engine | 6 | 1.5 | 0.7 | 2.0 | **3.2** | 🔑 |
| FND-4 | Loyalty ledger | 6 | 2 | 0.6 | 2.5 | **2.9** | 🔑 |
| FND-1 | Payment gateway (UPI/hosted) | 7 | 2 | 0.7 | 4.0 | **2.5** | 🔑 |
| FND-2 | Refunds & reconciliation | 5 | 1.5 | 0.6 | 2.5 | **1.8** | 🔑 |

### 2.2 Payments
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| PAY-2 | Payment status & retry | 7 | 1 | 0.7 | 1.0 | **4.9** | Cheap, protects revenue |
| PAY-3 | Refund from manager | 4 | 2 | 0.7 | 1.5 | **3.7** | Needs FND-2/5 |
| PAY-1 | Online payment checkout | 7 | 2 | 0.7 | 3.0 | **3.3** | Headline of the pillar |
| PAY-4 | Wallet / prepaid credits | 2 | 1 | 0.5 | 4.0 | **0.3** | ⏭ Stretch |

### 2.3 Accounts
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| ACC-2 | Order history | 5 | 1.5 | 0.8 | 1.5 | **4.0** | |
| ACC-3 | Saved profile & prefs | 5 | 1 | 0.8 | 1.0 | **4.0** | |
| ACC-1 | Phone-OTP auth | 6 | 1.5 | 0.8 | 2.0 | **3.6** | 🔑 Accounts entry |
| ACC-4 | Reorder & guest claim | 5 | 2 | 0.7 | 2.0 | **3.5** | Retention driver |
| ACC-5 | Favorites | 4 | 0.5 | 0.7 | 1.0 | **1.4** | |

### 2.4 Loyalty & Promotions
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| LOY-2 | Coupons / promo codes (UI) | 6 | 1.5 | 0.8 | 1.0 | **7.2** | Rides FND-3 |
| LOY-3 | Ratings, reviews & feedback | 6 | 1.5 | 0.7 | 2.5 | **2.5** | |
| LOY-1 | Loyalty program (UI) | 6 | 2 | 0.6 | 3.0 | **2.4** | Rides FND-4 |
| LOY-5 | Campaign & announcement mgmt | 4 | 1.5 | 0.6 | 3.0 | **1.2** | |
| LOY-4 | Referral program | 3 | 1 | 0.5 | 3.0 | **0.5** | ⏭ Stretch |

### 2.5 Retention & payment analytics (Owner)
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| RET-2 | Payment analytics (mix, refunds) | 6 | 1 | 0.8 | 1.0 | **4.8** | |
| RET-5 | Exports & scheduled reports | 6 | 1.5 | 0.8 | 2.0 | **3.6** | |
| RET-4 | Ratings / feedback summary | 5 | 1 | 0.7 | 1.0 | **3.5** | |
| RET-1 | Customer analytics (repeat/LTV/cohort) | 6 | 2 | 0.7 | 2.5 | **3.4** | |
| RET-6 | Audit log + payment settings | 5 | 1 | 0.8 | 1.5 | **2.7** | |
| RET-3 | Promotions analytics / ROI | 4 | 1 | 0.7 | 1.5 | **1.9** | |
| RET-7 | Cart abandonment funnel | 4 | 1.5 | 0.5 | 2.5 | **1.2** | ⏭ Stretch |

---

## 3. Consolidated Top 15 (committed scope)

| Rank | Ticket | Requirement | RICE | Pillar |
|--:|---|---|--:|---|
| 1 | LOY-2 | Coupons (UI) | 7.2 | Loyalty |
| 2 | PAY-2 | Payment retry | 4.9 | Payments |
| 3 | RET-2 | Payment analytics | 4.8 | Analytics |
| 4 | ACC-2 | Order history | 4.0 | Accounts |
| 5 | ACC-3 | Saved profile | 4.0 | Accounts |
| 6 | FND-5 | Manager role | 4.0 | Foundation |
| 7 | PAY-3 | Refund (manager) | 3.7 | Payments |
| 8 | ACC-1 | Phone-OTP 🔑 | 3.6 | Accounts |
| 9 | RET-5 | Exports / reports | 3.6 | Analytics |
| 10 | ACC-4 | Reorder & claim | 3.5 | Accounts |
| 11 | RET-4 | Ratings summary | 3.5 | Analytics |
| 12 | RET-1 | Customer analytics | 3.4 | Analytics |
| 13 | PAY-1 | Online checkout | 3.3 | Payments |
| 14 | FND-3 | Coupon engine 🔑 | 3.2 | Foundation |
| 15 | FND-4 | Loyalty ledger 🔑 | 2.9 | Foundation |

---

## 4. What the numbers say (and how it changes the plan)

1. **The pillar order you set holds — with a nuance.** Raw RICE would tempt us to do coupons (LOY-2, 7.2) first, but it's only cheap *because* FND-3 (3.2) pays the engine cost. Same for LOY-1↔FND-4 and all payments↔FND-1. **Enablers first, then the high-scoring UI on top** — identical to the Phase-1 lesson.

2. **Payments genuinely comes first.** Its enabler FND-1 (2.5) is the single biggest rock, and refunds (FND-2/PAY-3) can't exist without it *and* the manager role (FND-5). Front-loading payments de-risks the release.

3. **Accounts before Loyalty is confirmed.** ACC-1 (phone-OTP, 🔑) gates ACC-2/3/4 *and* the entire loyalty ledger (points need an identity). Loyalty UI (LOY-1) can't start until FND-4, which can't be meaningful until ACC-1.

4. **Analytics is cheap and rides existing rails.** RET-2/4/5 all score well because Phase-1's analytics pipeline already exists — they're mostly new queries + views, not new infrastructure. Interleave them *after* the pillar they measure lands.

5. **Clean stretch cut line.** PAY-4 wallet (0.3), LOY-4 referral (0.5), RET-7 funnel (1.2) fall well below everything else → **deferred to Phase 3**, not built in Phase 2 unless capacity frees up.

---

## 5. Committed vs stretch

**Committed (Phase 2):** all Foundations (FND-1…5), all Payments except wallet (PAY-1/2/3), all Accounts (ACC-1…5), Loyalty & Promotions except referral (LOY-1/2/3/5), and analytics RET-1…6.

**Stretch (→ Phase 3):** PAY-4 wallet, LOY-4 referral, RET-7 abandonment funnel. *Only pull in if a pillar finishes under estimate.*

**Parallel track (out of scope here):** the staff-ops items from `PHASE-2-SPEC.md §9` (KOT printing, walk-in POS-lite, receipt printing) — a separate "Phase 2b — Counter efficiency" mini-epic, not scored against these revenue/retention pillars.

---

## 6. Next step

Feeds directly into `docs/PHASE-2-SPRINT-PLAN.md` — the committed tickets above, sequenced enabler-first within each pillar.
