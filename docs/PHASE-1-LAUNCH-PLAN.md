# HIOC Revamp — Phase 1 Delivery, QA & Launch Plan

**Companion to:** `docs/PHASE-1-SPEC.md`, `docs/PHASE-1-SPRINT-PLAN.md`, `supabase/phase1-migration.sql`
**Version:** 0.1 (Draft for delivery planning)
**Date:** 2026-07-18
**Owner:** Product (Senior PM)
**Purpose:** The operational plan for shipping Phase 1 "Connected Ordering" safely. Phase 1 carries **no money risk** — its risk is **operational**: a real-time board a busy counter depends on, proactive notifications customers now expect, and staff learning a new accept/prepare flow. This plan is the QA strategy, staged rollout, go/no-go gates, and incident runbook the sprint plan assumes.

---

## 1. Phase-1 risk profile (why it needs a plan even without payments)

| Risk | Blast radius if wrong |
|---|---|
| **Missed order** (staff don't see a new order) | Customer waits, never served → worse than the old poll |
| **Real-time drops** on cafe wifi | Board goes stale silently; orders appear late |
| **Notification not delivered** | Customer never told it's ready; the headline feature fails quietly |
| **Order state-machine bug** (double/invalid transition) | Order stuck or skips a stage; metrics corrupted |
| **Store-hours / slot misconfig** | Customers wrongly blocked from ordering, or ordering when closed |
| **Staff adoption** at a busy counter | Slower service than the current flow → team rejects it |

**Principle:** the new real-time board and notifications ship **behind flags**, with the **Phase-1 baseline (15s poll + revisit-the-link status) preserved as fallback** and never removed until the new path is proven. No customer should ever be worse off than today.

---

## 2. Environments & configuration

| Item | Approach |
|---|---|
| Feature flags (XC-045) | `realtime_queue`, `new_order_alert`, `accept_reject`, `live_status`, `notifications`, `owner_dashboard` — independently toggleable, default **off** in prod |
| Migration | Apply `phase1-migration.sql` on a **preview DB** first — run the Section-1 enum block on its own and let it commit, then the rest. Sync `lib/types.ts` in the same PR |
| Notification provider | **Test/sandbox mode** through the build; real WhatsApp/SMS creds only at go-live. Server-only env — never `NEXT_PUBLIC_` |
| Store settings | Seed `store_settings` (hours, slots, prep default, GST) with **owner-confirmed values** before enabling customer-facing flags — a wrong config blocks orders |
| Realtime | Supabase Realtime channels scoped per order (customer) and per queue (staff); **poll fallback** wired from day one (NFR-002) |

---

## 3. QA / test plan

Phase 1 introduces the repo's **first automated tests** (Epic F, `F1t`) — start with the state machine + order API, then layer the flows below.

### 3.1 Order state machine (F1) — the backbone
| Scenario | Expected |
|---|---|
| Each allowed transition (received→accepted→preparing→ready→completed) | Status updates; `order_status_events` row written with actor + timestamp |
| **Disallowed** transition (e.g. completed→preparing) | Rejected `409`; no event written |
| **Concurrent** staff act on same order | Optimistic `version` guard; second sees conflict, re-reads |
| Reject / cancel | Reason required; correct terminal state; customer notified |
| Customer cancel racing staff accept | First commit wins; loser gets clear message |

### 3.2 Real-time & fallback (F2, NFR-002)
- New order appears on the staff board in **< 2s**; status change reflects on customer live-status in **< 2s**.
- **Channel drop → poll fallback** (≤15s) engages; "reconnecting" indicator shows; **no final state missed**.
- Availability change (86 an item) propagates to customer menu in **< 5s** (XC-011).
- Duplicate realtime events applied idempotently (keyed by `updated_at`).

### 3.3 New-order alert (S2) — must not miss
- Audible + visual alert fires and **persists until acknowledged**.
- Muted/backgrounded tablet → visual + badge on return.
- Browser autoplay restriction → one-time "enable sound" tap on session start works.
- Burst of orders → alerts queue, badge shows count.

### 3.4 Notifications (F4) — the headline feature
| Scenario | Expected |
|---|---|
| Order accepted | Message with order # + ETA within 30s; transactional (ignores marketing consent) |
| Order ready | "Ready for pickup" + pickup code within 30s |
| Rejected / cancelled | Reason delivered |
| Send fails | Retried ≥1; logged to `notifications`; staff card shows "couldn't notify — call {phone}" |
| Duplicate trigger (same order+event) | Idempotent — one send |

### 3.5 Store state & config (C3, C4, O5)
- Closed (scheduled or manual) → customer site blocks checkout, shows next-open.
- Busy/paused → correct banner; existing orders unaffected.
- Pickup slots respect open hours + last-order cutoff + capacity; past/full slots disabled.
- Ordering right at closing → blocked by server time + cutoff (IST).

### 3.6 Security (NFR-004) & regression
- Anon key **cannot** read `orders` / `order_items` (Phase-1 posture preserved).
- Owner routes gated to `owner` role; staff/customer blocked; no role self-escalation.
- Guest checkout + pay-at-counter (existing flow) **unchanged**.

---

## 4. Staged rollout (per milestone → gate → ramp)

| Stage | When | Who | Flags on | Exit gate (Go/No-Go) |
|---|---|---|---|---|
| **Internal** | after M2 (Sprint 2) | Team on staging | realtime, alert (test notif) | State-machine tests green; realtime < 2s with fallback proven |
| **Owner dark-launch** | after Sprint 6 | Owner only | `owner_dashboard` | Dashboard renders on real data; numbers reconcile vs manual count |
| **Staff pilot** | after M2 (Sprint 3) | **One shift, one tablet** | realtime, alert, accept_reject | Staff run a full shift on the new board without a missed order; faster-or-equal service |
| **Notifications pilot** | after Sprint 4 | Staff-triggered on real orders | `notifications` (live) | ≥ 95% delivery on accept/ready in the pilot shift |
| **Customer live-status** | after M3 (Sprint 5) | **10% of orders**, flagged | `live_status` | Status accuracy verified; no stuck orders |
| **Full launch** | after pilot | 100% | all | 1 week of pilot metrics within thresholds (§6) |

**Ramp for customer-facing (live status + notifications):** 10% → 50% → 100%, holding ≥ 2 days each. **Rollback = flip the flag** back to the poll/revisit-link baseline; the counter keeps working either way.

---

## 5. Go / No-Go criteria (full launch)

**GO only if ALL true:**
- [ ] State-machine + order-API tests green (F1t).
- [ ] Real-time verified < 2s **and** poll-fallback proven on a forced disconnect.
- [ ] New-order alert never-miss verified across mute/background/burst cases.
- [ ] Notification delivery ≥ 95% in the pilot shift; failure surfaces to staff.
- [ ] Store-hours/slot config confirmed by owner (no false "closed"/"open").
- [ ] Owner dashboard numbers reconcile against a manual day count.
- [ ] Staff pilot shift ran without a missed order and service was not slower.
- [ ] Rollback drill: flags off → clean revert to poll baseline.

**NO-GO triggers:** any missed order in the staff pilot, realtime with no working fallback, notification delivery < 90%, or a config that wrongly blocks ordering.

---

## 6. Success metrics & thresholds (1-week pilot)

Ties to `PHASE-1-SPRINT-PLAN.md §8` and Requirements §2.

| Metric | Target | Rollback threshold |
|---|---|---|
| Missed orders (unacknowledged > X min) | 0 | ≥ 1 |
| Notification delivery (accept/ready) | ≥ 95% | < 90% |
| Realtime uptime (vs fallback rate) | ≥ 98% | sustained fallback > 20% |
| Median `received → ready` time | ≤ current baseline | materially slower |
| "Where's my order?" counter questions | ↓ vs baseline | — (learning) |
| Stuck/invalid-state orders | 0 | ≥ 1 |

---

## 7. Monitoring, alerting & incident runbook

**Instrument (NFR-010):**
- Order events funnel (placed→accepted→ready→completed); alert on orders stuck > threshold in a stage.
- Realtime connection health + fallback rate; notification send success/failure rate.
- Unacknowledged-new-order age (feeds the never-miss guarantee).

**Ops-incident runbook (on-call = shift lead):**
1. **Order stuck / not appearing:** check realtime health → if degraded, board falls back to poll automatically → manually refresh; verify no order lost via `orders` table; if systemic, flip `realtime_queue` off (stays on poll).
2. **Notifications not sending:** provider status → retries firing? → staff fall back to calling `{phone}` (card flag) → flip `notifications` off if provider is down (Phase-1 revisit-link status still informs customers).
3. **Customers wrongly blocked from ordering:** check `store_settings` hours/override + last-order cutoff → correct config (takes effect without redeploy) → verify checkout reopens.
4. **Invalid order state:** inspect `order_status_events` for the order → correct via a valid transition → file the state-machine bug.

---

## 8. Data & migration plan

| Step | Detail |
|---|---|
| Apply migration | `phase1-migration.sql` on preview DB → verify → prod. Section-1 enum block first (commit), then the rest |
| Types sync | Update `lib/types.ts` for every change in the same PR (repo convention) |
| `pickup_time` migration | New orders write `pickup_slot_start`/`pickup_slot_label`; read paths prefer slot fields, fall back to legacy free-text `pickup_time` for old rows (C4) |
| `total_inr` backfill | Migration backfills existing orders so metric views see no nulls (already in the SQL) |
| Config seed | Seed `store_settings` with owner-confirmed hours/slots/prep/GST **before** enabling customer flags |
| Owner promotion | Promote the owner account to `role='owner'` via SQL (per README pattern) before dark-launch |

---

## 9. Comms & enablement

| Audience | What | When |
|---|---|---|
| **Staff** | New board: accept/reject + reason, set ETA, mark ready (→ auto-notify), 86-ing, busy/close, counter mode. One-page SOP + a hands-on run | Before staff pilot |
| **Owner** | Store settings (hours/slots/prep/GST), reading dashboard v1, the ops incident SOP | Before owner dark-launch |
| **Customers** | Soft — "track your order live + get notified." In-app only; no broadcast needed for Phase 1 | At full launch |

---

## 10. Timeline overlay (maps to the 8 sprints)

```
S1  S2      S3         S4          S5          S6     S7      S8
│   │       │          │           │           │      │       │
▼   ▼       ▼          ▼           ▼           ▼      ▼       ▼
Foundations Staff board Notif+staff Customer    Cust+  Owner   Hardening
    │       │           │          loop         owner  dash    │
    │       └─ Staff pilot (1 shift)                           ├─ Go/No-Go (§5)
    └─ Internal (realtime/test notif)   └─ Notif pilot         ├─ Customer 10%→…
                          └─ Owner dark-launch (S6)            └─ Full launch after 1wk pilot
```

Gates at **end of Sprint 8 (M5)**; customer ramp runs after the RC, so calendar go-live is ~1–2 weeks past Sprint 8 depending on hold times.

---

## 11. Open items feeding this plan

From Requirements §13 / `PHASE-1-SPEC.md §6`, the ones that gate launch:
1. **WhatsApp/SMS provider + budget** — gates the notification pilot (F4/§3.4). Engine is provider-agnostic, so this is a config/adapter swap.
2. **GST treatment** (rate, inclusive/exclusive) — gates bill breakup + settings seed (§8).
3. **Store hours / slot length / capacity / last-order cutoff** — owner must confirm before customer flags flip on.

---

## 12. Planning package — both phases now complete

| Phase | Spec | RICE | Sprint | Migration | Launch |
|---|:--:|:--:|:--:|:--:|:--:|
| **1** | ✅ | ✅* | ✅ | ✅ | ✅ (this) |
| **2** | ✅ | ✅ | ✅ | ✅ | ✅ |

*Phase-1 priority lives in the shared `RICE-PRIORITIZATION.md` (which also locks Phase-1 scope).

Every phase now has the full **what → order → schedule → data → safe launch** chain.
