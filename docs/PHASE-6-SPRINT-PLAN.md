# HIOC Revamp — Phase 6 Sprint & Epic Plan

**Companion to:** `docs/PHASE-6-SPEC.md` (the *what* and *why* — this document is the *when* and *who*), `docs/PHASE-6-RICE.md`
**Version:** 0.1
**Date:** 2026-08-07
**Owner:** Product (Senior PM)
**Audience:** This plan is written to be handed, ticket by ticket, to junior engineers (or engineer subagents) who have **not** read the whole history. Each ticket names its spec section, its files, its traps, and its definition of done. If a ticket seems to require knowledge this document doesn't point to, stop and ask — do not improvise around the money paths, the auth spine, or the permission system.

---

## 1. Planning assumptions

- Same velocity model as Phase 5: ~22–25 pts per sprint, three sprints + a hardening week.
- Branch: `phase-6-pos-usability`, branched off `phase-5-attendance-payroll` (Phases 3–5 are not on `main`; branching off `main` would drop their code — the same trap Phase 5 dodged).
- Every ticket lands with: tests green (`npm test`), types clean (`npx tsc --noEmit`), build clean (`npm run build`), and — where a migration is involved — `verify:db` probes in the same PR.
- Migrations are applied to the live Supabase **by the owner, on request, before the dependent deploy** — a PR description must say in bold when it carries one. Current outstanding-migration discipline per `[[db-verification-harness]]`.
- Commits follow the repo convention: one bulk commit per coherent ticket-set, message explains the *why* (see `git log` for the house style).
- External clocks tick from day 1: WA-2's possible template resubmission (Meta approval queue) and PRT-2's real-printer verification are both **week-1 items in their sprints** by design.

## 2. Epics

| Epic | Pillar (spec §) | Pts | Summary |
|---|---|--:|---|
| **WA** | §2 | 12 | The WhatsApp bill arrives and the owner can prove it |
| **FLOW** | §3 | 14 | One calm screen: docked payment, tap budgets, readable layout, post-order strip |
| **PRT** | §4 | 8 | Printing with zero visible UI; failures loud |
| **DEV** | §5 | 8 | Installable PWA; enrolled, named, revocable devices; per-device defaults |
| **PIN** | §6 | 14 | Operator switch by name + PIN; attribution end-to-end |
| **EVT** | §7 | 14 | Owner-initialised event mode, hidden until activated |
| | | **70** | |

## 3. Ticket backlog (by epic)

Format: **ID (pts) — title** → spec §; *files you will touch*; **traps**.

### Epic WA — the bill, provably (12 pts)

- **WA-1 (2) — Config doctor: no more lying `sent`** → §2/WA-1. *`lib/notifications/adapters.ts` (brand stub refs `stub_`), `lib/notifications/engine.ts` (skip-with-reason when provider misconfigured), `lib/notifications/health.ts` (no logic change expected — reuse), new `scripts/verify-notifications.ts` + npm script, owner banner in `app/owner/page.tsx` + `app/owner/notifications/`.* **Traps:** do not break the email channel or order-status templates — the engine path is shared on purpose; the stub must remain the default in dev (tests depend on no network); retroactive stub-branding in the log UI matches the legacy `log_` ref prefix, don't rewrite old rows.
- **WA-2 (2) — Meta-side audit: token, template, category** → §2/WA-2. *`scripts/verify-notifications.ts` (Graph API introspection: template status/category, token debug), `docs/WHATSAPP-BILL-TEMPLATE.md` (System-User-token walkthrough + UTILITY category requirement).* **Traps:** the decisive finding may be "resubmit template as UTILITY" — if so, file it with Meta **the same day** and continue; nothing else in the phase waits on approval. Never print the token itself in script output.
- **WA-3 (2) — Owner test-send** → §2/WA-3. *New route `app/api/owner/notifications/test-send/`, button + inline result in the `/owner/notifications` page component.* **Traps:** owner-gated (`getOwnerUser`), rate-limited via the existing `rate_limits` helper (5/hour); the test flows through `sendBillNotification` with sample data — do not build a parallel send path; mark rows as test.
- **WA-4 (4) — Delivery-status webhook** → §2/WA-4 + §8 migration `2026-08-notify-delivery.sql`. *New `app/api/webhooks/whatsapp/route.ts` (GET verify + POST statuses), migration + `lib/types.ts`, status rendering in the owner log, `verify:db` probes.* **Traps:** always answer 200 fast (Meta retries on non-2xx and will hammer you); HMAC-verify with `WHATSAPP_APP_SECRET` and **fail closed when unset** (copy the CRON_SECRET pattern from `app/api/cron/expire-orders/route.ts`); statuses are monotonic — `read` never downgrades; unknown refs log-and-drop, no 500.
- **WA-5 (2) — Bill truth + retry at the counter** → §2/WA-5. *`lib/staff/confirmation.ts` (`BillStatusView` gains webhook truth), `components/staff/PosOrderEntry.tsx` confirmation rendering, `components/staff/OrderDetailModal.tsx` resend verdicts.* **Traps:** resend goes through the existing `POST /api/orders/[id]/resend-bill` — respect its rate limit and `force` semantics; do not add a second resend implementation.

### Epic FLOW — one calm screen (14 pts)

- **FLOW-1 (4) — Docked payment; kill the takeover** → §3/FLOW-1. *`components/staff/PosOrderEntry.tsx`, `components/staff/PosPaymentModal.tsx` (content extracted into a docked panel), flag `NEXT_PUBLIC_FLAG_POS_V2` in `lib/flags.ts`.* **Traps:** **diagnose the reported bug first and write the root cause in the PR** (owner: POS opens onto the payment screen mid-order in Chrome — candidates in spec F6); the client never computes money (F13) — the panel renders quoted values only; split-tender behaviour (parts sum exactly to server total) must survive the move with its tests; the old modal flow stays behind the flag until Gate 6B (spec E10).
- **FLOW-2 (3) — Tap budget mechanisms** → §3/FLOW-2. *New pure helpers in `lib/pos/` (quick-tender denominations, favourites ranking), `PosOrderEntry.tsx`/payment panel wiring, device-default consumption (after DEV-3).* **Traps:** quick-tender buttons compute from the **quoted** total; favourites must respect 86'd availability (same `isMenuItemAvailable` data); budgets are G1 ≤ 6 taps, G2 ≤ 11 — measure before declaring done.
- **FLOW-3 (3) — Layout & readability pass** → §3/FLOW-3. *POS shell components; no logic changes.* **Traps:** nothing removed, only re-weighted; the total must never scroll out of view; every target ≥ 44 px; before/after screenshots in the PR.
- **FLOW-4 (2) — Post-order strip** → §3/FLOW-4. *`PosOrderEntry.tsx` confirmation region, `lib/staff/confirmation.ts` state machine (pure, tested).* **Traps:** never block the next order; failed bill/print chips persist until acted on (rush-proofing rules in spec AC).
- **FLOW-5 (2) — Golden-order gate harness** → §3/FLOW-5. *Unit tests for all pure logic extracted this epic; the written Gate 6B script appended to this document's §6.* **Traps:** no browser-automation framework exists in this repo — do not introduce one for this; the interaction gate is a scripted human check by design.

### Epic PRT — silent paper (8 pts)

- **PRT-1 (3) — Hidden-iframe print pipeline** → §4/PRT-1. *`PosOrderEntry.tsx` + `OrderDetailModal.tsx` print execution, `app/staff-print/[id]/[type]/` (`?auto=1` → print-on-load + `postMessage` afterprint), delete `openBlankPrintWindow`.* **Traps:** keep `lib/staff/autoPrint.ts` plan functions untouched (their tests define *what* prints *when*); queue jobs sequentially — two simultaneous `window.print()` calls race; the print page's staff-gating must still hold for the iframe.
- **PRT-2 (2) — Kiosk device profile + setup doc** → §4/PRT-2. *New `docs/POS-DEVICE-SETUP.md` only.* **Traps:** per-OS `--kiosk-printing` shortcut instructions must be verified on the cafe's real machine at Gate 6B — the doc is *done* when the owner can follow it unassisted; state the one-default-printer-per-profile limitation plainly.
- **PRT-3 (3) — Print watchdog** → §4/PRT-3. *Print-queue logic (pure, tested) + chip UI on the strip/shell.* **Traps:** silent success / loud failure — no toast on success ever; timeout starts at 10 s and is tuned on the real printer at the gate; retry re-runs one job, not the whole plan.

### Epic DEV — installs anywhere (8 pts)

- **DEV-1 (2) — PWA manifest** → §5/DEV-1. *New `app/manifest.ts`, icon assets in `public/`, theme-color metadata in `app/layout.tsx`.* **Traps:** **no service worker** (deliberate — spec D6-5/§13); nothing may regress for non-installed browser use; `start_url` is `/staff`.
- **DEV-2 (4) — Device enrollment & revocation** → §5/DEV-2 + §8 migration `2026-08-pos-devices.sql`. *Migration + `lib/types.ts`, new `app/owner/devices/` page, `app/api/owner/devices/` routes, device-cookie issue/verify helper in `lib/api/` (hash with sha-256; httpOnly/Secure/SameSite=Lax, 1-year).* **Traps:** RLS with **no policies** on `pos_devices` (service-role only — the qr_token lesson, spec §11); plaintext token exists only in the set-cookie moment; `verify:db` RLS probe in the same PR; a device cookie alone must grant **nothing**.
- **DEV-3 (2) — Per-device defaults** → §5/DEV-3. *Device settings columns (in the DEV-2 migration), owner editing UI, POS boot-time consumption with `store_settings` fallback.* **Traps:** defaults, not locks — the staffer can still override per order; store-level auto-print remains the fallback when the device column is null.

### Epic PIN — a name on every order (14 pts)

- **PIN-1 (3) — PIN model** → §6/PIN-1 + §8 migration `2026-08-staff-pins.sql`. *Migration (`staff_pins`, `pin_audit`) + types, bcrypt hashing + policy lib (pure: lockout arithmetic, trivial-PIN rejection — unit-tested), `verify:db` probes.* **Traps:** service-role-only RLS; lockout is enforced **server-side from the row**, the `rate_limits` helper is belt-and-braces on top, not the primary control.
- **PIN-2 (3) — Lock screen & switch UI** → §6/PIN-2. *New lock-layer component mounted from `app/staff/layout.tsx` on enrolled devices, `StaffHeader.tsx` operator display, idle timer.* **Traps:** only on enrolled devices — personal phones must never see it; switching does not clear an in-progress cart (spec E5 defines commit-time attribution); flag `NEXT_PUBLIC_FLAG_PIN_SWITCH` default OFF.
- **PIN-3 (4) — `getCounterActor()`** → §6/PIN-3. *`app/api/device/operator/` route (POST verify → operator JWT cookie; DELETE → lock), `lib/api/auth.ts` (**additive** `getCounterActor()`; existing functions untouched), migrate the POS route set one route per commit with tests: orders create/quote, payment, amend, resend-bill, tables GET, menu GET.* **Traps:** **the riskiest ticket in the phase (spec R2).** Classic-session path must resolve first and keep passing every existing test; `/owner/**` and owner APIs never accept the device path (D6-6); the operator JWT (HS256, `OPERATOR_JWT_SECRET`, 12 h) is valid only alongside an unrevoked device cookie; `hasPermission()` gets the *operator's* user. If any migrated route's behaviour is ambiguous, stop and ask.
- **PIN-4 (2) — Attribution sweep** → §6/PIN-4. *Each staff-surface write path's actor recording; owner views rendering operator names.* **Traps:** verify against the spec's Ravi/Priya AC exactly; `v_staff_entry_stats` keys per person again.
- **PIN-5 (2) — Owner PIN management** → §6/PIN-5. *`/owner/staff` team surface + `app/api/owner/staff/` extension.* **Traps:** PIN shown once at set-time, never retrievable; every set/reset writes `pin_audit`.

### Epic EVT — events on tap (14 pts)

- **EVT-1 (3) — Events CRUD** → §7/EVT-1 + §8 migration `2026-08-events.sql`. *Migration (events, event_menu_items, orders.event_id, channel CHECK widening, `event_pos` seed) + types, `app/owner/events/` + routes (copy the owner-tables CRUD pattern).* **Traps:** the `event_pos` permission seed + `KNOWN_PERMISSION_KEYS` + `DEFAULT_MIN_ROLE` + `PermissionKey` union land **in this same PR** (A-4 — a missing seed fails closed to manager and breaks event selling for staff); closing an event blocks *new* orders only.
- **EVT-2 (4) — The event pad** → §7/EVT-2. *New `app/staff/event/` + big-tile components, flag `NEXT_PUBLIC_FLAG_EVENT_POS` (default OFF).* **Traps:** quote-driven money only (F13) — the pad's simplicity is UI, never math; placement uses the same idempotency-key mechanics as `PosOrderEntry` (F12); required-variant items open the existing customize modal, nothing else does; ≤ 3 taps for G-EVT.
- **EVT-3 (2) — Activation & visibility** → §7/EVT-3. *`active_event_id` consumption (device boot), `hasPermission('event_pos')` gate on route + API, nav conditional.* **Traps:** visibility = device activation **AND** operator permission — either alone shows nothing; the refusal state is the `staffPos`-flag "not enabled" pattern, not an error page.
- **EVT-4 (3) — Event money stays out of the drawer** → §7/EVT-4. *`computeCashFlows` in `app/api/cash-days/route.ts` (exclude `channel='event_pos'`), refund attribution, engine no-customer-message verification.* **Traps:** regression-test the drawer both directions — cafe cash unchanged by event orders AND pre-Phase-6 behaviour unchanged for old orders; this function was rewritten once already (POS4-1) precisely because a wrong drawer is a trust-killer.
- **EVT-5 (2) — Event report** → §7/EVT-5. *New pure `lib/events/report.ts` (unit-tested, integer money) + report view on `/owner/events`.* **Traps:** totals must equal the sum of the event's orders exactly; refunds shown, not netted invisibly.

## 4. Sprint sequencing

### Sprint 1 — "The bill actually arrives" (21 pts) → **Gate 6A** + **Gate 6B-i**
WA-1 → WA-2 (**week 1, both** — external clocks start now) → WA-3 → WA-4 → WA-5, then FLOW-1 (diagnosis first), PRT-1 + PRT-3 together (silent success ships with loud failure, never separately).
**Gate 6A (spec §14):** owner's phone receives a real order's bill; log shows `delivered`; killing one env var turns the banner red. **Gate 6B-i:** placing an order never moves focus; paper appears (dialog acceptable pre-kiosk).

### Sprint 2 — "One screen, every place" (23 pts) → **Gate 6B**
DEV-1 → DEV-2 → DEV-3 (identity first — FLOW-2 consumes device defaults), then FLOW-2 → FLOW-3 → FLOW-4 → FLOW-5, PRT-2 verified on the real counter machine **early in week 2**, PIN-1 pulled forward (pure model work, no UI dependency).
**Gate 6B:** on the installed PWA at the actual counter: G1 ≤ 6 taps, G2 ≤ 11; 10/10 clean opens land on the order screen; zero-UI printing on the kiosk profile; printer-off → retry chip.

### Sprint 3 — "A name on every order, a stall at every event" (26 pts) → **Gate 6C**, **Gate 6D**
PIN-2 → PIN-3 (route-by-route, the sprint's critical path) → PIN-4 → PIN-5, then EVT-1 → EVT-2 → EVT-3 → EVT-4 → EVT-5. If the sprint runs hot, the cut order is EVT-5 → EVT-2/3 (RICE §4) — announced, never silent.
**Gate 6C:** mid-rush operator switching with correct attribution; lockout demonstrated; device revoked live; classic phone login untouched throughout. **Gate 6D:** full dry-run event on a spare device at the cafe before any real offsite use.

### Hardening week
Gate re-runs on real hardware; `SECURITY-PLAYBOOK.md` P6 invariants; flag flips (`POS_V2` on and old path removed, `PIN_SWITCH` on, `EVENT_POS` stays off until first event); owner walkthrough of `docs/POS-DEVICE-SETUP.md` unassisted; outstanding-migration check via `verify:db`.

## 5. Per-ticket definition of done

Identical to Phase 5's bar, restated because juniors read only this section:

1. **Spec AC pass** — every Given/When/Then in the ticket's spec section demonstrably true.
2. **Tests** — new pure logic has unit tests; touched routes have route tests; the full suite is green. A behaviour you moved keeps its tests (moved, not deleted).
3. **Types & build** — `npx tsc --noEmit` and `npm run build` clean; `lib/types.ts` in the same PR as any migration.
4. **Migration discipline** — migration + `verify:db` probes + bold PR callout that it must be applied before deploy.
5. **Guardrails held** — client computes no money; permission keys seeded per A-4; new surfaces behind flags; secrets hashed at rest and absent from logs; server-authoritative everything.
6. **The PR explains why** — house style: the description says what broke or why the change is shaped this way, not just what changed. FLOW-1's PR must contain the takeover bug's root cause.

## 6. Gate scripts (owner-runnable, ~10 min each)

Written during FLOW-5 and appended here; the sketches in spec §14 are the source. Each gate is executed on the real device by someone who did not build the feature, results recorded in the PR that closes the milestone.

## 7. Risks to the plan

| # | Risk | Owner-visible consequence | Mitigation |
|---|---|---|---|
| P1 | WA-2 finds a Meta-side cause with a multi-week approval queue | Bills stay dead while everything else ships | File resubmission day 1; WA-4's webhook proves the fix the hour it lands; interim: WA-3 test-send confirms channel health daily |
| P2 | PIN-3 destabilises staff APIs | Counter can't sell | Additive path, route-at-a-time commits, flag OFF till Gate 6C, classic login always reachable |
| P3 | Real printer/OS defeats kiosk silence | Printing works but shows a dialog | PRT-1 alone already kills focus-steal (the worse half); dialog-visible is a degraded pass, escalation path in §13 parking lot |
| P4 | Phase runs long | Event mode misses an actual event date | RICE cut order; EVT-1's schema can ship alone so data model waits for no one |
| P5 | The unreproducible takeover bug (F6) resists diagnosis | FLOW-1 rebuilds anyway | The docked design makes the takeover *class* impossible; diagnosis failure is documented, not blocking |
