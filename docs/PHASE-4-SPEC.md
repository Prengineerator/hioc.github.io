# HIOC Revamp — Phase 4 "Counter That Closes the Loop" — Detailed Spec

**Companion to:** `docs/REVAMP-REQUIREMENTS.md`, `docs/PHASE-3-SPEC.md` (§10 parking lot), `docs/PHASE-4-RICE.md` *(to be written after grooming)*, `docs/PHASE-4-SPRINT-PLAN.md` *(to be written after grooming)*
**Version:** 0.1 (Draft for grooming)
**Date:** 2026-08-02
**Owner:** Product (Senior PM)
**Scope:** Make the Phase-3 counter **actually usable in a live shift** and make the bill **actually reach the customer**. Phase 3 built the surfaces; a real-use review found the loop still open in three places — the bill never fires on the path staff actually use, the POS can't hold a running tab, and nothing at the counter carries the customer's value (loyalty, discounts) or the cash reality (tendered/change, split). Assumes Phase 1–3 are live on `phase-3-dinein-counter-ops`.

---

## 0. Phase-4 goal & definition of done

**Goal:** Phase 3's definition of done said *"the settled bill is deliverable three ways … sent automatically where contact info was captured."* In practice it isn't: on the one path a busy counter actually takes (punch → Collect now → next customer), **no bill is ever sent**, and nothing in the product reveals that. Phase 4 closes that loop and removes the four friction points that make staff reach back for the paper pad.

**Why now:** This is user-review feedback from real counter use, not speculation. Every finding below was reproduced in code. None of it requires new invention — the notification engine, the quote endpoint with coupon/loyalty support, the amend engine's version-guarded recompute, and the print pages all already exist. Phase 4 is almost entirely **wiring what we built to the path staff actually take**.

**Current-state facts (verified in code, 2026-08-02):**

| # | Fact | Evidence |
|---|---|---|
| F1 | The bill fires **only** on `status → 'completed'`. `PATCH /payment` records the method and payment status and **never touches status or sends a bill**. The POS "Collect now" flow calls exactly that route → a paid counter order gets **no bill** until someone separately marks it Completed in the queue. | `app/api/orders/[id]/status/route.ts:186-207`; `app/api/orders/[id]/payment/route.ts`; `components/staff/PosOrderEntry.tsx:355-368` |
| F2 | The WhatsApp bill channel is gated on **four** conditions (`customer_phone` + `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID` + `WHATSAPP_TPL_BILL`). Missing any one is a **silent skip** — no send, no `notifications` row, no error anywhere. | `lib/notifications/engine.ts:186-191` |
| F3 | `getAdapter()` checks only token + phone-id, so `accepted`/`ready` messages can be live **while the bill is dead** because `WHATSAPP_TPL_BILL` is unset. A half-configured deploy silently degrades to `logAdapter`. | `lib/notifications/adapters.ts:216-227` |
| F4 | `POST /api/orders/[id]/resend-bill` is implemented, rate-limited and correct — **and has zero callers in the UI**. | `app/api/orders/[id]/resend-bill/route.ts`; repo-wide grep |
| F5 | **No surface anywhere shows notification delivery state.** The `notifications` table has a staff-read RLS policy and the Meta webhook already reconciles sent/delivered/failed into it — nothing renders it. | `supabase/phase1-migration.sql:225`; `app/api/whatsapp/webhook/route.ts` |
| F6 | Customer capture in the POS is collapsed behind a "+ Add customer details" link **below the cart**, so the phone — the thing the whole WhatsApp bill depends on — is the easiest field to skip. | `components/staff/PosOrderEntry.tsx:599-655` |
| F7 | The amend engine is **void-only** (`{item_id, reason}`). There is no add-line path, so "two more coffees for table 4" creates a **second order and a second bill**. | `app/api/orders/[id]/amend/route.ts` |
| F8 | The POS quotes with `subtotal_inr` + `order_type` + `item_ids` only — **no `coupon_code`, no `redeem_points`** — although `POST /api/orders/quote` fully supports both. | `components/staff/PosOrderEntry.tsx:181-195`; `app/api/orders/quote/route.ts:23` |
| F9 | Staff orders set `user_id: null` by design (attribution is `created_by`). Correct for attribution — but it means a **regular who gives their phone at the counter earns no loyalty and can redeem nothing**. | `app/api/orders/route.ts:261` |
| F10 | Settlement is one method, exact amount. **No cash tendered/change, no split payment.** | `components/staff/PosPaymentModal.tsx:14-18, 80-92` |
| F11 | Placing an order does **not** print the KOT. Staff must reopen the order in the queue and click Print KOT, or the kitchen never sees it. | `components/staff/PosOrderEntry.placeOrder`; `components/staff/OrderDetailModal.tsx:132` |
| F12 | `POST /api/orders` has **no idempotency key**. A network timeout retried by a staffer can create a duplicate — and if the first one settled, a duplicate *paid* order. | repo-wide grep: no `Idempotency-Key` |
| F13 | The dine-in table picker is a flat `flex-wrap` of buttons with **no zone grouping**, while `TablesBoard` already groups by zone. Degrades past ~15 tables. | `components/staff/PosOrderEntry.tsx:494-510` vs `components/staff/TablesBoard.tsx` |

**Release-level Definition of Done**
- [ ] A counter order settled from the POS **"Collect now"** step delivers its bill on WhatsApp (and email where captured) **without any further staff action**.
- [ ] When a bill cannot be sent, the reason is **visible** — to the staffer at the moment of settle, and to the owner in a delivery log — never a silent skip.
- [ ] **Resend bill** is reachable in one tap from the order detail and from the post-placement confirmation, and reports which channels actually sent.
- [ ] The **phone is a first-class field in the settle step**, skippable in one tap, and the POS tells staff plainly what skipping costs ("no WhatsApp bill").
- [ ] A dine-in table holds **one running order**: staff add lines to the open order instead of creating a second one, with the same version-guarded server recompute and audit trail as a void.
- [ ] Cash settles with **tendered → change** shown, and a bill can be **split across two methods**.
- [ ] The **KOT prints automatically** on placement (owner-toggleable), and the bill on settle.
- [ ] A walk-in who gives their phone can **redeem a coupon and earn/burn loyalty points** at the counter.
- [ ] Order creation is **idempotent** — a retried submit can never double-charge.
- [ ] Pricing stays **server-authoritative** throughout (the client still never computes money); every new mutation is version-guarded and audited; `lib/types.ts` stays in exact sync with the migration.
- [ ] Automated tests for the settle→bill trigger, add-line recompute math, split-payment totals, and idempotent create.

**Conventions:** Same as Phase-1/2/3 — AC in Given/When/Then; integer ₹; UTC-stored, IST-displayed; server/RLS-enforced authorization; new surfaces dark-launched behind `lib/flags.ts`; sensitive actions gated through `hasPermission()` (never hard-coded roles).

---

## 1. Milestone architecture

Three independently launchable milestones, each leaving the cafe better off even if the next never ships:

| Milestone | Theme | Ships | Cafe outcome |
|---|---|---|---|
| **4A — The bill arrives** | Delivery reliability | BILL-1…5 | Every settled order's bill reaches the customer, and when it doesn't, someone knows and can fix it in one tap |
| **4B — The counter keeps up** | POS speed & correctness | TAB-1/2 · POS4-1…4 | One table = one running order; cash settles with change; the kitchen gets its ticket without a second click; a retry can't double-charge |
| **4C — The counter carries value** | Loyalty & discounts at the till | VAL-1/2 · POS4-5 | Regulars earn and redeem at the counter, not only on the web; the owner sees delivery + counter health |

> Sequencing rationale: 4A is the reported bug and the cheapest work in the phase — it is mostly wiring an existing engine to an existing route. 4B is the friction staff feel every shift and contains the only real new engine work (add-line). 4C is value capture that is meaningless until 4A/4B make the counter the primary entry point.

---

## 2. Pillar A — Bill delivery (BILL) — *Milestone 4A*

### BILL-1 — Fire the bill at settle, not only at completion
**Story:** As a customer paying at the counter, I get my bill on WhatsApp the moment I pay — not whenever a staffer happens to mark the order complete.

**Acceptance criteria**
- **Given** an order with a captured phone, **when** `PATCH /api/orders/[id]/payment` sets `payment_status = 'paid'`, **then** `sendBillNotification` is invoked with the reloaded order **and its line items** (so the `{{4}}` item count is accurate), best-effort and non-blocking.
- **Given** that same order later transitions to `completed`, **then** the existing settle-time send **no-ops** via the engine's per-`(order, event, channel)` idempotency — exactly one bill per channel.
- **Given** an order settled with `payment_status` other than `paid` (e.g. `payment_pending`), **then** no bill is sent.
- **Given** the send fails or times out, **then** the payment record still succeeds — a delivery failure must never fail settlement (the printed bill remains the guaranteed copy).

**Edge cases:** manager-comp (already sets `payment_status` without a method — decide via **D4-1**); online orders reconciled by the gateway (unchanged path); a resend after a failure must still work.
**Deps:** none. **Serves:** the entire phase's headline outcome.

### BILL-2 — Phone-first capture in the settle step
**Story:** As a staffer, the phone field is in front of me when I take the money, not buried under the cart.

**Acceptance criteria**
- **Given** the Collect-payment step, **then** a **"Bill on WhatsApp"** phone field is the first thing in the modal, focused, with a numeric keypad on tablet.
- **Given** the staffer taps a payment method with the phone blank, **then** a single inline confirm appears — "No number — customer gets no WhatsApp bill. Continue?" — dismissible in one tap, never a blocking dialog.
- **Given** an invalid number, **then** the existing `normalizeIndianMobile` validation blocks the settle with the existing message; a valid number is normalized to E.164 exactly as the web checkout does.
- **Given** a repeat customer's number, **then** their name (if previously captured on any order with that phone) is offered as a one-tap fill.

**Edge cases:** the customer-details block above the cart stays for name/email but stops being the only phone entry point — the two inputs must stay in sync.
**Deps:** BILL-1. **Serves:** every WhatsApp bill.

### BILL-3 — Never fail silently
**Story:** As the owner, a bill that didn't send is visible, not invisible.

**Acceptance criteria**
- **Given** `NOTIFY_PROVIDER=whatsapp` with any of `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` / `WHATSAPP_TPL_BILL` missing, **when** the server starts, **then** a single clear warning is logged naming the missing variables.
- **Given** the same misconfiguration, **then** owner settings shows a **channel health row** — "WhatsApp bill: not configured (WHATSAPP_TPL_BILL missing)" — instead of the current silent skip.
- **Given** a bill send is *attempted and skipped* (no phone, no email, channel dormant), **then** the reason is recorded, so "why didn't this customer get a bill?" is answerable per order. *(Today a skip writes nothing at all.)*
- **Given** a send fails at Meta, **then** the `notifications` row carries the provider error text (already implemented) and it is **rendered**, not just stored.

**Edge cases:** don't log-spam on every request — warn once per process.
**Deps:** none. **Serves:** BILL-4/5 and all future channel work.

### BILL-4 — Resend bill, wired up
**Story:** As a staffer, when a customer says "I didn't get it", I fix it in one tap.

**Acceptance criteria**
- **Given** any order with a phone or email, **then** the order detail shows **Resend bill**, calling the existing `POST /api/orders/[id]/resend-bill`.
- **Given** the response, **then** the UI reports **which channels actually sent** (the route already returns `sent.whatsapp` / `sent.email`) — including the honest "nothing sent" case, which today would render as a false success.
- **Given** the 3-per-10-minutes rate limit trips, **then** the 429's message is shown as-is.
- **Given** the post-placement confirmation (POS4-4), **then** Resend is reachable there too.

**Deps:** BILL-3 (for the "nothing sent" reporting). **Serves:** every "didn't get my bill" moment.

### BILL-5 — Owner delivery log
**Story:** As the owner, I can see what we sent, to whom, and what failed.

**Acceptance criteria**
- **Given** the owner dashboard, **then** a **Notifications** view lists recent sends: order #, channel, event, status, timestamp, error, with filters for `failed` and for the `bill` event.
- **Given** a failed row, **then** it offers Resend inline (same route, same rate limit).
- **Given** the Meta delivery webhook has reconciled a message to `delivered`/`read`/`failed`, **then** the view reflects that state — the reconciliation already runs; only the surface is missing.
- **Given** RLS, **then** the read uses the existing `notifications_staff_read` policy — no new policy, no service-role read from the client.

**Deps:** BILL-3. **Serves:** owner confidence; makes the next channel (SMS fallback) diagnosable.

---

## 3. Pillar B — Running tab & counter correctness (TAB / POS4) — *Milestone 4B*

### TAB-1 — Add lines to an open order (extends FND3-4)
**Story:** As a staffer, "two more coffees for table 4" goes onto table 4's existing bill.

**Acceptance criteria**
- **Given** an open order (`accepted` / `preparing` / `ready`, unpaid), **when** staff add lines via `POST /api/orders/[id]/amend` with an **add** operation, **then** the lines are inserted and the bill is **recomputed server-side** from all non-voided lines under the existing optimistic `version` guard.
- **Given** the recompute, **then** GST and packaging are re-derived by the same `computeBill` path the create route uses — the client never sends money.
- **Given** a lost version race, **then** the add rolls back exactly as the void path does, and the client re-fetches.
- **Given** any add, **then** an `order_amendments` row records actor, lines and timestamp — same audit contract as a void.
- **Given** a paid or terminal order, **then** the add is refused with a clear message (settle a new order instead).

**Edge cases:** a coupon already applied to the order must be **re-qualified** against the new subtotal (this was already flagged as deferred polish in Phase 3); KOT reprint should cover **only the newly added lines** (see POS4-3).
**Deps:** FND3-4 engine. **Serves:** TAB-2, the whole dine-in experience.

### TAB-2 — Open a table's running order from the POS
**Story:** As a staffer, tapping an occupied table adds to its order instead of starting a new one.

**Acceptance criteria**
- **Given** the tables board, **when** staff tap an **occupied** table, **then** they land on that table's running order with an **Add items** action that reuses the POS entry surface (quick-add bar, tiles, customize modal) and commits through TAB-1.
- **Given** the POS new-order screen with a table selected that already has an open order, **then** the POS warns and offers "Add to the open order" rather than silently creating a second one.
- **Given** an order with added lines, **then** the running bill, the receipt print and the WhatsApp bill all reflect the merged total.

**Deps:** TAB-1, POS-3. **Serves:** the "one table, one bill" DoD.

### POS4-1 — Cash tendered & change; split payment
**Story:** As a staffer, the POS does the change arithmetic and lets a customer pay half cash, half UPI.

**Acceptance criteria**
- **Given** Cash is selected, **then** a tendered field with quick-denomination chips (₹100/₹200/₹500/₹2000, exact) shows **change due** live, computed from the server-quoted total.
- **Given** a split, **when** staff record a first method and amount, **then** the remaining balance is shown and a second method settles it; the order is `paid` only when the parts sum to the total.
- **Given** any split, **then** the parts are **persisted** (not merged into one method) so the cash-day expected-cash math (OPS-2) counts only the cash part.
- **Given** an over-tender, **then** change is never negative and the recorded payment is the bill total, not the tendered amount.

**Edge cases:** refunds against a split order (**D4-2**); the existing "don't clobber a gateway-verified online payment" guard must survive.
**Deps:** schema change (§4). **Serves:** cash accuracy, OPS-2 integrity.

### POS4-2 — Idempotent order creation
**Story:** As a staffer on flaky cafe wifi, a retry never creates a second order.

**Acceptance criteria**
- **Given** the POS submits an order, **then** it sends a client-generated `Idempotency-Key`; **when** the same key is replayed, **then** the API returns the **original** order (201-equivalent) instead of creating a new one.
- **Given** a create that timed out client-side but succeeded server-side, **when** the staffer retries, **then** they see the original order — no duplicate, no double settle.
- **Given** keys, **then** they expire (24 h) and are scoped so two different orders can never collide.

**Deps:** schema change (§4). **Serves:** money integrity.

### POS4-3 — Auto-print KOT on placement, bill on settle
**Story:** As a cook, the ticket is on the rail without anyone clicking twice.

**Acceptance criteria**
- **Given** an order is placed from the POS **and** the owner setting "auto-print KOT" is on, **then** the KOT print fires automatically (the existing `/staff-print/[id]/kot` page).
- **Given** lines are added to a running order (TAB-1), **then** the auto-print covers **only the added lines**, marked as an addition to order #N.
- **Given** an order is settled **and** "auto-print bill" is on, **then** the receipt print fires.
- **Given** either setting is off, **then** behaviour is exactly as today (manual print from the order detail).

**Edge cases:** browsers block programmatic popups — the print must be initiated from within the user's settle/place gesture, not from an async callback after it.
**Deps:** KOT-1/2. **Serves:** kitchen flow.

### POS4-4 — Post-placement confirmation
**Story:** As a staffer, after taking money I see what happened and what I can do about it.

**Acceptance criteria**
- **Given** an order is placed (and optionally settled), **then** a compact confirmation replaces the current fire-and-forget toast: order #, total, method, **bill delivery status**, and actions **Print bill · Resend bill · Open order · New order**.
- **Given** the bill could not be sent, **then** the reason is stated there ("no phone captured" / "WhatsApp not configured") — the moment staff can still fix it.
- **Given** the staffer does nothing, **then** it auto-dismisses and the POS is ready for the next order with the command bar refocused (the current keyboard-first behaviour must not regress).

**Deps:** BILL-1/3/4. **Serves:** closes the counter loop visibly.

### POS4-5 — Table picker by zone
**Story:** As a staffer in a 30-table cafe, I find the table instantly.

**Acceptance criteria**
- **Given** tables with zones, **then** the POS picker groups by zone with the same grouping `TablesBoard` already uses, and shows occupied tables as occupied (tapping one routes to TAB-2's add-to-order).
- **Given** more than ~12 tables, **then** a type-to-filter matches the table label from the keyboard, consistent with the quick-add bar's keyboard-first model.

**Deps:** POS-3, TAB-2. **Serves:** counter speed.

---

## 4. Pillar C — Value at the counter (VAL) — *Milestone 4C*

### VAL-1 — Coupons & loyalty redemption at the POS
**Story:** As a staffer, I can apply the same coupon or points a customer would get on the web.

**Acceptance criteria**
- **Given** the POS bill panel, **then** a coupon field passes `coupon_code` to `POST /api/orders/quote` (already supported) and the discount line renders from the **server's** quote — never computed locally.
- **Given** a customer identified by phone (VAL-2), **then** their points balance is shown and `redeem_points` can be quoted and applied, honouring the same caps the web checkout enforces.
- **Given** an invalid/expired/ineligible coupon, **then** the server's reason is shown verbatim and the bill is unchanged.
- **Given** lines are later added (TAB-1), **then** the coupon is re-qualified server-side and the discount adjusts or is dropped with a visible note.

**Deps:** VAL-2 for points. **Serves:** promotions actually usable at the till.

### VAL-2 — Link a counter order to a customer account
**Story:** As a regular, buying at the counter earns me the same points as ordering on the web.

**Acceptance criteria**
- **Given** a staff order with a phone that matches an existing customer account, **then** the order is linked to that account for **loyalty earn/redeem** — while `created_by` continues to carry **staff attribution** (F9's distinction must not be lost: `user_id` semantics is the decision in **D4-3**).
- **Given** a phone with no account, **then** the order proceeds unlinked and no account is silently created.
- **Given** a linked order that completes, **then** points earn through the existing `earnForOrder` ledger hook, and a reject/cancel reverses them.
- **Given** linkage, **then** no customer PII beyond what staff typed is exposed in the POS (name only, never order history).

**Edge cases:** phone typos linking to the wrong account — require the matched name to be shown before it takes effect.
**Deps:** decision D4-3. **Serves:** retention at the counter; VAL-1's points path.

---

## 5. Data-model changes for Phase 4

| Change | Table | Why | Ticket |
|---|---|---|---|
| `order_payments` (order_id, method, amount_inr, tendered_inr, created_by, created_at) | new | Split payments must persist as parts, not one collapsed method, or OPS-2's expected-cash math breaks | POS4-1 |
| `idempotency_keys` (key, scope, order_id, created_at) with TTL cleanup | new | Replay-safe order creation | POS4-2 |
| `notifications.skip_reason` (text, default `''`) | alter | Distinguish "skipped, and why" from "never attempted" — today a skip writes nothing | BILL-3 |
| `order_amendments.kind` (`'void' \| 'add'`) | alter | The audit trail must record adds, not only voids | TAB-1 |
| `store_settings.auto_print_kot`, `.auto_print_bill` | alter | Owner-toggleable auto-print | POS4-3 |

All new tables RLS-covered on the same pattern as Phase 3 (staff read where needed; writes via service-role routes). `lib/types.ts` updated in the same commit as the migration — the FND3-M convention.

---

## 6. Open decisions (owner input needed before build)

| # | Question | Options | Recommendation |
|---|---|---|---|
| **D4-1** | Should a **manager-comped** order (₹0 owed) send a bill? | (a) yes, itemized with ₹0 due (b) no | **(a)** — the customer still wants the record, and it makes comps visible |
| **D4-2** | Refunds against a **split** payment | (a) refund proportionally across parts (b) staff chooses the part | **(b)** — cash back from the drawer vs a UPI reversal are operationally different |
| **D4-3** | Should a phone-matched counter order set `user_id`? | (a) set `user_id`, keep `created_by` for staff attribution (b) leave `user_id` null, add `customer_user_id` | **(b)** — preserves the Phase-3 invariant that `user_id` is *the session that placed it*; analytics built on that assumption stay correct |
| **D4-4** | Auto-print default | (a) on for KOT, off for bill (b) both off until opted in | **(a)** — kitchen needs it; bill paper is a cost choice |
| **D4-5** | Is the WhatsApp bill template `order_bill_1` approved? | see §7 checklist | **blocking for 4A go-live** (not for its code) |

---

## 7. Blocking input — WhatsApp bill template checklist (I3 carry-over)

> **Status (2026-08-05): confirmed NOT created.** Full submission guide — exact copy, header asset, sample values, rejection traps and post-approval env — is in **`docs/WHATSAPP-BILL-TEMPLATE.md`**. The checklist below remains the acceptance criteria for that work.

The Phase-3 sprint plan listed Meta template approval as input **I3**, submitted in Sprint 1. It was never submitted, and **4A cannot go live without it** (the code path is otherwise complete). Verify in Meta Business Manager → WhatsApp Manager → **Message templates**:

1. **A template exists** whose name matches whatever `WHATSAPP_TPL_BILL` is set to (default assumed by the code: `order_bill_1`). Name mismatch = silent failure.
2. **Status is `APPROVED`**, not `PENDING`, `REJECTED`, `PAUSED` or `DISABLED`. A paused template fails at send time with a Meta error that today nobody sees (→ BILL-3/5).
3. **Category is `Utility`** — a Marketing-category template is throttled and subject to marketing opt-out, which is wrong for a transactional bill.
4. **Language code matches `WHATSAPP_TPL_LANG`** (code default `en`; if the template was approved as `en_US`, the send fails).
5. **The body has exactly 6 variables in this order** — this is what `templateVarsFor(order, 'bill')` sends (`lib/notifications/templates.ts:122-136`):
   `{{1}}` first name · `{{2}}` order number (bare — the template literal supplies the `#`) · `{{3}}` total in ₹ · `{{4}}` item count · `{{5}}` payment method · `{{6}}` receipt link
6. **Header:** only set `WHATSAPP_TPL_BILL_HEADER_IMAGE` if the approved template was designed **with an IMAGE header**. Sending a header component the template doesn't declare is rejected by Meta.
7. **The `{{6}}` link resolves publicly** — `NEXT_PUBLIC_SITE_URL` must be set in the deployed environment, or the receipt URL is a broken relative path.

Then confirm the deployed environment (Vercel → the project's Environment Variables, and `.env.local` for dev — where all four are currently commented out) has: `NOTIFY_PROVIDER=whatsapp`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TPL_BILL`.

> If any of steps 1–4 fail, drafting and resubmitting the template is a 1–2 day approval wait — start it **before** the sprint, since it gates the 4A launch gate but none of its code.

---

## 8. RICE snapshot (indicative — formal scoring in `PHASE-4-RICE.md`)

Same scales as `docs/RICE-PRIORITIZATION.md §1`. Reach for counter surfaces ≈ 4–5 (every shift, every counter order), now measurable against real Phase-3 channel-mix data rather than estimated.

| Ticket | R | I | C | E | **RICE** | Note |
|---|--:|--:|--:|--:|--:|---|
| BILL-1 | 5 | 3 | 1.0 | 0.25 | **60.0** | The reported bug; ~a day's work on an existing engine |
| BILL-4 | 4 | 1.5 | 1.0 | 0.25 | **24.0** | Route exists; pure wiring |
| BILL-2 | 5 | 2 | 1.0 | 0.5 | **20.0** | Without it, BILL-1 has nothing to send to |
| POS4-4 | 5 | 1 | 1.0 | 0.5 | **10.0** | Makes the loop visible to staff |
| BILL-3 | 4 | 1.5 | 1.0 | 0.75 | **8.0** | Prevents the *next* silent failure |
| POS4-1 | 5 | 1.5 | 0.8 | 1.0 | **6.0** | Daily cash friction |
| TAB-1 | 4 | 2 | 0.8 | 1.5 | **4.3** | Only real new engine work |
| POS4-3 | 4 | 1 | 0.8 | 0.75 | **4.3** | |
| POS4-2 | 5 | 1 | 0.8 | 1.0 | **4.0** | Low frequency, high blast radius |
| TAB-2 | 4 | 1.5 | 0.8 | 1.0 | **4.8** | Rides TAB-1 |
| POS4-5 | 3 | 0.5 | 1.0 | 0.5 | **3.0** | Scales with table count |
| VAL-1 | 3 | 1.5 | 0.8 | 1.0 | **3.6** | Quote endpoint already supports it |
| BILL-5 | 2 | 1.5 | 1.0 | 0.75 | **4.0** | Owner-facing |
| VAL-2 | 3 | 1.5 | 0.5 | 1.25 | **1.8** | Lowest confidence — depends on D4-3 |

**What the numbers say:** 4A is the cheapest and highest-scoring work in the phase by a wide margin — BILL-1 alone is a day of work against the phase's headline outcome, because the engine, the template renderer, the idempotency and the webhook reconciliation all already exist. Nothing in 4B/4C beats it, so 4A ships first and alone if needed.

---

## 9. Suggested build order

1. **BILL-1 → BILL-2 → POS4-4** — the reported bug, end to end: fire at settle, capture the phone where the money is taken, show the outcome. Shippable on its own.
2. **BILL-3 → BILL-4 → BILL-5** — make failure legible: skip reasons, resend, owner log. *(Meta template verification, §7, runs in parallel from day 1 — it gates the 4A launch gate, not the code.)*
3. **TAB-1 → TAB-2 → POS4-5** — the running tab and the table surfaces that feed it.
4. **POS4-1 → POS4-2 → POS4-3** — cash reality, replay safety, auto-print. Migration-bearing; batch the schema change with TAB-1's.
5. **VAL-1 → VAL-2** — gated on D4-3; drop to Phase 5 if the decision isn't ready.

---

## 10. Explicitly out of scope (parking lot)

- **KDS / kitchen stations** and per-item ticking — still parked from Phase 3 §10; revisit once auto-print (POS4-3) shows whether paper is the bottleneck.
- **Split *bills*** (one table, several payers) — distinct from POS4-1's split *payment*; real-POS territory, and no demand signal yet.
- **Merge/move tables.**
- **Offline-first POS** (service worker + queued writes) — POS4-2's idempotency is the prerequisite; only worth building if the cafe's wifi actually proves unreliable in 4B use.
- **SMS fallback** when WhatsApp fails — cheap once BILL-5 shows how often it fails; deliberately deferred until there's data.
- **Bill as a PDF attachment** — the link-based bill was decided in Phase 3 (RCT-1/2) and nothing has changed.
