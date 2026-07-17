# HIOC Revamp — Phase 2 Sprint & Epic Plan

**Companion to:** `docs/PHASE-2-SPEC.md`, `docs/PHASE-2-RICE.md`, `supabase/phase2-migration.sql`
**Version:** 0.1 (Draft for sprint-0 planning)
**Date:** 2026-07-17
**Owner:** Product (Senior PM)
**Scope:** The Phase-2 "Value & Retention" release (Payments · Accounts · Loyalty), committed scope from `PHASE-2-RICE.md §5`. Assumes Phase 1 is live.

---

## 1. Planning assumptions (same team as Phase 1)

| Assumption | Value |
|---|---|
| Team | 3 engineers (2 full-stack + 1 frontend-leaning), fractional design/QA/PM |
| Sprint length | 2 weeks · 1 pt ≈ 1 focused dev-day |
| Target velocity | ~20–22 pts / sprint (buffered) |
| Total Phase-2 size | **≈ 157 pts** (≈ 31 dev-weeks — in line with Phase 1) |
| Duration | **8 sprints ≈ 16 weeks (~4 months)**, incl. a hardening/UAT sprint |
| DoD | Per `docs/PHASE-2-SPEC.md §0` |

> **New this phase (extra QA weight):** money movement (payments/refunds/reconciliation) and a **new RLS pattern** (logged-in customers reading their own data). Security + test tickets are heavier than Phase 1 — budgeted in Epic Q.

---

## 2. Epics

| Epic | Name | Pts | Maps to |
|---|---|--:|---|
| **P-FND** | Payment & platform foundations | 39 | FND-1…5 |
| **PAY** | Payments (customer + staff) | 16 | PAY-1/2/3 |
| **ACC** | Accounts | 21 | ACC-1…5 |
| **LOY** | Loyalty & Promotions | 27 | LOY-1/2/3/5 |
| **RET** | Retention & payment analytics | 29 | RET-1…6 |
| **Q** | Quality, Security & Release | 25 | tests, PCI/RLS, DPDP, hardening |
| | **Total** | **157** | |

*(Stretch — not in the 157: PAY-4 wallet, LOY-4 referral, RET-7 funnel.)*

---

## 3. Ticket backlog (by epic)

### Epic P-FND — Foundations (39 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| FND-1 | Payment gateway integration (UPI/hosted, webhooks, reconcile-poll) | FND-1 | 13 | migration, **provider decision** |
| FND-5 | Manager role + permission matrix | FND-5 | 5 | P1 RBAC |
| FND-2 | Refunds + settlement reconciliation | FND-2 | 8 | FND-1, FND-5 |
| FND-3 | Coupon / promo engine (validation, redemption record) | FND-3 | 8 | P1 bill breakup |
| FND-4 | Loyalty ledger (earn/redeem/adjust, balance = Σ ledger) | FND-4 | 8 | ACC-1 |

### Epic PAY — Payments (16 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| PAY-1 | Online payment at checkout (+ pay-at-counter choice) | PAY-1 | 8 | FND-1, FND-3, FND-4 |
| PAY-2 | Payment status distinct from fulfillment + retry | PAY-2 | 3 | PAY-1 |
| PAY-3 | Refund from manager (full/partial) + notify | PAY-3 | 5 | FND-2 |

### Epic ACC — Accounts (21 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| ACC-1 | Phone-OTP authentication | ACC-1 | 5 | P1 notif channel |
| ACC-2 | Order history (server route, own orders) | ACC-2 | 5 | ACC-1, `orders.user_id` |
| ACC-3 | Saved profile & prefs (server-route writes, never role) | ACC-3 | 3 | ACC-1 |
| ACC-4 | Reorder + guest-order claim by phone | ACC-4 | 5 | ACC-1, ACC-2 |
| ACC-5 | Favorites | ACC-5 | 3 | ACC-1 |

### Epic LOY — Loyalty & Promotions (27 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| LOY-2 | Coupon / promo-code entry (UI) | LOY-2 | 3 | FND-3 |
| LOY-1 | Loyalty program (earn/redeem UI, rewards page) | LOY-1 | 8 | FND-4, ACC-1 |
| LOY-3 | Ratings, reviews & feedback + owner response | LOY-3 | 8 | P1 state machine, notif |
| LOY-5 | Campaign / coupon mgmt + banners + broadcast | LOY-5 | 8 | FND-3, consent (ACC-3) |

### Epic RET — Retention & payment analytics (29 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| RET-1 | Customer analytics (repeat/LTV/cohort/top) | RET-1 | 8 | ACC-1, P1 pipeline |
| RET-2 | Payment analytics (mix, collected/pending, refunds) | RET-2 | 3 | FND-1/2 |
| RET-3 | Promotions analytics / ROI | RET-3 | 5 | FND-3/4 |
| RET-4 | Ratings / feedback summary | RET-4 | 3 | LOY-3 |
| RET-5 | Exports + scheduled reports | RET-5 | 5 | P1 pipeline, notif |
| RET-6 | Audit log viewer + payment settings UI | RET-6 | 5 | FND-5, FND-1 |

### Epic Q — Quality, Security & Release (25 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| Q1 | Payment webhook + refund tests (idempotency, double-charge, reconcile) | DoD | 8 | FND-1/2 |
| Q2 | Coupon + loyalty math tests (stacking, expiry, claw-back) | DoD | 3 | FND-3/4 |
| Q3 | **PCI + new per-user RLS review** (customers read own data) | NFR-004 | 3 | ACC/LOY tables |
| Q4 | DPDP consent flow + copy for marketing broadcasts | NFR-005 | 2 | LOY-5 |
| Q5 | Reconciliation hardening + settlement report | FND-2 | 4 | FND-2 |
| Q6 | UAT / bugfix buffer | — | 5 | all |

---

## 4. Sprint-by-sprint allocation

Pillar-sequenced, enabler-first (per `PHASE-2-RICE.md §4`). Each sprint ends demoable.

| Sprint | Theme | Tickets | Pts | Demo / exit criteria |
|---|---|---|--:|---|
| **1** | Payment foundations | FND-1, FND-5 | 18 | Gateway integrated in **test mode**; manager role gates sensitive actions |
| **2** | Payments live | PAY-1, PAY-2, FND-2 | 19 | Online payment end-to-end (test); failed payments never queue; refund backend ready |
| **3** | Payments done + accounts start | PAY-3, RET-2, Q1, ACC-1, ACC-3 | 21 | Manager refunds + notify; payment analytics; **first payment tests green**; phone-OTP login |
| **4** | Accounts | ACC-2, ACC-4, ACC-5, RET-1 | 21 | Order history, **reorder + guest-claim**, favorites; customer analytics |
| **5** | Promotions engine + coupons | FND-3, LOY-2, FND-4 | 19 | Coupon codes validate & apply in the bill; loyalty ledger ready |
| **6** | Loyalty + ratings | LOY-1, LOY-3, RET-4 | 19 | Points earn/redeem; post-order ratings + owner response; ratings summary |
| **7** | Owner promo tooling + analytics | LOY-5, RET-3, RET-5, Q2 | 21 | Owner creates coupons/campaigns/banners; promo ROI; exports/scheduled reports; **coupon/loyalty tests green** |
| **8** | Hardening & release | RET-6, Q3, Q4, Q5, Q6 | 19 | Audit + payment settings UI; PCI/RLS + DPDP gates pass; reconciliation hardened; UAT bugs cleared → RC |

**Cumulative:** 18 · 37 · 58 · 79 · 98 · 117 · 138 · 157 pts.

---

## 5. Milestones & demos

| Milestone | End of | What's provable |
|---|---|---|
| **M1 — Payment rails up** | Sprint 1 | Gateway + manager role working (test mode) |
| **M2 — Customers can pay online** | Sprint 3 | Online payment + refunds live (pilot candidate on a % of orders) |
| **M3 — Identity & reorder** | Sprint 4 | Phone-OTP login, order history, one-tap reorder, guest-claim |
| **M4 — Loyalty & coupons live** | Sprint 6 | Earn/redeem points, promo codes, post-order ratings |
| **M5 — Owner retention tooling** | Sprint 7 | Campaign management + customer/promo analytics + exports |
| **M6 — Release candidate** | Sprint 8 | DoD met (incl. PCI/RLS/DPDP gates); staged rollout ready |

**Rollout after M6:** enable online payment behind a flag for a **small % of orders** → watch success/refund rates → widen. Loyalty/coupons dark-launched to staff first, then customers. Keep pay-at-counter as the always-available default throughout.

---

## 6. Scope levers — what flexes if behind

Cut in this order (protects the money + identity core):
1. **RET-3** promo analytics → Phase 3 (owner can eyeball coupon usage short-term).
2. **ACC-5** favorites → Phase 3.
3. **LOY-5** campaign mgmt UI → owner sets coupons via a simpler form/SQL short-term (FND-3 engine still ships).
4. **RET-5** scheduled reports → manual export short-term (keep the one-off export).

**Never cut:** FND-1 gateway, FND-2 refunds, FND-5 manager role, PAY-1/2/3, ACC-1 phone-OTP, ACC-2 history, ACC-4 reorder, FND-3/4 engines, LOY-1/2 core, Q1/Q3/Q5 money+security gates.

---

## 7. Dependencies & risks (plan-level)

| # | Dependency / risk | Owner | Needed by | Mitigation |
|---|---|---|---|---|
| 1 | **Payment provider + fees** decision | Owner + PM | Sprint 1 (FND-1) | Decide in sprint-0; build gateway layer provider-agnostic |
| 2 | **Loyalty mechanic** (points rate / stamps / tiers, expiry) | Owner + PM | Sprint 5 (FND-4) | Confirm by end of Sprint 3; `loyalty_config` makes rates data, not code |
| 3 | **Coupon ↔ loyalty stacking** rules | PM | Sprint 5 (FND-3) | Define precedence up front; engine enforces it |
| 4 | **Money-movement correctness** (double-charge, refund, reconcile) | Eng lead | Sprint 2–3 | Idempotent webhooks, Q1 tests, Q5 reconciliation, manager-gated refunds |
| 5 | **New per-user RLS** exposes customer data to the client | Eng lead | Sprint 3–4 | Q3 review; keep order *detail* server-side; scope `auth.uid() = user_id` tightly |
| 6 | **DPDP consent** for marketing broadcasts | PM + legal | Sprint 7 (LOY-5) | Consent-first; transactional vs marketing separation (already in P1) |
| 7 | Refund/settlement edge cases with the gateway | Eng + Ops | Sprint 8 (Q5) | Reconciliation view + mismatch flags; documented refund SOP |

---

## 8. Post-launch success metrics (validate the Phase-2 bet)

Measured at 2 and 6 weeks post-launch, tied to Requirements §2 objectives:
- **Payments:** % orders paid online; payment success rate; refund rate; counter time saved.
- **AOV & attach:** AOV vs Phase-1 baseline; addon/coupon effect on basket.
- **Retention:** 30/60/90-day repeat rate; % orders from returning/logged-in customers; reorder usage.
- **Loyalty:** enrollment rate; points redemption rate; repeat-rate lift for enrolled vs not.
- **Promotions:** coupon redemption rate; promo ROI (incremental revenue vs discount cost).
- **Feedback:** rating volume + average; low-rating follow-up rate.

---

## 9. Next steps

1. **Sprint-0:** review with eng; confirm estimates/velocity; lock the payment provider + loyalty mechanic (§7 rows 1–2).
2. Apply `supabase/phase2-migration.sql` on a branch; sync `lib/types.ts`.
3. Load tickets FND-1…Q6 into the tracker with these estimates/dependencies.
4. Kick off Sprint 1 (Payment foundations).
