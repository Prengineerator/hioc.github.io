# HIOC Revamp — Phase 6 RICE Score

**Companion to:** `docs/PHASE-6-SPEC.md`, `docs/PHASE-6-SPRINT-PLAN.md`, `docs/RICE-PRIORITIZATION.md`, `docs/PHASE-5-RICE.md`
**Version:** 0.1 (scored after owner decisions D6-1…D6-4 — `PHASE-6-SPEC.md §9`)
**Date:** 2026-08-07
**Owner:** Product (Senior PM)
**Purpose:** Confirm by the numbers that the milestone order (6A → 6B → 6C → 6D) is right, separate committed scope from stretch, and make the cut line explicit before any code is written.

---

## 1. Method

**RICE = (Reach × Impact × Confidence) ÷ Effort**, same fixed scales as `docs/RICE-PRIORITIZATION.md §1` — R 1–10 · I 0.25/0.5/1/2/3 · C 0.5/0.8/1.0 · E person-weeks. **🔑 Enabler** = foundation whose direct RICE understates its value; sequenced first regardless of raw score.

**Reach calibration for this phase.** Phase 6 is unusual: it is the first phase since P2 where a pillar's reach includes **customers**, not just the team.

- **R 7–8** — every settled order's customer (the WhatsApp bill). This is the widest-reach work in the phase by an order of magnitude.
- **R 5–6** — every staffer, every order, all day (the POS flow, printing, PIN switch).
- **R 2–3** — the owner, daily/weekly (device management, delivery log).
- **R 1–2** — event days only (a few days a month — but see Impact: on those days it is the *only* till).

**Impact calibration.** I 3 is reserved for "the feature is the reason the phase exists or repairs active distrust": the bill that provably arrives (WA-1/4) and the takeover-free screen (FLOW-1) both qualify — one is customer-facing trust, the other is the owner's stated top pain. Tap-count and layout work score I 2: felt hourly, but nothing is *broken* without them.

**Confidence calibration.** C 1.0 where the pattern exists in-repo and is proven (owner CRUD, flags, rate-limits, idempotent placement, audit tables). C 0.8 for new-but-well-understood surfaces (webhook handling, PWA manifest, iframe printing, PIN pad). **C 0.5 twice**: WA-2 (the decisive cause may be Meta-side and outside our control — approval queues, category rulings) and PRT-2 (silent printing depends on the cafe's actual hardware/printer/OS combination, unknowable until stood next to — the Phase-5 GPS lesson applied to printers).

---

## 2. Scored Phase-6 tickets (sorted by RICE ↓ within group)

### 2.1 Pillar WA — the bill arrives, provably (6A)

| Ticket | Requirement | R | I | C | E | **RICE** | Flag |
|---|---|--:|--:|--:|--:|--:|---|
| WA-1 | Config doctor: stub branded, skips honest, red owner banner | 8 | 3 | 1.0 | 0.5 | **48.0** | 🔑 Highest score in the phase — and it *earns* it: every other WA ticket is blind until the log stops lying |
| WA-3 | Owner test-send button | 3 | 2 | 1.0 | 0.5 | **12.0** | The 10-second "is it working now?" answer |
| WA-5 | Bill truth + retry on the POS confirmation | 5 | 1 | 1.0 | 0.5 | **10.0** | |
| WA-4 | Meta delivery-status webhook + log statuses | 8 | 2 | 0.8 | 1.25 | **10.2** | The only *proof* of D6-1 being fixed (D6-10) |
| WA-2 | Meta-side audit: token/template/category + live Graph checks | 8 | 3 | 0.5 | 0.5 | **24.0** | C 0.5 is the point: run it week 1 so external clocks (resubmission) start immediately |

### 2.2 Pillar FLOW — one calm screen (6B)

| Ticket | Requirement | R | I | C | E | **RICE** | Flag |
|---|---|--:|--:|--:|--:|--:|---|
| FLOW-1 | Payment docked in-pane; takeover bug diagnosed & killed | 6 | 3 | 0.8 | 1.0 | **14.4** | Owner's top usability complaint; diagnosis is part of the ticket |
| FLOW-4 | Post-order strip (change due, bill/print chips, same-again) | 6 | 2 | 1.0 | 0.5 | **24.0** | Cheap and felt on every single order |
| FLOW-2 | Tap budget: quick tender, one-tap UPI, favourites, device defaults | 6 | 2 | 0.8 | 1.0 | **9.6** | Budgets G1 ≤ 6 / G2 ≤ 11 are the acceptance test |
| FLOW-3 | Layout/readability pass | 6 | 2 | 0.8 | 0.75 | **12.8** | |
| FLOW-5 | Golden-order gate harness + unit tests for extracted logic | 2 | 1 | 1.0 | 0.5 | **4.0** | Low score, but it is the tripwire that makes R4 (spec §12) survivable |

### 2.3 Pillar PRT — silent paper (6B)

| Ticket | Requirement | R | I | C | E | **RICE** | Flag |
|---|---|--:|--:|--:|--:|--:|---|
| PRT-1 | Hidden-iframe print pipeline (no tab, no focus steal) | 6 | 3 | 0.8 | 0.75 | **19.2** | Kills the "screen switches" mechanism (F5) even before kiosk mode |
| PRT-3 | Watchdog: silent success, loud failure | 6 | 2 | 0.8 | 0.5 | **19.2** | Silent printing is unsafe without it — ships with PRT-1, not after |
| PRT-2 | Kiosk device profile + setup doc | 5 | 2 | 0.5 | 0.5 | **10.0** | C 0.5: real printer + real OS verified at Gate 6B, like Phase 5 verified real GPS |

### 2.4 Pillar DEV — installs anywhere (6B)

| Ticket | Requirement | R | I | C | E | **RICE** | Flag |
|---|---|--:|--:|--:|--:|--:|---|
| DEV-1 | PWA manifest + standalone install | 5 | 2 | 0.8 | 0.5 | **16.0** | The whole "easy desktop app, several places" answer (D6-5) |
| DEV-3 | Per-device defaults (order type, print, event) | 4 | 1 | 1.0 | 0.5 | **8.0** | |
| DEV-2 | Device enrollment/revocation, hashed tokens | 3 | 2 | 0.8 | 1.0 | **4.8** | 🔑 Underpins PIN-2/3 and EVT-3 — raw score understates it |

### 2.5 Pillar PIN — a name on every order (6C)

| Ticket | Requirement | R | I | C | E | **RICE** | Flag |
|---|---|--:|--:|--:|--:|--:|---|
| PIN-2 | Lock screen + tile/PIN-pad switch UI | 6 | 2 | 0.8 | 0.75 | **12.8** | |
| PIN-1 | PIN storage, lockout, audit (migration) | 6 | 2 | 1.0 | 0.75 | **16.0** | 🔑 Blocks the rest of the pillar |
| PIN-4 | Attribution sweep (orders, voids, settles, views) | 6 | 2 | 1.0 | 0.5 | **24.0** | The payoff ticket — cheap once PIN-3 exists |
| PIN-5 | Owner PIN management on /owner/staff | 2 | 1 | 1.0 | 0.5 | **4.0** | |
| PIN-3 | `getCounterActor()` device+operator server path | 6 | 2 | 0.8 | 1.25 | **7.7** | 🔑 The auth spine — riskiest ticket in the phase (R2), sequenced with the most care, not the highest score |

### 2.6 Pillar EVT — events on tap (6D)

| Ticket | Requirement | R | I | C | E | **RICE** | Flag |
|---|---|--:|--:|--:|--:|--:|---|
| EVT-2 | Big-tile event pad, ≤ 3 taps to sell | 2 | 3 | 0.8 | 1.0 | **4.8** | Low R, high I: on event days it is the only till |
| EVT-1 | Events + event menu CRUD (migration) | 2 | 2 | 1.0 | 0.75 | **5.3** | 🔑 Blocks the pillar |
| EVT-4 | Channel + cash-day exclusion + refund attribution | 2 | 2 | 1.0 | 0.75 | **5.3** | The drawer-integrity ticket (F11) — not optional |
| EVT-3 | Activation: device × `event_pos` permission (A-4 seeding) | 2 | 2 | 1.0 | 0.5 | **8.0** | |
| EVT-5 | Event report | 1 | 2 | 1.0 | 0.5 | **4.0** | |

---

## 3. What the numbers say

1. **WA-1 (48) towers over the phase** — as it should. The single cheapest change with the widest reach is *making the log stop reporting fake success*. Everything else in 6A is built on believing what it says.
2. **The 6A pillar dominates the top of the table** (WA-1 48, WA-2 24, WA-3 12, WA-4 10.2). Milestone order 6A-first is confirmed numerically, not just narratively.
3. **FLOW-4 (24) and PIN-4 (24) are the sleeper tickets** — both cheap, both felt on every order. They must not be cut to make room for their glamorous siblings.
4. **The enablers score low and ship early anyway** (DEV-2 4.8, PIN-3 7.7, EVT-1 5.3) — the same 🔑 discipline as Phases 3–5: raw RICE orders *within* a pillar; dependency order sequences *across* it.
5. **EVT scores lowest as a pillar** (R 1–2 caps it). It stays in scope because the owner explicitly asked, and its cost is contained (~14 pts) — but it is **first against the wall** if the phase runs long, and §13's fence (no free-form items, no offline yet) is what keeps it that cheap.
6. **The two C 0.5 tickets (WA-2, PRT-2) are both "reality checks with external dependencies"** — both are deliberately scheduled in the first week of their sprint so surprises surface while there is still runway, the exact pattern Phase 5 used for GPS (Gate 5A-i).

## 4. Cut line

**Committed:** all of WA, FLOW, PRT, DEV, PIN (56 pts).
**Committed-but-cuttable under schedule pressure, in cut order:** EVT-5 → EVT-2/3 (pillar collapses to schema + report deferral) — announced to the owner the moment it happens, never silently.
**Not in the phase at any price:** everything in spec §13.
