# HIOC Revamp — Phase 5 Sprint & Epic Plan

**Companion to:** `docs/PHASE-5-SPEC.md`, `docs/PHASE-5-RICE.md`, `supabase/2026-08-attendance.sql` *(to be created by ticket FND5-M)*
**Version:** 0.1
**Date:** 2026-08-05
**Owner:** Product (Senior PM)
**Scope:** The Phase-5 "The Shift Is On The Record" release — committed scope from `PHASE-5-RICE.md §3`. Assumes Phases 1–4 are live.

---

## 1. Planning assumptions

| Assumption | Value |
|---|---|
| Execution model | **AI-agent implementers** working ticket-by-ticket from this plan, with owner/PM review per PR — same playbook as Phases 3–4 |
| Sprint length | 2 weeks · 1 pt ≈ 1 focused dev-day |
| Target velocity | ~20–22 pts / sprint |
| Total Phase-5 size | **≈ 68 pts** |
| Duration | **3 sprints + a 1-week hardening tail ≈ 7 weeks**, milestone-gated (5A → 5B → 5C) |
| Branch | `phase-5-attendance-payroll` off `main` |
| DoD | Per `PHASE-5-SPEC.md §0`; per-ticket DoD in §5 below |

> **Blocking inputs.** Two, both owner-owned and both cheap:
> **I1 — the cafe's exact coordinates and an on-site GPS accuracy reading.** Needed to configure and tune GEO-1. Not needed to *write* it. The owner should stand at the counter, at the door, and on the pavement outside and record what a phone reports. **Schedule this in Sprint 1, week 1.**
> **I2 — each staff member's monthly salary, shift length, shift start/end, and weekly off.** Needed to seed `staff_employment` before 5C means anything. Not needed before Sprint 3.
> Decisions D5-1…D5-4 were made 2026-08-05. **D5-5…D5-9 must be answered before Sprint 3 starts** — see §6.

---

## 2. Epics

| Epic | Name | Pts | Maps to |
|---|---|--:|---|
| **F5** | Foundations (migration, types, RLS, permission keys, geofence config) | 12 | FND5-M · OPS5-1a |
| **ATT** | Staff punch surfaces | 14 | ATT-1…4 · GEO-3 |
| **GEO** | Location integrity | 10 | GEO-1/2 |
| **SHEET** | Owner attendance sheet, corrections, auto-close | 18 | SHEET-1…4 · OPS5-1b |
| **PAY** | Payroll engine, screen, finalize, export | 14 | PAY-1…5 |
| | **Total** | **68** | |

---

## 3. Ticket backlog (by epic)

### Epic F5 — Foundations (12 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| FND5-M | `2026-08-attendance.sql` + `lib/types.ts` sync (6 tables, RLS, indexes, 2 permission keys seeded **and** mirrored in `lib/permissions.ts`) | §6 | 4 | — |
| OPS5-1a | Geofence config in owner settings (lat/lng/radius/accuracy/staleness + "use my location" helper + map preview) | OPS5-1 | 3 | FND5-M |
| FND5-F | `lib/flags.ts` — `attendance` flag, default **OFF** until Gate 5A passes | §0 | 1 | — |
| FND5-S | Privacy-policy update + `SECURITY-PLAYBOOK.md` attendance section | §9 | 2 | — |
| FND5-T | Test scaffolding: fixtures for sessions/employment/rules reused across all suites | §12 | 2 | FND5-M |

### Epic ATT — Staff punch (14 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| GEO-3 | Server-authoritative time + IST business date + midnight-crossing rule | GEO-3 | 2 | FND5-M |
| ATT-1 | `/staff/attendance` punch screen + `POST /api/attendance/punch` (one-open-session invariant, 60s retry idempotency) | ATT-1 | 5 | FND5-M, GEO-1, GEO-3 |
| ATT-2 | Consent notice + acknowledgement record + permission-denied recovery instructions | ATT-2 | 3 | ATT-1 |
| ATT-3 | "You're not clocked in" banner + header shift timer on `/staff` | ATT-3 | 1 | ATT-1 |
| ATT-4 | Staff self-view: week/month hours, late marks, edited-day markers | ATT-4 | 3 | ATT-1 |

### Epic GEO — Integrity (10 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| GEO-1 | `lib/attendance/geofence.ts` (haversine + accept/refuse/ambiguous verdicts) + route enforcement + refusal copy | GEO-1 | 5 | FND5-M, OPS5-1a |
| GEO-1t | **On-site tuning session** — measure real accuracy at the cafe, set `radius_m` / `max_accuracy_m` from data | Gate 5A | 2 | GEO-1, I1 |
| GEO-2 | Tamper flags (static coords / impossible travel / implausible accuracy) + `attendance_punch_attempts` log | GEO-2 | 3 | GEO-1 |

### Epic SHEET — Owner sheet (18 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| SHEET-4 | Employment record on `/owner/staff` — salary, contracted hours, shift times, weekly off, effective-dated with overlap constraint | SHEET-4 | 4 | FND5-M |
| OPS5-1b | Payroll rules panel (late / OT / break / thresholds) with validation + audit | OPS5-1 | 3 | FND5-M |
| SHEET-1 | `/owner/attendance` month grid + day drill-down + filters + map links | SHEET-1 | 5 | ATT-1 |
| SHEET-2 | Corrections: edit / void / manual session, mandatory reason, `attendance_edits` audit, `attendance_edit` gate | SHEET-2 | 4 | SHEET-1 |
| SHEET-3 | Auto-close cron (`CRON_SECRET`, fails closed, idempotent) + `vercel.json` entry + approval queue + `attendance_approve` gate | SHEET-3 | 2 | SHEET-1, SHEET-4 |

### Epic PAY — Payroll (14 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| PAY-1 | `lib/attendance/day.ts` day roll-up (pure) + tests | PAY-1 | 3 | OPS5-1b, SHEET-4 |
| PAY-2 | `lib/payroll/compute.ts` salary engine (pure) + the 11-case test matrix | PAY-2 | 5 | PAY-1 |
| PAY-3 | `/owner/payroll` screen with day-by-day derivation + needs-approval block | PAY-3 | 3 | PAY-2 |
| PAY-4 | Finalize / freeze / reverse + immutability enforcement in SHEET-2 | PAY-4 | 2 | PAY-3 |
| PAY-5 | CSV export (formula-injection safe) + printable payslip | PAY-5 | 1 | PAY-4 |

---

## 4. Sprint sequencing

### Sprint 1 — "A punch that means something" (22 pts) → **Gate 5A**
FND5-M (4) · FND5-F (1) · FND5-T (2) · OPS5-1a (3) · GEO-3 (2) · GEO-1 (5) · GEO-1t (2) · ATT-1 (5) — *ATT-1 lands late in the sprint; the 22 assumes GEO-1t runs in parallel with ATT-1, not after it.*

**Why this shape:** the geofence is the phase's only real unknown (`PHASE-5-RICE.md §4.3`), so it is measured in week one, not discovered in UAT. If the cafe's indoor accuracy turns out unworkable, we learn it with 46 pts still unspent and can pivot to the kiosk option (`SPEC §11`) without wasting 5B/5C.

**Exit gate 5A-i (must pass before Sprint 2):** the owner punches from inside the cafe, the doorway, ~200 m away, and home; accept/refuse behaves correctly at each; `radius_m` and `max_accuracy_m` are set from measured values, not guesses. **A refusal rate above ~5% for honest in-cafe punches fails this gate** and triggers the D5-1 re-decision.

### Sprint 2 — "The staffer's side and the owner's sheet" (23 pts)
ATT-2 (3) · ATT-3 (1) · ATT-4 (3) · GEO-2 (3) · FND5-S (2) · SHEET-4 (4) · SHEET-1 (5) · SHEET-3 (2)

**Exit gate 5B:** flag on for real staff. Leave a session open overnight and confirm auto-close, the approval queue, and that the day contributes zero hours until approved. Make a correction; verify the audit row and that the staffer sees the edit on their own screen.

### Sprint 3 — "Salary that computes itself" (23 pts) → **Gate 5C**
OPS5-1b (3) · SHEET-2 (4) · PAY-1 (3) · PAY-2 (5) · PAY-3 (3) · PAY-4 (2) · PAY-5 (1) · buffer (2)

**Exit gate 5C:** run payroll over a real part-month of real punches and **reconcile every line against a hand calculation before finalizing anything**. A mismatch of even ₹1 is a bug, not a rounding opinion (`SPEC §12`).

### Hardening week
Full-matrix regression, RLS review (staff cannot read another staffer's sessions, cannot read settings/salary/payroll), the retention purge job (D5-9), privacy-policy sign-off, and staff onboarding — a 10-minute walkthrough with the team, which matters more here than in any prior phase because this feature's success depends on people using it every single day.

---

## 5. Per-ticket definition of done

Every ticket, without exception:
- `tsc` clean, `next build` clean, `npm test` green — **no ticket lands red**, per Phases 3–4 practice.
- Any new table change is mirrored in `lib/types.ts` **in the same PR** (F4 / FND3-M convention).
- New money maths is integer paise in a **pure lib with unit tests**; routes stay thin.
- New sensitive actions go through `hasPermission()` with the key **seeded in the migration** — never a hard-coded role, and never an unseeded key (`SPEC §0 F4`).
- New surfaces are behind `lib/flags.ts` and default **off** until their gate passes.
- Anything touching location or salary gets an explicit RLS assertion in its test.

---

## 6. Decisions — all closed

**D5-1…D5-4** decided 2026-08-05, **D5-5…D5-9** decided 2026-08-06 (`PHASE-5-SPEC.md §7`). **Nothing product-side is blocking any sprint.** The two remaining blockers are the owner-owned *inputs* I1 and I2 in §1, not decisions.

Three of the late decisions add small, already-costed scope, absorbed by Sprint 3's 2-pt buffer:

| # | Adds | Where |
|---|---|---|
| D5-6 | A `paid_leave` day state — markable from the sheet, paid at contracted hours, not deducted | SHEET-2, PAY-1 |
| D5-7 | A ± adjustment line with a mandatory reason, frozen into the finalized run | PAY-3, PAY-4 |
| D5-9 | A coordinate-purge job at 365 days — extend the existing cron, do not add a second one | Hardening week |

---

## 7. Risks to the plan

| Risk | Trigger | Response |
|---|---|---|
| Indoor GPS accuracy unworkable at this building | Gate 5A-i refusal rate > ~5% | Re-open D5-1 **in Sprint 1**. The kiosk path (`SPEC §11`) writes the same `attendance_sessions` row, so 5B/5C are unaffected — only the punch route changes |
| Staff resistance ("you're tracking us") | Any pushback during Sprint 2 rollout | ATT-2's notice and ATT-4's self-view are the answer and both ship in Sprint 2 by design. Frame it as *their* evidence in a pay dispute — because it is |
| Scope pressure toward full HRMS | Requests for leaves / PF / TDS | `SPEC §11` is the agreed line; D5-6/D5-7 already cover the practical minimum |
| Payroll edge case found after go-live | Any month-end mismatch | PAY-4's frozen runs make the error inspectable rather than lost; reversal is the supported correction path |
| Salary data entered wrong | Sprint 3 | `staff_employment` is effective-dated, so a correction is a new row, not a rewrite — and PAY-3's derivation view surfaces a wrong rate before finalize, not after |
