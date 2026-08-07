# HIOC Revamp — Phase 6 "The Counter Gets Out of the Way" — Detailed Spec

**Companion to:** `docs/REVAMP-REQUIREMENTS.md`, `docs/PHASE-4-SPEC.md`, `docs/PHASE-5-SPEC.md`, `docs/PHASE-6-RICE.md`, `docs/PHASE-6-SPRINT-PLAN.md`, `docs/WHATSAPP-BILL-TEMPLATE.md`
**Version:** 0.1 (Draft for grooming)
**Date:** 2026-08-07
**Owner:** Product (Senior PM)
**Scope:** Make the POS fast, calm, and trustworthy in daily use: the WhatsApp bill *actually reaches the customer* and the owner can prove it; the order screen never changes underneath the staffer; printing is silent; the POS installs like an app on any counter machine; staff switch operators with a PIN in two seconds; and a stripped-down event mode can be switched on by the owner for offsite stalls. Assumes Phases 1–5 are on `phase-5-attendance-payroll`.

---

## 0. Phase-6 goal & definition of done

**Goal:** Phase 3/4 built a POS that is *correct* — quote-driven money, replay-safe placement, split tender, refunds that reconcile. Phase 6 makes it *pleasant and dependable*. Today the owner reports, from real daily use: the WhatsApp bill **never arrives**; opening the POS in Chrome can land the staffer on the **payment screen while they are still ordering**; printing **grabs the screen** (a new tab plus a print dialog) when it should be invisible; punching a routine order takes **too many taps**; and staff share one login so nobody knows who punched what without ceremony. On top of that, the cafe runs occasional **offsite/event stalls** that need a radically simpler order pad — which must stay invisible to staff until the owner turns it on.

**Why now:** Correctness without usability erodes trust in a different way than bugs do — the team routes around the product (paper KOTs, verbal bills, one shared login), and every phase after this inherits that erosion. The bill that never arrives is literally the first thing a *customer* notices about the whole system.

**Current-state facts (verified in code, 2026-08-07):**

| # | Fact | Evidence |
|---|---|---|
| F1 | `getAdapter()` **silently substitutes the log stub** when `NOTIFY_PROVIDER` isn't `whatsapp` or the credentials are missing — and the stub **returns `ok: true` with a synthetic ref**, so the delivery log records `sent` while nothing left the building. This is the prime in-repo suspect for "bill never arrives". | `lib/notifications/adapters.ts:216-227` (fallback), `:66-74` (stub "succeeds") |
| F2 | The trap in F1 is *known* to the code — `providerMismatch()` names it in a comment — but it only ever becomes a **once-per-process console.warn**, which nobody watching a Vercel deploy ever sees. Nothing on the owner surface forces the mismatch into view. | `lib/notifications/health.ts:88-122` |
| F3 | Even with credentials present, a bill send can die Meta-side **after** the API accepts it (template paused/rejected, category throttling, expired token, recipient quality limits). The engine records only the *synchronous* API response; there is **no status webhook**, so "accepted" is the last word we ever hear. `notifications` has no delivery-status columns. | `lib/notifications/adapters.ts:123-140`, `supabase/phase1-migration.sql:115` |
| F4 | The approved bill template has an **IMAGE header**, so `WHATSAPP_TPL_BILL_HEADER_IMAGE` is mandatory — Meta rejects a send that omits a declared header. Health only *warns* about it. Long-lived sending also requires a **permanent System User token**; a token created casually in the Meta dashboard expires (24 h or 60 d) and sends start failing with no in-product signal (see F3). | `docs/WHATSAPP-BILL-TEMPLATE.md`, `lib/notifications/health.ts:49-53` |
| F5 | Auto-print opens a **blank new tab inside the click** and points it at the print page afterwards — the browser switches to that tab and shows a print dialog. This is the mechanism behind "the screen changes while I'm ordering" and directly contradicts the owner's requirement that printing be invisible to staff. | `components/staff/PosOrderEntry.tsx:104-119`, `lib/staff/autoPrint.ts` |
| F6 | The payment step is a **full modal takeover** (`PosPaymentModal`, 469 lines) layered over the order screen, sharing state with the parent. The owner reports the POS "switches to the payment screen while ordering" on opening in Chrome — root cause unconfirmed; candidates are modal open-state surviving a remount, the F5 tab dance, or a stale-session redirect. Diagnosis is a ticket, not an assumption. | `components/staff/PosPaymentModal.tsx`, owner report 2026-08-07 |
| F7 | There is **no PWA**: no manifest, no icons purpose-built for install, nothing standalone. The POS lives in a browser tab with tabs/URL bar visible, indistinguishable from any other tab and killable by any staffer. `public/` contains only `images/`. | `ls public/`, `app/layout.tsx` (no manifest link) |
| F8 | Staff identity is **email + password via Supabase Auth**, one full session per person; there is no device concept, no PIN anywhere in the repo, and switching people means a full logout/login. Orders record `created_by` from the session, so on a shared login every order is attributed to the same account. | `app/staff/login/page.tsx:19-41`, `lib/api/auth.ts:118-124`, repo-wide grep for `pin` |
| F9 | `hasPermission()` **fails CLOSED to manager** for any key missing its `role_permissions` seed row — the TAB-1 trap, now playbook rule A-4. Any new key (`event_pos`) must be seeded in the migration *and* added to `KNOWN_PERMISSION_KEYS`, `DEFAULT_MIN_ROLE`, and the `PermissionKey` union in the same PR. | `lib/permissions.ts:18-31`, Phase-5 spec F4 |
| F10 | `orders.channel` is CHECK-constrained to `('customer_web','staff_pos','table_qr')` — an event channel requires widening the CHECK in a migration, exactly as `table_qr` did. | `supabase/phase3-migration.sql:74` |
| F11 | The cafe drawer's expected cash is `opening + Σ cash settles − Σ cash refunds` over `cash_days`; event orders taken offsite on a different cash box would **corrupt the cafe drawer** if they flow into the same computation. | `app/api/cash-days/route.ts` (`computeCashFlows`), Phase-4 POS4-1 |
| F12 | `POST /api/orders` is **replay-safe behind a per-attempt idempotency key** generated client-side — the exact foundation an offline-queue-later design needs (a queued order can be retried indefinitely without double-punching). | `components/staff/PosOrderEntry.tsx:94-102`, POS4-2 |
| F13 | The client **never computes money** — every displayed rupee comes from `POST /api/orders/quote`. Event mode must not break this, however simple its menu looks. | `components/staff/PosOrderEntry.tsx:9-13` |
| F14 | A `rate_limits` table + helper and a `verify:db` harness already exist; PIN attempt-limiting and Phase-6 schema probes extend proven patterns rather than inventing new ones. | `supabase/` (rate_limits), `scripts/` + `npm run verify:db`, `[[db-verification-harness]]` |

**Release-level Definition of Done**

- [ ] A counter order settled with a phone number produces a WhatsApp bill **on the customer's handset**, and `/owner/notifications` shows it reaching a **terminal `delivered` state reported by Meta** — not merely "accepted".
- [ ] When the channel is dead (missing env, expired token, paused template), the owner sees a **red banner on the owner dashboard naming the exact missing/broken thing** within one page-load — never a `sent` row that secretly went to a log stub. The log stub is **impossible to mistake for a real send** in any log or UI.
- [ ] The owner can fire a **test bill to their own phone** from `/owner/notifications` in one tap and see the result inline.
- [ ] The order screen **never changes underneath the staffer**: payment is a docked step on the same screen (no modal takeover), nothing auto-navigates, and the reported "opens on payment screen" bug is diagnosed and dead.
- [ ] A KOT/receipt prints with **zero visible UI on the POS** — no new tab, no focus change, no dialog — on a counter device set up per the documented kiosk profile. A print that *fails* is loudly visible; a print that succeeds is invisible.
- [ ] The POS **installs as an app** (own window, own icon, no browser chrome) on any desktop/laptop/tablet at any location, from the same URL, and the owner can see and revoke **named devices** ("Counter 1", "Event stand").
- [ ] A staffer switches the active operator on a shared counter device by tapping **their name + a 4-digit PIN in under 3 seconds**; every order/void/settle records *that person* as the actor; wrong-PIN attempts rate-limit and lock out; the owner sets/resets PINs. Personal-phone full login keeps working unchanged.
- [ ] The owner creates an **event** (name, dates, menu subset with optional price overrides), activates it on chosen devices/staff, and those staff see a **big-tile, two-tap order pad**; everyone else sees nothing. Event sales report separately and **never touch the cafe drawer**.
- [ ] Every new surface is dark-launched behind `lib/flags.ts`; every migration ships with `verify:db` probes; all new math/decision logic lives in pure, unit-tested libs.

**Conventions:** Same as Phases 1–5 — AC in Given/When/Then; integer money; UTC-stored / IST-displayed; server- and RLS-enforced authorization; sensitive actions through `hasPermission()`; new permission keys seeded per A-4; `lib/types.ts` in exact sync with migrations.

---

## 1. Milestone architecture

| Milestone | Pillars | Theme | Gate |
|---|---|---|---|
| **6A** | WA | The bill arrives, provably | **Gate 6A** — a real settled order's bill lands on a real phone; the log shows Meta-reported `delivered`; killing one env var turns the owner banner red |
| **6B** | FLOW, PRT, DEV | One calm screen, silent paper, installs anywhere | **Gate 6B** — golden orders within tap budget on an installed PWA; auto-print with zero visible UI; screen never changes uninvited |
| **6C** | PIN | A name on every order | **Gate 6C** — operator switch < 3 s; attribution correct across switches; lockout works; classic login untouched |
| **6D** | EVT | Events on tap, hidden until summoned | **Gate 6D** — dry-run event end-to-end: create → activate → orders → report; invisible to non-activated staff; cafe drawer unaffected |

6A is first because it is the only pillar a *customer* can see failing. 6B before 6C because PIN's lock screen mounts on the reworked shell. 6D last because event mode composes device identity (6B DEV) + operator identity (6C) + the simplified flow (6B FLOW).

---

## 2. Pillar WA — The bill arrives, provably — *Milestone 6A*

The owner's report is "never arrives at all". The honest engineering position: we do not yet know *which* link is broken, and the current system is built so that several failure modes are **indistinguishable from success**. WA therefore starts with instrumentation that makes the truth undeniable, then fixes whatever it reveals, then keeps it fixed with Meta's own delivery receipts.

### WA-1 — The config doctor: no more lying `sent`

**What:** Kill every path where a not-really-sent message records as success, and give the owner a one-glance verdict.
- The log adapter's synthetic refs and log rows must be **branded as stub** end-to-end: `providerRef` prefix `stub_`, a distinct `provider` value recorded on the notification row, and the owner log rendering them as "🧪 stub (not a real send)" — retroactively too, by matching the existing `log_` prefix.
- When `NOTIFY_PROVIDER=whatsapp` and credentials are missing, the engine must record **`skipped` with the exact missing var names** (extending BILL-3's `skip_reason`), not a stub `sent`.
- `providerMismatch()` + `billChannelHealth()` surface as a **red banner on `/owner` (dashboard home) and `/owner/notifications`** whenever anything required is missing — not only a console.warn.
- Extend `npm run verify:db`-style checking with `npm run verify:notifications`: a script that prints each channel's health, the resolved adapter, template names, and — with `--send-test <phone>` — performs one real send and prints Meta's raw response.

**Why:** F1/F2. A system that reports success while doing nothing is worse than one that fails loudly; every later WA ticket depends on being able to believe the log.

**AC:**
- Given `NOTIFY_PROVIDER` unset in production, when a bill send is attempted, then the notification row is `skipped` with `skip_reason` naming `NOTIFY_PROVIDER`, and the owner dashboard shows the red channel banner.
- Given a dev environment intentionally on the stub, when the owner opens `/owner/notifications`, then stub rows are visually branded and never counted in any "sent" tally.
- Given full config, when `verify:notifications --send-test` runs with the owner's number, then a real WhatsApp message arrives and the script prints the message id.

**Guardrails:** Pure health logic stays in `lib/notifications/health.ts` (it is already dependency-free and unit-tested). No behaviour change for the email channel beyond the shared banner. Order-status templates (`accepted`/`ready`/…) get the same skip honesty for free via the engine — don't fork the bill path.

### WA-2 — The Meta-side audit: template, token, category

**What:** A guided checklist ticket — part doc, part code assertion — that eliminates the Meta-side causes the repo cannot see:
1. **Token longevity** — confirm the token in Vercel env is a **permanent System User token**, not a dashboard user token (those expire in 24 h / 60 d and then every send fails). Document the generation steps in `docs/WHATSAPP-BILL-TEMPLATE.md`.
2. **Template state & category** — confirm `order_bill_1` (and the status templates) are **APPROVED** and categorised **UTILITY**, not MARKETING. A marketing-categorised bill is silently throttled per-recipient by Meta — the API accepts, the phone never rings. If Meta recategorised it, resubmit as UTILITY.
3. **Header image** — confirm `WHATSAPP_TPL_BILL_HEADER_IMAGE` is set to a public HTTPS URL that Meta's crawler can fetch (the 1200×628 asset at `public/images/whatsapp-bill-header.png` on the production origin).
4. **Number & phone-id** — confirm `WHATSAPP_PHONE_ID` belongs to the display number the business actually verified, and the recipient test uses a full E.164 Indian mobile.
- Code assertion half: `verify:notifications` queries the Graph API for the template's live `status` + `category` and the token's validity, and prints both — so this audit is re-runnable forever, not a one-time human checklist.

**Why:** F3/F4. "Never arrives" with a green-looking log is the classic signature of expired token, paused/marketing template, or missing declared header — none of which the current code can detect after the fact.

**AC:**
- Given an expired/invalid token, when `verify:notifications` runs, then it prints the Graph API error verbatim and exits non-zero.
- Given the template is not APPROVED+UTILITY, then the script says exactly that, with the live status/category fetched from Meta.

### WA-3 — Owner test-send

**What:** A **"Send test bill"** button on `/owner/notifications`: fires the real bill template (sample order data, marked TEST in the variable text) to a phone number the owner types, through the full engine path, and renders the engine's verdict plus — once WA-4 lands — the delivery status, inline.

**Why:** The owner must be able to answer "is it working *right now*?" in ten seconds without a deploy, a script, or a customer guinea pig.

**AC:**
- Given full config, when the owner test-sends to their own number, then the message arrives and the row appears in the log below, marked as a test.
- Given broken config, then the button's inline result names the failure (from the engine's error), not a generic "failed".

**Guardrails:** Owner-gated route; rate-limited (reuse `rate_limits`, e.g. 5/hour) so a stuck finger can't burn Meta quota; test rows carry a flag so they're excluded from any future analytics.

### WA-4 — Delivery receipts: Meta's webhook closes the loop

**What:** `POST /api/webhooks/whatsapp` receiving Meta Cloud API **status callbacks** (`sent` → `delivered` → `read`, or `failed` with an error object), plus the `GET` verification handshake (`hub.challenge` echo against `WHATSAPP_WEBHOOK_VERIFY_TOKEN`).
- **Migration** `supabase/2026-08-notify-delivery.sql`: `notifications` gains `provider_status text CHECK (provider_status IN ('sent','delivered','read','failed'))`, `provider_status_at timestamptz`, `provider_error text`; index on `provider_ref` (the webhook correlates by message id).
- Signature verification with `X-Hub-Signature-256` + `WHATSAPP_APP_SECRET` — reject on mismatch, fail closed when the secret is unset (the CRON_SECRET pattern, F8 of Phase-5).
- `/owner/notifications` shows the terminal status per row ("delivered 12:04", or the failure with Meta's error code and a plain-language translation of the common ones: 131026 recipient not on WhatsApp, 131049/131050 marketing limits, 132001 template not found/paused).
- Status transitions are monotonic (`read` never regresses to `delivered`); unknown message ids are logged and dropped, not 500s (Meta retries on non-2xx — always 200 fast, process after).

**Why:** F3. Without receipts, "accepted by the API" is where our knowledge ends — which is precisely how the current situation ("owner says never arrives, log presumably says sent") stayed invisible. This also future-proofs every other template we ever send.

**AC:**
- Given a delivered bill, when Meta posts the status, then the row shows `delivered` within seconds and the POS/owner surfaces read it.
- Given a send that Meta accepts then kills (paused template), then the row flips to `failed` with the code + translation — the first time this class of failure has ever been visible.
- Given a forged webhook body, then 401, nothing written.

**Guardrails:** The webhook is public-by-necessity — it must never trust the payload for anything except statuses keyed by `provider_ref`s we issued. No PII in webhook logs.

### WA-5 — The counter knows too

**What:** The POS placement confirmation (POS4-4's `BillStatusView`) upgrades from "sent/failed at API time" to the webhook truth where available, and a failed bill shows a **one-tap retry** (the existing resend route) right on the confirmation strip. `OrderDetailModal`'s resend reports the same truth.

**Why:** The staffer is standing in front of the customer; "it'll arrive" vs "it failed, tap to resend, or read out the total" is the difference between trust and apology.

**AC:** Given a bill that fails, when the confirmation strip is visible, then the failure and a Resend button are on it, and a successful resend updates the strip in place.

---

## 3. Pillar FLOW — One calm screen — *Milestone 6B*

Design principle for the whole pillar: **the screen never changes except as the direct, expected result of the staffer's tap.** No takeovers, no auto-navigation, no focus theft. Speed comes from fewer decisions, not more cleverness.

### FLOW-1 — Payment becomes a docked step; the takeover bug dies

**What:**
- Rebuild the payment step as a **docked panel inside the right-hand order pane** (replacing the `PosPaymentModal` overlay): cart on top, payment method + tendered/change below, one **Place order** commit. The left menu pane stays visible and interactive until commit.
- **Diagnose the reported bug first** (owner, 2026-08-07: "on opening in Chrome it switches to the payment screen while ordering"). Instrument/reproduce before rebuilding: check modal open-state persistence across remounts, the F5 print-tab dance returning focus oddly, and any redirect-on-stale-session path. Write the root cause in the PR description — the redesign must *provably* kill it, not coincidentally hide it.
- Modal remains only for genuinely modal moments (variant/addon customization — `PosCustomizeModal` stays).

**Why:** F6 + the owner's top complaint. A modal takeover means the staffer's context is destroyed mid-order; a docked step means payment is *part of* the order, which is also how the money actually works (quote → place with parts, POS4-1/2).

**AC:**
- Given items in the cart, when the staffer taps into the payment step, then the menu grid remains visible and tappable, and adding an item re-quotes without losing entered payment state.
- Given the POS is freshly opened in Chrome (cold load, warm load, after tab restore), then it always lands on the order screen with an empty cart — never any payment UI — verified across the reproduction matrix from the diagnosis.
- Given an in-flight place, then double-commit stays impossible (existing in-flight ref semantics preserved).

**Guardrails:** F13 — the docked panel renders **only quoted** amounts. Split-tender (POS4-1) parts UI moves into the panel unchanged in behaviour; parts must still sum exactly to the server total. All existing POS tests keep passing; the payment-flow tests move, they don't shrink.

### FLOW-2 — The tap budget

**What:** Define golden orders and drive their tap counts down:
- **G1** "chai + samosa, cash, no customer" — budget: **≤ 6 taps** from ready screen to committed order (2 item taps, payment method tap, quick-tender tap, place; one spare).
- **G2** "2 lattes one oat-milk, UPI, phone captured" — budget: **≤ 11 taps**.
- Mechanisms (implement in this order until budgets pass): **quick-tender buttons** (exact, ₹50, ₹100, ₹200, ₹500 — computed from the quoted total); **UPI-paid as one tap** (no amount entry — it's always exact); order-type defaults to the device's configured default (DEV-3) so takeaway counters never touch the toggle; **favourites row** above the grid (owner-curated or top-sellers) so G1's items are one tap each without search; phone capture stays **one optional tap away**, never a required field on the critical path (BILL-2 behaviour preserved).

**Why:** The owner picked "too many taps/too slow" first. A numeric budget converts "feels slow" into a pass/fail gate a junior engineer can hit.

**AC:** Given the standard seeded menu on an installed POS, when a tester runs G1/G2 cold, then the counted taps are within budget, recorded in the Gate 6B checklist. `lib/pos/` helpers that decide quick-tender denominations and favourites ranking are pure and unit-tested.

### FLOW-3 — Layout & readability pass

**What:** One deliberate pass over the POS shell for counter conditions (arm's length, glare, hurry): type scale up for the cart and total (the total readable from a metre); every touch target ≥ 44 px; cart lines show qty × name + line total with customizations one muted line under; clear visual states for order-type and table selection; the quote's discount/tax lines collapse into "Total" with a tap-to-expand (staff rarely need the breakdown mid-rush); consistent button hierarchy (one primary action per region). No information is removed — only re-weighted.

**Why:** "Layout/readability" was picked; the current screen accreted through POS-1 → POS4 tickets and has never had a single holistic pass.

**AC:** Before/after screenshots reviewed against the checklist above at Gate 6B; no regression in any existing behaviour test; the cart column never scrolls the total out of view.

### FLOW-4 — After the order: a strip, not a ceremony

**What:** The post-placement confirmation (POS4-4) becomes a compact **strip docked above the quick-add bar**: order number huge, change due huge (when cash), bill status chip (WA-5), print status chip (PRT-3), and two quick actions — **Same again** (re-punch identical cart) and **Find/amend** (deep-link to the order detail). It never blocks the next order; punching a new item dismisses it.

**Why:** "After-order chaos" was picked. The current 12-second confirmation competes with starting the next order — at rush, the next order always wins, and information (change due, failed bill) gets dismissed unseen.

**AC:** Given a settled cash order, when the confirmation strip shows, then starting to punch the next order does not hide the previous change-due until 5 s have passed (rush-proofing: the two coexist briefly), and a failed bill/print chip persists until acted on or the shift's next order commits.

### FLOW-5 — The golden-order gate harness

**What:** The pure logic extracted for FLOW-2/3/4 (tender denominations, favourites ranking, strip state machine) gets unit tests; the tap-count budgets and the "screen never changes uninvited" matrix become a **written Gate 6B script** in the sprint plan that a non-engineer can execute on the installed device in 10 minutes.

**Why:** The repo has no browser-automation harness (vitest only); pretending otherwise would produce a flaky half-Playwright. Honest split: pure logic → unit tests; interaction budgets → a scripted human gate, same as Phase 5's Gate 5A-i.

---

## 4. Pillar PRT — Silent paper — *Milestone 6B*

Owner requirement, verbatim: printing happens "directly without the staff knowing that it is getting printed." Success is **invisible**; only failure is loud.

### PRT-1 — The hidden print pipeline

**What:** Replace the blank-tab dance (F5) with a **hidden same-origin iframe**: mount an invisible iframe at `printUrl(orderId, type)` (+`?auto=1`); the print page, when `auto=1`, calls `window.print()` on load-complete and posts `afterprint` back via `postMessage`; the POS unmounts the iframe afterwards. Queue multiple prints (KOT then receipt) sequentially. Focus **never** leaves the POS; no new tab exists.
- On a stock browser this still shows the native print dialog (over the same tab) — acceptable in dev; **full silence comes from PRT-2's kiosk profile**, where Chrome prints straight to the default printer with zero UI.
- The print pages themselves (KOT-1/2 surfaces at `/staff-print/[id]/[type]`) are reused untouched except for the `auto` behaviour.

**Why:** F5 is the single mechanism behind both "the screen switches" and "staff see the printing". The pop-up-blocker gymnastics (`openBlankPrintWindow`, the 'noopener' caveat) get deleted rather than patched.

**AC:**
- Given auto-print KOT on, when an order is placed, then the POS screen never loses focus, no tab is created, and on a kiosk-profile device paper appears with zero visible UI.
- Given both KOT and receipt due, then both print, in order, one iframe at a time.

**Guardrails:** The iframe src is same-origin and staff-gated exactly as today (the print page's own auth stands). `lib/staff/autoPrint.ts`'s pure plan functions (`placementPrintPlan`, `settlePrintPlan`) are unchanged — only the *execution* changes, so the "what prints when" tests keep their meaning.

### PRT-2 — The kiosk device profile

**What:** `docs/POS-DEVICE-SETUP.md` — a one-page, follow-exactly guide the owner can run per counter machine: create a dedicated Chrome profile; install the PWA (DEV-1); create the launch shortcut with `--kiosk-printing` (per-OS: macOS/Windows commands provided) so `window.print()` goes straight to that profile's **default printer** silently; set the default printer (80 mm thermal) and default page settings; auto-launch on login. Include the verification steps ("place a test order; paper should appear; the screen should not change").
- Known limitation, stated plainly in the doc: `--kiosk-printing` prints everything to **one** default printer per profile. Routing KOT to a kitchen printer *and* receipts to a counter printer from one device needs a second profile/window or a print server — parked (§13), with the workaround documented.

**Why:** Browsers rightly refuse to print silently without an explicit operator-level opt-in; the kiosk flag *is* that opt-in, and it needs to be an owner-runnable procedure, not tribal knowledge.

### PRT-3 — Loud failure, silent success

**What:** A print watchdog in the POS: each queued print must reach `afterprint` within a timeout (10 s); otherwise a **persistent, non-blocking chip** appears on the confirmation strip / shell ("KOT didn't print — tap to retry"), with retry re-running just that job. Repeated failures (3 in a shift) escalate to a banner suggesting the printer/profile checklist. Print attempts and outcomes are recorded client-side only (no new table) — this is an operational nudge, not an audit domain.

**Why:** Silent printing's failure mode is silent *non*-printing — the kitchen just never gets the ticket. Invisible success is only safe when failure is guaranteed visible.

**AC:** Given the printer is off, when an order places, then within 10 s the chip appears and a retry after power-on produces the ticket.

---

## 5. Pillar DEV — Installs anywhere, known by name — *Milestone 6B*

### DEV-1 — The POS installs as an app

**What:** A web app manifest via `app/manifest.ts` (Next App Router native): `name` "HIOC POS", `display: standalone`, `start_url: /staff`, theme/background colors matching the staff shell, maskable icons (512/192) generated from the brand mark. Installed, the POS runs in its own window with no tabs or URL bar, own dock/taskbar icon, on macOS/Windows/ChromeOS/Android from the same production URL.
- **Deliberately no service worker in this phase.** Chrome no longer requires one for install, and a caching SW is exactly the kind of stale-POS foot-gun the offline-later design (§13) must introduce *carefully*, not as an install side-effect.

**Why:** F7; this is the whole answer to "is there an easy desktop application, usable at several places" — one URL, installed per machine, zero distribution/update problem (deploys are updates), and the shell PRT-2 and PIN-2 build on.

**AC:** Given Chrome on a desktop at any location, when the owner visits `/staff` and installs, then the POS opens standalone with the correct icon and survives relaunch; nothing about the in-tab experience regresses for non-installed use.

### DEV-2 — Devices, enrolled and revocable

**What:** Give counter machines an identity, owned by the owner:
- **Migration** `supabase/2026-08-pos-devices.sql`: `pos_devices` (`id uuid pk`, `name text`, `token_hash text` (sha-256 of an opaque 32-byte secret), `enrolled_by uuid`, `enrolled_at`, `last_seen_at`, `revoked_at timestamptz null`, per-device settings columns per DEV-3). RLS: no client access; service-role only (the qr_token lesson, Phase-3 §11 — secrets never reach PostgREST).
- **Enroll:** owner, logged in on the target machine, opens `/owner/devices` → "Enroll this device" → names it → server issues the token into an **httpOnly, Secure, SameSite=Lax cookie** (1-year), stores only the hash. **Revoke:** same screen lists devices (name, last seen, enrolled when) with a revoke action; a revoked device's cookie fails on next check and the device drops to the classic login screen.
- A device cookie alone grants **nothing** — it only unlocks the PIN-switch surface (6C) and carries device settings. All authority still comes from the operator (or a classic session).

**Why:** Shared counter hardware needs an identity separate from any person for PIN switching (6C), print/order-type defaults (DEV-3), and event activation (EVT-3) to hang off — and the owner needs a kill switch for a lost/retired machine.

**AC:**
- Given the owner enrolls "Counter 1", then it appears in `/owner/devices` and its cookie survives browser restarts.
- Given revocation, then the device's next request treats it as unenrolled; re-enrolling issues a fresh token.
- Given the DB, then no plaintext token exists anywhere at rest.

### DEV-3 — Per-device defaults

**What:** On the device row + `/owner/devices` editing: **default order type** (takeaway/dine-in), **auto-print overrides** (this device prints KOT? receipt?), and later **active event** (EVT-3). The POS reads its device's settings at boot and applies them as *defaults* (staffer can still override per order). Store-level auto-print settings (POS4-3) become the fallback when a device has no override.

**Why:** "Usable at several places" implies the places differ — the event stand shouldn't print KOTs, the counter shouldn't default to dine-in.

**AC:** Given a device set to takeaway + no-KOT, when the POS boots on it, then those defaults apply without a staffer touching anything, and another device is unaffected.

---

## 6. Pillar PIN — A name on every order — *Milestone 6C*

**The model (D6-2, closed):** the *device* is enrolled once (DEV-2); the *operator* is whoever last tapped their name and PIN. Orders, voids, settles, comps record the operator. Full Supabase login on personal phones is untouched — attendance (Phase 5) explicitly **stays on the personal phone with geofence** (D6-11); the PIN is attribution, not attendance.

### PIN-1 — PINs: stored, limited, audited

**What:** **Migration** `supabase/2026-08-staff-pins.sql`: `staff_pins` (`user_id uuid pk → profiles`, `pin_hash text` (bcrypt), `failed_attempts int default 0`, `locked_until timestamptz null`, `set_by uuid`, `updated_at`). RLS: service-role only. Plus `pin_audit` (who set/reset whose PIN, when — the `role_change_audit` shape, F12 of Phase-5). Server-side verify enforces: 4 digits; **5 consecutive failures → locked 60 s**, doubling per subsequent failure cap 15 min (`locked_until`); attempts also counted through the existing `rate_limits` helper per (device, user) as belt-and-braces. Trivial PINs (0000, 1234, birth-year-alike patterns 19xx/20xx) rejected at set time.

**AC:** Given 5 wrong entries, then the 6th correct entry within the lockout still fails with a "locked, try in X s" message; given the lockout passes, the correct PIN works and resets the counter.

### PIN-2 — The lock screen & switch UI

**What:** On an **enrolled device** (and only there), the staff shell mounts a lock/switch layer: tiles for each active staff member (name + initial avatar), tap → 4-digit PIN pad (the AskUserQuestion mock the owner approved), success → that person is the operator, shown persistently in `StaffHeader` ("👤 Ravi"). **Idle auto-lock** after a configurable timeout (default 2 min, device setting) and a one-tap manual lock. Switching operators does **not** clear an in-progress cart (rush reality: one person punches, another collects) — the *commit* records whoever is operator at commit time.

**AC:**
- Given the lock screen, when Ravi taps his tile and enters his PIN, then the POS is usable within 3 s of first tap and the header names him.
- Given 2 min idle, then the lock layer returns; the cart behind it is preserved.
- Given a non-enrolled device (someone's phone), then no lock screen exists and classic login behaves exactly as today.

### PIN-3 — The server knows the operator

**What:** The server-side half, designed to be additive and fail-safe:
- `POST /api/device/operator` — body `{userId, pin}` + device cookie → verifies (PIN-1 rules) → sets an **operator cookie**: a signed, httpOnly JWT `{op: userId, dev: deviceId, iat}` (HS256 with a dedicated `OPERATOR_JWT_SECRET`), 12 h sliding TTL. `DELETE` = lock.
- `lib/api/auth.ts` gains **`getCounterActor()`**: resolves a classic Supabase staff session first (unchanged path); otherwise, given valid device + operator cookies (device unrevoked, operator still `isStaffRole`), returns `{user, role, via: 'device'}` loading the operator's profile via the admin client. Staff-surface route handlers migrate from `getStaffOrOwner()` to `getCounterActor()` **one route at a time, each with tests** — starting with the POS path (orders create/quote/payment/amend, tables read, menu read).
- **Explicitly owner-excluded:** `/owner/**` and owner APIs never accept the device path (D6-6) — money screens, payroll, settings always require a full login. `hasPermission()` receives the *operator's* user, so per-person gates (void, comp, refund) bite the person, not the device.

**Why:** This is the riskiest ticket in the phase — it touches the auth spine. Additive design (new function, classic path untouched and tested first) is what keeps a mistake from locking the counter out on a Friday night, per the A-4 fail-closed philosophy.

**AC:**
- Given a valid operator on an enrolled device, when they place an order, then it succeeds with `created_by = operator` and permission checks evaluate the operator's role.
- Given a revoked device or a signed-out operator cookie, then staff APIs 401 and the UI falls to the lock screen (device) or login (unenrolled).
- Given no device cookies at all, then every existing session-based test passes unchanged.

### PIN-4 — Attribution end-to-end

**What:** Sweep the actor plumbing: orders `created_by`, amendments, settles/`order_payments`, comps, cash-day actions, resend-bill — every staff-surface write records the operator id from `getCounterActor()`. Owner-facing views that show "who" (order detail, amendments audit, notifications log, cash day) render the operator's name. The v_staff_entry_stats analytics view keys per real person again.

**AC:** Given Ravi punches and Priya later voids a line on the same order via PIN switch, then the order shows created-by Ravi and the void audited to Priya.

### PIN-5 — Owner manages PINs

**What:** On `/owner/staff` (the existing team surface, F9 of Phase-5): set/reset PIN per member (owner types it or generates; shown once, stored hashed), see lock state, unlock early. Every set/reset writes `pin_audit`. No self-service PIN change in this phase (parked, §13) — the owner is the registrar.

**AC:** Given a reset, then the old PIN fails, the new one works, and the audit row exists.

---

## 7. Pillar EVT — Events on tap, hidden until summoned — *Milestone 6D*

**The model:** an *event* is an owner-created container (name, dates, menu subset, optional price overrides). It is invisible to everyone until the owner **activates it on specific devices and/or grants specific staff**. Activated, the POS on those devices offers a big-tile order pad selling only the event menu; orders flow down the *same* pipeline (quote → idempotent place → settle) with `channel='event_pos'` and an `event_id`, and report separately. Online-only this phase; the design keeps the offline door open (D6-3).

### EVT-1 — Events, owned and dated

**What:** **Migration** `supabase/2026-08-events.sql`:
- `events` (`id`, `name`, `starts_on date`, `ends_on date`, `status` CHECK `draft|active|closed`, `notes`, `created_by`, timestamps). RLS: owner writes (service-role route), staff read only via server routes.
- `event_menu_items` (`event_id`, `menu_item_id`, `price_override_inr int null`, `sort int`) — a *subset* of the real menu with optional flat event pricing; **no free-form items** (D6-9: everything sold is a real menu item, so recipes/analytics/GST all keep working).
- `orders` gains `event_id uuid null → events`; `orders.channel` CHECK widens to include `'event_pos'` (F10).
- Owner CRUD at `/owner/events` (the owner-tables pattern): create, edit dates/menu/prices, activate, close. Closing an event blocks new orders against it (server-side check), never touches existing ones.

**AC:** Given a draft event, then nothing anywhere changes for staff; given activation without device/staff assignment, still nothing (visibility requires EVT-3's two keys to turn).

### EVT-2 — The event order pad

**What:** `/staff/event` (flag `NEXT_PUBLIC_FLAG_EVENT_POS`, default OFF): a deliberately minimal surface — **big tiles** (event items only, price on tile), tap to add (no variants at events unless the item requires one, then the existing customize modal), running total huge, **two settle buttons: Cash and UPI** (no split, no customer capture, no tables, no coupons/loyalty, no KOT by default per device settings). Quote-driven exactly like the main POS (F13) — the simplicity is in the *UI*, never in the money path. Placement uses the same idempotency-key mechanics (F12), which is precisely what makes a future offline queue retro-fittable.

**Why:** At a stall, the queue is long, the menu is 8 items, and the operator may be a borrowed hand. Two taps to sell a thing.

**AC:**
- Given an active assigned event, when the operator opens the event pad, then G-EVT "1 item, cash" commits in **≤ 3 taps** (tile, Cash, confirm).
- Given an item with a required variant, then the modal appears; otherwise never.
- Given event pricing (override set), then the quote returns the override and the tile shows it; tax lines per store settings unchanged.

### EVT-3 — Hidden until the owner says so

**What:** Visibility = **device activation AND operator permission**, both owner-controlled:
- Device: `/owner/devices` (DEV-3) sets `active_event_id` per device — the event pad only exists on a device pointed at an event.
- Person: new permission key **`event_pos`**, seeded `staff` in the migration + `KNOWN_PERMISSION_KEYS` + `DEFAULT_MIN_ROLE` + `PermissionKey` union in the same PR (A-4, F9). The owner's existing permission grid then lets them restrict event selling to chosen roles; per-person restriction beyond role uses the grid's existing semantics.
- Everyone else: no nav entry, no route (404-equivalent "not enabled" state, the `staffPos` flag pattern).

**Why:** The owner asked for exactly this: "hidden for specific staff, can be initialised by the Owner."

**AC:** Given an activated device but an operator whose role lacks `event_pos`, then the pad refuses with a plain message; given the permission but a non-activated device, the pad doesn't exist; given both, it works.

### EVT-4 — Event money stays out of the cafe drawer

**What:** `computeCashFlows` (F11) **excludes `channel='event_pos'` orders** from the cafe `cash_days` expectation; the event's own cash reconciles in EVT-5's report instead (D6-8). Notifications: event orders send **no customer messages** (no phone captured — the engine's existing "no destination → skip with reason" path covers it; verify, don't assume). Refunds on event orders: allowed through the existing counter-refund path, attributed to the event in reporting.

**Why:** An offsite cash box and the cafe till must never share an expected-cash equation — one borrowed ₹500 note would poison both reconciliations.

**AC:** Given a cafe cash day open while an event sells for cash, then the cafe day's expected cash is unchanged by event orders; the event report shows the event's cash total.

### EVT-5 — The event report

**What:** Per event on `/owner/events`: total sales, orders count, cash vs UPI split, item-wise quantities, refunds — computed from orders with that `event_id` via a pure lib (`lib/events/report.ts`) + a simple owner view. CSV export reuses whatever export convention exists by then (or defers to the same parking lot as cash CSV).

**AC:** Given a closed event with known orders, then the report's totals equal the sum of its orders exactly (integer money, unit-tested lib).

---

## 8. Data model (migration sketches)

Four migrations, one per epic that touches schema, applied in this order:

```sql
-- supabase/2026-08-notify-delivery.sql (WA-4)
alter table notifications
  add column provider_status    text check (provider_status in ('sent','delivered','read','failed')),
  add column provider_status_at timestamptz,
  add column provider_error     text;
create index if not exists idx_notifications_provider_ref on notifications (provider_ref);

-- supabase/2026-08-pos-devices.sql (DEV-2/3)
create table pos_devices (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  token_hash    text not null unique,          -- sha256(opaque secret); plaintext never stored
  enrolled_by   uuid not null references profiles(id),
  enrolled_at   timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  default_order_type text check (default_order_type in ('takeaway','dine_in')),
  auto_print_kot     boolean,                  -- null = fall back to store_settings
  auto_print_bill    boolean,
  active_event_id    uuid references events(id)
);
-- RLS: enable, NO policies → service-role only (the qr_token lesson).

-- supabase/2026-08-staff-pins.sql (PIN-1/5)
create table staff_pins (
  user_id         uuid primary key references profiles(id) on delete cascade,
  pin_hash        text not null,               -- bcrypt
  failed_attempts int  not null default 0,
  locked_until    timestamptz,
  set_by          uuid not null references profiles(id),
  updated_at      timestamptz not null default now()
);
create table pin_audit ( ... role_change_audit shape ... );
-- RLS: enable, NO policies → service-role only.

-- supabase/2026-08-events.sql (EVT-1..4)
create table events ( id, name, starts_on, ends_on, status check in ('draft','active','closed'), notes, created_by, created_at, updated_at );
create table event_menu_items ( event_id, menu_item_id, price_override_inr int check (price_override_inr >= 0), sort, primary key (event_id, menu_item_id) );
alter table orders add column event_id uuid references events(id);
alter table orders drop constraint orders_channel_check;
alter table orders add  constraint orders_channel_check check (channel in ('customer_web','staff_pos','table_qr','event_pos'));
-- seed permission key: insert into role_permissions (key, min_role) values ('event_pos','staff') on conflict do nothing;
```

Every migration ships with `verify:db` probes in the same PR (F14): table/column/CHECK existence, RLS posture on `pos_devices`/`staff_pins` (insert via service role, assert invisible to anon — the `idempotency_keys` probe pattern), and the widened channel CHECK accepting `event_pos` / rejecting garbage. `lib/types.ts` updates land in the same PR as each migration.

**New env:** `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `OPERATOR_JWT_SECRET`.
**New flags (all default OFF except noted):** `NEXT_PUBLIC_FLAG_POS_V2` (FLOW rework, default ON once Gate 6B passes — it replaces, not forks, the POS), `NEXT_PUBLIC_FLAG_PIN_SWITCH`, `NEXT_PUBLIC_FLAG_EVENT_POS`.

---

## 9. Decisions

**Closed (owner, 2026-08-07):**

| # | Decision | Choice |
|---|---|---|
| D6-1 | WhatsApp bill symptom | **Never arrives at all** → 6A leads with instrumentation (WA-1/2) before assuming any single cause; the stub-masquerade (F1) is the prime in-repo suspect, Meta-side causes (F3/F4) the prime external ones |
| D6-2 | PIN architecture | **Shared enrolled device + per-staff PIN operator switch** (Square/Toast model); full login unchanged on personal devices |
| D6-3 | Event connectivity | **Online-only now, offline-ready design** — idempotent placement is the retrofit point; offline queue is parked, not forgotten (§13) |
| D6-4 | Usability priorities | All four pains confirmed + two specifics: the payment-screen takeover must die (FLOW-1) and printing must be invisible (PRT) |

**Proposed defaults (PM) — owner may veto at grooming, none block Sprint 1:**

| # | Decision | Default & rationale |
|---|---|---|
| D6-5 | Desktop app technology | **Installable PWA + documented Chrome kiosk-print profile**; no Electron/Tauri (nothing native is needed; a wrapper adds a distribution/update problem the PWA doesn't have). Revisit only if silent per-job printer *routing* becomes a must-have |
| D6-6 | PIN authority ceiling | Operator-via-PIN reaches **staff surfaces only**; `/owner/**` always requires full login. A 4-digit PIN on shared hardware must never guard payroll or settings |
| D6-7 | PIN policy | 4 digits · 5 fails → 60 s lockout doubling to 15 min cap · owner-set/reset only · trivial PINs rejected · idle auto-lock default 2 min (per-device setting) |
| D6-8 | Event money | Event orders **excluded from cafe `cash_days`**; each event reconciles its own cash in its report |
| D6-9 | Event menu shape | **Subset of real menu items + optional per-event price override**; no free-form items (keeps quotes, GST, and item analytics true) |
| D6-10 | Delivery receipts | Meta status **webhook ships in 6A** (not later) — it is the only way "never arrives" can be *proven* fixed rather than believed fixed |
| D6-11 | PIN × attendance | PIN switching is **attribution only**; clock-in/out stays on the personal phone with the Phase-5 geofence. A counter PIN tap is not evidence of presence at shift start |

---

## 10. Edge cases & failure modes (consolidated)

| # | Case | Handling |
|---|---|---|
| E1 | Meta webhook arrives before the engine's own row commit (race) | Webhook handler retries lookup once after short delay, then logs-and-drops; Meta redelivers on our 200-with-processing-failure? No — always 200; unmatched statuses go to a dead-letter log line |
| E2 | Two devices enrolled with the same name | Allowed (names are labels); id + last-seen disambiguate in the owner list |
| E3 | Operator's role changes (staff → revoked) mid-shift | `getCounterActor()` re-checks `isStaffRole` per request — next request 401s to lock screen |
| E4 | Device cookie present but device revoked while POS is open | Same: next API call fails closed to classic login; in-flight cart is client-state and survives re-auth by the same person |
| E5 | PIN entry during placement in-flight | Commit records the operator at commit time (the placing request's actor), never retroactively rewritten |
| E6 | Event active on a device whose operator lacks `event_pos` | Pad refuses; the regular POS remains fully usable (event never blocks cafe selling) |
| E7 | Event item 86'd mid-event | Existing availability realtime applies (same data the tiles read); tile greys out |
| E8 | Event order needs a refund next day, event closed | Counter-refund path works by order id; report attributes it to the event; cafe drawer still unaffected (channel rule) |
| E9 | Print watchdog fires but paper actually printed (slow driver) | Retry is idempotent paper-wise annoying but harmless; timeout tuned at Gate 6B on the real printer |
| E10 | `POS_V2` flag off after rework merges | The old modal flow must still pass its tests until the flag is removed at 6B close — the rework lands behind the flag, not as a big-bang replace |
| E11 | Staffer has no PIN set but device is enrolled | Their tile shows "no PIN set — ask owner"; classic login on that device remains reachable from the lock screen |
| E12 | Test-send used against a customer's number | It's marked TEST in the template variables and rate-limited; owner-gated means accountability is the owner's |

---

## 11. Security, privacy & compliance

- **PINs are credentials**: bcrypt-hashed, service-role-only tables, rate-limited + locked out server-side, audited set/reset, never logged. A PIN alone (without an enrolled device) authenticates nothing.
- **Device tokens** are bearer secrets: stored hashed (sha-256), httpOnly/Secure cookies, revocable, never exposed via PostgREST (RLS with no policies — the qr_token lesson applied from day one this time).
- **Operator JWT** is signed with a dedicated secret, carries only `{op, dev, iat}`, expires in 12 h, and is worthless off-device (validated together with the device cookie).
- **Owner ceiling** (D6-6): no owner surface is ever reachable via the device+PIN path — enforced in `getCounterActor()` callers *and* by owner routes continuing to use `getOwnerUser()` untouched.
- **Webhook**: HMAC-verified (`X-Hub-Signature-256`), fails closed without `WHATSAPP_APP_SECRET`, writes only status fields keyed by refs we issued, logs no message bodies or phone numbers.
- **Events**: no customer PII is collected at event pads (no phone/name fields at all), so no new notice obligations; `app/privacy` needs no change for 6D.
- **SECURITY-PLAYBOOK.md** gains Phase-6 invariants (P6-1..) in the build PRs: stub-send branding is load-bearing for trust; permission-key seeding per A-4 for `event_pos`; the operator/device cookie contract.

---

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | The bill failure is Meta-side and approval/recategorisation (UTILITY resubmit) takes days–weeks | WA-2 runs in Sprint-1 week 1 so the clock starts immediately; WA-1/3/4 proceed in parallel regardless of which cause it turns out to be |
| R2 | `getCounterActor()` regression locks staff out of the POS | Additive path + per-route migration with tests + `PIN_SWITCH` flag OFF until Gate 6C; classic login is the permanent fallback on every device |
| R3 | Kiosk profile setup proves fiddly on the cafe's actual hardware/printer | PRT-2 is a *documented procedure with a verification step*, gated at 6B on the real counter machine — same "measure on-site before depending on it" posture as Phase 5's GPS gate |
| R4 | FLOW rework destabilises the most-used screen in the product | `POS_V2` flag; the old flow's tests stay green until flag removal; golden-order gate is a rollback tripwire |
| R5 | Event mode scope-creeps (custom items, discounts, multi-cashbox) | D6-9 and §13 are the fence; EVT ships the two-tap pad or nothing |
| R6 | Webhook endpoint becomes an attack surface | HMAC + fail-closed + writes constrained to status columns keyed by our refs; no reflection of payload content |

---

## 13. Out of scope (parking lot)

- **Offline event queue** (D6-3): queued-order store + background sync over the existing idempotency keys; requires a service worker strategy designed on purpose. Next phase candidate.
- **Native wrapper (Tauri)** — only if per-job printer routing or true offline demands it (D6-5).
- **Per-job printer routing** (KOT → kitchen, receipt → counter, from one device) — print-server/QZ-Tray territory; workaround documented in PRT-2.
- **Self-service PIN change**, biometric unlock on staff phones.
- **Kitchen display screen (KDS)** replacing paper KOTs — repeatedly adjacent, never yet justified against a thermal printer.
- **Event-specific coupons/discounts**; multi-till events; per-event staff scheduling (Phase-5 leave/rota machinery is where that belongs).
- **Customer-facing order status screen** at events.

---

## 14. Test plan (release gates)

**Unit (vitest, pure libs):** notify health verdicts incl. stub-branding; webhook signature + status monotonicity; quick-tender denomination logic; favourites ranking; confirmation-strip state machine; print plan (unchanged) + watchdog timer logic; PIN policy (lockout arithmetic, trivial-PIN rejection); operator JWT round-trip; device token hash/verify; event report math; `computeCashFlows` event exclusion (regression-guarded both directions).

**Route tests:** webhook (valid/forged/unknown-ref); test-send (gated, rate-limited); device enroll/revoke lifecycle; operator set/verify/lock; each route migrated to `getCounterActor()` — session path AND device path AND neither; event CRUD + activation gates; event order placement (channel + event_id + permission + closed-event refusal).

**verify:db additions:** all §8 probes.

**Gate scripts (human, on real hardware):**
- **Gate 6A** — kill `WHATSAPP_TOKEN` in preview → owner banner red + skipped rows; restore → test-send arrives on the owner's phone; settle a real order → `delivered` in the log.
- **Gate 6B** — installed PWA on the counter machine: G1 ≤ 6 taps, G2 ≤ 11 taps; cold/warm/restored open lands on order screen every time (10 tries); auto-print produces paper with zero visible UI; printer-off produces the retry chip.
- **Gate 6C** — switch operators mid-rush simulation; wrong-PIN lockout; revoke device live; verify attribution on the owner's order detail.
- **Gate 6D** — full dry-run event at the cafe on a spare device before the first real offsite use.
