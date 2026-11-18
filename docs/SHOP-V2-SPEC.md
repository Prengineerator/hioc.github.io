# Shop v2: Home Blend, saved addresses, one account, repeat-order Beanies

Product owner spec, 2026-11-18. It builds on `docs/INSTANT-COFFEE-SHOP.md` (v1),
which stays true except where this file changes it.

## Why

The online shop sells only instant coffee, to guests. Each order is
one-off. The customer types the full address every time. The order never
appears in their HIOC account, and nothing brings them back. v2 does four
things:

- sells a second product line, the **Signature Home Blend**, as whole bean or
  freshly ground;
- makes a **repeat order take two taps** by saving addresses and adding
  "Order again";
- puts shop and café orders in **one account**, each kept clearly apart;
- gives a **reason to come back**: Beanies earned on every order, spendable for
  up to 5% off a repeat order. After that, the owner's own discounts take over
  once the introductory offer has been used.

## Decisions already made (owner, 2026-11-18)

| Topic | Decision |
|---|---|
| Beanies | Shop orders **earn** Beanies at the café's earn rate. On a **repeat** order, the customer can **redeem up to 5%** of the goods. A repeat order is one from a customer who already has at least one paid café or shop order. Beanies from café orders and shop orders sit in one balance. |
| Home Blend packs | **250 g, 500 g, 1 kg**, each priced separately by the owner on `/owner/shop`. The packs stay hidden until the owner gives them a price and lists them. |
| Grind | **Whole Bean**, or ground for **Espresso**, **Moka pot**, **Pour-over / Filter**, **French press**. The grind is chosen per line. It does not change the price or the stock. |
| Introductory offer | Applies **once per customer**, to their **first paid Shop order** only (café history doesn't count). "Customer" means the same account, the same phone number or the same email. |
| Later offers | Created by the owner in **Owner → Promotions → Coupons** (the "discount column"), with a new **Where it works: Café / Shop / Both** setting. |
| Shipping | Still Shiprocket, prepaid only (Razorpay). |

## Non-negotiables

1. **Database.** The only live database is the Supabase project **Hioc India** (see
   CLAUDE.md). Engineers write the migration as a file in `supabase/` and do
   **not** apply it or run anything under `scripts/` against any project. The
   owner applies it, following the launch checklist.
2. **The server prices everything.** Prices, offers, coupons, Beanies and
   shipping are worked out on the server, from the database. The browser's
   numbers are only ever compared, never trusted. One pure pricing function is
   shared by the page and the checkout route, as in v1.
3. **Shop orders stay out of café operations.** They never reach the counter
   board, KOT, the cash day, stock, the café's reports or GST. Only
   **Beanies** and the **customer's account** now see them.
4. **The shop flag still gates everything.** Every new customer-facing surface
   sits behind `flags.shop`. Saved addresses work in the account even with the
   flag off, but no shop UI shows.
5. **No secrets or full project URLs** in the repository.
6. **Design system** (`tailwind.config.ts`, `.claude/skills/code-revamp/SKILL.md`):
   - only the existing colour tokens; `tan` is never used as text;
   - DM Sans for text, Space Mono with `tabular-nums` for money and order numbers;
   - `components/ui/*` primitives;
   - tap targets of at least 44 px, input text of at least 16 px;
   - correct `type`, `inputMode` and `autoComplete` on every field;
   - WCAG AA contrast, labelled inputs, `aria-live` on totals and status;
   - colour is never the only signal;
   - every async view has loading, empty and error states;
   - one primary button per view;
   - phone first.
7. **Robust.** All of the following must hold:
   - Every money path is idempotent: a double tap, a retry, the webhook and
     verify racing each other, a refund after Beanies.
   - Every limit is enforced in SQL as well as in TypeScript.
   - Every failure says what happened and what to do next.
   - New logic has vitest tests.
   - `npm test`, `npx tsc --noEmit` and `npm run lint` all pass.

---

## E1. Catalog: two product lines

**Model.** `shop_products` gains these columns:

- `line`: `'instant' | 'home_blend'`;
- `display_name`;
- `pack_grams` (integer);
- `ship_weight_kg`: the packed weight of one unit;
- `listed`: boolean, default true for the existing jars and false for the new packs;
- `requires_grind`: boolean;
- `description`.

Each Home Blend pack size is one row:

| Row id | SKU | Pack |
|---|---|---|
| `home-blend-250` | `HIOC-HB-250G` | 250 g |
| `home-blend-500` | `HIOC-HB-500G` | 500 g |
| `home-blend-1kg` | `HIOC-HB-1KG` | 1 kg |

The seed rows have `listed=false` and a placeholder price. The customer never
sees an unlisted product, and the checkout refuses one.

**Grind** is a closed list in code and in a SQL check on the line:

| Code | Label | Hint |
|---|---|---|
| `whole_bean` | Whole bean | I'll grind it myself |
| `espresso` | Espresso | Fine, for espresso machines |
| `moka` | Moka pot | Fine-medium, for stovetop moka pots |
| `filter` | Pour-over / Filter | Medium, for V60, Chemex, drip and South Indian filter |
| `french_press` | French press | Coarse, for French press and cold brew |

A cart line is `{product_id, quantity, grind?}`. `grind` is required when
`requires_grind`, and refused otherwise. The same product with a different
grind is a different line. The frozen order line stores:

- `grind` and `grind_label`;
- `line`;
- `pack_grams`;
- a line SKU of base SKU + grind (`HIOC-HB-250G-FLT`), so Shiprocket and the
  packer see exactly what to grind.

**Owner (`/owner/shop`) gets a "Products" card**, replacing "Flavours in
stock". For each product the owner can:

- edit the price (₹, whole rupees);
- switch it listed or unlisted, and in or out of stock;
- edit the packed weight;
- edit a one-line description.

Validation runs on the server. Changing a price never alters an order already
placed, because the lines are frozen.

**Acceptance**
- An unlisted or out-of-stock product is not purchasable, even when its id is
  posted to the API by hand.
- A Home Blend line without a grind is refused, with "Choose a grind for
  Signature Home Blend 250 g".
- The three jar flavours behave exactly as in v1.

## E2. Pricing v2 (one pure function, `lib/shop/pricing.ts`)

The quote is worked out in this order. Each step has its own line on the bill
and its own stored column.

1. **Goods subtotal**: the sum of the unit price × quantity of every line.
2. **Introductory offer**: the v1 jar tiers (`shop_settings`). It applies only
   when the customer is eligible (E2a), and only to **instant** units. Home
   Blend is never counted in jar tiers.
3. **Coupon** (E7): either one auto-apply coupon or one typed code, scoped to
   the shop.
   - The coupon and the introductory offer **do not stack**. The bill takes
     whichever saves more.
   - The bill says which one it used: "Introductory offer applied: it saves you
     more than WELCOME10".
4. **Beanies** (E5):
   - Only on a repeat order, and only for a signed-in customer whose balance is
     at least `loyalty_config.min_redeem_points`.
   - At most `shop_settings.beanies_max_redeem_pct` (default **5**) % of the
     goods after steps 2 and 3, rounded down to whole Beanies, and never more
     than the balance.
   - 1 Beanie = `loyalty_config.inr_per_point` (today ₹1).
   - Beanies stack with a coupon. They can't apply when the bill is already ₹0.
5. **Shipping**:
   - `shop_settings.shipping_fee_inr` (default ₹49).
   - Free when the goods after steps 2–4 come to at least
     `shop_settings.free_shipping_min_inr` (default **₹749**). This keeps v1's
     promise that 3 jars at ₹749 ship free, and now works across both lines.
6. **Total** = subtotal − (offer + coupon + Beanies) + shipping, and it is
   always more than ₹0.

**Limits.**
- At most 12 units per order.
- At most `MAX_PARCEL_KG = 6` kg of packed weight per order.
- Past either limit, the order is refused with the wholesale message
  ("call or email us").

**Stored on `shop_orders`.**
- New columns: `offer_discount_inr`, `coupon_id`, `coupon_code`,
  `coupon_discount_inr`, `beanies_redeemed`, `beanies_discount_inr`,
  `intro_offer_applied`.
- `discount_inr` stays the sum of the three discounts, enforced by a CHECK. The
  existing total CHECK and the Shiprocket sub_total/total_discount contract
  therefore keep working.
- `jar_count` keeps its name but means **units**.

**Nudges** come from the same quote, so they are never wrong.
- "Add ₹X more for free shipping" is based on goods value.
- The jar-tier nudge ("one more jar for ₹150 more") shows only while the
  introductory offer is eligible.

### E2a. Introductory offer once per customer

- **Eligible** means none of the following has a shop order with status `paid`,
  `sent_to_shiprocket`, `shipped` or `delivered` and `intro_offer_applied=true`:
  - this account (`user_id`);
  - this phone (normalised +91);
  - this email (lower-cased).
- A cancelled-and-refunded first order makes the customer eligible again.
- **Race-safe.** A table `shop_intro_claims` has unique keys on phone and email
  plus a nullable unique `user_id`.
  - It is inserted **at payment capture**, in the same idempotent path that
    marks the order paid.
  - At checkout the claim is checked. If two checkouts race, both may be
    charged the offer price. The second capture logs a warning and still
    honours the price, because money has been taken.
  - The race is accepted and documented. The owner sees "Intro offer reused"
    on the order card.
  - Cancelling an order that holds the claim deletes the claim.
- Guests are eligible on phone + email. Once a guest has used the offer,
  signing in doesn't reset it.
- **Copy for an ineligible customer:**
  - The shop page swaps the "Introductory offer" ribbon for "Welcome back".
  - Their best live offer shows instead: an auto coupon, or "use your Beanies".
  - They are never told "you're not allowed".
- The owner can still switch the offer off or reprice it (v1).

## E3. Saved addresses

**Table `customer_addresses`:**

- columns:
  - `id`, `user_id → auth.users on delete cascade`;
  - `label` (Home / Work / Other, or custom, up to 20 characters);
  - the address fields and their checks, the same as `shop_orders`: name,
    phone, line1, line2, city, state, pincode;
  - optional `landmark` (up to 80 characters);
  - optional `location_lat/lng/source`;
  - `is_default`;
  - `last_used_at`, `created_at`, `updated_at`;
- at most **10 per account** (trigger), and exactly one default (partial unique
  index on `user_id where is_default`);
- **RLS:** the owner can only `select/insert/update/delete` their own rows
  through `auth.uid() = user_id`. The API uses the user's session and adds a
  server-side check.

**API:** `GET/POST /api/account/addresses`, `PATCH/DELETE
/api/account/addresses/[id]`, and `POST .../[id]/default`. Validation reuses
`validateShopAddress`, extended with the landmark.

**Account → Addresses** (`/account/addresses`, linked from the account home):

- each address appears as a card with Edit, Delete and Make default;
- an empty state says "Save an address to check out in one tap";
- delete asks for confirmation.

**Checkout behaviour (the main friction win):**
- **Signed in with saved addresses.** The default address, or the one used most
  recently, is preselected and shown as a compact card with "Change". Change
  opens the list of radio cards plus "+ Add a new address". No address form
  appears unless the customer asks for one.
- **Signed in without saved addresses.**
  - The form is prefilled from the profile (name, phone, email).
  - "Save this address to my account" is **ticked by default**, with a label
    chip of Home.
  - The address is saved only when the payment succeeds (at capture), so a
    failed payment doesn't leave junk behind.
- **Guest.**
  - The form works as in v1, with a slim "Have an account? Sign in to use saved
    addresses and Beanies" link (`/login?next=/shop`). The cart survives the
    round trip (localStorage).
  - The confirmation page offers "Save these details for next time": an OTP
    sign-in to the order's phone, which then claims the order (E4) and saves
    the address.
- **Pincode helps** (P1, graceful). A 6-digit pincode fills in the state, and
  the city if it is empty.
  - It uses a static first-3-digit → state table in code, so no network is
    needed.
  - An optional lookup through the server to a public pincode API may be added
    only if it is reachable. When it is missing it fails silently.
- **Order history** keeps the address that was frozen on the order. Editing or
  deleting a saved address never changes past orders.

## E4. One account, café and shop kept apart

**History.** `GET /api/account/history` merges `shop_orders` into the café
results.
- Ownership: `user_id`, or a **verified** profile phone, or a verified login
  email, with `user_id` null. These are the same rules as the café.
- Unpaid (`payment_pending`) shop orders are excluded.
- Each item carries `channel: 'cafe' | 'shop'`.
- New query parameter `channel=all|cafe|shop` (default `all`).
- Pagination stays correct across both tables. Merge by `created_at desc`, and
  add tests.
- Add indexes on `shop_orders (user_id, created_at desc)`, `(phone)` and
  `(lower(email))`.

**Claim.** `/api/account/claim` (`lib/account/claim.ts`) also links guest shop
orders to the account, matching a verified phone or email, and sets `user_id`.
Beanies earned on those orders are credited when they become eligible (E5).

**Account UI** (`/account`, `/account/orders`):
- Segmented filter chips: **All · Café · Shop**. They are real buttons with
  `aria-pressed`, and the choice is remembered in the URL (`?channel=`).
- Every order row shows a channel badge:
  - Café: the existing pickup or dine-in wording;
  - Shop: "Shipped to <city>".
  - The badge uses an icon and text, not colour alone.
- A shop row shows:
  - the order number (`S1004`, mono);
  - a short item list (e.g. "2× Signature Classic, 1× Home Blend 500 g · Filter");
  - the total;
  - a status line: Paid → Packed → Shipped → Delivered;
  - a **Track** link (when there's an AWB), **View** (`/shop/order/<id>`) and
    **Order again**.
- The account home's "Active order" callout also covers an undelivered shop
  parcel: "Your coffee is on its way: Track".
- **Simpler account.** The account home becomes four clear tiles:
  - **Orders**;
  - **Addresses**;
  - **Beanies** (balance + "worth ₹X");
  - **Profile**.
  It keeps the favourites link. Every tile is reachable in one tap from the
  header avatar.

**Reorder (shop).** `GET /api/account/shop-reorder/[orderId]`:
- It checks ownership the same way as the café reorder, and re-prices against
  today's catalog.
- Products that are unlisted or out of stock are skipped with a reason.
- A price that changed is reported as `modified`, with the old and new price.
- It returns `{items, skipped, modified, address_id | address}`.

The client fills the shop cart and preselects the same address (the matching
saved address, or the frozen one as a new unsaved address), then opens `/shop`
at the review step with the notice shown. The goal is **Order again → review →
Pay, with no typing**.

## E5. Beanies on shop orders

**Ledger.**
- `loyalty_transactions` gains `shop_order_id uuid references shop_orders on
  delete set null`, plus a CHECK that a row never has both order ids.
- Idempotency: unique `(shop_order_id, type)` for earn and redeem.
- Reverse rows are made idempotent the same way as the café's.
- `lib/loyalty/ledger.ts` gains `earnForShopOrder`, `redeemForShopOrder` and
  `reverseForShopOrder`. They reuse the café's config and its balance cache
  (`loyalty_accounts`).

**Earn.**
- Earned when an order becomes **delivered**: through a Shiprocket refresh, the
  owner's "Mark delivered", or a nightly sweep of `shipped` orders whose
  Shiprocket status says delivered.
- The base is goods paid: total − shipping. Beanies spent are already out of
  the total.
- The rate is `floor(base × points_per_inr)`.
- Only for an account. A guest order that is claimed later earns once it is
  delivered, or straight away if it was already delivered when claimed.
- The customer sees "You'll earn ~N Beanies when it's delivered" at checkout
  and on the order page.

**Redeem.**
- The Beanies are **reserved at checkout**: a `redeem` row is written with the
  pending order.
- They are **returned** (a `reverse` row) when:
  - the order is still `payment_pending` after 30 minutes. The
    `/api/cron/expire-orders` cron gains a shop pass, which also deletes or
    marks stale pending shop orders, consistently with today's behaviour;
  - the Razorpay payment fails;
  - the owner cancels and refunds. The refund covers the money paid, and the
    Beanies spent come back as Beanies.
- A cancelled order that had already earned also reverses the earn.

**UI.**
- At checkout, a signed-in repeat customer with enough Beanies sees one toggle
  row: "Use 39 Beanies: −₹39 (up to 5% on repeat orders)". It is **on by
  default**, with the balance after the order shown under it.
- When the balance is below the minimum, the row reads "You have 12 Beanies.
  Use them from 20".
- On a first order, a signed-in customer sees "Earn ~N Beanies on this order
  and save up to 5% next time". A guest sees the same line with "Sign in to"
  in front.
- `/rewards` lists shop earns and redeems, each with a "Shop" badge and the
  order number.

## E6. Shiprocket and the owner's order view

- `buildShiprocketOrder`:
  - The item name comes from the frozen line: "HIOC. Premium Instant Coffee:
    Nutty Hazelnut (50 g)" or "HIOC. Signature Home Blend: 500 g, Pour-over /
    Filter".
  - The SKU is the line SKU.
  - The comment is generic: "HIOC. online order (prepaid)" plus the pin.
  - `total_discount` = `discount_inr` (all three discounts), and `sub_total` =
    `subtotal_inr`. The v1 contract and the bill check stay as they are.
  - Tests cover a mixed order with a coupon and Beanies, so Shiprocket's total
    equals what the customer paid.
- **Parcel weight:**
  - `defaultPackage(lines)` = 0.1 kg for the box + Σ `ship_weight_kg` ×
    quantity.
  - The starting guesses are 0.3 kg per jar and 0.3 / 0.55 / 1.1 kg for the
    Home Blend packs.
  - The box size is chosen by total weight.
  - The owner can still edit both in the send dialog.
- **Order card.**
  - The grind shows in **bold** on each Home Blend line, plus a packing
    checklist ("Grind 1 × 500 g for Pour-over / Filter").
  - The discounts are broken down: offer, coupon (with its code) and Beanies.
  - "Intro offer reused" shows when it applies (E2a).
- **CSV export** adds these columns: line, grind, offer, coupon code and amount,
  Beanies and their amount, and channel.
- The 30-day stats on `/owner/shop` count units and revenue for each line.

## E7. Shop discounts in Promotions

- `coupons.channel text not null default 'cafe' check (channel in
  ('cafe','shop','both'))`. Every existing coupon stays café-only.
- `coupon_redemptions`:
  - gains `shop_order_id`;
  - `order_id` becomes nullable;
  - a CHECK requires exactly one of the two;
  - `unique (coupon_id, shop_order_id)`.
  - `usage_limit` and `per_user_limit` count both kinds of order, keyed on the
    account, or on the phone for guests.
- The shop redemption is written **at capture**, idempotently. If the coupon's
  limit was hit in between, the order is still honoured and a warning is logged,
  the same as E2a.
- `CouponManager` gains a "Where it works" radio (Café / Shop / Both).
  - For the shop or both channels, an optional scope picks shop products.
  - Item and category scopes stay café-only.
- The coupon list shows a channel badge on each coupon.
- `validateAndComputeCoupon` (café):
  - ignores `channel='shop'` coupons;
  - its shop equivalent ignores `channel='cafe'`.
  - Both share one helper, with tests.
- **Shop checkout:**
  - The best eligible **auto-apply** shop coupon is chosen automatically.
  - A collapsed "Have a code?" link opens one input with Apply.
  - Errors say why: expired, minimum ₹X, already used, not for these items.
  - Coupons get the rate limit already used by the checkout.

## E8. The /shop page: less friction

On a phone, the whole purchase happens on one page in three steps that never
reload: **Choose → Deliver to → Pay**. A sticky bottom bar always shows the
item count, the total and the one primary action.

- **Choose.**
  - Two sections with a sticky segmented control at the top: **Instant
    Coffee · Home Blend**. Anchors are `#instant` and `#home-blend`, so links
    and ads can deep-link to either.
  - Instant: the v1 flavour cards and steppers, unchanged.
  - Home Blend: one product card, on the brand `surface` background with a
    placeholder image slot `public/images/shop/home-blend.png`.
  - Pack-size chips show the price on each chip, as a radio group.
  - Grind chips are labelled by brew method, each with its one-line hint, as a
    radio group.
    - There is **no default grind**. An unselected grind shows an inline prompt
      on Add, and never a blocking alert.
  - A small "Not sure? Pick how you brew" disclosure explains the chips.
  - A stepper and **Add to order**. Lines in the cart can be edited and removed
    from a cart drawer.
- **Deliver to:** E3. A signed-in customer with a default address skips
  straight past it, as a summary card.
- **Pay:**
  - the bill, broken down line by line, in this order: subtotal, introductory
    offer or coupon, Beanies, shipping, total;
  - the Beanies toggle, "Have a code?" and the delivery note;
  - Pay ₹X.
  - The total changes are announced through `aria-live`.
  - If the server's total differs (the existing 409), the page shows "Prices
    changed: here's the new total" and re-quotes without losing anything.
- `POST /api/shop/quote`:
  - It returns the full server quote for the cart, the signed-in user (or the
    guest's phone and email once they are entered), the coupon code and the use
    of Beanies.
  - It is debounced on the client, and the page renders that quote.
  - The local pure function still gives the instant figure, and the server
    figure wins.
  - It is rate limited.
- **Double-submit safety.**
  - The Pay button disables while the request is pending.
  - The checkout accepts an `Idempotency-Key` (a UUID per attempt, kept for
    retries) and returns the same pending order for the same key and cart. This
    closes v1's gap where two taps created two rows.
- The cart persists in localStorage under its own `hioc_shop_cart_v2` key, kept
  apart from the café cart. It survives sign-in and a reload.
- The confirmation page (`/shop/order/<id>`) shows:
  - the status timeline;
  - "Delivered to <city>";
  - the Beanies to be earned;
  - the save-details prompt for guests (E3);
  - Order again once the order is delivered.

## E9. Migration, tests, docs

- **One additive, re-runnable migration:** `supabase/2026-11-shop-v2.sql`.
  - It starts with comments in the house style, and every `add column` and
    `create` uses `if not exists`.
  - It contains the E1, E2, E3, E5 and E7 schema, the indexes and RLS.
  - It ends with a verification block.
  - It is followed by a `SHOP-3` check added to `scripts/verify-db.mjs`.
    Engineers only edit that script and **do not run it**.
- **Tests:**
  - pricing (every step, the stacking rules, the caps, shipping);
  - intro eligibility;
  - coupon channel filtering;
  - the Beanies cap and reservation, and its reversal;
  - the merge of the café and shop history with pagination;
  - shop reorder;
  - address validation and the 10-per-account limit (TS side);
  - the Shiprocket payload for mixed orders;
  - the checkout idempotency key.
- **Docs:** update `docs/INSTANT-COFFEE-SHOP.md` into the shop manual, covering:
  - the new rules table;
  - the owner's launch checklist (apply the SQL, price and list the Home Blend
    packs, weigh the parcels, add images, create shop coupons, CA/FSSAI notes
    for roasted coffee).

## Out of scope (later)

- Subscriptions.
- Cash on delivery.
- International shipping.
- Gift wrap.
- Shipping rates per courier.
- Live pincode serviceability checks with Shiprocket.

## Open items for the owner (not blocking the build)

- Prices for the 250 g, 500 g and 1 kg packs, and their real packed weights.
- Home Blend images, and tasting notes or roast level for the description.
- FSSAI label details and the GST/HSN for roasted coffee (likely different from
  instant): confirm with the CA.
- The dispatch promise for ground-to-order packs (default "within 2 working
  days").
