# HIOC Revamp — Phase 5 RICE Score

**Companion to:** `docs/PHASE-5-SPEC.md`, `docs/RICE-PRIORITIZATION.md`, `docs/PHASE-3-RICE.md`
**Version:** 0.1 (scored after owner decisions D5-1…D5-4 — `PHASE-5-SPEC.md §7`)
**Date:** 2026-08-05
**Owner:** Product (Senior PM)
**Purpose:** Confirm by the numbers that the milestone order (5A → 5B → 5C) is right, separate committed scope from stretch, and make the cut line explicit before any code is written.

---

## 1. Method

**RICE = (Reach × Impact × Confidence) ÷ Effort**, same fixed scales as `docs/RICE-PRIORITIZATION.md §1` — R 1–10 (breadth per day) · I 0.25/0.5/1/2/3 · C 0.5/0.8/1.0 · E person-weeks. **🔑 Enabler** = foundation whose direct RICE understates its value; sequenced first regardless of raw score.

**Reach calibration for this phase.** Phase 5's users are a handful of people, not a customer base — raw reach numbers are small and would flatten every score if read naively. The calibration used here:

- **R 4–5** — every staffer, every shift (the punch itself, the nudge). Same band Phase 3 used for staff surfaces.
- **R 2–3** — the owner, daily or near-daily (the sheet, the approval queue).
- **R 1** — the owner, once a month (payroll run, export, payslips).

A monthly-touch surface scoring R 1 is **not** a signal to cut it: PAY-2's *impact* is the phase's entire reason for existing, which is exactly what the Impact axis is for. RICE orders the *sequence* here; it does not decide the *scope*.

**Confidence calibration.** C 1.0 where the pattern already exists in this repo and is proven (cron, permissions, audit tables, owner CRUD). C 0.8 for new but well-understood work (geofence maths, payroll arithmetic). **C 0.5 for GEO-1** — not because the code is hard, but because the *real-world indoor GPS accuracy at this specific building is unknown until measured*. That is the single largest unknown in the phase and the score says so.

---

## 2. Scored Phase-5 tickets (sorted by RICE ↓ within group)

### 2.1 Foundations
| Ticket | Requirement | R | I | C | E | **RICE** | Flag |
|---|---|--:|--:|--:|--:|--:|---|
| FND5-M | Migration + `lib/types.ts` sync + RLS + permission-key seed | 5 | 1 | 1.0 | 0.75 | **6.7** | 🔑 Blocks everything |
| OPS5-1 | Owner rule set (late/OT/break/thresholds/geofence config) | 3 | 2 | 1.0 | 0.75 | **8.0** | 🔑 for PAY-2 and GEO-1 |
| SHEET-4 | Employment record: salary + shift, effective-dated | 2 | 2 | 1.0 | 0.75 | **5.3** | 🔑 for all of 5C |

### 2.2 Pillar A — Capture (5A)
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| ATT-1 | Clock in / clock out from the staff phone | 5 | 3 | 0.8 | 1.25 | **9.6** | **Headline of the phase** |
| ATT-3 | "You're not clocked in" nudge on `/staff` | 5 | 1 | 1.0 | 0.25 | **20.0** | Cheapest high-value ticket in the phase — fixes the #1 failure (forgetting) for a quarter-week |
| GEO-3 | Server-authoritative time + IST business date | 5 | 2 | 1.0 | 0.25 | **40.0** | Trivially cheap, and without it every number is forgeable |
| ATT-4 | My attendance (staff self-view) | 5 | 1 | 1.0 | 0.5 | **10.0** | Dispute prevention; also drives adoption |
| ATT-2 | Location consent notice + permission recovery | 5 | 1 | 1.0 | 0.5 | **10.0** | DPDP-required, not optional (§9) |

### 2.3 Pillar B — Integrity (5A)
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| GEO-1 | Server-side geofence + accuracy/staleness gates | 5 | 3 | **0.5** | 1.0 | **7.5** | 🔑 The premise of the feature. C 0.5 = on-site tuning risk, not code risk |
| GEO-2 | Tamper flags + rejected-attempt log | 3 | 1 | 0.8 | 0.5 | **4.8** | Honest ceiling of a BYOD geofence |

### 2.4 Pillar C — The sheet (5B)
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| SHEET-3 | Auto-close cron + approval queue | 3 | 2 | 1.0 | 0.75 | **8.0** | Copies the proven `expire-orders` cron pattern |
| SHEET-2 | Corrections with mandatory reason + audit | 3 | 2 | 1.0 | 0.75 | **8.0** | What makes the sheet a payroll source of truth |
| SHEET-1 | Owner month grid + day drill-down | 3 | 2 | 0.8 | 1.25 | **3.8** | The daily habit; most UI-heavy ticket in the phase |

### 2.5 Pillar D — Payroll (5C)
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| PAY-1 | Day roll-up (pure lib) | 1 | 3 | 0.8 | 0.5 | **4.8** | 🔑 for PAY-2 |
| PAY-2 | Salary engine (pure lib + full test matrix) | 1 | 3 | 0.8 | 1.25 | **1.9** | **The phase's payoff.** Low RICE is the reach axis, not a cut signal — see §1 |
| PAY-3 | Payroll screen with day-by-day derivation | 1 | 2 | 0.8 | 1.0 | **1.6** | Derivation view is what makes the number trusted |
| PAY-4 | Finalize + freeze + reverse | 1 | 2 | 1.0 | 0.5 | **4.0** | Cheap; prevents the worst class of dispute |
| PAY-5 | CSV export + printable payslip | 1 | 1 | 1.0 | 0.5 | **2.0** | Rides existing print conventions |

---

## 3. Committed scope vs stretch

**Committed (all 17 tickets above).** Nothing in §2 is cut. The phase is coherent only end-to-end: capture without integrity is theatre, integrity without a sheet is unreadable, and a sheet without payroll leaves the owner doing the arithmetic they asked us to remove.

**Cut line rationale.** If the phase must be shortened, cut **whole milestones from the tail**, never tickets from the middle:
- **5A alone** is shippable and useful — it replaces the paper register with a location-verified digital one. The owner still computes salary by hand, but from data they can trust.
- **5A + 5B** is the natural "good enough for a while" stopping point.
- **5C** is the payoff and depends on 5B's corrections being real.

**What is NOT in scope** — see `PHASE-5-SPEC.md §11`. The two most likely sources of pressure to expand are **leave management** and **statutory payroll (PF/ESI/TDS)**. Both are deliberately parked; D5-6 and D5-7 pick the 5%-effort versions of the 90% need.

---

## 4. Sequencing conclusions from the scores

1. **GEO-3 and ATT-3 are near-free and disproportionately valuable** (RICE 40 and 20). Both are quarter-week tickets. Build GEO-3 as part of the very first punch route — retrofitting server-authoritative time later means re-validating every stored row.
2. **OPS5-1 scores above its milestone** (RICE 8.0, in 5B) because both GEO-1 and PAY-2 read from it. **Pull the geofence half of OPS5-1 forward into 5A** and leave the payroll-rules half in 5B. This is the one deviation from a clean milestone split, and the score justifies it.
3. **GEO-1's C 0.5 is the phase's schedule risk, and it is a measurement risk, not a coding risk.** Mitigation: schedule the on-site tuning session (Gate 5A) *in the same sprint as the ticket*, not at the end of the phase. If the cafe's indoor accuracy proves unworkable, the kiosk fallback (§11) must be decided in that sprint, not discovered in UAT.
4. **SHEET-1 is the most expensive ticket in 5B** (E 1.25, RICE 3.8) and the most tempting to gold-plate. Ship the grid plain: states, totals, filters, drill-down. Charts and trends are not in this phase.
5. **PAY-2's test matrix is a release gate, not a nice-to-have.** Eleven enumerated cases in the spec, and the "perfect attendance = exactly the monthly salary" assertion is the one that catches rounding drift. Budget for it inside PAY-2's estimate — it is already there.

---

## 5. Comparison to prior phases

| Phase | Tickets | Est. size | Character |
|---|--:|--:|---|
| Phase 2 | — | 157 pts | Build the value layer from scratch |
| Phase 3 | 17 | 92 pts | Build the counter |
| Phase 4 | 12 | ~55 pts | Wire the counter to what already existed |
| **Phase 5** | **17** | **≈ 68 pts** | **Mostly new build, but on very well-worn rails** |

Phase 5 invents two genuinely new things — the geofence verdict and the payroll engine — and both are **pure functions with no external dependency**, which is the cheapest kind of new. Everything around them (auth, RLS, audit tables, cron, owner CRUD, print) is a pattern this repo has already shipped and tested. That is why a 17-ticket phase estimates below Phase 3's.
