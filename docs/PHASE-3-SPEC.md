# HIOC Revamp — Phase 3 "Dine-In & Counter Ops" — Detailed Spec

**Companion to:** `docs/REVAMP-REQUIREMENTS.md`, `docs/PHASE-2-SPEC.md` (§9 parking lot), `docs/PHASE-3-RICE.md`, `docs/PHASE-3-SPRINT-PLAN.md`
**Version:** 0.1 (Draft for grooming)
**Date:** 2026-07-21
**Owner:** Product (Senior PM)
**Scope:** Bring **every order into the one pipeline** — staff-entered dine-in/walk-in orders (POS-lite), tables as first-class objects, kitchen tickets, and (stretch) table-QR self-ordering — plus the channel analytics that make the mix measurable. Assumes Phase 1 "Connected Ordering" and Phase 2 "Value & Retention" are live.

---

## 0. Phase-3 goal & definition of done

**Goal:** Today the website only captures *remote takeaway* orders; dine-in and walk-in orders live on paper and never enter the system. Phase 3 makes **staff the second order-entry channel**: a counter/tablet POS-lite that places, amends, and settles dine-in orders through the *same* order pipeline (state machine, payments, notifications, analytics) the website already uses. One order base, every channel.

**Why now:** The plumbing is already there — `order_type` supports `dine_in` (Phase-1 migration), the state machine + realtime board run every order, Phase-2 gives us payments/refunds, the manager role, and per-staff attribution. What's missing is purely the *entry surface* and the dine-in-specific rules (tables, counter settlement, corrections). This was explicitly parked in `PHASE-2-SPEC.md §9` ("Phase 2b — Counter efficiency"); this spec is that phase, promoted and expanded.

**Current-state facts (verified in code, 2026-07-21):**
- `OrderType = 'takeaway' | 'dine_in' | 'delivery'` exists and `POST /api/orders` validates it — but the checkout UI never sends it, so **every real order is `takeaway`**.
- The staff app (`app/staff/`) is queue-only: it advances orders but **cannot create one** (STF-040 gap).
- **No table concept** anywhere in schema or UI.
- Orders are immutable after placement (no add/remove — STF-008 gap).
- Payments assume web-originated orders; a **staff-entered, counter-settled** order has no path, and nothing guards that dine-in completes only once paid.

**Release-level Definition of Done**
- [ ] Staff can **create a dine-in or walk-in order** from the staff app in ≤ 30 s for a typical 3-item order, assigned to a **table** (dine-in) or as counter/takeaway.
- [ ] Staff-created orders flow the **same state machine**, appear on the same queue/board, and carry **per-staff attribution** (STF-053).
- [ ] Open orders can be **corrected** — a line **voided** (manager-gated), never deleted — with the bill re-computed **server-side** and every change audited.
- [ ] Dine-in orders **cannot complete until settled** (paid or manager-comped); settle records method (cash/UPI/card) exactly like STF-041.
- [ ] A **tables board** shows free/occupied state at a glance; an occupied table opens its running order.
- [ ] **KOT** prints per order and **receipt/token** prints at settle (thermal or browser-print fallback); reprint works (STF-020/024/042).
- [ ] The settled bill is deliverable **three ways**: printed (KOT-2), **WhatsApp'd** (RCT-1), and **emailed** (RCT-2) — sent automatically where contact info was captured, resendable from the order detail.
- [ ] *(Stretch, flag-gated)* A customer scanning a **table QR** orders into the same pipeline with the table pre-filled (CUS-025).
- [ ] Owner analytics show **channel mix** (web / staff / QR), dine-in vs takeaway revenue, and average ticket per channel.
- [ ] The cash drawer is managed in-system: **day-open float and day-close counts entered by denomination**, expected vs counted computed automatically, over/short stored with sign-off (OPS-2, STF-045).
- [ ] Sensitive actions are governed by an **owner-configurable permission matrix** — the owner decides which actions staff may perform vs manager-only (FND3-6, STF-050/051) — shipped with safe defaults (D4).
- [ ] All new tables RLS-covered; pricing stays **server-authoritative**; `lib/types.ts` in exact sync with `supabase/phase3-migration.sql`.
- [ ] Automated tests for amendment math, dine-in state-machine rules, and settle/void concurrency.

**Conventions:** Same as Phase-1/2 specs — AC in Given/When/Then; integer ₹; UTC-stored, IST-displayed; server/RLS-enforced authorization; new surfaces dark-launched behind flags (`lib/flags.ts`).

---

## 1. Milestone architecture

The phase ships in **three independently launchable milestones** — each one leaves the cafe better off even if the next never ships:

| Milestone | Theme | Ships | Cafe outcome |
|---|---|---|---|
| **3A — Staff takes the order** | POS-lite core | FND3-1/2/3/5 · POS-1/2/3 · KOT-2 · RCT-1 | Paper pads retired; every dine-in/walk-in order is in the system, settled through it, bill printed or WhatsApp'd |
| **3B — Corrections, kitchen & permissions** | Voids + KOT + access control | FND3-6 · FND3-4 · POS-4 · KOT-1 | Kitchen works off printed tickets; mistakes are voided with an audit trail; the owner decides who may do what |
| **3C — Cash, self-serve & insight** | Cash + QR + email + analytics | OPS-2 · QR-1/2 · RCT-2 · OPS-1 | The drawer opens and closes by denomination count; customers order from the table; bills reach inboxes; owner sees channel economics |

> Sequencing rationale: 3A is pure value with the least new invention (reuses quote/create/settle paths). 3B contains corrections and the printer integration — isolated so hardware can't block 3A. 3C is demand-gated (QR) and measurement (analytics), both meaningless until 3A/3B generate the data.

---

## 2. Foundations (FND3)

### FND3-1 — Tables registry + owner CRUD
**Story:** As the owner, I define my tables (label, zone, capacity, active) so orders can be pinned to a physical table.

**Acceptance criteria**
- **Given** the owner settings area, **when** the owner adds a table (label e.g. "T1", optional zone e.g. "Terrace", capacity), **then** it appears in the staff table picker and tables board, in `sort_order`.
- **Given** a table with an **open order**, **when** the owner deactivates it, **then** deactivation is blocked with a clear message (settle first).
- **Given** any table, **then** it carries a stable `qr_token` (generated at creation) reserved for QR-1 — regenerable by the owner (old links die).

**Edge cases:** duplicate labels (block, case-insensitive), delete vs deactivate (soft-deactivate only — orders reference tables historically).
**Deps:** none. **Serves:** POS-1/3, QR-1.

### FND3-2 — Order channel & staff attribution
**Story:** As the platform, every order records *which channel* created it and *which staff member* (when staff-created), so ops and analytics can trust the data.

**Acceptance criteria**
- **Given** any order, **then** it has `channel ∈ {customer_web, staff_pos, table_qr}`; existing rows backfill to `customer_web`; website checkout continues to write `customer_web` untouched.
- **Given** a staff-created order, **then** `created_by` = the staff profile id, surfaced on the order detail and in the audit trail (extends STF-053 / Phase-1 events).
- **Given** a dine-in order, **then** `table_id` + a `table_label` **snapshot** are stored (label survives later table renames, same snapshot philosophy as menu prices).

**Deps:** FND3-1 (table FK). **Serves:** everything below; OPS-1.

### FND3-3 — Staff order-creation path
**Story:** As the platform, `POST /api/orders` accepts a **staff-authenticated** creation mode so the POS surface reuses the whole existing pricing/validation stack instead of forking it.

**Acceptance criteria**
- **Given** a request from an authenticated staff/manager/owner session (`getStaffUser()` family), **when** it creates an order, **then** guest-checkout guards (OTP verification, customer rate-limits) are **skipped**, and server-side pricing/validation (items, variants, addons, availability, store-open) applies **unchanged**.
- **Given** a staff-created order, **then** it starts at **`accepted`** (staff placing it *is* acceptance — no self-accept ceremony), with a `null → accepted` status event attributed to the staff actor.
- **Given** `order_type = dine_in`, **then** a valid active `table_id` is **required**, `packaging_inr` is **0**, and no pickup slot is required; **given** a staff *walk-in takeaway*, **then** table is absent and the existing token/pickup flow applies.
- **Given** customer name/phone, **then** both are **optional** for staff-created orders (anonymous walk-in allowed); when a phone *is* captured it is E.164-normalized and the order is claimable/loyalty-eligible exactly like a web guest order.
- **Given** a staff-created dine-in order, **then** payment is normally collected **during entry** (counter model, decision D2 — see POS-1/2); an order created **unpaid** (collect-later fallback) still enters the flow — unlike web online-payment orders which gate on `paid`.

**Edge cases:** store force-closed (staff may still create — staff presence implies open; log it), several open orders on one table (allowed — under the counter model a second visit is simply a new order; the tables board groups them), item 86'd mid-entry (same availability error path as web).
**Deps:** FND3-1/2, Phase-1 pricing stack. **Serves:** POS-1. 🔑 *Enabler — the pillar rides on it.*

### FND3-4 — Order corrections engine (STF-008, scoped to voids)
**Story:** As the platform, an open order can be **corrected** — a wrongly punched line voided — with the bill recomputed server-side and every change audited. *(Scoped down from a full rounds/amendment engine by decision D2: HIOC is counter-service one-shot, so "add a round" has no user — a second order is a new order.)*

**Acceptance criteria**
- **Given** an open order (`accepted`/`preparing`/`ready`, `payment_status ≠ paid`), **when** a line is voided, **then** it is **voided, never deleted** (`voided=true`, reason, `voided_by`, timestamp) — the row survives for audit and because a KOT may already have fired; voided lines are excluded from totals, which are recomputed server-side under the optimistic-concurrency `version` guard.
- **Given** policy D4, **then** every void is **manager-gated** (same re-auth pattern as Phase-2 refunds) and attributed to the acting manager.
- **Given** any correction, **then** an `order_amendments` record (who/what/when/payload) is written and the staff board updates in realtime.
- **Given** a **paid** order, **then** correction is blocked — post-payment fixes go through the existing refund path (Phase-2 FND-2), not silent edits.

**Edge cases:** two staff correcting simultaneously (version guard — loser re-fetches), voiding the only line (order total → ₹0; staff must cancel the order instead), coupon/points on the order (recompute discount against the new subtotal; if the coupon no longer qualifies, drop it with a visible bill change — snapshot the decision).
**Extensibility:** `order_amendments.kind` is an open enum — if the service model ever adds table-service rounds, they attach here without schema breakage.
**Deps:** FND3-3, Phase-1 `version` guard, Phase-2 FND-5. **Serves:** POS-4, KOT-1 reprints.

### FND3-5 — Dine-in rules in the state machine
**Story:** As the platform, the state machine understands dine-in: staff-created orders skip `received`, "ready" means "serve it", and completion requires settlement.

**Acceptance criteria**
- **Given** `lib/orders/stateMachine.ts`, **then** it permits the `null → accepted` staff-create entry (FND3-3) alongside the existing `null → received`/`placed` paths — table-driven, like every other rule.
- **Given** a **dine-in** order at `ready`, **when** staff advances to `completed`, **then** the transition is **blocked unless `payment_status = paid`** (or an explicit manager comp) — the settle action (POS-2) is what completes it.
- **Given** a staff-created order with **no phone**, **then** the notification engine skips sends cleanly (no queued-failed noise); **given** a phone on a dine-in order, **then** the `ready` notification is **suppressed** (food is walked to the table — default D7) while the settle receipt still sends.

**Deps:** Phase-1 state machine, FND3-3. **Serves:** POS-2, correctness everywhere.

---

### FND3-6 — Owner-configurable permission matrix (STF-050, STF-051)
**Story:** As the owner, I decide which sensitive actions plain staff may perform and which need a manager — instead of the hierarchy being hard-coded. *(Extends Phase-2 FND-5, which introduced the `manager` role with fixed gates; this is the "broader staff role granularity" parked in `PHASE-2-SPEC.md §9`.)*

**Acceptance criteria**
- **Given** a `role_permissions` table seeded with the D4 defaults (void line: manager · comp: manager · refund: manager (Phase-2 behavior preserved) · day-open: staff · day-close sign-off: manager · POS order entry: staff · settle: staff · menu edits: staff), **then** every Phase-3 sensitive gate consults it via a single helper (`hasPermission(user, key)`) instead of hard-coded role checks.
- **Given** the owner's existing team-management page, **then** a **permission × role grid** lets the owner toggle each defined key between *staff-and-up* and *manager-and-up*; changes are server-enforced, owner-gated, take effect immediately (no redeploy), and are **audited** (who flipped what, when).
- **Given** any configuration, **then** invariants hold: `owner` always has every permission; nothing is grantable to customers; unknown/missing keys fail **closed** to manager-and-up.

**Edge cases:** permission flipped mid-shift (next action uses the new rule — per-request lookup, no long-lived cache), a demoted staff member with an open session (server checks role fresh, as Phase-1 RBAC already does).
**Deps:** Phase-2 FND-5, owner team management (live). **Serves:** FND3-4 voids, POS-2 comps, OPS-2 day-close. **Milestone 3B.**

---

## 3. Pillar A — Staff POS (POS)

### POS-1 — Staff order entry (STF-040)
**Story:** As counter staff, I punch in a dine-in or walk-in order in seconds on the counter tablet.

**Acceptance criteria**
- **Given** the staff app (flag `NEXT_PUBLIC_FLAG_STAFF_POS`), **when** I tap **New order**, **then** I get a tablet-first entry screen: category-tabbed menu grid with search, tap-to-add, variant/addon picker (same rules as web), a running cart with qty steppers, and an order-type toggle **Dine-in / Takeaway**.
- **Given** Dine-in, **then** I must pick a **free table** (picker fed by FND3-1); **given** Takeaway, **then** no table and the token flow applies.
- **Given** the cart, **then** the bill breakup (subtotal/GST/total — packaging only for takeaway) comes from the **existing quote endpoint** — the client never computes price.
- **Given** the cart is confirmed, **then** the flow ends in a **Collect payment** step — Cash / UPI / Card (POS-2), creating the order *paid*, the typical counter flow — with a one-tap **Collect later** escape that creates it *unpaid* for POS-2 to settle from the detail.
- **Given** submit, **then** the order is created via FND3-3, appears on the queue board instantly (existing realtime), and I land back ready for the next order — **≤ 30 s end-to-end for 3 items** is the UX bar.
- **Given** optional customer capture, **then** name/phone fields are present but skippable in one tap.

**Edge cases:** offline/socket loss (same poll fallback as the board), accidental double-submit (idempotent submit guard), 86'd item appears (grey it out live — reuse availability data).
**Deps:** FND3-1/2/3. **Headline of the phase.**

### POS-2 — Collect payment & complete (extends STF-041)
**Story:** As staff, I collect payment — normally right at order entry (D2 counter model), or later from the order detail — and the order closes cleanly.

**Acceptance criteria**
- **Given** payment collection (inline at POS-1 entry, or **Settle** on an open order's detail), **then** I see the final bill breakup and choose **Cash / UPI / Card** (the existing collected-payment path, same `payment_method` values); once served, a paid dine-in order completes in one tap (guard FND3-5).
- **Given** a captured phone, **then** the customer gets the existing receipt notification; **given** none, **then** no send is attempted.
- **Given** a manager, **then** a **comp/₹0-settle** override exists with reason, audited (FND-5 gating).
- **Given** the order completes, **then** its table frees on the tables board immediately (once no other open order holds it).

**Edge cases:** settle raced with a last-second void (version guard forces re-view of the new total), online payment for staff-entered orders (out of v1 — cash/UPI-scan/card only; revisit with QR learnings).
**Deps:** FND3-3/5, POS-1. 

### POS-3 — Tables board
**Story:** As staff, I see every table's state at a glance and jump to its order.

**Acceptance criteria**
- **Given** the staff app, **then** a **Tables** view shows all active tables grouped by zone: **free** vs **occupied** (each open order's age, item count, and total — one table can hold several orders under the counter model).
- **Given** an occupied table tap, **then** its open order(s) open (→ correct in 3B, settle via POS-2); **given** a free table tap, **then** POS-1 opens with that table pre-selected.
- **Given** any order change anywhere, **then** the board updates via the existing realtime channel (poll fallback included).

**Deps:** FND3-1/2, POS-1/2.

### POS-4 — Void a line from the staff app (UI for FND3-4)
**Story:** As staff, when we punched the wrong item, a manager voids that line from the order detail.

**Acceptance criteria**
- **Given** an open order's detail, **then** each line offers **Void** — a reason is picked/entered, then the manager re-auth gate (same pattern as refunds) confirms it.
- **Given** a completed void, **then** the corrected bill shows immediately, the line renders struck-through (not removed), and the audit entry is visible in the order's history.

**Deps:** FND3-4, POS-1/3. **Milestone 3B.**

---

## 4. Pillar B — Kitchen tickets, receipts & bill delivery (KOT/RCT)

### KOT-1 — Kitchen Order Ticket per order (STF-020, STF-024)
**Story:** As kitchen/barista, each order reaches me as a compact printed ticket.

**Acceptance criteria**
- **Given** any order, **then** a KOT is producible: order #, table/token, items+variants+addons+notes — **no prices**.
- **Given** the confirmed locally-connected (USB) thermal printer (D3), **then** v1 prints via a dedicated **80 mm print-CSS layout** through the system print dialog — no driver/model-specific code; direct ESC/POS integration is a pre-scoped fast-follow only if the dialog proves too slow in service.
- **Given** any order, **then** **Reprint KOT** exists on the detail (STF-024); voided lines print struck-through on reprints.

**Edge cases:** printer offline (KOT view remains on-screen — the board is the fallback), web-channel orders (same KOT available from the detail; auto-print on accept is a config toggle).
**Deps:** POS-1/4. **Milestone 3B.**

### KOT-2 — Receipt & token print (STF-042)
**Story:** As staff, I hand the customer a printed receipt (settle) or token slip (walk-in takeaway).

**Acceptance criteria**
- **Given** settle (POS-2), **then** a receipt prints: itemized bill with GST breakup, payment method, order #, and (when applicable) loyalty points earned — same print-CSS approach as KOT-1.
- **Given** a walk-in takeaway, **then** a token slip prints (big token #, items count).

**Deps:** POS-2. **Milestone 3A (browser-print is enough here).**

### RCT-1 — Bill on WhatsApp at settle
**Story:** As a customer who gave my number, the itemized bill lands on my WhatsApp when I pay — no paper needed.

**Acceptance criteria**
- **Given** an order reaches settle/`completed` with a captured phone, **then** a **`bill` notification event** (new `NotificationEvent`) fires through the existing engine: order #, item count, total, payment method, and a link to the order's receipt page.
- **Given** Meta requires approved templates for proactive sends, **then** the bill template copy is submitted for approval **during Sprint 1** (input I3) — the code path ships dark until approval lands. **Draft copy (pending I3 approval),** name `order_bill_1`, 6 vars matching the `templateVarsFor` convention:
  > "Hi {{1}}, thanks for visiting HIOC! Your bill for order #{{2}}: ₹{{3}} for {{4}} item(s), paid via {{5}}. View your itemized receipt: {{6}}"
- **Given** the staff order detail, **then** a **Resend bill** action exists (rate-limited); sends are logged in the existing notifications table.
- **Given** no phone on the order, **then** the engine skips cleanly (same FND3-5 rule).

**Edge cases:** template rejected by Meta (re-submit with adjusted copy; printed bill is never blocked), send failure (logged `failed`, resend available — never blocks settle).
**Deps:** POS-2, Phase-1 notification engine, **I3**. **Milestone 3A.**

### RCT-2 — Bill by email
**Story:** As a customer who wants the bill in my inbox (expense claims, records), I get an itemized email bill.

**Acceptance criteria**
- **Given** the first **email adapter** in `lib/notifications/adapters.ts` (provider per default D9, env-keyed, flag-safe), **then** the `bill` event can also deliver as an HTML email reusing the receipt rendering — itemized lines, GST breakup, payment method.
- **Given** POS entry, **then** an **optional email field** exists (one-tap skip, like phone); **given** a logged-in web/QR customer, **then** their account email is used automatically; captured emails are stored on the order (`customer_email`).
- **Given** the staff order detail, **then** the resend action offers email alongside WhatsApp where an address exists.
- **Given** no email anywhere on the order, **then** the channel skips cleanly.

**Edge cases:** invalid address (validate at capture; bounces just log `failed`), provider outage (bill still printed/WhatsApp'd — email is never the only copy).
**Deps:** RCT-1 (`bill` event), provider decision D9. **Milestone 3C.**

*(Stretch, not committed: STF-021/022/023 KDS, station routing, per-item ticking — see §10.)*

---

## 5. Pillar C — Table QR self-ordering (QR) — *Milestone 3C, flag-gated*

### QR-1 — Scan-to-order (CUS-025, subsumes CUS-024)
**Story:** As a seated customer, I scan the table's QR and order from my phone — no app, no typing a table number.

**Acceptance criteria**
- **Given** a scan of `/t/<qr_token>` (flag `NEXT_PUBLIC_FLAG_TABLE_QR`), **then** the normal menu opens in **dine-in context**: table badge visible, no pickup-slot picker, packaging ₹0.
- **Given** checkout, **then** the order is created with `channel = table_qr`, the table attached, and **pays online first** (decision D6 — the existing Phase-2 gateway flow; nothing enters the queue unpaid); it lands on the same staff queue flagged with its table.
- **Given** an invalid/regenerated token, **then** a friendly "ask staff" screen — never a broken cart.
- **Given** the table already has an open staff-side order, **then** v1 keeps QR orders as **separate orders** on the same table (merging tabs is out of scope — §10).

**Note:** This *subsumes* CUS-024 (order-type selector): dine-in is entered via QR context, not a free choice on the remote checkout — a remote user picking "dine-in" is a support headache, not a feature.
**Deps:** FND3-1 (`qr_token`), FND3-2, Phase-1 checkout.

### QR-2 — Printable QR assets
**Story:** As the owner, I print a QR card per table from the tables CRUD.
**AC:** per-table QR (encodes `/t/<qr_token>`) rendered on a print-ready A6 card layout, batch "print all"; regenerating a token (FND3-1) invalidates the old card. **Deps:** FND3-1, QR-1.

---

## 6. Pillar D — Ops, cash & analytics (OPS)

### OPS-1 — Channel & dine-in analytics (extends OWN-010/§8 order-mix)
**AC:** owner dashboard adds: orders + revenue by **channel** (web/staff/QR) and **order type**, average ticket per channel, dine-in peak hours, table turnover (settles per table per day), staff-entry leaderboard (orders keyed by `created_by`). Same pipeline/views pattern as Phase-1/2 analytics. **Deps:** FND3-2 data flowing (≥ 2 weeks of 3A).

### OPS-2 — Cash management: day-open & day-close by denomination (STF-045)
**Story:** As staff, I open the day by counting the float into the drawer and close it by counting what's in it — denomination by denomination — so the drawer always matches the system to the rupee.

**Acceptance criteria**
- **Given** day-open (permission-gated, FND3-6), **then** I enter the opening float as a **denomination grid** (₹500 / ₹200 / ₹100 / ₹50 / ₹20 / ₹10 / coins × count); the total is **computed, never typed**, and stored with my attribution. Only one cash day may be open at a time.
- **Given** the day is open, **then** expected cash = **opening float + Σ cash settles − Σ cash refunds** (online/UPI-gateway money never touches the drawer math).
- **Given** day-close, **then** I count the drawer into the same denomination grid; counted total is computed from the denoms, **over/short** = counted − expected is computed, and the closure is signed off per the permission matrix (default: manager) with notes required on any variance.
- **Given** a signed closure, **then** it is **immutable** — corrections are a next-day audited adjustment entry, never an edit.
- **Given** the day summary (orders, revenue by method, voids, comps, over/short), **then** it matches the owner payment analytics for the same window and is exportable (reuses Phase-2 RET-5 path); the owner sees closure history and an over/short trend.

**Edge cases:** forgot to open the day (block cash settles with a clear prompt to open first), close attempted with open unpaid orders (warn, list them, allow with sign-off), denomination miscount (recount before sign-off — totals recompute live).
**Deps:** POS-2, FND3-6. **Milestone 3C.**

---

## 7. Data-model changes for Phase 3

`supabase/phase3-migration.sql`; keep `lib/types.ts` in **exact** sync; preserve snapshotting.

| Change | Serves |
|---|---|
| New `tables (id, label unique-ci, zone, capacity, qr_token unique, is_active, sort_order, created_at, updated_at)` | FND3-1, POS-3, QR-1 |
| `orders` add `channel text default 'customer_web'` (+ backfill), `table_id FK nullable`, `table_label` snapshot, `created_by FK profiles nullable` | FND3-2/3 |
| `order_items` add `voided bool default false`, `void_reason`, `voided_by`, `voided_at` | FND3-4, KOT-1 |
| New `order_amendments (id, order_id, staff_id, kind ∈ void_item/change_table/comp — open enum, payload jsonb, created_at)` | FND3-4, audit |
| New `cash_days (id, business_date unique, status open/closed, opened_by, opened_at, opening_denoms jsonb, opening_total_inr, closed_by, closed_at, closing_denoms jsonb, counted_total_inr, expected_cash_inr, over_short_inr, notes)` — totals always derived from denoms server-side | OPS-2 |
| New `role_permissions (permission_key unique, min_role staff/manager, updated_by, updated_at)` seeded with D4 defaults; single `hasPermission()` helper; changes audited | FND3-6 |
| `orders.customer_email` — **already added** by the link-based e-bill migration; RCT-2 reuses it (no new column) | RCT-2 |
| `NotificationEvent` gains `'bill'` — added **in RCT-1** with its template + adapter wiring (so the exhaustive handlers stay in sync), not in FND3-M; email joins the adapter set with provider env keys | RCT-1/2 |
| Totals become **Σ non-voided items** — enforce in the (server-only) recompute path, not a DB trigger | FND3-4 |
| Analytics views: channel/order-type mix, avg ticket per channel, table turnover | OPS-1 |
| RLS: `tables` — public read of active rows **minus `qr_token`** (token resolved server-side only); writes owner-only. New tables staff/owner-scoped like Phase-1 order tables. Customer self-read policies (Phase-2 pattern) untouched — staff-created orders with no `user_id` are simply invisible to customers. | NFR-004 |

> **State-machine deltas** (code, `lib/orders/stateMachine.ts`): `null → accepted` staff-create entry; `ready → completed` guard `payment_status = paid` for `dine_in` (comp = manager override that sets paid-equivalent with audit). No new statuses — dine-in reuses the existing lifecycle, which keeps every Phase-1/2 surface working unmodified.

---

## 8. Decisions (2026-07-21) & remaining inputs

**Decided with the owner:**

| # | Question | Decision | Effect on scope |
|---|---|---|---|
| **D2** | Service model | **Counter one-shot** — order & pay at the counter; a second order is a new order | FND3-4/POS-4 scoped to **voids only** (no rounds/running tabs, ≈ −6 pts); multiple open orders per table allowed |
| **D3** | Printer hardware | **Thermal printer exists, locally connected (USB) to the counter device** | KOT-1 fully unblocked: v1 prints via the system print dialog (no model-specific work); the model matters only if the ESC/POS fast-follow is ever picked up |
| **D5** | Dine-in bill math | **Same GST as takeaway, packaging ₹0, no service charge** | FND3-3 bill rules as specced; no new tax config |
| **D6** | QR trust model | **Pay online first** | QR-1 reuses the Phase-2 gateway unchanged; nothing enters the queue unpaid |

**Defaults adopted (overridable — say so before the relevant sprint):**

| # | Topic | Default in effect |
|---|---|---|
| **D4** | Void/comp policy | Voids and comps are **manager-gated** with a required reason, always audited (FND3-4, POS-2) — shipped as the **default permission matrix**, owner-tunable thereafter via FND3-6 |
| **D7** | Dine-in notifications | The "ready" WhatsApp is **suppressed** for dine-in — food is walked over; the settle receipt still sends when a phone was captured (FND3-5) |
| **D8** | Loyalty/coupons at POS | Points **earn** works via captured phone; coupon entry & points **redemption** at the counter are deferred |
| **D9** | Email provider (RCT-2) | **Resend** (simple API, Vercel-friendly free tier) — swap to any provider before Sprint 4 if preferred |

**Still needed — the only open inputs:**

| # | Input | Blocks |
|---|---|---|
| **I1** | Table inventory — count, labels (or table-stand numbers), zones, capacities | FND3-M migration seed only. **Fallback:** ship unseeded — the owner adds tables via the FND3-1 CRUD on day one, so this never blocks the build |
| **I3** | Approve the WhatsApp **bill template copy** (drafted in RCT-1; Meta approval has lead time, so it's submitted in Sprint 1) | RCT-1 *sends* only — code ships dark regardless |

---

## 9. Suggested build order

Foundations → entry → payment → tables → paper → corrections → QR → analytics; each milestone gate-checked before the next starts.

1. **Foundations:** FND3-1 tables → FND3-2 channel/attribution → FND3-3 staff create + FND3-5 state machine
2. **Milestone 3A:** POS-1 entry → POS-2 settle → POS-3 tables board → KOT-2 receipt/token → RCT-1 WhatsApp bill → *gate: a full day of real counter use, incl. a bill received on a test phone*
3. **Milestone 3B:** FND3-6 permission matrix → FND3-4 corrections engine → POS-4 void UI → KOT-1 KOT print → *gate: a KOT-driven service day on the real printer + a manager-gated void in the audit trail + the owner flips a permission and it takes effect immediately*
4. **Milestone 3C:** OPS-2 cash day-open/close → QR-1 scan-to-order → QR-2 assets → RCT-2 email bill → OPS-1 channel analytics → *gate: the drawer ties out by denomination three days running*
5. **Gates throughout:** correction-math + state-machine tests, RLS review (tables/qr_token), settle/void concurrency tests, print smoke on the actual device.

---

## 10. Explicitly out of scope (parking lot)

- **KDS / station routing / per-item ticking** (STF-021/022/023) — revisit after 3B proves ticket volume.
- **Rounds / running tabs / at-table service** — decision D2 says counter one-shot; `order_amendments.kind` leaves the door open if the service model ever changes.
- **Split bills, merge tables, transfer items between tables** — real POS territory; not v1.
- **Delivery** (`delivery` order type stays dormant), reservations/waitlist, inventory decrement (STF-035), shift handover (STF-046), clock-in (STF-052).
- **Online payment at the table for staff-entered orders** — cash/UPI-scan/card only in v1; reassess with QR learnings.
