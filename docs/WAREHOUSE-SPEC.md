# Warehouse: stock requests from the store, the owner's stock sheet, transit, deliveries and matching

Status: **BUILT** (2026-11-01). Branch `claude/relaxed-mayer-svl3gg`. Dark behind
`NEXT_PUBLIC_FLAG_WAREHOUSE` (default off), which needs `NEXT_PUBLIC_FLAG_INVENTORY` on as well.
It builds on the inventory system in [INVENTORY-SPEC.md](INVENTORY-SPEC.md) and changes nothing
there while it is off.

## Why

HIOC keeps its stock in a warehouse and sells from the store. The inventory system tracked only the
store's shelf. A "stock request" meant "someone fetch this from the store room", and nothing moved
until the POS counted it in. That left four gaps:

- **No warehouse sheet.** The owner had no record of what the warehouse held, what was low there, or
  what was about to expire.
- **No transit.** Once stock left the warehouse it was nowhere until it reached the store, and if it
  never arrived nobody could say so.
- **No delivery person.** Only a team member with a login could be assigned, and that person was
  also the one who recorded the pick, so their count was never checked against anyone's.
- **No alert.** The owner found out about a request only by opening the Stock screen.

## The flow

```
 STORE → WAREHOUSE request ("Request from warehouse", route from_warehouse)

 Anyone at the store      Owner / manager                Warehouse side           Delivery person     At the store's POS
 ───────────────────      ───────────────                ──────────────           ───────────────     ──────────────────
 [Request from warehouse] Choose who delivers it  ──►  Record what was SENT  ──►  carries it   ──►  Verify & receive:
  low items pre-filled     (a team member, or a         (owner or manager)                           counted by someone
        │                   driver by name + phone)      → leaves the warehouse                      other than the
        ▼                                                  sheet, earliest                            delivery person
  OWNER ALERTED                                            expiry first                               → store stock up
  (email; WhatsApp once                                  → IN TRANSIT                                 → any line ≠ sent
   a template is approved)                                                                              is flagged
                                                                                                        → OWNER ALERTED
                                                                                                              │
                                                    Owner settles each line that doesn't match  ◄────────────┘
                                                      short: lost on the way  |  never left → back in the warehouse
                                                      over:  warehouse sent extra → off the warehouse  |  accept it

 STORE → WAREHOUSE return ("Send back to warehouse", route to_warehouse)

 Manager: items + who carries it ──► leaves the store's stock at once ──► IN TRANSIT ──► Owner counts it in at the
                                     OWNER ALERTED                                         warehouse → warehouse up
                                                                                           → difference settled the
                                                                                             same way (origin = store)
```

Status of a warehouse transfer: `requested → assigned → picked (sent, in transit) → received`, then
**settled** if it arrived different. It can be `cancelled` only before it has left (WH-D7). A return is
created already `picked`.

## Decisions (defaults chosen by the lead; the owner can change them)

| # | Decision |
|---|----------|
| WH-D1 | **One warehouse, one store**, sharing the store's item list (name, unit, perishable). The warehouse has its **own** batches, ledger and low level. A quantity means the same thing in both places, and the store's sums (auto-hide, FEFO, the Stock screen) never see warehouse stock. |
| WH-D2 | **The route is fixed on the request when it is made.** With the warehouse on, "Request stock" becomes "Request from warehouse" (`from_warehouse`). Requests made while it was off stay `store_room` and behave exactly as before, even after it is switched on, and the other way round. |
| WH-D3 | The **owner or a manager** chooses who delivers. That can be a team member (emailed, as in INV-D20) or **someone without a login**, by name and an optional Indian mobile number (not emailed). |
| WH-D4 | **What left the warehouse is recorded by the warehouse side: the owner or a manager.** The delivery person can't record their own dispatch, because the point of matching is that whoever carries the stock is checked by counts at both ends. That makes three parties: the warehouse counts it out, someone carries it, the store counts it in. |
| WH-D5 | **Dispatch is never refused** for lack of warehouse records. The goods are physically on their way, so it is the records that are behind. What the warehouse batches can't cover is recorded as a warehouse shortfall, and the item shows **"Count needed"** on the stock sheet (as INV-D10 does for sales). A dispatch of all zeros is refused, because that is a cancel. |
| WH-D6 | The store counts a warehouse delivery in **at the POS only** (INV-D4), and **not the delivery person** (a manager may, as for their own pick). It uses the same verify screen as before: blank fields, expiry dates required for perishables. The screen shows the earliest expiry that was sent, as a hint. |
| WH-D7 | **A transfer on the road can't be cancelled**, because stock has already moved. Count it in with 0 for what didn't come, then settle the difference as "never left", which puts it back where it came from. Before it leaves, the usual cancel rules apply. |
| WH-D8 | **Returns** ("Send back to warehouse") are a manager's job and need a named carrier. The stock **leaves the store's records immediately**, earliest expiry first. A return larger than the store's records hold is refused: count the item first. The **owner** counts returns in at the warehouse, with expiry dates for perishables. |
| WH-D9 | **The owner is alerted when the store places a request**, when it sends a return, and when a delivery is counted in different from what was sent. Alerts go out after the reply, so the counter never waits on a mail server, and an alert that fails never undoes the request. |
| WH-D10 | **Email goes to every owner account's login email** by default, plus up to 10 extra addresses (Warehouse → Alerts). It is sent through the same Resend account as the reports (`RESEND_FROM_REPORTS`, falling back to `RESEND_FROM`). |
| WH-D11 | **WhatsApp alerts** go to up to 5 numbers once a Meta-approved **Utility** template is named in `WHATSAPP_TPL_STOCK_ALERT` (§F). Until then each attempt is logged as *skipped* with the reason, and the Alerts tab says so. A business-initiated WhatsApp message must use an approved template. |
| WH-D12 | **Every alert attempt is logged** (`warehouse_alerts`). An address is never sent the same alert twice for the same request. The owner header shows a **Warehouse badge** counting what is waiting on the owner: requests to assign, requests to send, returns to count in, and differences to settle. |
| WH-D13 | **The owner settles each line that differs, once, all in one go.** Short: *lost on the way* (nothing moves; it is written off in transit) or *never left* (back into the origin's stock, with the expiry that was sent). Over: *the origin sent more than it recorded* (taken off the origin's stock; anything it can't cover becomes a shortfall there) or *accept it* (nothing moves). |
| WH-D14 | **The warehouse sheet belongs to the owner.** Purchases (one batch per line; also used for the opening count), counts, write-offs and the warehouse low level are owner-only, on the owner portal. Items themselves are still added and edited on the Stock screen (INV-D15 unit lock and all). |
| WH-D15 | **Transit is never typed in.** It is derived from the transfers: every sent line not yet counted in, plus every arrived-different line not yet settled. The In-transit tab and the stock sheet's "→ Store" and "→ Warehouse" columns read the same functions. |

## Data: `supabase/2026-11-warehouse.sql`

| Table / column | What it holds |
|---|---|
| `stock_requests.route` | `store_room` (default; every earlier request) · `from_warehouse` · `to_warehouse` |
| `stock_requests.deliverer_name`, `deliverer_phone` | a carrier without a login (then `assigned_to` is null). Constraint: never both. |
| `stock_requests.resolved_by`, `resolved_at`, `resolution_note` | the owner's settlement (only on a received transfer that arrived different) |
| `stock_request_lines.dispatch_expiry` | the expiry of the first batch sent (a hint for whoever counts it in) |
| `stock_request_lines.resolution`, `resolved_qty` | how a differing line was settled, and by how much |
| `warehouse_items` | per item: warehouse `par_level` (low at), `shortfall_since_count`, `last_counted_at`. Created on first use. |
| `warehouse_batches` | what is in the warehouse: `qty_received`, `qty_remaining`, `expiry_date`, source (`purchase` / `return` / `count` / `transit_back`), `supplier` |
| `warehouse_movements` | the warehouse ledger: `purchase`, `dispatch`, `return_in`, `waste`, `count`, `transit_back`, `transit_extra`, signed, with any shortfall. One dispatch row per (request, item). |
| `warehouse_alert_settings` | one row: alerts on, email the owner logins, extra emails, WhatsApp numbers |
| `warehouse_alerts` | one row per alert attempt (event, request, channel, address, sent/failed/skipped, reason). A unique index means an address is sent the same alert only once. |
| `inventory_movements.kind` | adds `return_out` (left the store for the warehouse), `transit_back` and `transit_extra` (a return's settlement on the store side) |
| `inventory_batches.source` | adds `transit_back` |

Warehouse stock on hand is **not stored**. It is the sum of the item's warehouse batches, the same
rule as the store's. Every multi-row write is a database function that takes the row locks and
re-checks status: `warehouse_create_request`, `warehouse_dispatch`, `warehouse_create_return`,
`warehouse_receive_return`, `warehouse_resolve`, `warehouse_purchase`, `warehouse_adjust`, plus the
helpers `warehouse_lock_item` and `warehouse_take_fefo`. All new tables are service-role only (RLS on,
no policies, explicit REVOKE), and EXECUTE is revoked from anon and authenticated. The file is safe to
re-run, and `2026-10-inventory.sql` can be re-run after it without undoing anything (checked by
`scripts/inventory/pg-smoke.sh`, step 5d).

## Build

| Ticket | Files |
|---|---|
| WH-1 migration + DB functions | `supabase/2026-11-warehouse.sql` |
| WH-2 rules (pure, tested) | route-aware `canPick` / `canReceive` / `canCancel` and `requestStatusLabel` in `lib/inventory/rules.ts`; `lib/inventory/warehouse.ts` (owner steps, settlements, deliverer, purchases, transit, waiting, CSV) |
| WH-3 reads | `lib/inventory/server.ts` `loadStockRequests` (warehouse columns, with a fallback before the migration), `lib/inventory/warehouseServer.ts` (owner gate, stock sheet, waiting counts) |
| WH-4 request actions, shared | `lib/inventory/requestActions.ts`: used by `PATCH /api/inventory/requests/[id]` (staff) and `PATCH /api/owner/warehouse/requests/[id]` (owner) |
| WH-5 owner alerts | `lib/inventory/ownerAlerts.ts`; sent from `POST /api/inventory/requests`, `POST /api/inventory/returns` and the count-in action |
| WH-6 owner API | `app/api/owner/warehouse/**` (page data, waiting badge, request actions, purchases, low level, adjust, alerts, CSV) |
| WH-7 returns API | `app/api/inventory/returns` |
| WH-8 owner screen | `app/owner/warehouse`, `components/owner/warehouse/*` (Requests · Stock sheet · In transit · Alerts); the Warehouse link and badge in `lib/owner/ownerNav.ts` and `components/owner/OwnerHeader.tsx` |
| WH-9 staff screen | `components/staff/inventory/RequestsTab.tsx` (route-aware), `StockTab.tsx` ("Request from warehouse", "Send back to warehouse"), `DelivererPicker.tsx`, `ReturnModal.tsx`; delivery wording in `lib/inventory/notify.ts` |
| WH-10 flag + probes | `lib/flags.ts` `warehouse`, `.env.local.example`, `scripts/verify-db.mjs` `checkWarehouse`, `scripts/inventory/pg-smoke.sh` step 5d |
| Tests | `tests/warehouseRules.test.ts`, `tests/warehouseRoutes.test.ts`, `tests/warehouseOwnerAlerts.test.ts`, additions to `tests/ownerNav.test.ts` and `tests/inventoryNotify.test.ts`; the real-Postgres walk-through in `pg-smoke.sh` |

## API

| Route | Who | Does |
|---|---|---|
| `POST /api/inventory/requests` | any counter actor | with the warehouse on: a `from_warehouse` request (`warehouse_create_request`), then the owner is alerted |
| `PATCH /api/inventory/requests/[id]` | per the rules | `assign` (`assigneeId`, or `deliverer: {name, phone?}` for a warehouse transfer) · `pick` (for `from_warehouse`, the dispatch: owner or manager → `warehouse_dispatch`, answers `short`) · `receive` (POS, not the deliverer; a difference alerts the owner) · `cancel` (not once it has left) |
| `POST /api/inventory/returns` | manager / owner | "Send back to warehouse": `{lines, note?, assigneeId \| deliverer}` → `warehouse_create_return`, then the owner is alerted |
| `GET /api/owner/warehouse` | owner | stock sheet, transfers (open, waiting to be settled, recent), people who can deliver, what is waiting |
| `GET /api/owner/warehouse/waiting` | owner | the header badge's counts |
| `PATCH /api/owner/warehouse/requests/[id]` | owner | `assign` · `pick` (record what was sent) · `cancel` · `receive_return` · `resolve` (`{lines: [{itemId, resolution}], note?}`) |
| `POST /api/owner/warehouse/purchases` | owner | `{supplier?, note?, lines: [{itemId, qty, expiryDate}]}`, one batch per line |
| `PATCH /api/owner/warehouse/items/[id]` | owner | `{parLevel}`: the warehouse low level |
| `POST /api/owner/warehouse/items/[id]/adjust` | owner | `{kind: 'waste', qty, batchId?, reason}` or `{kind: 'count', qty}` |
| `GET` / `PATCH /api/owner/warehouse/alerts` | owner | alert settings, who an alert reaches now, channel health, recent attempts |
| `GET /api/owner/warehouse/sheet` | owner | the stock sheet as a CSV |

Every owner route uses `getOwnerUser()` only (rule D6-6: never a counter PIN) and returns 404 while
the warehouse is off. A database function's own refusal comes back as a 409 with its message.

---

## Deployment requirement sheet

### A. Technical prerequisites

| # | Requirement | Who | How to check | Done |
|---|---|---|---|---|
| A1 | Inventory is deployed: `2026-10-inventory.sql` (and `-addon-scopes.sql`) applied, with requirement sheet A of [INVENTORY-SPEC.md](INVENTORY-SPEC.md) done | Dev | `npm run verify:db`: INV-1 and INV-12 all ✓ | ☐ |
| A2 | Apply **`supabase/2026-11-warehouse.sql`** in the Supabase SQL editor (safe to re-run) | Dev | `npm run verify:db`: the "WH-1 · warehouse" section is all ✓ | ☐ |
| A3 | Deploy the code with `NEXT_PUBLIC_FLAG_WAREHOUSE` **unset**. Nothing changes, and requests stay store-room ones. | Dev | Owner portal has no Warehouse link | ☐ |
| A4 | Email is already configured for the reports (`RESEND_API_KEY`, `RESEND_FROM_REPORTS` or `RESEND_FROM`) | Dev | Owner → Warehouse → Alerts says "Email: ready" | ☐ |
| A5 | Nothing new to install. The only new variables are the flag and (optionally) `WHATSAPP_TPL_STOCK_ALERT` / `_LANG`. | — | — | ✓ |
| A6 | Before production, run `bash scripts/inventory/pg-smoke.sh` on a dev machine with Postgres 13+ | Dev | `pg-smoke: PASS` | ☐ |

### B. Information the owner must supply

- **B1 — Opening warehouse stock.** On go-live day, a count of what is in the warehouse, **with expiry
  dates** for perishables. It is entered as a purchase (Warehouse → Stock sheet → Record purchase),
  one line per batch.
- **B2 — Warehouse low levels.** For each item, the amount at which the warehouse should buy more
  (Stock sheet → Low level). This is separate from the store's own low level.
- **B3 — Who delivers.** The team members who do the run, and the names and numbers of any drivers or
  helpers without a login.
- **B4 — Who is alerted.** Extra email addresses (a partner, the warehouse keeper) and WhatsApp
  numbers (Warehouse → Alerts).
- **B5 — Decisions to confirm or change** (defaults in brackets): the delivery person may not record
  their own dispatch [yes] (WH-D4); dispatch beyond the records is recorded as "count needed" rather
  than refused [yes] (WH-D5); returns are a manager's [yes] (WH-D8); alert events [request, return,
  arrived different] (WH-D9).

### C. Go-live steps

| # | Step | Who | Done |
|---|---|---|---|
| C1 | **Count the store room into the warehouse, or the warehouse into the store.** Any stock the store's records hold that is physically in the warehouse is in the wrong place. Count the store (Stock → Count) so it holds only what is on its shelves. | Manager | ☐ |
| C2 | Set `NEXT_PUBLIC_FLAG_WAREHOUSE=true` (preview first, then production) and redeploy. A `NEXT_PUBLIC_` flag is baked in at build. | Dev | ☐ |
| C3 | Enter the opening warehouse stock (B1) and the low levels (B2) | Owner | ☐ |
| C4 | Set up alerts (B4). If WhatsApp is wanted, submit the template (§F). | Owner | ☐ |
| C5 | Run the acceptance walk-through (D) | Owner + two staff | ☐ |

Do C3 **before** the first request is sent. With an empty warehouse sheet, every dispatch records a
shortfall and every item reads "Count needed".

### D. Acceptance walk-through

1. Staffer A taps **Request from warehouse** on the Stock screen. Low items are pre-filled; they send it.
   **The owner receives an email** naming the request, each item, and what the warehouse and the store
   hold. The owner header shows a **Warehouse badge**.
2. On the owner portal (Warehouse → Requests), the owner chooses **Someone else**, enters "Ravi
   (driver)" and a phone number, and saves. No email is sent.
3. The owner taps **Record what was sent** and enters one quantity higher than the warehouse sheet
   holds. The request moves to **On the way to the store**. The stock sheet's warehouse column drops,
   the item shows **Count needed**, and the In-transit tab lists every line with Ravi as carrier.
4. Repeat 2 with a team member B as the delivery person. **B is emailed** "yours to deliver". On the
   Stock screen, B can't record the dispatch, and at the POS **B can't verify it**.
5. Staffer C, at the POS, taps **Verify & receive** and enters milk one litre short. Store stock goes
   up by what arrived. The request shows **Arrived different — the owner settles it**, and **the owner
   is emailed**.
6. The owner taps **Settle the difference** and picks **It never left — back in the warehouse**. The
   litre is back on the warehouse sheet with the expiry that was sent, and the request shows
   **Difference settled**.
7. Repeat with a line that arrives over and settle it as **The warehouse sent more than it recorded**.
   The extra comes off the warehouse sheet.
8. Try to **cancel** a request that is on its way. It is refused with the "count it in and settle"
   message.
9. A manager taps **Send back to warehouse**, picks an item, a quantity and a carrier, and sends it.
   Store stock drops at once and **the owner is emailed**. On the owner portal, **Count it in** with one
   less than was sent, then settle it as **never left**. The unit goes back on the store's shelf.
10. **Record purchase** with two lines of the same perishable item (two expiry dates), then **Count**
    an item and **Write off** an expired batch. **Download sheet (CSV)** opens in Excel.
11. Warehouse → Alerts lists each email as *sent*, and each WhatsApp number as *skipped* until
    the template is approved.

### E. Rollback

Unset `NEXT_PUBLIC_FLAG_WAREHOUSE` and redeploy. New requests are store-room requests again. The
Warehouse page, its APIs and the returns API return 404, and no alerts are sent. Requests already on
the warehouse route keep their route: on the Stock screen they can still be dispatched by a manager,
received at the POS and cancelled. Settling a difference and counting a return in need the owner
page, so finish those first or switch the flag back on to do them. The tables stay, so nothing is lost.

### F. WhatsApp alert template (optional)

Meta Business Suite → WhatsApp Manager → Message templates → Create template.

| Field | Value | Why |
|---|---|---|
| Name | `stock_alert_1` | Must match `WHATSAPP_TPL_STOCK_ALERT` exactly |
| Category | **Utility** | An operational message to the business's own owner, not marketing |
| Language | English → `en` | Must match `WHATSAPP_TPL_STOCK_ALERT_LANG` or `WHATSAPP_TPL_LANG` (default `en`) |
| Header | None | |

Body (copy exactly):

```
HIOC stock update — {{1}} #{{2}}, by {{3}}: {{4}}. Please open the owner portal to act on it.
```

| Var | Meaning | Sample |
|---|---|---|
| `{{1}}` | what happened | `New stock request` |
| `{{2}}` | request number | `12` |
| `{{3}}` | who raised, sent or counted it | `Asha` |
| `{{4}}` | the items, shortened | `Full-cream milk 20 L, Paper cup 500 pcs` |

After approval, set `WHATSAPP_TPL_STOCK_ALERT=stock_alert_1` in Vercel (Production and Preview),
redeploy, and add the owner's number on Warehouse → Alerts. `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID`
are already set for the bill. To check: `select channel, status, detail, count(*) from
warehouse_alerts group by 1,2,3;`

## Known limits

- **One warehouse, one store.** A second store or warehouse would need a location on each request
  and batch.
- **No supplier records or costs.** A purchase records the supplier's name as text, with no prices,
  purchase orders or bills.
- **Expiry through transit is a hint.** The warehouse records the earliest expiry it sent. The store
  still types the expiry it sees, and a "never left" settlement puts stock back with that earliest
  expiry, not each batch's own.
- **An outside delivery person gets no message.** Their name and number are on the transfer for
  whoever phones them.
- **Settling is all-or-nothing per transfer.** Every differing line is answered in one go, and a
  settlement can't be edited afterwards; correct it with a count.
- **Store-side auto-hide counts what the store holds**, so stock in transit does not keep a menu item
  on the menu.
