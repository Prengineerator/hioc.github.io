# HIOC Revamp — Phase 1 "Connected Ordering" — Detailed Spec

**Companion to:** `docs/REVAMP-REQUIREMENTS.md`, `docs/RICE-PRIORITIZATION.md`
**Version:** 0.1 (Draft for engineering grooming)
**Date:** 2026-07-17
**Owner:** Product (Senior PM)
**Scope:** The Phase-1 locked scope from the RICE sheet §5. Each requirement below has a **user story**, **acceptance criteria** (Given/When/Then), **edge cases**, and **dependencies**. This is the hand-off artifact for sprint grooming.

---

## 0. Phase-1 goal & definition of done

**Goal:** Turn HIOC from a one-way order form into a real-time loop — customers see live status and get notified, staff accept/prepare on a real-time board, and the owner gets a first analytics dashboard.

**Release-level Definition of Done**
- [ ] All acceptance criteria below pass on staging with real Supabase data.
- [ ] Order state machine (F1) is the single source of truth; every transition is timestamped + attributed.
- [ ] Real-time works end-to-end (< 2s), with a **poll fallback** if the socket drops (NFR-002).
- [ ] Notifications deliver on `accepted`, `ready`, `rejected`, `cancelled`; delivery is logged.
- [ ] Owner dashboard renders on mobile + desktop from live data.
- [ ] `lib/types.ts` kept in exact sync with the schema; RLS policies cover new tables.
- [ ] Automated tests for the state machine transitions + order API (first tests in the repo).

**Conventions:** AC written as **Given / When / Then**. "Actor" = the authenticated user performing the action. All money in paise-safe integer ₹ (existing convention). All times stored UTC, displayed IST.

---

## 1. Foundations

### F1 — Order state machine (XC-041)
**Story:** As the platform, I model an order's full lifecycle so every surface reads one consistent status and every transition is measurable.

**States:** `placed → received → accepted → preparing → ready → completed`, plus `rejected`, `cancelled` (and payment sub-states `payment_pending`, `paid`, `refunded` — wired in P2 when payments land; the enum ships now).

**Allowed transitions**
| From | To | Actor | Guard |
|---|---|---|---|
| (create) | received | system | order successfully persisted |
| received | accepted | staff | store open |
| received | rejected | staff | reason required |
| received | cancelled | customer/staff | before `accepted` only |
| accepted | preparing | staff | — |
| accepted | cancelled | staff | reason required |
| preparing | ready | staff | — |
| ready | completed | staff | — |
| any non-terminal | cancelled | manager | reason required (override) |

**Acceptance criteria**
- **Given** a valid transition in the table, **when** the actor performs it, **then** status updates, `order_status_events` gets a row `(order_id, from, to, actor_id, reason, at)`, and `orders.updated_at` refreshes.
- **Given** a transition *not* in the table (e.g. `completed → preparing`), **when** attempted, **then** the API rejects it `409` and no event is written.
- **Given** two staff act on the same order near-simultaneously, **when** both submit, **then** the second sees a conflict (optimistic version check) and re-reads current status — no double transition.
- **Given** any transition, **then** the actor is recorded (STF-053) — never null for staff actions.

**Edge cases:** clock skew (server time authoritative); a customer cancel racing a staff accept → whichever commits first wins, loser gets a clear "order already accepted/cancelled" message.
**Deps:** none (build first). Terminal states: `completed`, `rejected`, `cancelled`.

### F2 — Real-time infrastructure (XC-010) + availability propagation (XC-011)
**Story:** As staff and customers, I see changes push instantly instead of waiting for a 15s refresh.

**Acceptance criteria**
- **Given** the staff queue is open, **when** a new order is placed or any status changes, **then** the board reflects it in **< 2s** without a manual refresh.
- **Given** a customer is on their live-status page, **when** staff advance the order, **then** the customer's status updates in **< 2s**.
- **Given** the realtime channel drops, **when** connectivity is lost, **then** the client falls back to polling (≤ 15s) and shows a subtle "reconnecting" indicator; no missed final state.
- **Given** staff toggle an item unavailable / 86 it, **then** it disappears (or greys) on the customer menu in **< 5s** (XC-011).

**Edge cases:** flaky cafe wifi (fallback), many concurrent customers on status pages (channel scoping per order), duplicate events (idempotent client apply keyed by `updated_at`).
**Deps:** F1.

### F3 — RBAC expansion + route gating + session (XC-001, XC-003, XC-005, XC-002)
**Story:** As the business, I want three role-scoped surfaces so customers, staff, and the owner each see only what they should.

**Roles this phase:** `customer`, `staff`, `owner`. (`kitchen`/`cashier`/`manager` granularity deferred to P2 — but the `role` column and permission checks are built to extend.)

**Acceptance criteria**
- **Given** an authenticated user, **when** they hit `/owner/**`, **then** access is allowed only if `role='owner'`; staff and customers get `403`/redirect.
- **Given** an authenticated `customer`, **when** they hit `/staff/**`, **then** they are blocked (existing behavior preserved).
- **Given** a role change (e.g. promote to owner via SQL), **then** it is recorded in an audit trail (who/when) and takes effect on next session refresh.
- **Given** any privileged write, **then** the server (not the client) enforces the role via RLS + route guard — no client-trusted role.

**Edge cases:** a user with no `profiles` row (defaults to `customer` via existing trigger); owner is also allowed read access to staff ops (OWN-002).
**Deps:** none; needed before /owner ships.

### F4 — Notifications engine (XC-020, XC-021, XC-022, XC-023)
**Story:** As a customer, I get told when my order is accepted and ready, so I don't have to keep checking.

**Channels this phase:** **WhatsApp** (primary, via Business API/provider) + **SMS fallback**; **web-push** optional if opted in. Email optional.

**Events → templates:** `accepted` (with ETA), `ready` ("come collect, order #"), `rejected` (reason + apology), `cancelled` (reason).

**Acceptance criteria**
- **Given** an order transitions to `accepted`, **then** a notification is sent to `customer_phone` within **30s**, containing order number and ETA, and a link to live status.
- **Given** an order transitions to `ready`, **then** a "ready for pickup" notification is sent with the pickup code (CUS-056).
- **Given** an order is `rejected`/`cancelled`, **then** the customer is notified with the reason.
- **Given** a send fails, **then** it is retried (≥1) and the final result logged to `notifications` `(order_id, channel, event, status, provider_ref, sent_at)`.
- **Given** a customer opts out of marketing, **then** **transactional** order notifications still send (consent applies to marketing only, XC-022).

**Edge cases:** invalid/unreachable number (log + surface to staff so they can call), WhatsApp template not approved (fall back to SMS), duplicate sends (idempotency key = order_id+event).
**Deps:** F1 (transitions trigger sends). **Open Q:** which WhatsApp provider/budget (Requirements §13.2).

### F5 — Analytics event pipeline (XC-044)
**Story:** As the platform, I capture order + funnel events so the owner dashboard is accurate and cheap to query.

**Acceptance criteria**
- **Given** any order lifecycle event, **then** it lands in a queryable store (from `order_status_events` + order rows) sufficient to compute every Phase-1 owner metric (revenue, counts, prep-time, best-sellers, peak-hours).
- **Given** the owner opens a dashboard for a date range, **then** queries return in **< 3s** (use rollups/materialized views if raw aggregation is too slow).
- **Given** a menu item is later renamed/repriced, **then** historical metrics use the **snapshotted** order-item values (existing convention) — not current menu values.

**Deps:** F1.

---

## 2. Staff surface

### S1 — Real-time order queue (STF-001) + counter mode (STF-013)
**Story:** As counter staff, I watch incoming and in-progress orders on a live board optimized for a shared tablet.

**Acceptance criteria**
- **Given** the queue, **then** orders are grouped in lanes: **New (received) · Accepted · Preparing · Ready**, newest-first within lane, each card showing order #, customer name, item count, total, order age (ticking), and order type.
- **Given** a status changes anywhere, **then** the board updates in < 2s (F2) with the card moving lanes.
- **Given** "counter mode" is enabled, **then** the board goes full-screen, hides nav chrome, uses large tap targets, and keeps the screen awake.
- **Given** completed/rejected/cancelled orders, **then** they leave the active lanes (accessible via history/search S5).

**Edge cases:** long item lists (card expands/scrolls), 20+ concurrent orders (virtualized list), tablet sleep (wake-lock in counter mode).
**Deps:** F1, F2.

### S2 — New-order alert (STF-002)
**Story:** As busy counter staff, I can't miss a new order, so the app grabs my attention until I acknowledge it.

**Acceptance criteria**
- **Given** a new `received` order arrives, **then** an audible sound + visual banner fires and repeats/persists until a staff member acknowledges (accept/reject or dismiss).
- **Given** the tablet is muted or backgrounded, **then** the visual alert still shows on return and a badge count reflects unacknowledged orders.
- **Given** staff settings, **then** volume/sound can be toggled (STF-043 busy mode does not silence new-order alerts).

**Edge cases:** multiple orders in quick succession (queue the alerts, badge shows count), browser autoplay restrictions (require a one-time "enable sound" tap on session start).
**Deps:** F2.

### S3 — Accept / Reject (STF-003) + set ETA (STF-006) + order detail (STF-005)
**Story:** As staff, I open a new order, see everything about it, then accept it with a ready-time or reject it with a reason.

**Acceptance criteria**
- **Given** a `received` order, **when** staff tap it, **then** a detail view shows all line items with variant + addons + per-item notes, order-level notes, customer name/phone, order type, and placed-time.
- **Given** the detail view, **when** staff tap **Accept**, **then** they are prompted for an estimated ready time (default from OWN-030 prep default, adjustable in +5min steps), status → `accepted`, ETA saved to `promised_ready_at`, and the customer is notified with the ETA (F4).
- **Given** the detail view, **when** staff tap **Reject**, **then** a reason is required (dropdown: out of stock / too busy / closing / other+text), status → `rejected`, customer notified.
- **Given** an `accepted` order, **when** staff tap **Start**, **then** → `preparing`; **Ready** → `ready` (fires S4 notify); **Complete** → `completed`.
- **Given** the store is closed/busy-paused, **when** staff try to accept, **then** they can still accept manually (staff override) but see a warning.

**Edge cases:** rejecting after partially accepted (not allowed — accept is one-way to accepted), customer cancelled while staff viewing (detail shows "cancelled by customer", accept disabled), ETA in the past (block, min = now+5).
**Deps:** F1, F4, OWN-030 (prep default).

### S4 — "Ready" fires customer notification (STF-011)
**Story:** As staff, when I mark an order ready, the customer is automatically told to come collect.

**Acceptance criteria**
- **Given** an order → `ready`, **then** the customer receives the "ready for pickup" notification (F4) within 30s including order # and pickup code — no extra staff action.
- **Given** the notification fails, **then** staff see a small "couldn't notify — call {phone}" flag on the card.

**Deps:** F4, S3.

### S5 — Search / filter orders (STF-009)
**Story:** As staff, I find any order quickly to answer a customer at the counter.

**Acceptance criteria**
- **Given** the search box, **when** staff type an order number, phone, or name, **then** matching orders (including today's completed) show with status.
- **Given** filters, **when** staff pick a status and/or date, **then** the list narrows accordingly.

**Edge cases:** partial phone match, order from a previous day (date filter), no results (clear empty state).
**Deps:** F1.

### S6 — 86 / snooze item (STF-032) + photo upload (STF-033)
**Story:** As staff, I mark an item out of stock in one tap and set it to auto-return, and I can attach a photo.

**Acceptance criteria**
- **Given** the menu screen, **when** staff tap **86** on an item, **then** it becomes unavailable immediately (propagates to customers via F2/XC-011) and offers "auto re-enable" options (2h / end of day / manual).
- **Given** an auto-reenable time, **when** it passes, **then** the item returns to available automatically.
- **Given** an item edit, **when** staff upload an image, **then** it is stored and shown on the customer menu (CUS-003); size/format validated.

**Edge cases:** item 86'd while in someone's cart (checkout re-validates availability, S3/order creation rejects unavailable items with a clear message), large image (compress/limit).
**Deps:** F2, XC-011, existing menu CRUD.

### S7 — Busy mode (STF-043) + open/close store (STF-044) + mark payment (STF-041)
**Story:** As staff, I control whether we're accepting orders and how fast, and I record how a walk-up paid.

**Acceptance criteria**
- **Given** staff enable **Busy mode**, **then** the customer menu shows longer ETA (added prep buffer) or a "kitchen is busy" banner; new orders still allowed unless paused.
- **Given** staff **Pause new orders**, **then** customers see "not accepting online orders right now" and cannot check out; existing orders unaffected.
- **Given** staff **Close store**, **then** the customer site shows closed state (CUS-010) and blocks checkout until reopened or the next scheduled open time.
- **Given** an order, **when** staff mark payment collected, **then** they pick a method (cash/UPI/card), and it's recorded on the order (feeds OWN-009 later).

**Edge cases:** scheduled hours vs manual override (manual wins until cleared), reopening mid-day, pausing with in-flight carts (carts persist, checkout blocked with message).
**Deps:** F1, OWN-030.

---

## 3. Customer surface

### C1 — Live order status (CUS-051) + prep ETA (CUS-052) + pickup code (CUS-056)
**Story:** As a customer, after I order I watch it move from received to ready, with an ETA and a code to show at the counter.

**Acceptance criteria**
- **Given** a placed order, **then** the confirmation/status page shows a progress UI: **Received → Accepted → Preparing → Ready**, the current step highlighted, updating in real time (F2).
- **Given** the order is accepted, **then** the estimated ready time is shown ("Ready by ~1:45 PM").
- **Given** the order, **then** a pickup code / QR (CUS-056) is displayed to show at the counter.
- **Given** the order is rejected/cancelled, **then** the page clearly shows that state with the reason.
- **Given** the customer closes and reopens the link, **then** current status is preserved (server-sourced).

**Edge cases:** guest returning via link (no login needed — existing confirmation link pattern), very fast orders (skips visibly through states), ETA passed but not ready ("running a little late").
**Deps:** F1, F2.

### C2 — Order notifications (CUS-054, CUS-055)
**Story:** As a customer, I'm messaged when my order is accepted and when it's ready — and if it's rejected/cancelled.

**Acceptance criteria**
- Covered by F4; from the customer's view: **Given** I placed an order with a valid number, **then** I receive an "accepted (ETA)" message and a "ready" message; and a "rejected/cancelled (reason)" message if that happens.
- **Given** I never logged in, **then** notifications still reach me via the phone I entered at checkout.

**Deps:** F4.

### C3 — Out-of-stock in real time (CUS-009) + store open/closed awareness (CUS-010)
**Story:** As a customer, I only see what's actually available and can't place an order when the cafe is closed.

**Acceptance criteria**
- **Given** an item is 86'd/unavailable, **then** it shows greyed "unavailable" (or is hidden) and can't be added to cart; if already in cart, checkout blocks it with a clear message.
- **Given** the store is closed (scheduled hours or manual, per S7), **then** the site shows a closed banner with next-open time and disables checkout.
- **Given** the store is open but paused, **then** checkout shows "not accepting online orders right now".
- **Given** availability changes while browsing, **then** it reflects within 5s (F2/XC-011).

**Edge cases:** ordering right at closing time (block based on server time + last-order cutoff), timezone (IST).
**Deps:** F2, XC-011, S6, S7, OWN-030 (hours).

### C4 — Per-item special instructions (CUS-021) + structured pickup slots (CUS-026)
**Story:** As a customer, I add a note to an item and choose a real pickup time slot instead of typing free text.

**Acceptance criteria**
- **Given** an item in customization, **then** I can add a short free-text instruction; it's shown to staff on the order card (S3) and snapshotted on the order line.
- **Given** checkout, **then** pickup time is chosen from **structured slots** (e.g. "ASAP (~15 min)", then 15-min slots within open hours) rather than free text; slots respect open hours and any per-slot capacity (OWN-030).
- **Given** a full/past slot, **then** it's disabled/hidden.

**Edge cases:** ASAP vs scheduled, slot capacity reached (grey it), store closing before a chosen slot (block).
**Deps:** OWN-030 (hours/slots/capacity). **Migration note:** replaces today's free-text `pickup_time`.

### C5 — GST / bill breakup (CUS-031)
**Story:** As a customer, I see a clear price breakdown so I trust the total.

**Acceptance criteria**
- **Given** the cart/checkout, **then** the summary shows item subtotal, applicable **GST** (per configured tax, OWN-033/030), any packaging charge, and the grand total — each as a labeled line.
- **Given** the order is placed, **then** the same breakdown is snapshotted on the order (`subtotal_inr`, `tax_inr`, `total_inr`) and shown on confirmation.

**Edge cases:** zero-tax items vs taxed, rounding (consistent integer ₹ rounding rule documented).
**Deps:** OWN-030/033 tax config. **Schema:** add `tax_inr`, `total_inr` to `orders`.

### C6 — Item photos (CUS-003) + menu performance (CUS-083)
**Story:** As a customer, I see appetizing photos, and the menu loads fast on my phone.

**Acceptance criteria**
- **Given** an item with an uploaded image (S6), **then** the card and detail show it; items without a photo show a tasteful placeholder (no broken layout).
- **Given** a mid-range phone on 4G, **then** the menu is interactive in **< 2.5s** (NFR-001): images lazy-loaded, responsive sizes, no layout shift.

**Edge cases:** missing image, slow network (progressive load, skeletons).
**Deps:** S6 (upload), `image_url` on `menu_items`.

---

## 4. Owner surface (v1)

> New `/owner` area, gated by F3. Mobile-first cards + a few charts. All figures from F5 pipeline; historical values use snapshots.

### O1 — Today at a glance (OWN-001) + live ops mirror (OWN-002)
**Story:** As the owner, I open one screen and instantly know how today is going and what's happening right now.

**Acceptance criteria**
- **Given** the owner dashboard, **then** the top shows today's: **revenue ₹, order count, AOV, orders in progress**, each vs. the same weekday last week (delta + arrow).
- **Given** the live-ops card, **then** the owner sees a **read-only** mirror of the staff queue (counts per lane, oldest in-progress age) updating in real time.
- **Given** no orders yet today, **then** a clean zero-state (not an error).

**Deps:** F3, F5, F2.

### O2 — Revenue over time + trend (OWN-003)
**Story:** As the owner, I see revenue across a date range with comparison so I can spot trends.

**Acceptance criteria**
- **Given** a range selector (today / 7d / 30d / custom), **then** a time-series of revenue renders with the prior-period comparison and a headline total + % change.
- **Given** a day is tapped, **then** it drills into that day's hourly revenue.
- **Given** refunds/cancellations, **then** revenue is net (excludes cancelled; subtracts refunds when payments land in P2).

**Deps:** F5.

### O3 — Orders analytics (OWN-004) + prep-time/SLA (OWN-008)
**Story:** As the owner, I see order volume and how fast we fulfill, so I can manage capacity.

**Acceptance criteria**
- **Given** a range, **then** show counts + rates for placed / accepted / rejected / completed / cancelled, and acceptance & rejection rates.
- **Given** SLA metrics, **then** show **median and p90** time-to-accept (placed→accepted) and prep-time (accepted→ready), with trend across the range.
- **Given** rejections/cancellations, **then** show the reason breakdown (from S3/F1 reasons).

**Deps:** F1 (events), F5.

### O4 — Best & worst sellers (OWN-005) + peak-hours heatmap (OWN-007)
**Story:** As the owner, I see which items and hours drive the business.

**Acceptance criteria**
- **Given** a range, **then** show top and bottom items by units and by revenue, plus category mix.
- **Given** the heatmap, **then** render a day-of-week × hour grid shaded by order volume (or revenue), making peak windows obvious.

**Deps:** F5.

### O5 — Store settings (OWN-030)
**Story:** As the owner, I configure hours, pickup slots, prep defaults, and tax — the settings the customer and staff flows depend on.

**Acceptance criteria**
- **Given** settings, **then** the owner can set weekly opening hours + holidays, last-order cutoff, pickup-slot length + per-slot capacity, default prep time, and GST/tax config.
- **Given** a change, **then** it takes effect on the customer site (C3/C4/C5) and staff ETA defaults (S3) without a redeploy.

**Edge cases:** overlapping/holiday hours, changing slot length mid-day (applies to future slots), tax change (only affects new orders — snapshots preserve old).
**Deps:** F3. **Note:** several other Phase-1 items (C3, C4, C5, S3, S7) depend on O5 — **build O5 early**.

---

## 5. Data-model changes required for Phase 1

Applied on top of the existing schema; keep `lib/types.ts` in sync; preserve order-item snapshotting.

| Change | Serves |
|---|---|
| Extend `order_status` enum: add `placed`, `accepted`, `rejected`, `cancelled` (+ payment sub-states reserved) | F1 |
| New `order_status_events (id, order_id, from_status, to_status, actor_id, reason, created_at)` | F1, O3, audit |
| `orders` add: `order_type`, `promised_ready_at`, `pickup_code`, `tax_inr`, `total_inr`, `payment_method`, `payment_status` | S3/S7, C1/C5 |
| `orders` migrate `pickup_time` free-text → structured slot ref/value | C4 |
| `menu_items` add: `image_url`, `unavailable_until` (86 auto-reenable) | S6, C6 |
| New `notifications (id, order_id, channel, event, status, provider_ref, sent_at)` | F4 |
| New `store_settings` (hours, holidays, slot config, prep default, tax) | O5 |
| `profiles.role` extend to include `owner`; role-change audit | F3 |
| Rollups / materialized views for owner metrics | F5, O1–O4 |
| RLS policies for all new tables (owner-read, staff-write as appropriate) | NFR-004 |

---

## 6. Cross-references & open questions blocking Phase 1

- **F4 (notifications):** choose WhatsApp provider + budget → Requirements §13 Q2. *Blocks C2/S4 go-live; build engine channel-agnostic so provider swap is config.*
- **O5 tax config:** confirm HIOC's GST treatment (rate, inclusive vs exclusive) → C5.
- **Architecture:** one codebase, three role-gated surfaces (`/`, `/staff`, `/owner`) — confirmed direction (Requirements §13 Q5).
- **Order type (C4/S3):** confirm takeaway-only vs takeaway+dine-in for Phase 1 (delivery is P2+) → Requirements §13 Q3.

---

## 7. Suggested build order (dependency-first)

1. **F1** state machine + **F3** RBAC/gating + **O5** store settings (unblock everything)
2. **F2** realtime + **F5** analytics pipeline
3. **S1/S2/S3/S4/S5** staff queue + accept/reject/ETA + alerts
4. **F4** notifications engine → wire S4/C2
5. **C1/C3/C4/C5/C6** customer live status, availability, slots, bill, photos (+ **S6/S7**)
6. **O1–O4** owner dashboards on top of F5
7. NFR gates: perf pass (C6/NFR-001), poll fallback (F2/NFR-002), RLS review (NFR-004), DPDP consent (NFR-005), first automated tests (F1 + order API)

> Each numbered group is demoable. Ship behind a feature flag (XC-045) if you want to dark-launch the owner surface before opening it up.
