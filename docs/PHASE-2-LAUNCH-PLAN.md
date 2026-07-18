# HIOC Revamp — Phase 2 Delivery, QA & Launch Plan

**Companion to:** `docs/PHASE-2-SPEC.md`, `docs/PHASE-2-SPRINT-PLAN.md`, `docs/PHASE-2-RICE.md`, `supabase/phase2-migration.sql`
**Version:** 0.1 (Draft for delivery planning)
**Date:** 2026-07-17
**Owner:** Product (Senior PM)
**Purpose:** The operational plan for shipping Phase 2 safely — because Phase 2 **moves real money** (payments, refunds, reconciliation) and **opens a new data-exposure surface** (logged-in customers reading their own data via RLS). This is the QA strategy, staged rollout, go/no-go gates, and incident runbook that the sprint plan assumes but doesn't detail.

---

## 1. Why Phase 2 needs its own launch plan

Phase 1 was internal-risk (staff ops) + one-way notifications. Phase 2 changes the risk profile:

| New risk in Phase 2 | Blast radius if wrong |
|---|---|
| Online payments | Customer double-charged / charged-but-no-order / paid-but-lost |
| Refunds & reconciliation | Money refunded twice / never / mismatched settlements |
| Coupons & loyalty | Discount abuse, negative balances, revenue leakage |
| New per-user RLS | One customer reads **another** customer's orders/loyalty |
| Marketing broadcasts | DPDP breach (messaging non-consented users) |

**Principle:** ship the money and identity paths **behind flags, to a small % first, with pay-at-counter always available as the safe default**, and never remove the Phase-1 fallback until Phase 2 is proven.

---

## 2. Environments & configuration

| Item | Approach |
|---|---|
| Payment gateway | **Test mode** through Sprint 1–7; switch to **live keys** only at the M6 go-live gate. Keys in server-only env (never `NEXT_PUBLIC_`) |
| Feature flags (Phase-1 XC-045) | `payments_online`, `accounts`, `loyalty`, `coupons`, `marketing_broadcast` — each independently toggleable, default **off** in prod |
| Migration | Apply `phase2-migration.sql` on a **branch/preview DB** first (Section 1 enum block committed separately), verify, then prod. Sync `lib/types.ts` in the same PR |
| Secrets | Gateway key/secret, webhook signing secret, SMS/WhatsApp OTP creds — rotate before go-live; document owner |
| Webhooks | Gateway webhook → a dedicated verified endpoint; test-mode events replayed in staging |

---

## 3. QA / test plan

Phase 2 lands the repo's money + auth logic, so testing is heavier than Phase 1's. Test tickets (Epic Q in the sprint plan): **Q1** payment/refund, **Q2** coupon/loyalty math, **Q3** PCI + per-user RLS, **Q4** DPDP consent, **Q5** reconciliation.

### 3.1 Payments (Q1) — the critical path
| Scenario | Expected |
|---|---|
| Happy path: pay → webhook → order `received` | Order queued once; single `payments` row `paid` |
| **Duplicate webhook** (same gateway ref twice) | Idempotent — no double transition, no double order |
| Payment success, **webhook never arrives** | Reconciliation poll catches it within the window; order queued |
| Payment fails / user cancels | Order stays `payment_pending`, **never shown to staff**; cart preserved |
| **Double-tap pay** / two tabs | One charge; second deduped |
| Store closes mid-payment | Blocked; if charged, auto-refund path fires |
| Signature invalid on webhook | Rejected; logged; no state change |
| Amount tampering (client sends lower total) | Server recomputes total; gateway amount authoritative |

### 3.2 Refunds & reconciliation (Q1/Q5)
- Full refund; **partial refund**; refund > paid amount (blocked); refund on already-refunded (blocked).
- Manager-gated: plain `staff` cannot refund (flagged for approval instead).
- Refund fails at gateway → retried, surfaced, never silently lost.
- Daily settlement report reconciles `payments`/`refunds` vs gateway; mismatches flagged.

### 3.3 Coupons & loyalty math (Q2)
- Coupon: expired / min-order-not-met / usage-limit / per-user-limit / wrong scope → correct rejection reason.
- **Race on last remaining use** → atomic; never over-redeemed.
- Coupon + points redemption together → configured precedence; bill correct.
- Loyalty: earn on completed+paid; **reverse on refund/cancel**; balance always = Σ ledger; expiry entry correct; redemption never exceeds balance or `max_redeem_pct`.

### 3.4 Security — per-user RLS (Q3) — MUST pass to launch
- Logged-in customer A **cannot** read customer B's orders / loyalty / reviews (attempt via anon key with A's session).
- Order *detail* still server-side only; anon key can't reach `orders`/`order_items`.
- Customer cannot self-escalate role (profiles writes server-side, whitelisted columns, never `role`) — regression from Phase-1 guarantee.
- No card data (PAN/CVV) stored anywhere; only gateway refs.

### 3.5 Consent / DPDP (Q4)
- Marketing broadcast sends **only** to `marketing_consent = true`; transactional order messages still send regardless.
- Opt-out honored immediately; consent state auditable.

### 3.6 Regression
- Guest checkout + pay-at-counter (Phase-1 path) **unchanged and always available**.
- Phase-1 live status / notifications / staff queue unaffected by new states.

---

## 4. Staged rollout (per milestone → gate → ramp)

| Stage | When | Who sees it | Flags on | Exit gate (Go/No-Go) |
|---|---|---|---|---|
| **Internal (test mode)** | after M2 (Sprint 3) | Team only | `payments_online` (test) | Q1 payment tests green; no double-charge in 50 test orders |
| **Staff dry-run** | after M2 | Staff on staging | payments (test) | Staff can take a paid order + issue a refund end-to-end |
| **Payments pilot** | Go-live gate (M6-a) | **5–10% of real orders** | `payments_online` (live) | Q1/Q3/Q5 pass; live smoke: 1 real ₹1 charge + refund reconciled |
| **Accounts + reorder** | after M3, gated | opt-in customers | `accounts` | Phone-OTP abuse controls verified; RLS review (Q3) signed off |
| **Loyalty + coupons** | after M4 | staff-visible → then customers | `loyalty`, `coupons` | Q2 math tests green; owner can create/expire a coupon |
| **Marketing broadcast** | after M5 | consented customers only | `marketing_broadcast` | Q4 consent gate passes; legal sign-off on copy |
| **Full launch** | after pilot ramp | 100% | all | 2 weeks of pilot metrics within thresholds (§6) |

**Ramp for payments:** 5% → 25% → 50% → 100%, holding ≥ 3 days at each step, watching payment-success and refund rates. **Rollback = flip the flag**; pay-at-counter remains, so no customer is ever blocked from ordering.

---

## 5. Go / No-Go criteria (payments go-live)

**GO only if ALL true:**
- [ ] Q1 (payment/refund) + Q3 (PCI/RLS) + Q5 (reconciliation) test suites green.
- [ ] Live smoke test: a real small charge captured, order queued, refund issued, settlement reconciled.
- [ ] Idempotent webhooks verified (duplicate + missing-webhook cases).
- [ ] Monitoring + alerts live (§7); on-call owner assigned.
- [ ] Rollback drill done: flipping `payments_online` off cleanly reverts to pay-at-counter.
- [ ] Refund SOP documented; manager trained.

**NO-GO triggers:** any double-charge in testing, any cross-customer data read in RLS testing, unreconciled settlement mismatch, or missing rollback path.

---

## 6. Success metrics & thresholds (2-week pilot)

| Metric | Target | Rollback threshold |
|---|---|---|
| Payment success rate | ≥ 92% | < 85% |
| Double-charge incidents | 0 | ≥ 1 |
| Charged-but-no-order incidents | 0 | ≥ 1 |
| Refund success (of attempted) | ≥ 98% | < 95% |
| Settlement mismatch | 0 unresolved | any unresolved > 24h |
| Cross-customer data exposure | 0 | ≥ 1 (immediate rollback) |
| % orders paid online (adoption) | trend ↑ | — (learning, not gating) |

Retention/loyalty metrics (repeat rate, enrollment, redemption, promo ROI) tracked per `PHASE-2-SPRINT-PLAN.md §8` — informational for the first cycle, not go/no-go.

---

## 7. Monitoring, alerting & incident runbook

**Instrument (extends Phase-1 observability NFR-010):**
- Payment funnel: initiated → success/fail/abandon; alert if success rate drops below threshold.
- Webhook lag & failures; reconciliation-mismatch count (daily).
- Refund queue depth & failures.
- RLS: log/alert on any denied cross-user access attempt.

**Money-incident runbook (on-call owner):**
1. **Suspected double-charge / charged-no-order:** flip `payments_online` off → identify affected orders via `payments` table → issue manual refund → notify customer → root-cause before re-enabling.
2. **Settlement mismatch:** freeze refunds if systemic → reconcile against gateway report → correct records → document.
3. **Cross-customer data read:** flip `accounts`/affected flag off immediately → patch RLS → Q3 re-run → post-mortem.
4. **Gateway outage:** customer flow auto-falls back to pay-at-counter (banner); no action needed beyond monitoring.

---

## 8. Data & migration plan

| Step | Detail |
|---|---|
| Apply migration | `phase2-migration.sql` on preview DB → verify → prod. Run enum/Section-1 block first, commit, then the rest |
| Types sync | Update `lib/types.ts` for every new table in the same PR (repo convention) |
| Guest-order claim backfill | On first phone-OTP login, link prior `orders` matching the verified `customer_phone` to `user_id` (ACC-4) — idempotent, one-time per user |
| Loyalty backfill (optional) | Decide whether pre-Phase-2 orders earn retroactive points (recommend **no** — start fresh at launch) |
| Config seed | Seed `loyalty_config` + `store_settings` (payment/tax) with owner-confirmed values before enabling flags |

---

## 9. Comms & enablement

| Audience | What | When |
|---|---|---|
| **Staff** | New: mark-paid vs online-paid orders, manager refund flow, coupon/loyalty at counter. One-page SOP + a short training | Before staff dry-run |
| **Owner** | Payment settings, coupon/campaign tools, reading the new analytics, the refund/incident SOP | Before M5 |
| **Customers** | "Now you can pay online + earn rewards" announcement (in-app banner + one broadcast to consented users) | At full launch, not pilot |
| **Support** | FAQ for payment/refund questions; who to escalate money issues to | Before payments pilot |

---

## 10. Timeline overlay (maps to the 8 sprints)

```
S1  S2  S3        S4     S5   S6      S7        S8
│   │   │         │      │    │       │         │
▼   ▼   ▼         ▼      ▼    ▼       ▼         ▼
Pay foundations   Accounts   Loyalty/Promotions  Hardening
    │   │                                         │
    │   └─ Internal + staff dry-run (test mode)   │
    │                                             ├─ Go/No-Go gate (§5)
    └─ (gateway test)                             ├─ Payments pilot 5%→…
                                                  └─ Full launch after 2wk pilot
```

Gates live at the **end of Sprint 8 (M6)**; the pilot ramp runs **after** the release candidate, so calendar go-live is ~2–3 weeks past Sprint 8 depending on ramp hold times.

---

## 11. Open items feeding this plan

Same decisions as `PHASE-2-SPEC.md §7` — the ones that specifically gate launch:
1. **Payment provider** — determines webhook shape, reconciliation report format, live-key process.
2. **Refund policy** — approval, window, partials → SOP in §7.
3. **Loyalty retroactivity** — §8 (recommend: no).
4. **DPDP consent copy** — legal sign-off gates marketing broadcast.

---

## 12. Phase-2 planning package — status

| Artifact | Purpose | Status |
|---|---|---|
| `PHASE-2-SPEC.md` | Stories + acceptance criteria | ✅ |
| `PHASE-2-RICE.md` | Scored backlog, pillar order, committed vs stretch | ✅ |
| `PHASE-2-SPRINT-PLAN.md` | Epics, tickets, 8 sprints | ✅ |
| `supabase/phase2-migration.sql` | Schema migration | ✅ |
| `PHASE-2-LAUNCH-PLAN.md` (this) | QA, rollout, go/no-go, incident runbook | ✅ |

Phase-2 planning is now complete end-to-end: **what** to build (spec), **in what order** (RICE), **on what schedule** (sprint plan), **on what data** (migration), and **how to ship it safely** (this plan).
