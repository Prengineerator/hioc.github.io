# HIOC Revamp — Phase 5 "The Shift Is On The Record" — Detailed Spec

**Companion to:** `docs/REVAMP-REQUIREMENTS.md`, `docs/PHASE-3-SPEC.md`, `docs/PHASE-4-SPEC.md`, `docs/PHASE-5-RICE.md`, `docs/PHASE-5-SPRINT-PLAN.md`
**Version:** 0.1 (Draft for grooming)
**Date:** 2026-08-05
**Owner:** Product (Senior PM)
**Scope:** Staff attendance capture with location verification, an owner-trusted attendance sheet with corrections, and a rule-driven salary calculation. Assumes Phases 1–4 are live on `phase-3-dinein-counter-ops`.

---

## 0. Phase-5 goal & definition of done

**Goal:** Today the cafe knows exactly what was *sold* and nothing about who *worked*. Attendance lives on paper or in someone's memory, and salary is computed by hand at month-end from that memory. Phase 5 makes the shift a first-class record: a staffer clocks in from their own phone **only when they are physically at the cafe**, the owner sees a month grid they can trust and correct, and salary computes itself from a rule set the owner controls.

**Why now:** Every prior phase pushed more of the cafe's operations onto the product — orders (P1/2), the counter and the drawer (P3/4). Labour is the single largest remaining cost centre still tracked off-system, and it is the one where a disagreement ("I came at 10", "you came at 11:20") has no evidence on either side. It is also the last daily-touch surface where staff still have to remember something.

**Current-state facts (verified in code, 2026-08-05):**

| # | Fact | Evidence |
|---|---|---|
| F1 | There is **no attendance, shift, roster, or payroll concept anywhere** — no table, no route, no type. | repo-wide grep: no `attendance` / `shift` / `payroll` / `clock_in` |
| F2 | Staff already have real individual accounts with email+password login and a server-verified session. Attendance needs **no new identity system**. | `app/staff/login/page.tsx`, `app/api/auth/login`, `lib/api/auth.ts:getStaffOrOwner` |
| F3 | `/staff/**` and `/owner/**` are gated twice — in `middleware.ts` and again in each layout's server check. A new attendance page inherits both for free. | `middleware.ts:102-119`, `app/staff/layout.tsx`, `app/owner/layout.tsx` |
| F4 | Sensitive actions go through `hasPermission(user, key)`, which **fails CLOSED to manager** for any key with no `role_permissions` row. Phase 4 hit this trap: TAB-1 deliberately reused `pos_order_entry` rather than mint a new key. Any new key must be seeded in the migration *and* added to `KNOWN_PERMISSION_KEYS`, `DEFAULT_MIN_ROLE`, and the `PermissionKey` union in the same PR. | `lib/permissions.ts:78-92`, `supabase/phase3-migration.sql:163-172`, memory of TAB-1 |
| F5 | The store has **no coordinates**. `store_settings` holds hours, tax, slots, packaging — no `lat`/`lng`, no radius. A geofence has nothing to fence against until we add it. | `supabase/phase1-migration.sql:136-153` |
| F6 | "Today" is already defined as an **IST business date** (`Asia/Kolkata`, no DST) and `cash_days` already keys a business day by `business_date date`. Attendance must reuse this convention verbatim, or the drawer and the sheet will disagree about which day a 00:30 event belongs to. | `lib/api/date.ts`, `supabase/phase3-migration.sql:128-131` |
| F7 | The cafe's seeded hours are **10:00–24:00 daily**. Shifts therefore routinely cross midnight, and any naive `clock_out - clock_in` grouped by calendar date will split one shift across two days. | `supabase/phase1-migration.sql:161-165` |
| F8 | A protected cron pattern already exists and **fails closed without `CRON_SECRET`**. The auto-close job for missed clock-outs can copy it exactly. | `app/api/cron/expire-orders/route.ts:19-26`, `vercel.json` |
| F9 | Owner already manages the team (create account, set role staff/manager, revoke) from `/owner/staff`. Salary and shift config belong on that same surface, not a new one. | `app/api/owner/staff/route.ts`, `components/owner/TeamManager.tsx` |
| F10 | The codebase's money convention is **integer ₹, never floats**, and derived values are computed by pure, unit-tested libs (`lib/orders/lines.ts`, `lib/staff/tableOccupancy.ts`, `lib/pos/quickAdd.ts`) rather than stored. Payroll must follow both rules. | repo convention; `lib/orders/lines.ts` |
| F11 | `profiles` already carries `name` and `phone`; the auth user carries the email. The attendance sheet needs **no new person record** — only an employment record hanging off `user_id`. | `supabase/phase2-migration.sql:101-106` |
| F12 | Every prior audit surface (`order_amendments`, `permission_change_audit`, `role_change_audit`) records who/what/from/to/when. Attendance corrections are exactly this shape and must not invent a new one. | `supabase/phase3-migration.sql`, `lib/types.ts:589-596` |

**Release-level Definition of Done**
- [ ] A staffer opens `/staff/attendance` on their own phone, taps **Clock in**, and the punch is accepted **only if the server** — not the browser — computes them to be inside the cafe's geofence.
- [ ] The recorded time is **the server's clock**, never a client-supplied timestamp.
- [ ] A punch attempted from outside the radius is **refused with a plain-language reason** and the failed attempt is still recorded, so repeated out-of-range attempts are visible to the owner.
- [ ] Location is captured **only at the moment of a punch** — never in the background, never continuously — and the product says so on screen before the first punch.
- [ ] A forgotten clock-out is **auto-closed at shift end + grace**, marked `auto_closed`, and **excluded from payroll until the owner approves or corrects it**. Payroll never silently pays a guessed number.
- [ ] The owner opens `/owner/attendance` and sees a **month grid** (staff × day) with hours, late marks, half-days and absences, and can drill into any cell to see the punches, the distance-from-store of each, and any integrity flags.
- [ ] The owner can **correct any punch**, with a mandatory reason, and every correction is audited (old → new, by whom, when).
- [ ] The owner sets, per staff member, a **monthly salary and a contracted shift length (9h / 10h / any)**, effective-dated so a raise does not rewrite last month's pay.
- [ ] The owner configures the **rule set** — late grace, overtime threshold and multiplier, auto-deducted unpaid break, half-day/absent thresholds, weekly off — and salary computes from it.
- [ ] The owner runs payroll for a period, reviews per-staff lines, and **finalizes** — after which the run is immutable and carries a frozen snapshot of the rules and rate it used.
- [ ] All attendance and payroll math lives in **pure, unit-tested libs**; routes are thin. Money is integer paise internally, rounded to whole ₹ once, at the line.
- [ ] `lib/types.ts` stays in exact sync with the migration; every new surface is dark-launched behind `lib/flags.ts`.

**Conventions:** Same as Phase 1–4 — AC in Given/When/Then; integer money; UTC-stored / IST-displayed; server- and RLS-enforced authorization; new surfaces behind flags; sensitive actions through `hasPermission()`, never hard-coded roles.

---

## 1. Milestone architecture

Three independently launchable milestones. Each leaves the cafe better off even if the next never ships.

| Milestone | Theme | Ships | Cafe outcome |
|---|---|---|---|
| **5A — The punch is real** | Capture + integrity | FND5-M · ATT-1…4 · GEO-1…3 | Staff clock in and out from their phone at the cafe; the record is server-timed, location-verified, and tamper-evident |
| **5B — The sheet the owner trusts** | Visibility + correction | SHEET-1…4 · OPS5-1 | The owner sees a month grid, fixes what's wrong with an audit trail, and clears the missed-punch queue |
| **5C — Salary that computes itself** | Rules + payroll | PAY-1…5 | Monthly salary, shift lengths and rules in, payroll run out — reviewable, finalizable, exportable |

> Sequencing rationale: 5A is worthless without integrity, so capture and geofence ship together. 5B is what converts raw punches into something an owner will actually look at daily — and it is a hard prerequisite for payroll, because payroll over an uncorrected sheet is payroll over garbage. 5C is the payoff and is deliberately last: its math is only as good as 5B's data.

---

## 2. Pillar A — Attendance capture (ATT) — *Milestone 5A*

### FND5-M — Migration + types (foundation)
**Story:** As the engineer, the attendance data model exists, is RLS-locked, and `lib/types.ts` matches it exactly.

**Acceptance criteria**
- **Given** `supabase/2026-08-attendance.sql` is applied, **then** `attendance_settings`, `staff_employment`, `attendance_sessions`, `attendance_edits`, `payroll_runs`, and `payroll_run_lines` exist as specified in §6, with all CHECK constraints and indexes.
- **Given** the migration, **then** the two new permission keys are seeded into `role_permissions` **and** added to `KNOWN_PERMISSION_KEYS` + `DEFAULT_MIN_ROLE` + the `PermissionKey` union **in the same PR** (F4 — a missing seed row silently escalates the action to manager-only).
- **Given** RLS, **then**: a staffer may read **only their own** `attendance_sessions` rows and **nothing** in `attendance_settings`, `staff_employment` (others'), `payroll_runs`, or `payroll_run_lines`. All writes go through service-role routes.
- **Given** `lib/types.ts`, **then** every new table has a matching interface, and no route casts to `any` to work around a missing one.

**Edge cases:** the migration must be idempotent (`if not exists` / `on conflict do nothing`) like every prior one — it will be run by hand against the live project.
**Deps:** none. **Serves:** all of Phase 5.

---

### ATT-1 — Clock in / clock out from the staff phone
**Story:** As a staffer, I open the staff site on my phone at the cafe, tap one button, and my shift starts.

**Acceptance criteria**
- **Given** a signed-in staff session at `/staff/attendance`, **when** no session is open, **then** the screen shows a single large **Clock in** button, my name, and the current IST time.
- **Given** an open session, **then** the same screen shows **Clock out**, the running elapsed time, and the clock-in time.
- **Given** a tap on Clock in, **then** the browser requests a fresh position (`enableHighAccuracy: true`, `maximumAge: 0`) and `POST /api/attendance/punch` sends `{ type: 'in', lat, lng, accuracy_m, fix_age_ms }` — **raw readings only**. The client never sends a verdict, a distance, or a time.
- **Given** the server accepts the punch, **then** `clock_in_at` is set to the **database's `now()`**, `business_date` is the IST business date of that instant, and the response returns the created session.
- **Given** a successful punch, **then** the screen confirms it in one line ("Clocked in at 10:04 AM") and the button flips state without a page reload.
- **Given** a clock-out, **then** the response includes the day's total worked time so far, so the staffer can see it immediately.

**Edge cases:** double-tap / retry — the route is idempotent on `(user_id, type)` within a 60-second window, returning the existing session rather than opening a second one; a clock-out with no open session returns a clear 409, not a 500; a clock-in when a session is already open returns the open session with an explanatory message rather than stacking.
**Deps:** FND5-M, GEO-1. **Serves:** the entire phase.

### ATT-2 — Location consent, stated plainly
**Story:** As a staffer, I know exactly what is being recorded about me and when, before I ever grant location access.

**Acceptance criteria**
- **Given** a staffer who has never punched, **when** they first open `/staff/attendance`, **then** a one-time notice explains, in plain language: location is read **only at the instant you tap clock in or clock out**, it is used **only to confirm you are at the cafe**, it is **not tracked between punches**, and the owner sees how far from the cafe each punch was.
- **Given** the notice, **then** acknowledging it is recorded against the staffer (timestamp + version) so consent is evidenced, and the notice does not reappear.
- **Given** the browser's permission prompt is **denied**, **then** the screen explains that attendance cannot be marked without it and shows the exact steps to re-enable it for this site on iOS Safari and Android Chrome — not a generic "permission denied".
- **Given** the privacy policy page, **then** it is updated to cover punch-time location collection, its purpose, and its retention window (§9).

**Edge cases:** a staffer who declines consent cannot punch and the owner must mark them manually (SHEET-2) — the product must not pretend a manual mark is a verified punch.
**Deps:** ATT-1. **Serves:** DPDP posture (§9) and staff trust.

### ATT-3 — "You're not clocked in" nudge on the staff home
**Story:** As a staffer mid-service, I don't have to remember attendance — the product reminds me.

**Acceptance criteria**
- **Given** the staff order cockpit at `/staff`, **when** the signed-in staffer has no open attendance session, **then** a dismissible banner reads "You're not clocked in" with a one-tap link to `/staff/attendance`.
- **Given** an open session, **then** the header shows a small running shift timer instead.
- **Given** a dismissal, **then** the banner stays hidden for the rest of that browser session but returns the next day.
- **Given** the banner, **then** it **never blocks** POS use. Attendance is a record, not a gate — a hard block would stop service the first time GPS misbehaves. *(Owner-toggleable hard block is parked — §11.)*

**Edge cases:** owner/manager accounts see the banner only if they have an employment record (an owner who does not draw an hourly salary should not be nagged).
**Deps:** ATT-1. **Serves:** data completeness — the single biggest failure mode is simply forgetting.

### ATT-4 — My attendance, for the staffer
**Story:** As a staffer, I can see my own hours without asking the owner.

**Acceptance criteria**
- **Given** `/staff/attendance`, **then** below the punch button I see **this week** and **this month**: days present, total hours, late marks, and any day flagged for owner review.
- **Given** a day with a correction, **then** it is visibly marked as edited by the owner, with the corrected times shown — a silent edit to someone's pay record is not acceptable.
- **Given** any other staffer's data, **then** it is not retrievable — RLS restricts reads to `user_id = auth.uid()` and the route re-checks.

**Edge cases:** an auto-closed day shows as "needs owner approval", not as confirmed hours.
**Deps:** ATT-1. **Serves:** dispute prevention — the cheapest payroll dispute is the one that never happens.

---

## 3. Pillar B — Location integrity (GEO) — *Milestone 5A*

> **Stated honestly up front:** browser geolocation is spoofable. DevTools can override it in two clicks and Android mock-location apps do it system-wide, and **no web API can reliably detect either**. GEO-1 stops honest error and casual cheating; GEO-2 makes deliberate cheating leave a trail an owner can see. Anyone promising more than that from browser GPS alone is wrong. The upgrade paths that actually close the hole — a kiosk device, or a selfie on the punch — are specced in the parking lot (§11) so they can be added without rework.

### GEO-1 — Server-authoritative geofence
**Story:** As the owner, a punch is only accepted from inside my cafe, and that decision is made by my server, not by the staffer's phone.

**Acceptance criteria**
- **Given** owner settings, **then** the owner sets the cafe's **latitude, longitude and radius (metres, default 150)** — with a map preview and a "use my current location" helper so they never have to type coordinates.
- **Given** a punch request, **then** the server computes the great-circle (haversine) distance between the reported fix and the stored store point in a **pure, unit-tested** `lib/attendance/geofence.ts`, and decides. A client-supplied distance or verdict is ignored if present.
- **Given** `distance_m ≤ radius_m` **and** `accuracy_m ≤ max_accuracy_m` (default 100) **and** the fix is fresher than `max_fix_age_sec` (default 60), **then** the punch is **accepted** and `distance_m` + `accuracy_m` are stored on the row.
- **Given** `accuracy_m > max_accuracy_m`, **then** the punch is **refused** with "We couldn't get a precise enough location (±NNN m). Step near a window or outdoors and try again." — because a ±2 km accuracy circle that happens to centre inside a 150 m radius proves nothing.
- **Given** `distance_m − accuracy_m > radius_m` (definitively outside even allowing for error), **then** the punch is **refused** with "You're about NNN m from the cafe. Attendance can only be marked at the cafe."
- **Given** `distance_m > radius_m` but within the accuracy margin (ambiguous), **then** the punch is **accepted and flagged** `low_confidence` for owner review — a marginal GPS reading should not cost someone their day's pay, but it should be visible.
- **Given** the geofence configuration, **then** it is **never sent to the client**. Staff learn only accept/refuse and their distance — not the radius or the thresholds.
- **Given** any refusal, **then** the attempt is still **recorded** as a rejected punch with its distance and reason (GEO-2), and the response is a 422 with a human-readable message the UI shows verbatim.

**Edge cases:** the store point is unset → punching is disabled with an owner-facing "set your cafe location first" message rather than silently accepting everything; a device with no GPS (desktop, Wi-Fi geolocation) will typically fail the accuracy gate, which is the correct outcome; secure-context requirement (HTTPS) is already satisfied in production and must be noted for local dev.
**Deps:** FND5-M. **Serves:** the entire credibility of the feature.

### GEO-2 — Tamper signals, flagged not blocked
**Story:** As the owner, if someone is faking their location, the pattern shows up in the record even though I can't prove it from one punch.

**Acceptance criteria**
- **Given** a punch whose coordinates are **byte-identical** to a previous punch by the same staffer (to full precision), **then** it is flagged `static_coords` — real GPS jitters by metres between readings; a pinned mock location does not.
- **Given** two punches by the same staffer whose separation implies **impossible travel** (> 900 km/h), **then** both are flagged `impossible_travel`.
- **Given** a punch reporting a suspiciously **perfect accuracy** (e.g. a constant value repeated across punches, or an implausibly small value), **then** it is flagged `implausible_accuracy`.
- **Given** a rejected punch, **then** a `attendance_punch_attempts` row records user, type, distance, accuracy, reason and server time — so "tried from home four times, then walked in" is legible.
- **Given** any flag, **then** the punch is **accepted if it passed GEO-1** — flags inform the owner, they do not block service. Blocking on a heuristic would strand honest staff.
- **Given** the owner's sheet, **then** flagged days are visually marked and filterable (SHEET-1).

**Edge cases:** two staff punching from the same phone would produce plausible-but-identical coordinates — this is *expected* when a phone is shared and must not be treated as fraud; the flag exists to prompt a look, not to accuse.
**Deps:** GEO-1. **Serves:** the honest limit of a BYOD geofence.

### GEO-3 — Time comes from the server, always
**Story:** As the owner, changing the phone's clock changes nothing.

**Acceptance criteria**
- **Given** any punch, **then** `clock_in_at` / `clock_out_at` are set by the **database** (`now()`), and any client-supplied time field is ignored — not validated, ignored.
- **Given** the client's reported fix age, **then** it is used **only** to reject stale cached positions, never to adjust the recorded time.
- **Given** an IST business date, **then** it is derived server-side from the server instant using the same `Asia/Kolkata` convention as `lib/api/date.ts` and `cash_days` (F6).
- **Given** a shift that crosses midnight, **then** the session's `business_date` is the date of the **clock-in**, and the whole shift belongs to that day (F7) — matching how the cash drawer already treats a business day.

**Edge cases:** a session open across a business-date rollover must not be double-counted on both days; auto-close (SHEET-3) must handle `shift_end < shift_start` (overnight) without computing a negative duration.
**Deps:** FND5-M. **Serves:** every number downstream.

---

## 4. Pillar C — The owner's attendance sheet (SHEET) — *Milestone 5B*

### SHEET-1 — The month grid
**Story:** As the owner, I open one screen and see who worked, when, and for how long — for the whole month.

**Acceptance criteria**
- **Given** `/owner/attendance`, **then** a grid of **staff (rows) × days (columns)** for the selected month shows each cell's state: hours worked, or `H` half-day, `A` absent, `O` weekly off, `—` not employed yet.
- **Given** a cell, **then** late arrivals, integrity flags, auto-closed sessions and owner edits are each visually distinct at a glance — the owner should be able to spot a problem without clicking.
- **Given** a row, **then** the right edge shows month totals: days present, half-days, absents, total hours, overtime hours, late marks.
- **Given** a filter, **then** the owner can show only: needs-approval, flagged, late, or a single staff member.
- **Given** a click on any cell, **then** a detail panel lists that day's sessions with in/out times, worked minutes, distance-from-cafe for each punch, flags, and the edit history.
- **Given** a punch's location, **then** the panel offers a map link for that coordinate — the owner should be able to see *where*, not just *how far*.

**Edge cases:** a month with a mid-month joiner or leaver must render `—` outside their employment window, not `A`; a staffer with no employment record must still appear if they punched (misconfiguration must be visible, not hidden).
**Deps:** FND5-M, ATT-1. **Serves:** the daily habit that makes the data trustworthy.

### SHEET-2 — Corrections, always audited
**Story:** As the owner, I fix a wrong punch — and the fix is on the record forever.

**Acceptance criteria**
- **Given** a session in the detail panel, **then** the owner can edit `clock_in_at` / `clock_out_at`, void the session, or add a manual session for a staffer who could not punch (ATT-2 consent declined, dead phone, forgot entirely).
- **Given** any edit, **then** a **reason is mandatory** and an `attendance_edits` row records field, old value, new value, actor and timestamp — the same shape as `order_amendments` and `permission_change_audit` (F12).
- **Given** a manual session, **then** it is permanently marked `source = 'manual'` and is **visibly distinguishable** from a verified punch everywhere it appears, including payroll.
- **Given** an edit to a day inside a **finalized** payroll run, **then** it is **refused** — a finalized run is immutable (PAY-4). The owner must reverse the run first, or record the difference in the next period.
- **Given** the edit action, **then** it is gated on `hasPermission(user, 'attendance_edit')`, seeded at `manager` (owner always passes).
- **Given** an edited session, **then** the affected staffer sees it as edited on their own screen (ATT-4).

**Edge cases:** an edit that produces a negative or > 24h duration is refused with a clear message; editing a clock-out earlier than the clock-in is refused; a void requires a reason and excludes the session from all totals while remaining visible in the audit.
**Deps:** SHEET-1. **Serves:** the difference between a log and a payroll source of truth.

### SHEET-3 — Missed clock-out: auto-close + approval queue
**Story:** As the owner, a forgotten clock-out never silently becomes a paid 14-hour day, and never quietly disappears either.

**Acceptance criteria**
- **Given** a session still open at the staffer's **contracted shift end + `auto_close_grace_min`** (default 120), **when** the cron runs, **then** the session is closed with `status = 'auto_closed'`, `clock_out_at` = the shift end time, and flag `auto_closed`.
- **Given** an auto-closed session, **then** it is **excluded from payroll totals** until an owner explicitly approves or corrects it — payroll must never pay a guessed number.
- **Given** the owner's sheet, **then** a **Needs approval** queue lists every auto-closed and flagged session with one-tap **Approve as-is** or **Correct**.
- **Given** an approval, **then** it is recorded (`approved_by`, `approved_at`) and gated on `hasPermission(user, 'attendance_approve')`, seeded at `manager`.
- **Given** the cron endpoint, **then** it is protected by `CRON_SECRET` and **fails closed when the secret is unset**, copying `app/api/cron/expire-orders` exactly (F8), and is registered in `vercel.json`.
- **Given** a staffer with no employment record (so no known shift end), **then** the session auto-closes at a configured absolute cap (default 14h) and is flagged for review rather than left open forever.

**Edge cases:** an overnight shift's auto-close must resolve the shift-end to the *next* calendar day when `shift_end < shift_start`; the cron must be idempotent (running twice must not re-close or double-flag); a staffer who clocks out *after* an auto-close happened gets their real time recorded as a correction request, not a second session.
**Deps:** SHEET-1, GEO-3. **Serves:** the most common real-world failure by a wide margin.

### SHEET-4 — Employment record: salary and shift, effective-dated
**Story:** As the owner, I set each person's salary and shift length where I already manage my team — and a raise doesn't rewrite history.

**Acceptance criteria**
- **Given** `/owner/staff`, **then** each member's row gains **monthly salary (₹)**, **contracted hours/day** (e.g. 9 or 10), **shift start/end time**, **weekly off day**, and **employment start date**.
- **Given** a change to salary or contracted hours, **then** a **new effective-dated row** is written (`effective_from`) and the previous row is closed (`effective_to`) — the old rate remains attached to already-worked days. Editing in place is not offered.
- **Given** payroll for a period spanning a change, **then** each day is priced with the record **in effect on that day**.
- **Given** a staffer with no employment record, **then** attendance still records normally but payroll reports them as **unconfigured** rather than computing ₹0 silently.
- **Given** these fields, **then** they are readable **only** by the owner — salary is not staff-readable, including one's own, in this phase *(self-service payslips are parked, §11)*.

**Edge cases:** an employment record ending mid-month (departure) must prorate correctly (PAY-2); overlapping effective ranges must be rejected by a DB constraint, not by UI convention.
**Deps:** FND5-M. **Serves:** all of 5C.

### OPS5-1 — The rule set, in the owner's hands
**Story:** As the owner, I set the rules once and the maths follows them.

**Acceptance criteria**
- **Given** owner settings, **then** a single **Attendance & payroll rules** panel configures, with plain-language explanations and worked examples of each:
  - **Late:** grace period (min, default 15) and late-marks-per-half-day-deduction (default 3).
  - **Overtime:** minutes beyond contracted hours before OT starts (default 0) and OT multiplier (`0×` = unpaid, `1×`, `1.5×`, `2×`; default `1×`).
  - **Unpaid break:** auto-deduct N minutes (default 0) from any single-session day longer than M minutes (default 360).
  - **Thresholds:** minutes below which a day is a **half-day** (default 240) and below which it is **absent** (default 120).
  - **Weekly off:** per staff member on the employment record (SHEET-4); work on a weekly off is paid at the OT multiplier and flagged.
  - **Geofence:** latitude, longitude, radius, max accuracy, max fix age, auto-close grace, absolute session cap.
- **Given** a rules change, **then** it applies from that moment forward and is **audited** (who, what, old → new). It does **not** retroactively alter a finalized payroll run (PAY-4).
- **Given** the auto-break rule, **then** it applies **only to a day with exactly one session** — if a staffer punched out for their break, deducting a break again would charge them twice.
- **Given** the rules, **then** they live in a singleton `attendance_settings` row (the `store_settings` pattern) that is **not staff-readable**.

**Edge cases:** rules must be validated (grace ≥ 0, absent threshold ≤ half-day threshold ≤ contracted hours) with a clear message, not saved into an incoherent state.
**Deps:** FND5-M. **Serves:** PAY-2, GEO-1.

---

## 5. Pillar D — Payroll (PAY) — *Milestone 5C*

### PAY-1 — The day roll-up
**Story:** As the system, a day of punches becomes one honest set of numbers.

**Acceptance criteria**
- **Given** a staffer and a business date, **then** a pure function in `lib/attendance/day.ts` returns: `worked_minutes` (sum of all closed, non-void sessions), `first_in`, `last_out`, `session_count`, `late_minutes`, and the applied `auto_break_minutes`.
- **Given** a day containing any **unapproved** auto-closed session, **then** the day is returned with status `needs_approval` and **contributes zero paid minutes** until resolved.
- **Given** the rule set, **then** the day resolves to exactly one of: `present`, `half_day`, `absent`, `weekly_off`, `paid_leave`, `not_employed`, `needs_approval`.
- **Given** a day the owner marked `paid_leave` (D5-6), **then** it pays at **contracted hours** and is **not** deducted as an absence; a `weekly_off` day that was worked contributes its minutes as **OT** (D5-5).
- **Given** a shift crossing midnight, **then** all of its minutes land on the clock-in business date (GEO-3), never split.
- **Given** this function, **then** it takes rules + sessions + employment as arguments and reads nothing — fully unit-testable, in the style of `lib/staff/tableOccupancy.ts`.

**Edge cases:** overlapping sessions for one staffer (a data error) are merged, not summed, and flagged — double-counting overlapping punches would inflate pay; a session with a null clock-out that is not auto-closed contributes zero and marks the day `needs_approval`.
**Deps:** OPS5-1, SHEET-4. **Serves:** PAY-2.

### PAY-2 — The salary engine
**Story:** As the owner, monthly salary + contracted hours + actual hours = the right number, every time, with no arithmetic from me.

**Acceptance criteria**
- **Given** a staff member and a period, **then** `lib/payroll/compute.ts` derives:
  - `expected_working_days` = days in the period within the employment window, **minus** weekly offs.
  - `expected_minutes` = `expected_working_days × contracted_hours × 60`.
  - `per_minute_paise` = `monthly_salary_inr × 100 ÷ expected_minutes` — so a 28-day February and a 31-day March both pay the full monthly salary for full attendance.
  - `base_pay` from paid minutes capped at contracted hours per day; `ot_pay` from minutes beyond, at the OT multiplier; `deductions` from absences and accumulated late marks.
  - `net_pay_inr` = base + OT − deductions.
- **Given** any intermediate calculation, **then** it is in **integer paise**, rounded **once** to whole ₹ at `net_pay_inr` (round-half-up). No floats touch money (F10).
- **Given** a period spanning a salary change (SHEET-4), **then** each day is priced at the rate in effect that day and the line shows both rates.
- **Given** a staffer with an unconfigured employment record, **then** the line reports `unconfigured` with ₹0 and a warning — never a silent zero.
- **Given** the engine, **then** it is covered by unit tests for at minimum: a clean full month; February; a mid-month joiner; a mid-month leaver; a mid-month raise; a month with overtime; a month with 4 late marks; an unpaid-break day vs a two-session day; a weekly-off worked; an overnight shift; and a month containing an unapproved auto-close.

**Edge cases:** perfect attendance must produce **exactly** the monthly salary — the rounding rule must not leak ₹1 up or down; zero `expected_minutes` (employment window entirely weekly-offs) must not divide by zero.
**Deps:** PAY-1. **Serves:** the headline outcome of the phase.

### PAY-3 — The payroll screen
**Story:** As the owner, I pick a month, look at every person's number, understand where it came from, and fix what's wrong before I pay anyone.

**Acceptance criteria**
- **Given** `/owner/payroll`, **then** selecting a period shows one row per staff member: days present / half / absent, hours, OT hours, late marks, base, OT, deductions, **net pay**.
- **Given** a row, **then** expanding it shows the **day-by-day derivation** — this is the difference between a number the owner trusts and one they re-check by hand.
- **Given** any day in the period that `needs_approval`, **then** the run is **blocked from finalizing** and the screen links straight to that day in the attendance sheet.
- **Given** an advance, a loan repayment or any one-off correction (D5-7), **then** the owner can add a **± adjustment line with a mandatory reason** to a staffer's row; it lands in `deductions_inr` (or as a positive addition), shows separately on the payslip, and is frozen into the run on finalize.
- **Given** the screen, **then** it is **owner-only** (`getOwnerUser`), not in the permission matrix — salary is not a manager-delegable surface in this phase.

**Edge cases:** a period with zero attendance data renders an explicit empty state naming the likely cause (no punches / no employment records), not a blank table.
**Deps:** PAY-2. **Serves:** the month-end ritual.

### PAY-4 — Finalize a run, immutably
**Story:** As the owner, once I've paid, that month's numbers stop moving.

**Acceptance criteria**
- **Given** a reviewed run, **when** the owner finalizes it, **then** a `payroll_runs` row is written with `status = 'finalized'` and `payroll_run_lines` snapshot each staffer's computed figures **plus the rule set and rate used** (frozen JSON).
- **Given** a finalized run, **then** later changes to rules, salary, or attendance **do not alter it** — re-opening the screen shows the frozen numbers, not a recomputation.
- **Given** an attempt to edit attendance inside a finalized period, **then** it is refused with a message pointing at the run (SHEET-2).
- **Given** a genuine error found after finalizing, **then** the owner may **reverse** the run (a recorded action with a reason, not a delete), after which the period is editable again.
- **Given** finalization, **then** it is owner-only and audited.

**Edge cases:** two overlapping runs for the same period are prevented by a DB constraint; a reversal must not delete the original run row — the history of what was paid, and what it was corrected to, is the point.
**Deps:** PAY-3. **Serves:** trust, and any future dispute.

### PAY-5 — Payslip + export
**Story:** As the owner, I can hand each staffer a clear payslip and get the month into my accounts.

**Acceptance criteria**
- **Given** a finalized run, **then** the owner can export a **CSV** — one row per staffer with every component column — and download it.
- **Given** a run line, **then** the owner can open a **printable payslip** for that staffer, styled with the existing print conventions used by `app/staff-print/**` (which already prints outside the chrome-bearing layouts).
- **Given** a payslip, **then** it shows: period, days present/half/absent, hours + OT, monthly salary, rate basis, each component, deductions with their reason, and net pay.

**Edge cases:** CSV must be safe against formula injection (a leading `=`/`+`/`-`/`@` in a name field must be escaped) — this is a real risk in any Excel-bound export.
**Deps:** PAY-4. **Serves:** the last manual step at month-end.

---

## 6. Data model (migration sketch — `supabase/2026-08-attendance.sql`)

> Names and shapes are proposed here so engineering can review before anything is written. Follows every prior migration's conventions: `if not exists`, CHECK-constrained text over enums, `updated_at` triggers, RLS on by default, indexes on every lookup path.

**`attendance_settings`** — singleton, owner-only, **not staff-readable** (staff must not learn the radius).
`is_singleton`, `store_lat numeric(9,6)`, `store_lng numeric(9,6)`, `geofence_radius_m int default 150`, `max_accuracy_m int default 100`, `max_fix_age_sec int default 60`, `grace_period_min int default 15`, `late_marks_per_halfday int default 3`, `ot_threshold_min int default 0`, `ot_multiplier numeric(3,2) default 1.00`, `auto_break_min int default 0`, `auto_break_after_min int default 360`, `half_day_min_minutes int default 240`, `absent_below_minutes int default 120`, `auto_close_grace_min int default 120`, `max_session_hours int default 14`, `location_retention_days int default 365`, `updated_at`.

**`staff_employment`** — effective-dated, owner-only.
`id`, `user_id → auth.users`, `monthly_salary_inr int`, `contracted_hours_per_day numeric(4,2)`, `shift_start_time time`, `shift_end_time time`, `weekly_off_dow smallint null` (0=Sun), `effective_from date`, `effective_to date null`, `created_by`, `created_at`. Constraint: no overlapping `[effective_from, effective_to)` per `user_id`.

**`attendance_sessions`** — the core record; staff read **own rows only**.
`id`, `user_id`, `business_date date`, `clock_in_at timestamptz not null default now()`, `clock_in_lat/lng numeric(9,6)`, `clock_in_accuracy_m numeric`, `clock_in_distance_m numeric`, `clock_out_at timestamptz null`, `clock_out_lat/lng`, `clock_out_accuracy_m`, `clock_out_distance_m`, `status text check in ('open','closed','auto_closed','void')`, `source text check in ('punch','manual')`, `flags text[] default '{}'`, `approved_by`, `approved_at`, `notes text`, `created_at`, `updated_at`. Partial unique index enforcing **at most one open session per user**.

**`attendance_punch_attempts`** — rejected punches (GEO-2). `id`, `user_id`, `type`, `lat/lng`, `accuracy_m`, `distance_m`, `reason text`, `created_at`.

**`attendance_edits`** — audit (F12 shape). `id`, `session_id`, `field`, `old_value text`, `new_value text`, `reason text not null`, `edited_by`, `edited_at`.

**`payroll_runs`** — `id`, `period_start date`, `period_end date`, `status text check in ('draft','finalized','reversed')`, `rules_snapshot jsonb`, `generated_by`, `generated_at`, `finalized_at`, `reversed_at`, `reversal_reason`. Unique on an active `(period_start, period_end)`.

**`payroll_run_lines`** — `id`, `run_id`, `user_id`, `monthly_salary_inr`, `contracted_hours_per_day`, `per_minute_paise`, `days_present`, `days_half`, `days_absent`, `days_off`, `worked_minutes`, `ot_minutes`, `late_marks`, `base_pay_inr`, `ot_pay_inr`, `deductions_inr`, `net_pay_inr`, `detail jsonb` (day-by-day derivation).

**Permission keys to seed** (and mirror in `lib/permissions.ts` + `lib/types.ts` — F4): `attendance_edit → manager`, `attendance_approve → manager`.
**Deliberately NOT permission-gated:** clocking in and out. It requires only a valid staff session. Gating the one action every staffer performs daily behind a key that fails closed to manager (F4) would break attendance for the whole team the moment a seed row were missing.

---

## 7. Decisions

**Resolved in grooming (2026-08-05):**

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D5-1** | Punch device and anti-cheat strength | **Own phone + GPS geofence + accuracy/staleness checks**, with tamper *flagging* (GEO-2) | Cheapest to ship, no hardware, no new identity. Its limits are stated plainly in-product and in §3, and the stronger options remain available without rework (§11) |
| **D5-2** | Salary basis | **Monthly salary + contracted hours/day → derived per-minute rate**; shortfall deducts, excess is OT | Matches how the owner already thinks (₹/month, "9-hour shift"), and handles 9h vs 10h staff in one model |
| **D5-3** | Configurable rules | **All four**: late grace + late marks; OT threshold + multiplier; auto-deducted unpaid break; half-day/absent thresholds + weekly off | Owner-configurable from day one; defaults chosen so an owner who configures nothing still gets sane output |
| **D5-4** | Missed clock-out | **Auto-close at shift end + grace, flag, exclude from payroll until approved** | Never pays a guessed number; never loses the day either |

**Resolved 2026-08-06 — owner accepted the PM recommendation on all five.** Reversible: each row records what was chosen and why, so a change is a decision, not an archaeology exercise.

| # | Decision | Choice | Consequence for the build |
|---|---|---|---|
| **D5-5** | Work on a **weekly off** | Paid at the **OT multiplier** and flagged on the sheet | PAY-2 treats a weekly-off day's minutes as OT minutes outright; no comp-off balance is tracked |
| **D5-6** | **Paid leaves** | The owner marks a day as **"paid leave"** from the sheet; no allowance or balance system | SHEET-2 gains `paid_leave` as a day state; PAY-1 pays it at contracted hours and PAY-2 does not deduct it. A leave-balance system stays parked (§11) |
| **D5-7** | **Advance / loan** deduction | A free-text **± adjustment line with a mandatory reason** on the payroll run | PAY-3 gains an adjustments editor; PAY-4 freezes adjustments into the run alongside the rules snapshot. No advance *ledger* — the owner tracks the running balance themselves |
| **D5-8** | **Manager** visibility | Managers see the attendance sheet and can approve; **only the owner sees money** | Already the split above — SHEET-1/2/3 gate on `hasPermission()` (`attendance_edit`, `attendance_approve`, seeded at manager); all PAY-* routes use `getOwnerUser()` and are absent from the permission matrix |
| **D5-9** | **Raw coordinate** retention | **365 days**, then purge `lat`/`lng`, keeping `distance_m` + the verdict | Needs a purge job in the hardening week — extend the existing cron rather than adding a second one. `attendance_settings.location_retention_days` defaults to 365. Stated in the privacy policy (§9) |

> D5-6 and D5-7 are deliberately the cheap versions of expensive features. If either turns out to be load-bearing in real use, that is the signal to build the real thing — not a reason to have built it now.

---

## 8. Edge cases & failure modes (consolidated)

| Scenario | Required behaviour |
|---|---|
| Location permission denied or unavailable | Punch refused with device-specific re-enable instructions; owner can add a manual session (SHEET-2) marked `manual` |
| Poor GPS indoors (a real, frequent problem in a cafe) | Accuracy gate refuses with actionable guidance; marginal readings accepted and flagged rather than lost |
| Phone clock changed | No effect — server time only (GEO-3) |
| Staffer forgets to clock out | Auto-closed + flagged + excluded from pay until approved (SHEET-3) |
| Staffer forgets to clock in | No session; owner adds a manual one with a reason; the day reads `manual`, never `verified` |
| Shift crosses midnight | Entire shift belongs to the clock-in business date (F7, GEO-3) |
| Two sessions in one day (break punch-out) | Minutes summed; auto-break **not** applied (OPS5-1) |
| Overlapping sessions | Merged, not summed, and flagged (PAY-1) |
| Network drops mid-punch, staffer retries | 60-second idempotency window returns the existing session (ATT-1) |
| Staffer punches in, then is removed from the team | Open session auto-closes at the cap; the period up to removal still pays |
| Salary raised mid-month | Each day priced at the rate in effect that day (SHEET-4, PAY-2) |
| Owner edits a day after paying | Refused while the run is finalized; reversal is the supported path (PAY-4) |
| Cron doesn't run (Vercel incident) | Sessions stay open; the next run closes them; the absolute cap prevents unbounded sessions |
| `CRON_SECRET` unset | Endpoint returns 401 — fails closed (F8) |
| Store coordinates never set | Punching disabled with an owner-facing setup message, not silently open |
| Perfect attendance | Nets **exactly** the monthly salary — an explicit test, not an assumption |

---

## 9. Security, privacy & compliance

- **Location is personal data** under India's DPDP Act 2023. The lawful basis here is the employment relationship, but the Act still requires **notice, purpose limitation, and retention limitation** — all three are specced: ATT-2 (notice + recorded acknowledgement), collection *only at the punch instant* (never background, never continuous), and D5-9 (purge raw coordinates after the retention window, keeping only the derived distance and verdict).
- **Data minimisation:** we store the coordinate, its accuracy, and the derived distance. We do not store a track, a history between punches, a device identifier, or anything the geofence decision does not need.
- **Privacy policy must be updated** before 5A ships — `app/privacy` currently says nothing about staff location.
- **Authorization:** staff read own sessions only (RLS + route re-check); `attendance_settings`, `staff_employment`, `payroll_*` are never staff-readable. Payroll routes are owner-only via `getOwnerUser()`; attendance edit/approve go through `hasPermission()` with seeded keys (F4).
- **The geofence config is not exposed to the client** — staff learn accept/refuse and their own distance, nothing more.
- **Cron** copies the fail-closed `CRON_SECRET` pattern (F8).
- **CSV export** escapes formula-injection prefixes (PAY-5).
- Add an attendance section to `docs/SECURITY-PLAYBOOK.md` in the same PR as FND5-M.

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **GPS spoofing defeats the geofence** | Medium | High — the feature's whole premise | Stated honestly in-product and here; GEO-2 flags make patterns visible; kiosk/selfie upgrades specced and ready (§11). Do not oversell this to the team |
| Indoor GPS accuracy makes honest punches fail | **High** | High — staff lose faith in week one | Tune `max_accuracy_m` and `radius_m` **on site** during Gate 5A; the ambiguous-margin rule accepts-and-flags rather than refuses; manual sessions are always available |
| Staff perceive it as surveillance | Medium | High — adoption collapses | ATT-2's plain-language notice; punch-moment-only collection; ATT-4 gives staff their own record; frame it as *their* evidence in a pay dispute, which it genuinely is |
| Payroll math disputes | Medium | High | Every number shows its derivation (PAY-3); finalized runs are frozen with their rules (PAY-4); the test matrix in PAY-2 is a release gate |
| Scope sprawl into full HRMS (leaves, comp-offs, PF/ESI, TDS) | **High** | Medium | §11 parking lot is explicit; D5-6/D5-7 deliberately choose the 5%-effort version |
| Cron reliability | Low | Medium | Idempotent job + absolute session cap + the approval queue surfaces anything missed |

---

## 11. Out of scope (parking lot)

Deliberately excluded from Phase 5, recorded so they can be added without rework:

- **Kiosk-mode punching** on a shared counter tablet with per-staff PIN — the real fix for GPS spoofing. The data model already supports it: it is a different punch route writing the same `attendance_sessions` row with a `source` value.
- **Selfie-on-punch** — the strongest practical anti-buddy-punching measure. Needs Supabase Storage, camera permission, and a consent update; the session row would gain a photo path.
- **Store Wi-Fi / IP pinning** as a second factor alongside GPS.
- Shift **rostering / scheduling** (who is *supposed* to work when) — Phase 5 records what happened, it does not plan it. Late detection uses the contracted shift start, not a roster.
- **Leave balances**, comp-offs, holiday calendars (D5-6 covers the minimum).
- **Statutory payroll** — PF, ESI, TDS, Form 16, payslip statutory formats.
- **Staff self-service payslips** (staff see hours in ATT-4, not money, in this phase).
- Bank transfer / payout **execution** — Phase 5 computes what to pay, it does not pay it.
- **Blocking POS use when not clocked in** (ATT-3 deliberately nudges instead) — revisit once the geofence's real-world false-refusal rate is known.
- Tips, incentives, and **attendance-linked bonuses**.
- Biometric / face-recognition attendance.

---

## 12. Test plan (release gate)

**Pure-function unit tests** (the bulk — following `tests/tableOccupancy.test.ts`, `tests/quickAdd.test.ts`):
- `tests/geofence.test.ts` — haversine accuracy against known coordinate pairs; accept / refuse / ambiguous-flag verdicts across the accuracy and staleness matrix; missing store point.
- `tests/attendanceDay.test.ts` — single session; two sessions; overlapping sessions; auto-break applied and correctly *not* applied; midnight-crossing shift; unapproved auto-close contributing zero; late-minute computation across the grace boundary.
- `tests/payroll.test.ts` — the full PAY-2 matrix, including the **perfect-attendance-equals-exact-salary** assertion and the divide-by-zero guard.
- `tests/attendanceFlags.test.ts` — static coords, impossible travel, implausible accuracy.

**Route tests** (following `tests/ordersCreateStaff.test.ts`, `tests/cashDays.test.ts`):
- punch accept/refuse paths and that a client-supplied time or verdict is ignored;
- one-open-session invariant under concurrent requests;
- the 60-second retry idempotency window;
- staff cannot read another staffer's sessions;
- edit/approve permission gates;
- finalized-run immutability;
- cron fails closed without `CRON_SECRET` and is idempotent across two runs.

**Manual gates (owner-owned, on site):**
- **Gate 5A** — apply the migration; set the cafe's coordinates; punch from *inside* the cafe, from the doorway, from ~200 m away, and from home. Tune `radius_m` / `max_accuracy_m` from what the real building actually returns. **This gate cannot be skipped** — the indoor-accuracy risk is the phase's highest.
- **Gate 5B** — leave a session open overnight, confirm auto-close and the approval queue; make a correction and verify the audit trail and the staffer's own view.
- **Gate 5C** — run payroll for a real part-month against real punches and reconcile against a hand calculation before finalizing anything.

---

**Next documents:** `docs/PHASE-5-RICE.md` (prioritization), `docs/PHASE-5-SPRINT-PLAN.md` (sequencing and gates).
