# HIOC Revamp — Phase 7 "The Counter Owns Its Machine" — Detailed Spec

**Companion to:** `docs/PHASE-6-SPEC.md` (PRT, DEV, PIN), `docs/POS-DEVICE-SETUP.md`
**Version:** 0.1 (Draft for grooming)
**Date:** 2026-09-24
**Owner:** Product
**Scope:** Ship the POS as a desktop application (Windows + macOS) that prints silently to **owner-configured printers with per-ticket routing**, drives the thermal printer natively (cut, cash drawer, real paper status), and **keeps taking and billing orders with no internet**, syncing them to the server when the connection returns. Assumes Phases 1–6 are on `phase-5-attendance-payroll`.

**Reverses D6-5.** Phase 6 chose "PWA + Chrome kiosk profile, no Electron" and named the trigger to revisit: *"silent per-job printer routing becomes a must-have."* The owner has now confirmed routing, native printer control and full offline ordering are all needed (2026-09-24). None of the three is reachable from a browser tab.

---

## 0. Goal & definition of done

**Goal:** The counter machine is a till, not a browser. It prints the KOT to the kitchen printer and the receipt to the counter printer without a dialog, pops the drawer on cash, knows when the printer is out of paper, and a dropped internet connection costs the cafe nothing but a banner.

**Current-state facts (verified in code, 2026-09-24):**

| # | Fact | Evidence |
|---|---|---|
| F1 | Every print goes through one pure queue with an injected `execute`; the only executor today is a hidden iframe calling `window.print()` | `lib/pos/printQueue.ts` (`PrintQueueOptions.execute`) |
| F2 | The browser cannot see paper: `afterprint` fires with the printer off or empty, so "printed" is really "handed to the spooler"; the queue compensates with a human "Didn't print" button | `printQueue.ts` `handedOff` doc comment |
| F3 | `--kiosk-printing` sends everything to one default printer per Chrome profile — no routing | `docs/POS-DEVICE-SETUP.md` §"The limitation" |
| F4 | The POS order screen is a client component that talks to the server only through `fetch` to `/api/menu`, `/api/tables`, `/api/customers/lookup`, `/api/orders/quote`, `/api/orders`, `/api/orders/[id]/payment`, `/api/orders/[id]/amend`, `/api/orders/[id]/resend-bill` | `components/staff/PosOrderEntry.tsx:346,363,453,499,720,745,805,841` |
| F5 | Order placement already sends an `Idempotency-Key` and the server replays a duplicate instead of creating a second order | `PosOrderEntry.tsx:224,722`; `lib/orders/idempotency.ts` |
| F6 | Server pricing is pure and reusable: `resolveOrderLines()` + `computeBill()` | `lib/orders/lines.ts`; `lib/store/hours.ts` |
| F7 | Staff orders skip OTP/verified-orders gates and start `accepted` | `app/api/orders/route.ts:215,459` |
| F8 | `order_number` is a server identity column — it cannot exist before the server sees the order | `supabase/schema.sql:75` |
| F9 | `paid_at` is stamped with `now()` by trigger and is immutable; cash-count windows key off it. An offline cash sale synced tomorrow would land in tomorrow's drawer window → phantom shortage today, phantom surplus tomorrow | `supabase/2026-09-cash-counts.sql:34-51`; `lib/cash/checkpoints.ts:133-143` |
| F10 | Coupon and points redemption are server-locked RPCs (`try_redeem_coupon`, `try_redeem_points`) — correct only with a live DB | `app/api/orders/route.ts:623,651` |
| F11 | PIN operator switching (PIN-1..5) is specced but not built; `pos-devices.sql` is still unapplied | memory / `supabase/2026-08-pos-devices.sql` |

**Definition of done (Gate 7):**
- [ ] Installers for Windows (.exe) and macOS (.dmg), signed, that auto-update; a new web deploy needs **no** reinstall.
- [ ] Owner adds printers from a settings screen (USB, network IP, or OS printer), assigns KOT/receipt/token roles, test-prints each; routing survives restart.
- [ ] Placing a cash order prints the KOT on the kitchen printer, the receipt on the counter printer, cuts both, opens the drawer — zero dialogs.
- [ ] Printer out of paper / offline / cover open shows a loud failure within 3 s; no "Didn't print" guesswork on ESC/POS printers.
- [ ] Pull the network cable: within 5 s the app shows OFFLINE; staff place, bill and print orders; re-plug; every order appears on the server exactly once with its original time, offline bill number, payments and operator, and the day's cash count balances.

---

## 1. Architecture

```
┌──────────────────────── Electron app (desktop/) ────────────────────────┐
│  Main process                                                          │
│   ├─ PrinterService   USB / TCP 9100 / OS-driver; ESC/POS; status poll │
│   ├─ LocalStore       SQLite: snapshot, outbox, bill series, config    │
│   ├─ SyncService      snapshot pull ▸ outbox push ▸ backoff            │
│   └─ Connectivity     probes /api/health, not navigator.onLine         │
│                                                                        │
│  Window  ── ONLINE ──▶ https://staff.hioc.in  (the live web app)       │
│          ── OFFLINE ─▶ app://pos  (bundled build of the SAME           │
│                         PosOrderEntry, data via IPC to LocalStore)     │
│                                                                        │
│  preload: window.hiocDesktop = { print, printers, posApi, status }     │
└────────────────────────────────────────────────────────────────────────┘
```

**One screen, two transports.** `PosOrderEntry` stops calling `fetch` directly and calls a `posApi` module (F4). In a browser, and in the desktop app while online, `posApi` is fetch. In the desktop app while offline, `posApi` is IPC into the local engine. The UI staff learn is the same whether or not the net is up, and there is only one order screen to maintain.

**The web app stays the source of truth for everything else.** Orders board, tables, attendance, cash, owner pages remain online-only web pages. Offline scope is exactly: take an order, take payment, print, and, for orders made offline on this machine, add items and reprint.

---

## 2. Pillar SHL — The shell — *Milestone 7A*

### SHL-1 — Electron app skeleton
`desktop/` in this repo (shares `lib/` pure code via the TS path alias). Electron + electron-builder. The window loads `https://staff.hioc.in`. It has no browser chrome, starts on login (configurable) and allows a single instance only. External links open in the OS browser. Navigation is pinned to `*.hioc.in`.

### SHL-2 — The bridge
`preload.ts` exposes `window.hiocDesktop` via `contextBridge`. Only to `*.hioc.in` origins and `app://pos`. No `nodeIntegration`, `contextIsolation: true`, sandboxed renderer. The web app detects the bridge (`lib/desktop/bridge.ts`, typed, `null` in a browser) and never assumes it.

### SHL-3 — Distribution & updates
electron-updater from GitHub Releases (or S3). Build pipeline produces signed Windows NSIS + macOS notarized dmg (universal). The shell updates rarely; the POS UI updates with every Vercel deploy (online) and with every shell release (offline bundle). The offline bundle carries a `bundleVersion`; the server rejects sync from bundles older than a floor (SYN-3) so a stale machine can't write old pricing logic forever.

### SHL-4 — Enrolment inside the app
Uses DEV-2 enrolment as-is (device cookie). The shell additionally stores a **device sync credential** (see SYN-1) in the OS keychain (`safeStorage`), issued at enrolment.

---

## 3. Pillar PRN — Printers you configure — *Milestone 7A*

### PRN-1 — Printer settings screen
In-app page (desktop only, owner or staff-with-permission): **Add printer** →
- **Connection:** USB (list detected ESC/POS devices), Network (IP + port, default 9100), or OS printer (any installed driver — fallback for non-ESC/POS printers).
- **Name**, **paper width** (58 / 80 mm), **roles** (KOT, Receipt, Token — any combination; a role may go to several printers, e.g. KOT to kitchen AND bar), **copies per role**, **cut after print**, **open drawer on cash payment** (receipt printer only), **character set**.
- **Test print** and a live status dot.
Stored **locally** on the machine (USB paths and IPs are physical facts of that counter), with an "export/import config" for setting up a second machine. Server mirror for owner visibility is parked (§9).

### PRN-2 — Routing
`placementPrintPlan()` already decides *which tickets*; routing decides *which printers*. `PrinterService.route(type) → Printer[]`. A type with no printer assigned is a loud configuration error at print time, not a silent skip.

### PRN-3 — ESC/POS rendering
A pure `lib/print/escpos.ts`: order → byte stream (text layout, bold/double-height headers, GST lines, QR for the e-bill link, cut, drawer pulse `ESC p`). Ticket **content** is extracted from `components/print/StaffTickets.tsx` into a pure `lib/print/ticketModel.ts` so the HTML ticket and the ESC/POS ticket are generated from one model and can't drift. Tested with golden byte fixtures.

### PRN-4 — Real status, real failure
Before and after each job, `DLE EOT` status query (paper-out, near-end, cover open, offline). Network printers: TCP connect timeout. The desktop executor for `PrintQueue` rejects on any fault, so PRT-3's loud failure chip fires from the printer itself. `handed-off` / "Didn't print" stays only for OS-driver printers, where we still can't see paper.

### PRN-5 — Driver fallback
For OS-printer entries: `webContents.print({ silent: true, deviceName })` on an offscreen window rendering the existing `/staff-print/[id]/[type]` page (online) or the bundled ticket (offline). Silent, routed, no Chrome flag.

### PRN-6 — Drawer
Opens on: a cash (or cash-part) payment settle, and a manual **Open drawer** button that requires a reason and is logged (`cash_movements`-style audit, synced). Never on card/UPI.

---

## 4. Pillar OFF — Orders without internet — *Milestone 7B*

### OFF-1 — The snapshot
The shell keeps in SQLite: menu items + addon groups + availability, tables, store settings (GST rate, packaging, bill header), device context, and the **staff roster needed for offline operator identity** (OFF-6). It refreshes on launch, every 5 min online, and on the existing realtime menu-availability event. Every snapshot has a `snapshot_version` (server-issued) stamped onto each offline order.

### OFF-2 — `posApi` seam
Refactor `PosOrderEntry` (and `PosPaymentModal`) to call `lib/pos/api.ts` instead of `fetch`. Browser: the same fetches as today, so nothing changes for the web. Desktop: a transport chosen by connectivity. **Mid-order switching:** a cart in progress survives the switch; an order whose placement request was in flight when the net dropped is resolved by idempotency key on reconnect (F5), never re-placed blindly.

### OFF-3 — Local engine
Implements the offline `posApi` over SQLite using the **shared pure pricing** (`resolveOrderLines`, `computeBill`, F6), so offline totals are computed by the same code the server runs. Each order gets:
- `client_order_id` (UUID v7), which is also its idempotency key;
- `offline_bill_no` from a **per-device series** (SYN-2);
- `client_created_at`, `client_paid_at`, operator id, device id, snapshot version, bundle version.

### OFF-4 — What works offline, what doesn't
| Works | Disabled offline, and why |
|---|---|
| New dine-in / takeaway order, addons, notes, table pick | **Coupons**: usage limits need the server lock (F10) |
| Cash, card (external terminal), UPI via the static counter QR with staff confirmation | **Points redemption**: can't check balance → double-spend risk. Earning still applies after sync |
| Split tender | **Customer lookup** by phone: typed phone is kept and linked on sync |
| KOT / receipt / token print, reprint, drawer | **Adding to an order created online**: its current state is on the server |
| Adding items to an order *created offline on this machine* | Web / table-QR orders: they never reach this machine offline |
| Cancel an unsynced offline order (reason required, synced as cancel) | Refunds; e-bill WhatsApp (queued, sent after sync) |

### OFF-5 — The offline host
`app://pos` is a Vite build of `PosOrderEntry` + print dock + an offline banner ("OFFLINE — 7 orders waiting to sync"), bundled in the shell. Connectivity service flips the window between hosts with hysteresis (3 failed probes down, 2 good probes up) so a flaky link doesn't bounce the screen mid-order. Offline host also shows a local **Today (this machine)** list for reprints and add-items.

### OFF-6 — Who is at the counter offline
Supabase sessions can't be refreshed offline. The shell caches the signed-in staffer's identity at the moment of the drop and keeps using it. **If PIN-1 has shipped**, offline operator switching uses PIN hashes cached in the snapshot (verified locally, same lockout policy D6-7). Offline mode refuses to start for a machine that has never had a staff session.

---

## 5. Pillar SYN — Sync — *Milestone 7B*

### SYN-1 — Device sync credential
At enrolment the server issues a random secret; its hash is stored on the `pos_devices` row. The shell sends it with every sync call. It authorises **only** `POST /api/device/offline-orders` (and the snapshot pull), for **that device**, and revocation (DEV-2) kills it at the next request. Upholds D-1: the device cookie still never authorises staff actions. This is a new, narrower key.

### SYN-2 — Offline bill numbers (GST)
Rule 46(b) CGST: invoice serials ≤16 chars, unique per financial year, multiple series allowed. Series per device: `{deviceCode}-{FY}-{seq}` e.g. `C2-2627-000123` (14 chars). `seq` is allocated locally, persisted before printing, and resets on 1 April. `deviceCode` is assigned by the server at enrolment and never reused. Online orders keep `HIOC-00xxxx`. The receipt printed offline carries the offline number, and that number is permanent: the server stores it, and search/receipts show both.

### SYN-3 — The ingest endpoint
`POST /api/device/offline-orders` accepts a batch. Per order, in one transaction (RPC):
1. Dedupe on `client_order_id` (replay returns the existing order).
2. **Re-price** with the server's snapshot of that `snapshot_version`; a mismatch is **recorded, not rejected**, because the customer has already paid. The order is stored as billed and gets a `sync_discrepancy` row for the owner.
3. Insert order, items, addons, `order_payments` with the **client timestamps** (`created_at`, `paid_at`). Requires a trigger change (F9): `set_order_paid_at` accepts a supplied `paid_at` when `origin = 'offline'`, clamped to `[client_created_at, received_at]`.
4. Link the customer by phone (VAL-2 rules), award loyalty earn, enqueue the WhatsApp e-bill.
5. Status: offline orders arrive `completed` if paid and closed on the machine, else their local state.
Errors are per-order; one bad order never blocks the batch behind it.

### SYN-4 — Outbox & ordering
SQLite outbox, strictly ordered per device, exponential backoff, survives restart and power loss (WAL mode, write-before-print). An order and its later add-items/cancel sync in order. The shell refuses to **uninstall/re-enrol/revoke** cleanly with unsynced orders and warns loudly.

### SYN-5 — Cash integrity
Because `paid_at` is the true sale time (SYN-3), an offline cash sale lands in the right drawer window. A cash count taken **while** a machine holds unsynced cash orders is marked `provisional` and recomputed when that device's outbox drains, so staff are not charged a shortage for money that's in the drawer but not yet on the server.

### SYN-6 — Owner visibility
Owner → Devices shows per machine: online/offline, last sync, **orders waiting to sync**, oldest unsynced age, printer status summary. `sync_discrepancy` rows get a review list. Alert (WhatsApp/email to owner) when a device has held unsynced orders > 2 h while it has been reachable, or > 24 h in total.

---

## 6. Data model (migration sketch — `supabase/2026-10-desktop-offline.sql`)

```sql
alter table pos_devices add column device_code text unique,           -- 'C2'
                        add column sync_secret_hash text,
                        add column last_sync_at timestamptz,
                        add column pending_sync_count int not null default 0;
alter table orders add column origin text not null default 'online'
                     check (origin in ('online','offline')),
                   add column client_order_id uuid unique,
                   add column offline_bill_no text unique,
                   add column snapshot_version text,
                   add column synced_at timestamptz;
create table sync_discrepancies (...order_id, field, client_value, server_value, reviewed_by, reviewed_at);
create table menu_snapshots (version text primary key, created_at, payload jsonb);  -- for SYN-3 re-price
-- set_order_paid_at(): honour supplied paid_at when new.origin = 'offline'
```
Depends on `2026-08-pos-devices.sql` being applied first (F11).

---

## 7. Decisions

**Closed (owner, 2026-09-24):** desktop app for Windows **and** macOS · printers configurable from the UI · full offline ordering.

**Proposed defaults — owner to confirm at grooming:**

| # | Decision | Default & rationale |
|---|---|---|
| D7-1 | Shell technology | **Electron**: Node gives us USB/TCP printing and SQLite, and it's the same TypeScript as the app. Tauri is lighter but puts the printer/DB code in Rust |
| D7-2 | Offline UPI | **Static counter QR + staff taps "Received"**, exactly like today's manual UPI confirm. No gateway offline |
| D7-3 | Offline coupons / points | **Both off offline** (OFF-4). Earn still accrues on sync |
| D7-4 | Price mismatch on sync | **Record, don't reject**; owner reviews. The customer has paid, so the till is the truth for that sale |
| D7-5 | Offline limit | **No hard cap**; a banner escalates at 2 h, and at 24 h the machine blocks new orders until it syncs once (snapshot too stale to trust prices) |
| D7-6 | Printer config storage | **Local to the machine** with export/import; server mirror parked |
| D7-7 | Code signing | Apple Developer Program (~US$99/yr) for notarization; Windows OV/EV cert (~US$200–400/yr) or ship unsigned first and accept the SmartScreen warning during pilot |
| D7-8 | Offline operator | Last signed-in staffer until PIN ships; PIN switching offline once PIN-1..3 land |

---

## 8. Edge cases

- **Power cut mid-order:** outbox and bill `seq` are written (fsync) *before* the receipt prints. A seq burned by a failed print is a voided number, logged, not reused.
- **Two machines offline, same table:** allowed; both orders sync; the tables screen shows both open, and staff merge or close manually. There's no lock without a server.
- **Item marked unavailable online while a machine is offline:** the machine can still sell it; flagged in discrepancies.
- **Clock skew:** device time is compared with the server time on every probe; skew > 2 min raises a banner, and client timestamps are clamped at ingest (SYN-3).
- **Placement in flight when the net drops:** resolved by idempotency key on reconnect; the offline host shows it as "confirming…", never as a second order.
- **Machine revoked while offline:** it keeps working (it can't know), sync is rejected at reconnect, and the orders are held and exportable (CSV + JSON) for the owner to import. Nothing is lost silently.
- **FY rollover offline on 31 Mar → 1 Apr:** the series resets locally by device date; skew clamp applies.

## 9. Out of scope (parking lot)
Offline orders board / kitchen display across machines (would need LAN peer sync) · offline refunds · server-side printer config mirror · Android/iPad shell · label printers · weighing scales.

## 10. Risks
| # | Risk | Mitigation |
|---|---|---|
| R1 | USB ESC/POS access differs per OS (Windows needs WinUSB/driver swap; macOS kernel driver claims device) | PRN-5 driver fallback always available; USB-raw is opt-in; verify on the real counter printer in week 1 |
| R2 | Offline pricing drift vs server | Same pure code (F6) + snapshot version + discrepancy review |
| R3 | Two POS implementations drift | There is only one: OFF-2 seam, same component |
| R4 | Cash-count false shortages from delayed sync | SYN-5 provisional counts |
| R5 | Native module builds (SQLite, USB) across 2 OS × 2 arch | better-sqlite3 + prebuilt binaries; CI matrix |

## 11. Milestones & rough size
| Milestone | Tickets | Size |
|---|---|---|
| **7A — Till that prints** | SHL-1..4, PRN-1..6 | ~2 weeks. Useful on its own: routing + drawer + real status, online |
| **7B — Till that survives** | OFF-1..6, SYN-1..6, migration | ~3–4 weeks |
| Hardening | Gate 7 on the real counter hardware, both OSes | ~1 week |

## 12. Test plan (release gates)
- Unit: `escpos` golden bytes; `ticketModel` parity with HTML tickets; offline pricing == server pricing over the full menu fixture; bill-series allocation incl. FY rollover and crash-between-alloc-and-print; ingest dedupe/replay; `paid_at` honour + clamp.
- DB: `verify:db` probes for new columns, uniqueness of `offline_bill_no`/`client_order_id`, trigger behaviour.
- Gate 7 on hardware: the five definition-of-done checks, on Windows and macOS, with the cafe's actual printers.
