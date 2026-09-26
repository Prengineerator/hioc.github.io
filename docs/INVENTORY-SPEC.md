# Inventory: stock requests, verified receiving at the POS, expiry dates and recipes

Status: **BUILT** (2026-09-26; add-on recipes, auto-hide and assignment emails added the same day). Branch `claude/cool-bohr-13yrnx`. Dark behind
`NEXT_PUBLIC_FLAG_INVENTORY` (default off) until the requirement sheet below is done.

## Why

The app had no stock. "Available / unavailable" on a menu item was a manual
toggle (README-MVP "No inventory"). Nobody could see what was running low. A
request for stock was a shout across the counter. Nothing recorded who fetched
what, and nothing checked that the right quantity arrived. Expiry dates lived on
the packets and nowhere else.

## The flow

```
 Anyone              Manager / owner          Assignee              At the POS (not the picker)
 ───────             ───────────────          ────────              ───────────────────────────
 [Request stock] ──► Assign to a staffer ──► Mark picked      ──►  Verify & receive:
  low items             (can re-assign)       (what they            count each line,
  pre-filled                                   actually picked)     enter expiry dates
                                                                     → stock goes up
                                                                     → any line ≠ picked
                                                                       is flagged
 Order completes ──► recipe × quantity (+ add-on recipes) comes off stock, earliest expiry first
                    ──► a menu item no size of which can now be made is hidden from the menu;
                        it comes back by itself when stock is received
```

The picker is emailed when a request is assigned to them.

Status of a request: `requested → assigned → picked → received`. It can be
`cancelled` before it is received.

## Decisions (defaults chosen by the lead; the owner can change them)

| # | Decision |
|---|----------|
| INV-D1 | **Anyone on the team** can raise a stock request. Low items (at or below their "low at" level) that are not already on an open request are pre-filled at their usual request quantity. |
| INV-D2 | Only a **manager or the owner** assigns a request, and can re-assign it until it is picked. |
| INV-D3 | Only the **assignee** records the pick (a manager may stand in). Picked quantities can be 0 for "not available". A pick of all zeros is refused, because that is a cancel. |
| INV-D4 | Receiving happens **only at the POS** (an enrolled counter device), and only by **someone other than the picker**. A manager or the owner may verify their own pick, because a small team can't always have two people on. |
| INV-D5 | The verifier **types the count**. The fields start blank, so they count the stock rather than confirm a pre-filled number. A received quantity different from the picked one is stored, and the request is marked **"Arrived different from picked"**. |
| INV-D6 | **Stock only increases at verification**, never at request or pick. |
| INV-D7 | A perishable item (**"expiry date required"**, on by default) cannot be received without an expiry date for the batch. A date already in the past is **refused at the door**. Batches expiring within **3 days** show as "expiring soon". The day after the expiry date they show as expired. |
| INV-D8 | Stock is used **earliest expiry first** (FEFO). Batches with no expiry date are used last. |
| INV-D9 | Stock comes off when an order **completes**. That is the one path to "completed", and a rejected or cancelled order never used anything. A refund after completion does **not** return stock, because the food was made. |
| INV-D10 | A sale is **never refused** for lack of stock. What the batches cannot cover is recorded as a shortfall, and the item shows **"Count needed"** until a manager counts it. Stock never goes negative. |
| INV-D11 | A recipe is what **one serving** uses, in each ingredient's own unit. A size (variant) can have **its own recipe, which replaces** the base one for that size. It is not added on top. Sizes are matched by **label** ("Large"), because saving a menu item re-creates its size rows; an id-keyed recipe would vanish on the next price edit. Renaming a size falls back to the base recipe until its recipe is set again. |
| INV-D12 | Recipes follow the menu's rule: the `menu_edit` permission, **on the POS only**. They are read-only on the staff website. |
| INV-D13 | A manager or the owner can **count** an item (set on-hand to what is on the shelf; this clears "count needed") and **write off** waste (an expired batch or oldest stock first, with a reason). |
| INV-D14 | A manager or the owner can **receive a delivery with no request** at the POS, with the same quantity and expiry-date rules. |
| INV-D15 | An item's **unit is locked** once it has stock history or appears in a recipe. Every stored quantity is in that unit. To change the unit, retire the item and add a new one. |
| INV-D16 | **Auto-hide:** a menu item is taken off the menu when **no size** of it can be made (some ingredient has less on hand than one serving needs). One sold-out size alone does not hide the item. Only sizes switched **on** count: a size switched off on POS → Menu → On / off (everywhere, or in the item's category) is not on sale, so it cannot keep the item on the menu (if every size is switched off, all of them count, as on the menu). Items with no recipe are never touched. |
| INV-D17 | An auto-hidden item **comes back by itself** when stock makes it possible again. An item a person switched off is **never** switched back on by stock. A person toggling availability on the Menu page takes the item out of stock's hands (clears the auto-hide mark). |
| INV-D18 | Auto-hide is **on by default** and a manager can switch it off on the Stock tab. Switching it off puts back everything it hid, at once. |
| INV-D19 | **Add-ons** (extra shot, oat milk) have their own recipes: what one add-on uses per serving it is added to. An add-on on a line of 2 is used twice. Add-ons are not auto-hidden. |
| INV-D20 | When a request is assigned, the **picker is emailed** at their personal email (staff accounts), with the items and a link to the Stock screen. No email when a manager assigns it to themselves. The manager sees whether it went. WhatsApp is not used, because a business-initiated WhatsApp message needs a Meta-approved template. |

## Data: `supabase/2026-10-inventory.sql`

| Table | What it holds |
|---|---|
| `inventory_items` | name (unique, case-insensitive), unit (`g kg ml l pcs pack`), category, `par_level` (low at), `reorder_qty`, `tracks_expiry`, `is_active`, `shortfall_since_count`, `last_counted_at` |
| `stock_requests` | `request_number`, status, note, requested/assigned/picked/received by and when, `received_device_id`, `has_discrepancy`, cancel reason |
| `stock_request_lines` | per item: `qty_requested`, `qty_picked`, `qty_received`, `expiry_date` |
| `inventory_batches` | what is on the shelf: `qty_received`, `qty_remaining`, `expiry_date`, source (receive / count) |
| `inventory_movements` | the ledger: receive / sale / waste / count, signed `qty_delta`, sale `shortfall`, who, why, which order/request/batch. One sale row per (order, item), enforced by a unique index. |
| `recipe_lines` | (menu item, size label or '' for the base, stock item, qty per serving) |
| `addon_recipe_lines` | (add-on option, stock item, qty per serving) |
| `menu_items.stock_out_auto` | the item is hidden because of stock (not by a person) |
| `store_settings.stock_auto_hide` | the auto-hide switch (default on) |

**Stock on hand is not stored.** It is the sum of the item's batches, so it can
never disagree with the expiry warnings. Every write that touches more than one
row goes through a database function (`inventory_create_request`,
`inventory_pick`, `inventory_receive`, `inventory_apply_sale`,
`inventory_adjust`, `inventory_set_recipe`, `inventory_set_addon_recipe`). Each
function that changes stock or recipes ends by calling
`inventory_refresh_availability`, which hides and restores menu items. Each function takes the row lock
and re-checks status, so two phones racing the same request can't both win. All
tables are service-role only: RLS is on, there are no policies, and there is an
explicit REVOKE. EXECUTE on the functions is revoked from anon and authenticated.

## Build

| Ticket | Files |
|---|---|
| INV-1 migration + DB functions | `supabase/2026-10-inventory.sql` |
| INV-2 rules (pure, tested) | `lib/inventory/rules.ts`, `lib/inventory/itemFields.ts` |
| INV-3 stock items + adjust APIs | `app/api/inventory/items/**` |
| INV-4 requests: create / assign / pick / receive / cancel; direct delivery | `app/api/inventory/requests/**`, `app/api/inventory/receipts` |
| INV-5 recipes API | `app/api/inventory/recipes/**` |
| INV-6 completion hook | `lib/inventory/server.ts` `consumeStockForOrder`, called from `app/api/orders/[id]/status` |
| INV-7 Stock screen (Stock / Requests / Recipes tabs) | `app/staff/inventory`, `components/staff/inventory/*`; "Stock" tab in `lib/staff/staffNav.ts` (on the POS bar, and under More on the staff website) |
| INV-8 flag + deploy probe | `lib/flags.ts` `inventory`, `.env.local.example`, `scripts/verify-db.mjs` `checkInventory` |
| INV-9 assignment email | `lib/inventory/notify.ts`, called from the assign action |
| INV-10 auto-hide | `inventory_refresh_availability` (migration), `app/api/inventory/settings`, the Stock-tab panel, `app/api/menu/[id]` (manual toggle clears the mark), "Out of stock" label in `components/staff/MenuItemTable.tsx` |
| INV-11 add-on recipes | `addon_recipe_lines`, `app/api/inventory/addon-recipes/[optionId]`, the Recipes tab's Add-ons list |
| Tests | `tests/inventoryRules.test.ts`, `tests/inventoryRoutes.test.ts`, `tests/inventoryConsume.test.ts`, `tests/inventoryNotify.test.ts`, `tests/menuStockOutAuto.test.ts`, `tests/staffNav.test.ts`, `tests/orderStatusRoute.test.ts` |

## API

| Route | Who | Does |
|---|---|---|
| `GET /api/inventory/items` | any counter actor | items with on-hand, batches, expiry state, low / count-needed, open request numbers |
| `POST /api/inventory/items` | manager / owner | add an item |
| `PATCH /api/inventory/items/[id]` | manager / owner | edit; the unit is locked once the item has history |
| `POST /api/inventory/items/[id]/adjust` | manager / owner | `{kind:'waste', qty, batchId?, reason}` or `{kind:'count', qty}` |
| `GET /api/inventory/requests` | any counter actor | open requests plus the last 30 closed, plus assignees (for managers) |
| `POST /api/inventory/requests` | any counter actor | "Request stock": `{lines:[{itemId, qty}], note?}` |
| `PATCH /api/inventory/requests/[id]` | per INV-D2–D5 | `{action:'assign'\|'pick'\|'receive'\|'cancel', …}` |
| `POST /api/inventory/receipts` | manager / owner, on the POS | delivery with no request |
| `GET /api/inventory/recipes` | any counter actor | menu + sizes, stock items, recipe lines, `canEdit` |
| `PUT /api/inventory/recipes/[menuItemId]` | `menu_edit`, on the POS | replace one menu item's recipe: `{lines:[{sizeLabel, itemId, qty}]}` |
| `PUT /api/inventory/addon-recipes/[optionId]` | `menu_edit`, on the POS | replace one add-on's recipe |
| `PATCH /api/inventory/settings` | manager / owner | `{autoHide: boolean}` |

Every route returns 404 while the flag is off. Errors raised by the database
functions come back as 409s with a readable message.

---

## Deployment requirement sheet

Everything in this section has to be true before the flag is switched on. Items
marked **Owner** are information or decisions only the cafe can supply. The
code cannot guess them.

### A. Technical prerequisites

| # | Requirement | Who | How to check | Done |
|---|---|---|---|---|
| A1 | Supabase is on Postgres **13 or later** (the functions use `trim_scale`; Supabase is on 15) | Dev | `select version();` | ☐ |
| A2 | Earlier migrations applied: `schema.sql` (menu_items, menu_item_variants, orders, order_items), `2026-08-pos-devices.sql` (POS surface), `2026-09-staff-accounts.sql` | Dev | `npm run verify:db` passes its existing checks | ☐ |
| A3 | Apply **`supabase/2026-10-inventory.sql`** in the Supabase SQL editor. It is safe to re-run. | Dev | `npm run verify:db`: the "INV-1 · inventory" section is all ✓ | ☐ |
| A4 | At least **one enrolled POS device** (`docs/POS-DEVICE-SETUP.md`). Receiving is refused anywhere else. | Owner + Dev | The counter shows the POS nav (Live orders · Orders · New order · Menu) | ☐ |
| A5 | `role_permissions.menu_edit` is set to who should edit recipes (default: staff and up) | Owner | Owner → Settings → Permissions | ☐ |
| A6 | Team roles are right in the owner portal: who is **manager** (assigns, counts, writes off, direct deliveries) and who is **staff** | Owner | Owner → Staff | ☐ |
| A7 | Deploy the code with the flag **off** (`NEXT_PUBLIC_FLAG_INVENTORY` unset). Nothing changes for anyone. | Dev | `/staff/inventory` says "Stock is not enabled" | ☐ |
| A8 | Nothing new to install, and no new secrets. No new dependencies or environment variables other than the flag. | — | — | ✓ |
| A9 | For assignment emails: email sending already configured (`RESEND_API_KEY`, `RESEND_FROM` / `RESEND_FROM_STAFF`, as for payslips), and each staffer's **personal email** filled in on Owner → Staff. Without it the assignment still works; the manager is told the email didn't go. | Owner + Dev | Owner → Staff shows a personal email per person | ☐ |

### B. Information the owner must supply

**B1 — Stock item list.** One row per ingredient or packaging item you want to track:

| Name | Unit (g / kg / ml / l / pcs / pack) | Category | Low at | Usually request | Perishable (expiry date required)? |
|---|---|---|---|---|---|
| *e.g.* Full-cream milk | l | Dairy | 5 | 10 | Yes |
| *e.g.* Espresso beans | g | Coffee | 500 | 1000 | No |
| *e.g.* Paper cup 8 oz | pcs | Packaging | 100 | 500 | No |

Pick the unit you want recipes written in. A latte uses "0.2 L of milk" or
"200 ml". Choose one and keep it, because the unit locks once the item is used
(INV-D15).

**B2 — Recipes.** For every menu item that should use stock, list what **one
serving** uses. Where sizes differ (e.g. Regular / Large), list each size's full
recipe:

| Menu item | Size (blank = every size) | Ingredient | Qty per serving |
|---|---|---|---|
| *e.g.* Latte | | Full-cream milk | 0.2 |
| *e.g.* Latte | | Espresso beans | 18 |
| *e.g.* Latte | Large | Full-cream milk | 0.3 |
| *e.g.* Latte | Large | Espresso beans | 27 |

A menu item with no recipe simply uses no stock. You can start with the
highest-volume items and add the rest later. The Recipes tab shows how many
items still have no recipe.

Size names must match the menu exactly ("Large", not "large"). Add-ons get
their own short list, e.g. *Extra shot → Espresso beans 9 g*; *Oat milk →
Oat milk 0.2 L*.

**B3 — Opening stock.** On go-live day, a count of what is on the shelf, **with
expiry dates** for perishables. It is entered as a delivery (Stock → Receive
delivery, on the POS), one line per batch.

**B4 — Decisions to confirm or change** (defaults in brackets):
- Who may raise a request [everyone] (INV-D1)
- Whether a manager may verify their own pick [yes] (INV-D4)
- The expiry warning window [3 days] (INV-D7; the constant `EXPIRY_WARN_DAYS` in `lib/inventory/rules.ts`)
- When stock comes off [on order completion] (INV-D9)
- Hide a menu item automatically when an ingredient runs out [on] (INV-D16–D18)

### C. Go-live steps

| # | Step | Who | Done |
|---|---|---|---|
| C1 | Switch the flag on **in a preview deployment** first: `NEXT_PUBLIC_FLAG_INVENTORY=true` | Dev | ☐ |
| C2 | Add the stock items from B1 (Stock → Add item, as a manager) | Manager | ☐ |
| C3 | Enter the recipes from B2 (Stock → Recipes, **on the POS**) | Staff with `menu_edit` | ☐ |
| C4 | Receive the opening stock from B3 (Stock → Receive delivery, on the POS) | Manager | ☐ |
| C5 | Run the acceptance walk-through (D) end to end | Owner + one staffer | ☐ |
| C6 | Switch the flag on in **production** and redeploy (a `NEXT_PUBLIC_` flag is baked in at build) | Dev | ☐ |
| C7 | For the first week, look at "Needs attention" daily. A "Count needed" usually means a recipe quantity is off. | Manager | ☐ |

Do C2–C4 **before** C6. With the flag on and no opening stock, every completed
order records a shortfall and every item reads "Count needed".

### D. Acceptance walk-through

1. Staffer A taps **Request stock**. The low items are pre-filled. They send it.
2. The manager assigns it to staffer B. B sees **"Yours to pick"** and records the picked quantities.
3. On the **staff website**, the request shows "Stock is verified and received at the POS only". On the **POS**, B is told someone else has to verify.
4. Staffer C, on the POS, taps **Verify & receive**, enters one quantity lower than picked and an expiry date for milk. Leaving the milk expiry blank is refused. A past date is refused.
5. The request shows **Received** with "Arrived different from picked". Stock went up by the **received** quantities, and the milk batch shows its expiry date.
6. Ring up and complete an order containing an item with a recipe. On-hand drops by recipe × quantity, taken from the earliest-expiring batch.
7. Complete an order that needs more than is left. The item shows **Count needed**. A manager's **Count** clears it.
8. **Write off** an expired batch. It disappears from on-hand, and the movement records who did it and why.
9. The picker from step 2 received an email naming the request and its items.
10. Sell a recipe item until an ingredient runs short of one serving. The item disappears from the customer menu and shows "Out of stock" on the staff Menu page. Receive that ingredient: it comes back by itself.
11. Order a latte with an extra shot and complete it: the add-on's beans come off too.

### E. Rollback

Unset `NEXT_PUBLIC_FLAG_INVENTORY` and redeploy. The Stock tab disappears, the
APIs return 404, and completed orders stop touching stock. The tables stay, so
nothing is lost. Nothing else in the app reads them.

## Known limits

- **Auto-hide is per item, not per size.** If only the Large can't be made, the
  item stays on the menu and a Large order records a shortfall. Add-ons are
  never auto-hidden.
- **Auto-hide counts expired stock as on hand** until it is written off. Write
  off expired batches promptly.
- **Amending a completed order** does not re-take stock (the sale is recorded
  once per order and item).
- **A count surplus has no expiry date.** It becomes an undated batch. Receive a
  real delivery to record expiry dates.
- **No supplier or purchase-order records** and no cost/price tracking. Requests
  are internal (store-room → counter or an errand to buy). Costing would come
  next.
- **Assignment alerts are email only** (no WhatsApp: that needs a Meta-approved
  template). The Requests tab also shows a badge of requests waiting on you.
