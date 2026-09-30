# HIOC Ritual: prepaid coffee plans, sold and redeemed on the website and at the POS

**Version:** 1.1 · **Date:** 2026-09-30 · **Status:** BUILT behind the flag (as-built notes in §12)
**Flag:** `NEXT_PUBLIC_FLAG_COFFEE_PASS` (default **off**) · **Migration:** `supabase/2026-10-coffee-pass.sql`
**Ticket prefix:** `CP-` · **Decision prefix:** `CP-D`

> **Naming (owner, 2026-09-30).**
> - The customer-facing brand is **HIOC Ritual**. The plans are **Weekly Ritual** and **Monthly Ritual**, and they are counted in **cups** ("your Ritual · 5 cups left").
> - Loyalty points are now **Beanies** (1 Beanie = ₹1 off).
> - Only display copy uses these names. They are held in `lib/passes/brand.ts` and `lib/loyalty/brand.ts`, so a later rename is one line.
> - Technical names stay neutral and do not change: the `coffee_pass_*` tables, `order_kind = 'coffee_pass'`, `/api/passes/*`, the flag `NEXT_PUBLIC_FLAG_COFFEE_PASS`, and loyalty's `points` fields and tables.
> - "Coffee Pass" below means the HIOC Ritual feature.

---

## 1. What the cafe asked for

Two prepaid plans for regulars:

| Plan | Customer pays for | Customer gets | Valid for |
|---|---|---|---|
| **Weekly Ritual** | 5 coffees | **7 coffees** | 7 days |
| **Monthly Ritual** | 6 coffees | **7 coffees** | 30 days |

Both must be **buyable on the website and at the POS**, and **usable on the website and at the POS**.
The weekly plan gives the bigger discount (29%) for a tighter window. The 30-day plan gives a smaller
one (14%) with more room to use it.

## 2. Why it is built the way it is

Three facts about this codebase decide the shape:

1. **A customer is an account plus a verified phone.** There is no customers table. The POS finds an
   account from the phone a staffer types (`findVerifiedCustomerByPhone`), and opens one when there is
   none (`createCounterCustomer`, POS-ACC). The website knows the account from the session. A pass
   belongs to **an account** (`auth.users.id`), so it works in both places without a new identity.
2. **All money moves through orders.** Razorpay needs an order (`payments.order_id NOT NULL`), the
   cash day counts `order_payments`, refunds and receipts are per order. So **selling a pass is an
   order** (`order_kind = 'coffee_pass'`) with one line: the pass. Every existing money path
   (split tender, cash-day, refunds, receipts, bill notification, reports) works on it unchanged.
3. **The ledger is the source of truth; balances are derived.** This is the loyalty and inventory
   rule. Drinks left on a pass are never stored. They are computed from the pass, its redemptions and
   its adjustments, so they can never drift from the history.

## 3. Decisions

Defaults chosen by the lead. Every number is an owner setting, not a code constant.

| # | Decision |
|---|---|
| CP-D1 | **A plan is data.** `coffee_pass_plans` holds name, drinks given, drinks paid for (display only), validity days, **drink value**, price, optional daily cap, GST-exempt and active flags. The two plans above are seeded **inactive** with placeholder prices (§9 B). The owner confirms them before anything is sold. |
| CP-D2 | **Drink value.** Each pass drink covers **up to the plan's drink value** (seeded ₹150) of **one unit** of an eligible drink. Size and add-ons count towards it. Anything above is paid as a top-up. The pass price is `drinks_paid × drink_value` by default (₹750 weekly, ₹900 for 30 days), and the owner may override it. |
| CP-D3 | **Eligibility is a menu switch.** `menu_items.pass_eligible` (default false), shared by all plans. The owner ticks drinks on Owner → Passes, with a "select the whole category" shortcut for Coffee / Creme Coffee / Iced Coffee / Cold Brews. |
| CP-D4 | **A pass belongs to one account.** Sold at the POS, it goes to the account of the phone given. The account is opened if needed, exactly as a counter order does. Bought online, it goes to the signed-in account. The account is **never** taken from a request body. |
| CP-D5 | **Validity runs in IST calendar days.** A pass bought on day D is valid until the end of day D + validity − 1 (IST). A Weekly bought Monday 10:00 is good through Sunday 23:59. `expires_at` is stored as the instant the next IST day starts. |
| CP-D6 | **The pass is issued when its order is paid, and only then.** A database trigger issues it when a `coffee_pass` order's `payment_status` becomes `paid`, whichever path got there: counter settle, Razorpay verify, webhook, reconcile poll, or cron. The same trigger marks the sale order `completed`, so it never sits on the kitchen board. It is idempotent: `unique(order_id)`. |
| CP-D7 | **Buying a pass is a separate order.** v1 does not mix a pass and menu items in one cart. The POS sells it from the Passes screen. The customer buys it on `/ritual`. The first drink can be redeemed on the very next order, seconds later. |
| CP-D8 | **Online purchase needs Razorpay.** There is no "reserve a pass, pay at the counter". If the gateway is not configured, `/ritual` says "Buy at the counter" instead of showing Buy. |
| CP-D9 | **Redemption happens on a normal order.** The request says how many pass drinks to use (`pass_drinks`). The **server** chooses which lines and which passes. It covers the **most expensive eligible units first** and uses the **soonest-expiring pass first**. It stops at the drinks left, the daily cap and the eligible units in the cart. |
| CP-D10 | **Default use.** On the website the checkout pre-selects the maximum usable, and the customer can lower it. At the POS it starts at **0**, and the staffer asks the customer and taps "Use pass". The staffer is not the pass holder. |
| CP-D11 | **Money and GST.** GST on a pass is charged **when it is sold**, following the store's GST settings like any item (unless the plan is marked GST-exempt). On a redeemed drink, the **covered amount is taken out of the taxable base**, so tax is never charged twice. A top-up is taxed normally. See §6 worked examples. **The owner must confirm this treatment with their CA (§9 B4).** |
| CP-D12 | **The pass is applied first, then coupon, then points.** A coupon is computed on `subtotal − pass cover`. Points apply to what is left after that. Nothing can take the bill below zero. |
| CP-D13 | **No loyalty points on a pass purchase.** A pass is already the discount. A redeemed drink earns points only on what the customer actually paid. This follows naturally, because points are earned on `total_inr`. |
| CP-D14 | **Credits return automatically** when an order that used them is rejected, cancelled, expired unpaid, or **fully** refunded, or when a redeemed line is voided. A database trigger does this, so no route can forget. A partial refund returns no drinks. A manager can return one by hand (CP-D16). |
| CP-D15 | **Refunding a pass.** A pass can be refunded (existing `refund` permission) **only if no drink has been used**. **Any refund on a pass sale cancels the pass**, so a pass sold across two tenders (cash + UPI) can be refunded one tender at a time. The first refund voids the pass *before* the money moves, and later refunds on the same sale are allowed because the pass is already void. If the first refund's money step fails, the void is undone. A used pass cannot be refunded in the app. |
| CP-D16 | **Manager adjustments.** A manager or the owner can **extend** a pass (1–60 days) or **give back drinks** (for example after a spilt coffee on a fully covered order). A reason is required and every change is audited in `coffee_pass_adjustments`. No one can take drinks away except by redemption. |
| CP-D17 | **Daily cap.** This is optional per plan (`max_per_day`, IST day) and seeded **off** for both plans. The owner may set 1 on the Weekly pass to make it "a coffee a day" (§9 B3). |
| CP-D18 | **Sharing.** Pass drinks may be used for anyone in the holder's order, for example two coffees for the holder and a friend. At the counter the holder's phone must be on the order. |
| CP-D19 | **Expired drinks are gone.** There is no refund and no automatic roll-over. The owner report shows them as "expired unused" (breakage). |
| CP-D20 | **Where a pass may be sold at the counter.** The same rule as taking an order: `canTakeOrders(surface, staff_web_ordering)`. Selling needs the new `pass_sell` permission (default staff). Extending and giving back drinks need `pass_manage` (default manager). Plans and eligibility are owner-only. |
| CP-D21 | **Revenue is counted when the pass is sold.** That is when the drawer or bank receives the money, and it keeps the cash day balancing. Redeemed drinks show at their paid amount. Their covered value is reported separately as "drinks served on passes". The owner page also shows **outstanding liability**: drinks left × what the customer paid per drink (price ÷ drinks). |

**Not in v1** (backlog, §11): automatic weekly renewal (Razorpay Subscriptions / UPI Autopay),
WhatsApp "pass bought / expiring" messages (these need Meta-approved templates, and that channel is
failing today), pass codes and gifting, a pass and menu items in one cart, and redeeming on items
added later to a running tab.

## 4. Journeys

```
WEBSITE — BUY                               POS — SELL
/ritual ─► Buy (signed in) ─► Razorpay        Passes screen ─► phone ─► plan ─► Sell
   │         POST /api/passes/checkout          │     POST /api/passes/sell (unpaid order)
   │         (coffee_pass order, placed)        ▼
   ▼                                          Payment panel (cash / UPI / card / split)
 verify / webhook / poll ─► payment_status='paid' ◄── PATCH /api/orders/[id]/payment
                               │
                     DB trigger: issue pass, order → completed
                               ▼
               Pass active: 7 drinks, valid till <date>

WEBSITE — USE                                POS — USE
Checkout "HIOC Ritual: use 1 of 5"           Customer phone attached → "Coffee pass · 5 left"
  (pre-filled to max usable)                 staffer taps "Use pass" (starts at 0)
        └──── POST /api/orders/quote {items, pass_drinks} ─► preview ────┘
        └──── POST /api/orders {…, pass_drinks} ─► coffee_pass_redeem() (row-locked) ─► order
```

## 5. Data: `supabase/2026-10-coffee-pass.sql`

The file is safe to re-run. It changes nothing for anyone until the flag is on and a plan is active.

### 5.1 New tables

All of them have RLS enabled, **no policies**, and `revoke all … from anon, authenticated`. They are
service-role only, like inventory. Customers read their own passes through API routes scoped by
session.

| Table | Columns (key ones) |
|---|---|
| `coffee_pass_plans` | `id`, `name` (unique ci), `description`, `drinks_total` 1–50, `drinks_paid` 1–`drinks_total` (display), `validity_days` 1–365, `drink_value_inr` > 0, `price_inr` > 0, `max_per_day` null or ≥ 1, `gst_exempt` bool, `is_active` bool (default false), `sort_order`, `created_at`, `updated_at` (trigger) |
| `coffee_passes` | `id`, `user_id` → auth.users (not null), `plan_id` → plans, `order_id` → orders **unique**, on delete cascade. **Snapshots:** `plan_name`, `drinks_total`, `drink_value_inr`, `price_inr`, `max_per_day`. Plus `starts_at`, `expires_at`, `status` (`active`, `refunded`, `void`), `issued_by` (the order's `created_by`, null online), `created_at`. Index `(user_id, expires_at)`. |
| `coffee_pass_redemptions` | `id`, `pass_id` → passes, `order_id` → orders, `order_item_id` → order_items (all on delete cascade), `drinks` > 0, `covered_inr` ≥ 0 (for these drinks), `business_date` (IST date), `created_at`, `reversed_at`, `reversed_reason`. `unique(order_item_id, pass_id)`. Index `(pass_id)`, `(order_id)`. |
| `coffee_pass_adjustments` | `id`, `pass_id`, `kind` (`extend`, `credit`, `void`, `unvoid`), `days`, `drinks`, `reason` (non-empty for extend and credit), `created_by`, `created_at` |

### 5.2 Columns added to existing tables

| Column | Meaning |
|---|---|
| `orders.order_kind text not null default 'menu' check in ('menu','coffee_pass')` | A pass sale vs. everything else. `POST /api/orders` never sets it, so every existing path stays `menu`. |
| `orders.pass_discount_inr int not null default 0 check ≥ 0` | Total covered by pass drinks on this order. **Separate from `discount_inr`**, which stays coupon + points only, so reports never count prepaid drinks as a marketing discount. |
| `order_items.pass_drinks int not null default 0` | Units of this line covered by a pass |
| `order_items.pass_covered_inr int not null default 0` | ₹ of this line covered by a pass |
| `order_items.coffee_pass_plan_id uuid null → coffee_pass_plans` | Set on the single line of a pass-sale order (`menu_item_id` is null there) |
| `menu_items.pass_eligible bool not null default false` | CP-D3 |

The bill identity every renderer relies on becomes:
`total_inr = subtotal_inr + tax_inr + packaging_inr − discount_inr − pass_discount_inr`.

### 5.3 Derived balance: view `v_coffee_pass_balances` (`security_invoker = true`)

For each pass it gives `drinks_used` (non-reversed redemptions), `drinks_credited` (credit
adjustments), `drinks_remaining = drinks_total + credited − used` (never below 0), `used_today` (IST),
and `state`:

- `refunded` or `void` when the pass has that status;
- otherwise `expired` when `now() ≥ expires_at`;
- otherwise `used_up` when remaining is 0;
- otherwise `active`.

### 5.4 Functions

Each is `security definer`, `set search_path = ''`, with EXECUTE revoked from public, anon and
authenticated and granted to `service_role`.

| Function | Does |
|---|---|
| `coffee_pass_redeem(p_user_id uuid, p_order_id uuid, p_allocations jsonb) returns text` | Allocations are `[{pass_id, order_item_id, drinks, covered_inr}]`. It locks the named passes `FOR UPDATE` **in id order** (no deadlocks) and re-checks each one: owned by `p_user_id`, `status='active'`, `now() < expires_at`, drinks remaining, daily cap. Then it inserts the redemptions. It returns `'ok'` or a reason code (`'not_owner'`, `'inactive'`, `'expired'`, `'insufficient'`, `'daily_limit'`, `'bad_input'`). If redemptions already exist for `p_order_id` it returns `'ok'` (idempotent). |
| `coffee_pass_adjust(p_pass_id, p_kind, p_days, p_drinks, p_reason, p_actor) returns text` | `extend` moves `expires_at` by whole days (1–60). `credit` adds drinks (1..`drinks_total`). Both are row-locked and write an adjustment row. |
| `coffee_pass_void_for_refund(p_order_id uuid) returns text` | Locks the pass of that sale order. It returns `'used'` if any non-reversed redemption exists. Otherwise it sets `status='refunded'`, writes a `void` adjustment and returns `'ok'` (or `'not_found'`, `'already'`). |
| `coffee_pass_restore_after_failed_refund(p_order_id uuid) returns text` | Compensation: back to `active` with an `unvoid` adjustment, only if the sale order's `payment_status` is still `paid`. |

### 5.5 Triggers (the part that cannot be forgotten)

| Trigger | On | Does |
|---|---|---|
| `trg_coffee_pass_complete_on_paid` | BEFORE INSERT OR UPDATE OF payment_status ON orders | A `coffee_pass` order becoming `paid` with a non-terminal status: `new.status := 'completed'`, bump `version`. |
| `trg_coffee_pass_issue_on_paid` | AFTER INSERT OR UPDATE OF payment_status ON orders | A `coffee_pass` order becoming `paid`: insert the pass (snapshots from the plan referenced by the order's line; `user_id = coalesce(customer_user_id, user_id)`; `starts_at = now()`; `expires_at` per CP-D5) `on conflict (order_id) do nothing`. Write an `order_status_events` row (`actor_role 'system'`, reason `'Coffee pass issued'`) if the status changed. If there is no account, it does `raise warning` and issues nothing. The routes make that impossible (§7). |
| `trg_coffee_pass_return_on_order` | AFTER UPDATE OF status, payment_status ON orders | A `menu` order moving to `rejected`/`cancelled`, or `payment_status` moving to `refunded`: set `reversed_at` on its redemptions (reason says why). A `coffee_pass` order moving to `payment_status='refunded'`: pass `status='refunded'` if still active. This is the safety net for any refund path. |
| `trg_coffee_pass_return_on_void` | AFTER UPDATE OF voided ON order_items | A line becoming voided: reverse its redemptions. |

Deleting an order (test-order cleanup, create-path rollback) cascades to its redemptions, and the
derived balance restores itself.

### 5.6 Permissions and seeds

- `role_permissions`: `('pass_sell','staff')`, `('pass_manage','manager')`, `on conflict do nothing`.
- Plans seeded **inactive**:
  - Weekly Ritual: 7 drinks, 5 paid, 7 days, ₹150 drink value, ₹750, no daily cap.
  - Monthly Ritual: 7 drinks, 6 paid, 30 days, ₹150 drink value, ₹900, no daily cap.
- No `pass_eligible` rows are pre-set. The owner chooses them (§9 B2).

## 6. Money: worked examples

Store defaults: GST 5% **exclusive**, no packaging, drink value ₹150.

**Selling a Weekly pass.** Subtotal ₹750, GST ₹38 (750 × 5% = 37.5, rounded), total **₹788**. With
GST-inclusive pricing the total is ₹750, and ₹36 of it is GST. No points are earned.

| Order | Subtotal | Pass | Coupon / points | Taxable | GST | **Total** |
|---|---|---|---|---|---|---|
| A. Cappuccino L ₹120, 1 pass drink | 120 | −120 | 0 | 0 | 0 | **₹0** (starts `paid`) |
| B. Lotus Biscoff Latte XL ₹215 + Cappuccino L ₹120, 2 pass drinks | 335 | −(150 + 120) = −270 | 0 | 65 | 3 | **₹68** |
| C. Latte L ₹140 + Sandwich ₹180, 1 pass drink, 10% coupon | 320 | −140 | coupon 10% of (320 − 140) = −18 | 180 | 9 | **₹171** |
| D. 3 Cappuccinos, 1 pass drink left | 360 | −120 (1 unit) | 0 | 240 | 12 | **₹252** |

The pure helper that every create, quote and recompute path uses:

```
composePassBill({ subtotal, taxableSubtotal, passCovered, passCoveredTaxable, discount }, settings)
  → computeBill(subtotal, settings, discount + passCovered, taxableSubtotal − passCoveredTaxable)
    with discount_inr = discount (coupon + points only) and pass_discount_inr = passCovered
```

`recomputeOrderTotals` (void / add on a running tab) recomputes `passCovered` from the **non-voided**
lines' `pass_covered_inr` and clamps the coupon/points discount to `subtotal − passCovered`.

## 7. API

Every route listed here returns **404 while the flag is off**. All of them use `dynamic =
'force-dynamic'`, `parseJsonBody`, `errorResponse`, and the admin client after the auth helper.
Refusals from database functions come back as 409s with a readable message.

| Route | Who | Does |
|---|---|---|
| `GET /api/passes/plans` | public | Active plans, eligible drinks `[{id, name, category}]`, `online_purchase` (Razorpay configured), `gst {percent, inclusive}` |
| `GET /api/passes/mine` | signed-in customer | The caller's passes (active ones, plus the last 10 others) with balances and redemption history; `phone_verified` |
| `POST /api/passes/checkout` | signed-in customer | `{plan_id}` → creates a `coffee_pass` order (`customer_web`, `placed`, `payment_pending`, `user_id` = `customer_user_id` = session) plus its Razorpay intent, and returns `{order_id, order_number, total_inr, payment}`. 503 if the gateway is unconfigured. 400 if the profile has no phone. 404 if the plan is inactive. Rate limit 10 per 10 min per user. |
| `GET /api/passes/holder?phone=` | counter actor | `{found, name, passes[]}` for the verified account on that phone. Rate limit 120 per 10 min, like customer lookup. Never returns a user id. |
| `POST /api/passes/sell` | counter actor, `pass_sell`, `canTakeOrders` | `Idempotency-Key` required. `{plan_id, customer_phone, customer_name}` → finds or opens the account (CP-D4). **Refuses (409) if no account can be linked.** Creates an unpaid `coffee_pass` order (`staff_pos`, `accepted`, `created_by`) with one line and packaging 0, and returns `{order}` for the payment panel. |
| `POST /api/passes/[id]/adjust` | counter actor, `pass_manage` | `{kind:'extend', days, reason}` or `{kind:'credit', drinks, reason}` → `{pass}` |
| `GET /api/owner/passes` | owner | All plans, eligible ids, and menu `[{id, name, category}]` for the picker |
| `POST /api/owner/passes/plans` · `PATCH /api/owner/passes/plans/[id]` | owner | Create or edit a plan (no delete: deactivate). Edits never touch passes already sold (they hold snapshots). |
| `PUT /api/owner/passes/eligible` | owner | `{menu_item_ids}` replaces the eligible set |
| `GET /api/owner/passes/summary?from&to` | owner | Sold (count, ₹) by plan, active passes, drinks outstanding, liability ₹, drinks redeemed (count, covered ₹), expired unused (drinks, ₹), recent passes |

**Changes to existing routes (CP-5):**

| Route | Change |
|---|---|
| `POST /api/orders` | Accepts `pass_drinks` (integer 0–20; default 0). The beneficiary is the session user on the web, or the linked account for staff (existing resolution). It allocates with `allocatePassDrinks` before the coupon (CP-D12), writes `pass_drinks` / `pass_covered_inr` on lines and `pass_discount_inr` on the order, and after insert calls `coffee_pass_redeem`. On anything but `'ok'` it deletes the order and returns **409** "Your Coffee Pass changed while you were ordering — please review your bill." — the same shape as `try_redeem_points`. With no linked account, `pass_drinks > 0` gives 400. |
| `POST /api/orders/quote` | Accepts optional `items` (order-item shape) and `pass_drinks`. With `items`, it prices server-side through `resolveOrderLines`. It returns `pass: {requested, applied, discount_inr, eligible_units, available, message, passes[]}`, which is null when no account is known. |
| `lib/orders/amend.ts` `recomputeOrderTotals` | CP-D14 / §6: pass cover from non-voided lines. |
| `app/api/orders/[id]/status` | `coffee_pass` orders: every transition is refused (409) except `→ cancelled` while unpaid. |
| `app/api/orders/[id]/refund` | `coffee_pass` orders (CP-D15): before any money moves, call `coffee_pass_void_for_refund`. `'used'` gives 409 "This pass has already been used — it can't be refunded." `'ok'` means this call voided it. `'already'` means an earlier refund did, and the refund continues. If the money step fails **and** this call voided the pass, call `coffee_pass_restore_after_failed_refund`. |
| `lib/payments/reconcile.ts` `captureGatewayPayment` | For `coffee_pass` orders, do **not** advance `placed → received` (the trigger completes the order). Still send the bill (best-effort). |
| `app/api/orders/[id]/status` completion hooks | Never call `earnForOrder`, inventory consumption or the feedback enqueue for a `coffee_pass` order (defence in depth for CP-D13). |
| `GET /api/orders` (board) | Unchanged API: the rows carry `order_kind`. The **live board's kitchen columns and KOT auto-print skip `coffee_pass` orders** (UI, CP-8). Settle and the Orders history show them labelled "Coffee pass sale". |
| `GET /api/customers/lookup` | Adds `passes` (usable summaries) for a found account. |
| `GET /api/menu` / `MenuItem` | Exposes `pass_eligible`. |
| `lib/reports/reconcile.ts` `buildReport` | Adds `passSales {count, inr}` and `passRedemptions {drinks, inr}`, and does not fold pass cover into `discountInr`. |

## 8. Screens

The design system is `.claude/skills/code-revamp/SKILL.md`: tokens only, `components/ui/*`
primitives, `font-mono tabular-nums` for money, 44 px tap targets, loading, empty and error states,
and `SurfaceLink`.

**Customer (phone first)**
- **`/ritual`.** The top section explains the offer ("7 coffees for the price of 5" / "Pay for 6, get
  7"). Below it:
  - the two plan cards, with price (and "+ GST" when exclusive), validity, and "covers any eligible
    coffee up to ₹150, pricier drinks pay the difference";
  - eligible drinks as chips;
  - how it works in three steps, and the terms;
  - a Buy button. It asks a signed-out customer to log in (`next=/ritual`). When online purchase is
    unavailable it shows "Buy at the counter".
  - **Your Ritual** (signed in): drinks left as dots, "valid till Sun 5 Oct", history, and a note when
    the phone is unverified: "Verify your number in Profile to use your Ritual at the counter".
- **Checkout** "Offers & rewards": a row "HIOC Ritual — using **1** of 5 cups (−₹120)" with a stepper,
  pre-filled to the maximum usable (CP-D10). It is only shown when signed in with a usable pass.
- **Bill rows** "HIOC Ritual (N cups) −₹X" on the cart summary, order status page, e-receipt and QR
  checkout.
- **Menu**: a small "Ritual" chip on eligible items. **Account**: a "HIOC Ritual" card and nav link.
  **Home**: a teaser linking `/ritual`. **Legal**: a HIOC Ritual section on the refund & cancellation
  page (CP-D15, CP-D19).

**Staff / POS (landscape tablet and Electron)**
- **`/staff/passes`** (More → "Ritual passes"):
  - phone lookup with the existing suggestions;
  - the holder's passes and history;
  - plan cards → **Sell** → the existing payment panel for the new order (split tender works) → a
    "Pass active" confirmation, with print receipt;
  - manager actions Extend / Give back a drink, each with a reason;
  - any **unpaid pass sale** for that phone, with "Collect payment".
- **New order** (`PosOrderEntry`) "Coupon & points" box:
  - when the attached customer has a usable pass: "Coffee pass · 5 left · till Sun" with a **Use pass**
    button and a stepper (starts at 0, CP-D10), priced through the quote;
  - "Sell a pass" when they have none.
- **Prints**: the receipt (ESC/POS `ticketModel` and HTML `ReceiptTicket`) gets the pass row, and a pass
  sale receipt shows "valid till". A pass sale never prints a KOT.

**Owner**
- **`/owner/passes`**:
  - summary cards: sold, revenue, active, drinks outstanding, liability, redeemed, expired unused;
  - the plans table with an edit modal. The price defaults to drinks paid × drink value and shows the
    effective per-drink price and discount %;
  - the eligible-drinks picker, grouped by category, with select-all;
  - recent passes.
- **Reports** show the new pass rows. The **Permission matrix** gets labels for `pass_sell` and
  `pass_manage`.

## 9. Deployment requirement sheet

### A. Technical

| # | Requirement | Who | Check |
|---|---|---|---|
| A1 | Earlier migrations applied, including `2026-08-counter-loyalty.sql`, `2026-09-counter-accounts.sql`, `2026-09-gst-exempt.sql`, `2026-09-cash-counts.sql` and `2026-08-split-payments.sql` | Dev | `npm run verify:db` |
| A2 | Apply `supabase/2026-10-coffee-pass.sql` (safe to re-run) | Dev | `npm run verify:db` shows "CP-1 · coffee pass" all ✓ |
| A3 | Deploy with the flag **off**. Nothing changes for anyone. | Dev | `/ritual` returns 404 |
| A4 | For online purchase: Razorpay keys and webhook already configured, as for online orders | Dev | `/ritual` shows Buy, not "Buy at the counter" |
| A5 | Role permissions reviewed: `pass_sell`, `pass_manage` | Owner | Owner → Staff → Permissions |
| A6 | No new dependencies. No new secrets beyond the flag. | — | ✓ |

### B. Owner decisions (the code cannot guess these)

| # | Decision | Default in the seed |
|---|---|---|
| B1 | **Drink value and prices** per plan | ₹150 → ₹750 weekly, ₹900 for 30 days |
| B2 | **Which drinks are eligible** (Owner → Passes) | none ticked |
| B3 | **Daily cap** on the Weekly pass ("a coffee a day")? | off |
| B4 | **GST treatment confirmed with the CA**: charged at sale (CP-D11), or pass marked GST-exempt | charged at sale |
| B5 | Terms wording on `/ritual` and the refund page (the defaults are CP-D15 and CP-D19) | as built |
| B6 | Switch the plans to **active**, then set `NEXT_PUBLIC_FLAG_COFFEE_PASS=true` and redeploy | inactive / off |

### C. Go-live checks (on the real counter)

1. Sell a Weekly pass at the POS for cash. Check the receipt, the cash day, and "Pass active 7 left".
2. Redeem 1 drink at the POS on a new order (bill ₹0 or a top-up). Balance goes to 6.
3. Buy the 30-day pass online with a ₹1 test plan. Check that the pass appears after payment, then
   refund it (unused). The pass is voided and the refund succeeds.
4. Void a redeemed line on a running tab. The drink comes back and the bill recomputes.
5. Cancel an order that used 2 drinks. Both come back.

## 10. Build plan: tickets, owners, gates

Planning, spec, review and final QA are done by the **lead (Opus)**. Implementation is done by
**Sonnet agents**, each owning a set of files. Waves run in order, and agents within a wave run in
parallel.

| Wave | Ticket | Agent | Owns (files) |
|---|---|---|---|
| 1 | **CP-1** migration, verified on a local Postgres 16 | foundation | `supabase/2026-10-coffee-pass.sql`, `scripts/verify-db.mjs` (check) |
| 1 | **CP-2** pure rules: `allocatePassDrinks`, `composePassBill`, `passExpiresAt`, `passState`, input validators | foundation | `lib/passes/rules.ts`, `lib/passes/types.ts`, `tests/coffeePassRules.test.ts` |
| 1 | **CP-3** flag, permissions, types | foundation | `lib/flags.ts`, `.env.local.example`, `lib/permissions.ts`, `lib/types.ts` |
| 1 | **CP-4** server helpers: load passes for a user, summaries, redeem / void RPC wrappers, 404 guard | foundation | `lib/passes/server.ts`, `lib/passes/api.ts` |
| 2 | **CP-5** order pipeline (§7 changes to existing routes) | orders | `app/api/orders/**`, `lib/orders/amend.ts`, `lib/payments/reconcile.ts`, `app/api/customers/lookup`, `app/api/menu`, `lib/reports/reconcile*.ts`, and their tests |
| 2 | **CP-6** pass APIs (§7 new routes) | pass-api | `app/api/passes/**`, `app/api/owner/passes/**`, and their tests |
| 3 | **CP-7** customer screens | customer-ui | `app/ritual`, `components/passes/**`, `components/checkout/**`, `components/cart/**`, `components/menu/**`, `app/account/**`, `components/account/**`, `app/order/**`, `app/page.tsx`, `app/refund-cancellation`, `components/legal/**` |
| 3 | **CP-8** POS screens and prints | staff-ui | `app/staff/passes`, `components/staff/passes/**`, `components/staff/PosOrderEntry.tsx`, `lib/pos/loyalty.ts`, `lib/staff/staffNav.ts`, `lib/print/**`, `components/print/**`, `components/staff/Settle*` |
| 3 | **CP-9** owner screens and reports | owner-ui | `app/owner/passes`, `components/owner/passes/**`, `components/owner/OwnerHeader.tsx`, `components/owner/PermissionMatrix.tsx`, `app/owner/reports` |
| 4 | **CP-10** review, security pass, full CI, go-live sheet | lead | everything |

**Gate between waves** (lead): `npx tsc --noEmit`, `npm test`, `npm run lint` all clean. The lead
reviews the diff against this spec. Wave 3 starts only when the API contracts in §7 exist and are
tested.

**Definition of done**: every §7 route has a route test, including the flag-off 404 and auth refusals.
The rules helper has a table-driven test covering §6 A–D plus the daily cap, FEFO, expired and
insufficient cases. The migration has run on a clean Postgres 16 with the scenario script passing.
`npm run build` passes. The spec's §9 C checklist is ready for the owner.

## 11. Backlog (after v1)

1. **Auto-renew subscription.** Razorpay Subscriptions / UPI Autopay would charge weekly or monthly
   and issue the next pass. This needs a mandate flow and a webhook for `subscription.charged`.
2. **WhatsApp messages**: "pass bought", "2 drinks left", "expires tomorrow". This needs
   Meta-approved templates (see `docs/WHATSAPP-BILL-TEMPLATE.md`) and a daily cron.
3. **Pass code / QR** for customers whose phone is not verified, and gifting.
4. **A pass and menu items in one cart** ("buy the pass and have the first coffee now").
5. **Redeem on items added to a running tab.**
6. Pass lines in the owner **email digest**.

## 12. As built (v1, 2026-09-30)

Built in four waves: the lead (Opus) planned and reviewed, and Sonnet agents implemented each ticket
against this spec. Everything is behind `NEXT_PUBLIC_FLAG_COFFEE_PASS` (default off).

| Area | Where |
|---|---|
| Migration (verified on Postgres 16 against every repo migration, with a 156-assertion scenario suite and a two-session race) | `supabase/2026-10-coffee-pass.sql` |
| Rules, brand, server helpers | `lib/passes/{rules,brand,types,server,api,sale,summary,ui,ownerUi}.ts`, `lib/orders/passPricing.ts` |
| Order pipeline | `app/api/orders/**`, `lib/orders/amend.ts`, `lib/payments/reconcile.ts`, `app/api/customers/lookup`, `app/api/menu`, `lib/reports/reconcile*.ts` |
| Pass APIs | `app/api/passes/**`, `app/api/owner/passes/**` |
| Customer | `/ritual` (`app/ritual`, `components/passes/**`), checkout row, bill rows, menu chip, account link, home teaser, legal sections |
| Counter | `/staff/passes`, the New order Ritual row, settle and payment bill rows, board and KOT exclusions, receipt rows |
| Owner | `/owner/passes`, report rows and CSV columns |

**Differences from the plan, decided during review:**

- **Pre-fill.** The quote returns `max_usable` so the web checkout can pre-fill the stepper (CP-D10).
  `lib/payments/gateway.ts` gained `isGatewayConfigured()`.
- **Void rolled back.** If the amend route loses its version race it un-voids the line. The void
  trigger then marks the cups spent again, but only the reversal the void made. A cancel's or a
  refund's reversal is never undone.
- **No counter fallback for online Ritual purchases.** `POST /api/payments/[orderId]/status` refuses
  `switch_to_counter` for a pass sale (409). Retry still works.
- **Sale order shape.** A pass sale is stored as `order_type 'takeaway'`, with an empty pickup label,
  `pickup_code` null and packaging 0.
- **Rate limit.** The holder lookup shares the customer lookup's rate-limit key: 120 per 10 minutes
  across both.
- **Report CSV** gains four columns after Net sales: Ritual sales, Ritual sales (INR), cups served,
  and cups covered (INR).
- **Copy.** Customer-facing copy never says "Coffee Pass" or "pass". It says **HIOC Ritual** and
  **cups**. Loyalty is **Beanies**.

**Hardening after the independent review:**

- **Sold terms.** The sale line stores the plan's terms (`order_items.coffee_pass_terms`: cups, cup
  value, validity, daily cap, name). The issue trigger reads them, so an owner's edit between sale and
  payment never changes what the customer bought. The live plan is used only if the terms are missing
  or unreadable, and that logs a warning.
- **Refund states.** `PATCH /api/orders/[id]/payment` refuses `refunded` / `partially_refunded` for
  every order (400). Those states belong to the refund route, which has the `refund` permission.
  Before this, any staffer could set them and the return trigger would hand back spent cups.
- **No short settle.** A pass sale cannot be settled short (409). Tips are still allowed.
- **Un-void.** When a void is rolled back, the cups are restored only while the order is not
  cancelled, rejected or fully refunded, and only if the pass still has the cups (row-locked).
  Otherwise the reversal stands and a warning is logged.
- **No amendments.** A pass sale refuses amendments: no void and no added lines (409).

**Known limits in v1 (backlog):**

- Table-QR orders cannot use a Ritual. The QR pad sends no `items` or `pass_drinks`.
- The cart drawer's total does not show discounts. This was already true for coupons and Beanies.
- The owner's eligible-drinks picker has no prices, so it cannot warn when a drink always needs a
  top-up.
- The shared `ToggleSwitch` is 24 px tall, below the 44 px tap target. A primitive fix will cover
  every screen.
- `GET /api/passes/mine` keeps an abandoned checkout in `pending` for 60 minutes.
