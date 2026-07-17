# HIOC Revamp — Phase 1 Sprint & Epic Plan

**Companion to:** `docs/PHASE-1-SPEC.md`, `docs/RICE-PRIORITIZATION.md`, `supabase/phase1-migration.sql`
**Version:** 0.1 (Draft for sprint-0 planning)
**Date:** 2026-07-17
**Owner:** Product (Senior PM)
**Scope:** The Phase-1 "Connected Ordering" release, broken into epics → tickets → sprints.

---

## 1. Planning assumptions

| Assumption | Value |
|---|---|
| Team | **3 engineers** (2 full-stack + 1 frontend-leaning full-stack), fractional design, QA, and PM |
| Sprint length | 2 weeks |
| Estimation unit | Story points (Fibonacci); **1 pt ≈ 1 focused dev-day** |
| Target velocity | **~20–22 pts / sprint** (buffered below theoretical ~24; accounts for reviews, meetings, support) |
| Total Phase-1 size | **≈ 165 pts** (≈ 33 dev-weeks — matches the RICE §5 estimate of 28–34) |
| Duration | **8 sprints ≈ 16 weeks (~4 months)**, including a hardening/UAT sprint |
| Definition of Done | Per `docs/PHASE-1-SPEC.md §0` |

> If velocity runs lower, the **flex items** in §6 drop to Phase 2 first — foundations and the core loop never get cut.

---

## 2. Epics

| Epic | Name | Pts | Maps to spec |
|---|---|--:|---|
| **A** | Platform Foundations | 32 | F1, F3, F5, O5 (backend) |
| **B** | Real-time & Notifications | 24 | F2, F4, XC-011 |
| **C** | Staff Ops Cockpit | 34 | S1–S7 |
| **D** | Customer Connected Experience | 26 | C1–C6 |
| **E** | Owner Dashboard v1 | 28 | O1–O5 (UI) |
| **F** | Quality, Security & Release | 21 | NFRs, tests, flags |
| | **Total** | **165** | |

---

## 3. Ticket backlog (by epic)

### Epic A — Platform Foundations (32 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| A1 | Order state machine: enum, transition API, `order_status_events`, optimistic `version` guard | F1 | 8 | migration |
| A2 | Migrate existing 4-state flow into the new state machine (fold STF-004) | F1 | 3 | A1 |
| A3 | RBAC: add `owner` role, `/owner` route guards, `getOwnerUser()`, gating tests | F3 | 5 | migration |
| A4 | Session management + role-change audit trigger | F3 | 3 | A3 |
| A5 | `store_settings` backend + config read helpers (hours/slots/prep/tax) | O5 | 5 | migration |
| A6 | Analytics views/pipeline (`v_*` views) + typed query layer | F5 | 5 | A1 |
| A7 | Apply `phase1-migration.sql` + sync `lib/types.ts` + RLS review | — | 3 | — |

### Epic B — Real-time & Notifications (24 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| B1 | Real-time infra (Supabase Realtime channels) staff + customer, **poll fallback** | F2 | 8 | A1 |
| B2 | Real-time availability propagation to customer menu | XC-011 | 3 | B1 |
| B3 | Notification engine core (provider-agnostic): templates, retry, delivery log | F4 | 8 | A1 |
| B4 | WhatsApp + SMS provider integration + consent/opt-out | F4 | 5 | B3, **provider decision** |

### Epic C — Staff Ops Cockpit (34 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| C1 | Real-time queue board (lanes) + full-screen counter/kiosk mode | S1, S13 | 8 | B1 |
| C2 | New-order alert (sound + visual + badge; autoplay unlock) | S2 | 3 | B1 |
| C3 | Order detail view + Accept/Reject (reason) + set ready ETA | S3, S5-detail, S6 | 8 | A1, A5 |
| C4 | "Ready" → fires customer notification | S4 | 2 | B3, C3 |
| C5 | Search / filter orders | S5 | 3 | A1 |
| C6 | 86 / snooze item + auto-reenable + photo upload | S6 | 5 | B2 |
| C7 | Busy mode + open/close store + mark payment collected | S7 | 5 | A5 |

### Epic D — Customer Connected Experience (26 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| D1 | Live status page + progress UI + pickup code/QR (+ notif receipt) | C1, C2 | 8 | B1, B3 |
| D3 | Out-of-stock realtime + store open/closed/paused states | C3 | 5 | B2, C7 |
| D4 | Per-item special instructions + structured pickup slots | C4 | 5 | A5 |
| D5 | GST / bill breakup (cart + checkout + order snapshot) | C5 | 3 | A5 |
| D6 | Item photos display + menu performance pass (<2.5s) | C6 | 5 | C6 |

### Epic E — Owner Dashboard v1 (28 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| E1 | Today-at-a-glance + live ops mirror | O1, O2 | 8 | A3, A6, B1 |
| E2 | Revenue over time + trend/compare + day drilldown | O3 | 5 | A6 |
| E3 | Orders analytics + SLA/prep-time + reason breakdown | O3, O8 | 5 | A6 |
| E4 | Best/worst sellers + peak-hours heatmap | O4, O7 | 5 | A6 |
| E5 | Store-settings owner UI (edit hours/slots/prep/tax) | O5 | 5 | A5 |

### Epic F — Quality, Security & Release (21 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| F1t | Automated tests: state machine + order API (repo's **first tests**) | NFR-012 | 5 | A1 |
| F2t | Performance pass (menu interactive < 2.5s) | NFR-001 | 3 | D6 |
| F3t | Security/RLS review + DPDP consent copy & flow | NFR-004/005 | 3 | A7 |
| F4t | Feature flags (XC-045) + dark-launch the owner surface | XC-045 | 2 | A3 |
| F5t | Poll-fallback resilience + monitoring/error tracking | NFR-002/010 | 3 | B1 |
| F6t | Next.js security patch + UAT/bugfix buffer | — | 5 | all |

---

## 4. Sprint-by-sprint allocation

Sequenced dependency-first (spec §7). Each sprint ends in a **demoable increment**.

| Sprint | Theme | Tickets | Pts | Demo / exit criteria |
|---|---|---|--:|---|
| **1** | Foundations I | A1, A3, A5, A7 | 21 | Migration applied; state-machine transitions via API; `/owner` shell gated to owner role; store settings read/writable |
| **2** | Foundations II + realtime | A2, A4, A6, B1, F4t | 21 | Legacy flow on new state machine; realtime channel live with poll fallback; analytics views query; feature flags in place |
| **3** | Staff cockpit I | C1, C2, C3, C5 | 22 | Staff see a live board; accept/reject with reason; set ETA; search orders |
| **4** | Notifications + staff II | B3, B4, C4, C6 | 20 | Accept & Ready fire **WhatsApp/SMS**; delivery logged; items 86-able with photos |
| **5** | Customer loop | B2, C7, D1, D3 | 21 | Customer **live status + notifications end-to-end**; out-of-stock realtime; store open/closed/busy |
| **6** | Customer II + owner start | D4, D5, D6, E1 | 21 | Structured pickup slots; GST bill breakup; item photos + perf; owner today-at-a-glance |
| **7** | Owner dashboards | E2, E3, E4, E5 | 20 | Full **owner v1**: revenue trend, orders/SLA, best-sellers + heatmap, settings UI |
| **8** | Hardening & release | F1t, F2t, F3t, F5t, F6t | 19 | RC: tests green, perf/security/DPDP gates pass, monitoring on, UAT bugs cleared |

**Cumulative:** 21 · 42 · 64 · 84 · 105 · 126 · 146 · 165 pts.

---

## 5. Milestones & demos

| Milestone | End of | What's provable |
|---|---|---|
| **M1 — Foundations solid** | Sprint 2 | New order lifecycle + realtime + RBAC + analytics data all working under the hood |
| **M2 — Staff on the new board** | Sprint 3 | Counter can run the queue with accept/reject/ETA (internal pilot candidate) |
| **M3 — The loop closes** | Sprint 5 | Customer places → staff accept → customer notified → ready → notified. The headline outcome. |
| **M4 — Owner can see the business** | Sprint 7 | Owner dashboard v1 live on real data |
| **M5 — Release candidate** | Sprint 8 | DoD met; ready for staged rollout |

**Rollout after M5:** dark-launch owner surface (F4t) → **staff pilot at one shift** → enable customer live-status + notifications behind a flag for a % of orders → full launch. Keep the legacy poll path as fallback for one week.

---

## 6. Scope levers — what flexes if we're behind

Cut/deferred **in this order** (protects the core loop):
1. **D6** item photos + **C6** photo upload → Phase 2 (menu is text+price today anyway).
2. **E4** peak-hours heatmap → Phase 2 (nice-to-have analytic).
3. **C5** order search → Phase 2 (staff can scroll the board short-term).
4. **E5** settings *UI* → owner edits via a simpler form / SQL short-term (backend A5 still ships).

**Never cut:** A1 state machine, A3 RBAC, B1 realtime, B3/B4 notifications, C3 accept/reject, D1 live status, D3 store-state, A6 + E1 owner glance, F1t/F3t gates.

---

## 7. Cross-team dependencies & risks (plan-level)

| # | Dependency / risk | Owner | Needed by | Mitigation |
|---|---|---|---|---|
| 1 | **WhatsApp/SMS provider + budget** decision | Owner + PM | Sprint 4 (B4) | Decide by end of Sprint 2; B3 built provider-agnostic so B4 is a config/adapter swap |
| 2 | **GST treatment** (rate, inclusive/exclusive) | Owner | Sprint 5–6 (D5/E5) | Confirm in Sprint 1; default 5% exclusive in migration until confirmed |
| 3 | **Order-type scope** (takeaway-only vs +dine-in) | Owner + PM | Sprint 3 (C3/D4) | Default takeaway; enum supports dine_in/delivery when ready |
| 4 | Cafe **wifi reliability** for realtime | Ops | Sprint 2 (B1) | Poll fallback (F5t) is a hard requirement, not optional |
| 5 | **Staff training** on new board | Ops + PM | M2 pilot | Pilot off-peak; keep counter mode dead-simple; one-page SOP |
| 6 | Test infra doesn't exist yet | Eng lead | Sprint 1–2 | F1t stands up the first harness; budget a little extra in Sprint 1 |
| 7 | `next@14.2.5` known advisory | Eng | Before launch (F6t) | Patch in hardening sprint; regression-test |

---

## 8. Post-launch success metrics (validate the bet)

Tie back to Requirements §2 objectives — measure at 2 and 6 weeks post-launch:
- **Loop clarity:** % orders where customer opened live status; "where's my order" counter questions ↓.
- **Notification reach:** % of accept/ready events successfully delivered (target ≥ 95%).
- **Counter speed:** median `received → ready` time (baseline vs post); orders/hour at peak.
- **Owner adoption:** owner dashboard weekly active use.
- **Reliability:** realtime uptime / fallback rate; zero lost orders.

---

## 9. Next steps

1. **Sprint-0:** review this plan + `phase1-migration.sql` with eng; adjust estimates & velocity; confirm the 3-person team.
2. Resolve the two blocking decisions (provider, GST) — §7 rows 1–2.
3. Convert tickets A1–F6t into the tracker (Jira/Linear) with these estimates & dependencies.
4. Kick off Sprint 1 (Foundations I).
