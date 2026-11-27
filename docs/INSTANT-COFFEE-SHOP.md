# HIOC. Online Shop manual

The online shop sells two lines, paid by Razorpay and shipped with Shiprocket:

- **Instant Coffee**: HIOC. Premium Instant Coffee jars, 50 g (Signature Classic,
  Nutty Hazelnut, French Vanilla).
- **Signature Home Blend**: whole bean or ground to order, in 250 g, 500 g and
  1 kg packs.

Shop orders never reach the café's counter board, KOT, cash day, stock, café
Reports or GST. Only **Beanies** and the **customer's account** see them. The
owner sees them on `/owner/shop`.

Where the rules live: `docs/SHOP-V2-SPEC.md` (the product spec),
`lib/shop/pricing.ts` (the one price function), `lib/shop/catalog.ts` (copy,
grinds, parcel sizes), `lib/shop/lifecycle.ts` (money and Beanies over an
order's life), and `supabase/2026-11-shop-v2.sql` (the database).

---

## 1. What the shop sells

### Instant Coffee

| Product | SKU | Price |
|---|---|---|
| Signature Classic, 50 g | `HIOC-IC-CLASSIC-50G` | ₹399 |
| Nutty Hazelnut, 50 g | `HIOC-IC-HAZELNUT-50G` | ₹399 |
| French Vanilla, 50 g | `HIOC-IC-VANILLA-50G` | ₹399 |

No grind. Prices come from `shop_products` on the server, never from the browser.

### Signature Home Blend

| Pack | Base SKU | Price | Grind |
|---|---|---|---|
| 250 g | `HIOC-HB-250G` | set by the owner | required |
| 500 g | `HIOC-HB-500G` | set by the owner | required |
| 1 kg | `HIOC-HB-1KG` | set by the owner | required |

The three packs stay **hidden** until the owner gives each a price and lists it
on `/owner/shop`. A hidden pack cannot be bought, even if its id is posted by
hand.

**Grind** is chosen per line. There is no default. Grind never changes the
price or the stock.

| Grind | Hint shown to the customer | Line SKU suffix |
|---|---|---|
| Whole bean | I'll grind it myself | `WB` |
| Espresso | Fine, for espresso machines | `ESP` |
| Moka pot | Fine-medium, for stovetop moka pots | `MOKA` |
| Pour-over / Filter | Medium, for V60, Chemex, drip and South Indian filter | `FLT` |
| French press | Coarse, for French press and cold brew | `FP` |

The line SKU is the base SKU plus the suffix, for example `HIOC-HB-250G-FLT`.
Shiprocket and the packer see that SKU, so the right grind goes in the right
parcel. The same pack in two grinds is two lines.

---

## 2. The rules

| Rule | What the code does |
|---|---|
| **Introductory offer** | Default tiers **1 for ₹399 · 2 for ₹599 · 3 for ₹749** (`shop_settings`). Any mix of instant jars. More than 3 jars are taken in full groups of 3, then the rest (4 jars = ₹749 + ₹399). Home Blend never counts towards the tiers. The jars keep their ₹399 price on the order. The saving is its own bill line. |
| Offer: once per customer | A customer is the same **account**, the same **phone** (+91) or the same **email**. The offer applies to their **first paid shop order** only. Café orders do not count. |
| Offer: when it is used again | A first order that is cancelled and refunded makes the customer eligible again. |
| Offer: the accepted race | Two checkouts from the same customer at the same moment can both get the offer price. Both are charged. The owner sees **"Intro offer reused"** on the order card. This is accepted. |
| Ineligible customers | The shop shows **"Welcome back"** and their best live offer. They are never told they are not allowed. |
| **Coupons** | Made in **Owner → Promotions → Coupons**. Each has **Where it works: Café, Shop or Both**. A café-only coupon never works online. A shop-only coupon never works at the café. |
| Coupons: how many | One coupon per order: the best auto-apply shop coupon, or one typed code under "Have a code?". |
| Coupons: no stacking with the offer | A coupon and the introductory offer never both apply. The bill takes whichever saves more, and says so: "Introductory offer applied: it saves you more than WELCOME10". A tie goes to the offer. |
| Coupons: with Beanies | Beanies can be added to a coupon. The bill never goes below ₹1; a coupon is capped at the goods minus ₹1. |
| **Beanies: earn** | Earned when an order is **delivered**, never at payment. Base = goods paid (total − shipping). Rate = the café's rate (`loyalty_config`, `points_per_inr`), rounded down. Only an account earns. A guest order earns once it is claimed by a signed-in account and delivered. |
| **Beanies: redeem** | Only on a **repeat order**: the customer already has at least one paid café or shop order. Only when the balance is at least the café minimum (`loyalty_config.min_redeem_points`). Up to **5%** of the goods after the offer and coupon (`shop_settings.beanies_max_redeem_pct`), rounded down to whole Beanies, never more than the balance. 1 Beanie = ₹1 today. The toggle is on by default and shows the balance after the order. |
| **Beanies: reserve and return** | Beanies spent at checkout are **reserved**. They are kept when the order is paid. A **failed payment keeps the reservation**, so the customer can retry the same Razorpay order. They are **returned** when the order expires (unpaid for 30 minutes, then at the next `expire-orders` run) or when the owner cancels. That run is 4 times a day through pg_cron (`supabase/2026-10-expire-orders-cron.sql`), with the daily `vercel.json` entry as a backstop, so a reservation from an abandoned checkout can last a few hours, or up to about a day without the pg_cron job. **A new checkout does not wait for that**: before it quotes or reserves Beanies, a signed-in customer's own earlier unpaid orders that hold Beanies (older than 60 seconds, at most 5, never the order the current `Idempotency-Key` reuses) go through the same per-order expiry step the cron uses (Razorpay is asked first: a captured payment is recovered as paid, an authorized one is skipped, otherwise the order expires and its Beanies come back). A failure there never blocks checkout. The quote counts those Beanies as available, so it matches. |
| **Beanies: one balance** | Café and shop Beanies sit in one balance. |
| **Shipping** | **₹49** (`shop_settings.shipping_fee_inr`). **Free from ₹749** of goods after all discounts, Beanies included (`shop_settings.free_shipping_min_inr`). Both are editable on `/owner/shop`. |
| **Limits** | At most **12 units** and **6 kg** of packed goods per order. Past either, the order is refused with: "For more than 12 packs or 6 kg in one order, please call or email us — we do wholesale." The limits are checked in the browser and on the server. |
| **Payment** | Prepaid only, through Razorpay (UPI, cards, netbanking). No cash on delivery. |
| **Delivery** | Shiprocket. Dispatch "within 2 working days" and delivery "3–7 working days" after dispatch (`DISPATCH_WITHIN` and `DELIVERY_TAKES` in `lib/shop/catalog.ts`). Both are shown on the shop and on Shipping & Delivery. |
| Saved addresses | At most **10** per account, one default. |

---

## 3. The customer's journey

On a phone, the whole purchase is on `/shop` in three steps that never reload
the page: **Choose → Deliver to → Pay**. A bar at the bottom always shows the
item count, the total and the one primary button.

**Choose.**
- A segmented control at the top: **Instant Coffee · Home Blend**. Links can go
  straight to `/shop#instant` or `/shop#home-blend`.
- Instant Coffee: the three flavour cards with steppers.
- Home Blend: pick a pack (the price is on each chip), then pick a grind. The
  grind chips show their hint. Nothing is pre-picked. Adding without a grind
  shows a short prompt next to the button, not an alert.
- "Not sure? Pick how you brew" explains the grinds.
- The cart is kept on the device (`hioc_shop_cart_v2`), separate from the café
  cart. It survives sign-in and a reload. Lines are edited and removed in the
  cart drawer.

**Deliver to.**
- **Signed in with saved addresses:** the default (or the one used most
  recently) is shown as a compact card with **Change**. Change lists the saved
  addresses and **+ Add a new address**. No form appears unless asked for.
- **Signed in with no saved address:** the form is filled from the profile.
  **Save this address to my account** is ticked, with the label Home. The
  address is saved only when payment succeeds.
- **Guest:** the form works without an account. A slim link reads "Have an
  account? Sign in to use saved addresses and Beanies". The cart stays.
- A six-digit pincode fills in the state (and the city, when it is empty).

**Pay.**
- The bill, line by line, in this order: subtotal, introductory offer or coupon,
  Beanies, shipping, total.
- The Beanies toggle, "Have a code?", and the delivery note.
- The button reads **Pay ₹X**. It is disabled while the request is in progress.
- If the total changed on the server, the page says "Prices changed: here's the
  new total" and shows the new bill. Nothing typed is lost.

**Confirmation** (`/shop/order/<id>`): the status timeline, "Delivered to
<city>", the Beanies the order will earn, **Save these details for next time**
(guests only), and **Order again** once the order is delivered.

**Order again.** Loads a past order's items into the cart and selects its
address. Items that are no longer listed or in stock are skipped with a reason.
Items whose price changed are shown with the old and new price. The customer
then goes to review and pays. Nothing is retyped.

**Save these details (guests).** An OTP sign-in to the order's phone number
claims the order and saves its address to the new account.

**Account.** `/account` has four tiles: **Orders**, **Addresses**, **Beanies**
(balance and what it is worth) and **Profile**. Orders are filtered **All ·
Café · Shop**. A shop row shows the order number (`S1004`), the items, the total,
the status line (Paid → Packed → Shipped → Delivered), and **Track**, **View**
and **Order again**. Editing or deleting a saved address never changes a past
order, which keeps the address it was sent to.

---

## 4. Order life and money

| Status | What it means | What happens to money and Beanies |
|---|---|---|
| `payment_pending` | Checkout started, not paid | Beanies are reserved. |
| `paid` | Razorpay has taken the money | Reservation kept. Introductory offer claimed for this customer (account, phone and email). If the same customer already had it, the order is still honoured and flagged Intro offer reused. Address saved if ticked. Coupon use counted. Customer and owner get email. |
| `sent_to_shiprocket` | Created in Shiprocket | No change. |
| `shipped` | Has an AWB and tracking | Customer is emailed the tracking link. |
| `delivered` | Arrived | **Beanies earned**. The owner's "Mark delivered" does this, as does a Shiprocket refresh or the delivery sweep in each `expire-orders` run. |
| `expired` | Unpaid for 30 minutes, then picked up at the next `expire-orders` run (4 times a day through pg_cron, daily from `vercel.json` as a backstop) | Beanies returned at that run, so they can be held for a few hours (up to about a day without the pg_cron job). The order is kept, so a payment that lands late is still honoured. |
| `cancelled` | The owner cancelled and refunded | Money refunded in full through Razorpay. Beanies spent are returned. Beanies earned from this order are taken back. The offer claim is released, so the customer can use the offer again. Coupon use no longer counts. |

**Idempotency.** Every money step can run twice safely:
- Each checkout attempt sends an `Idempotency-Key`. The same key and cart return
  the same pending order, so a double tap creates one order.
- The payment confirmation can come from three places (the verify call, the
  Razorpay webhook, and the order page's poll). Whichever comes first marks the
  order paid. The others do nothing.
- Beanies and the coupon count are written once per order. A repeat earn,
  redeem or return does nothing.
- If the coupon's limit was reached while the order was pending, the order is
  still honoured and a warning is logged.

---

## 5. The owner's day on `/owner/shop`

- **Setup checklist** at the top until everything is in place (database, the
  v2 columns, Home Blend packs priced and listed, Razorpay, Shiprocket, the shop
  flag).
- **Stat cards:** to ship, plus the last 30 days. Units and revenue are counted
  for each line.
- **Products card:** for each product, the owner sets the price (whole rupees),
  listed (on or off), in stock (on or off), the packed weight in kg, and a
  one-line description. Changing a price never changes an order already placed.
- **Order tabs:** To ship (oldest paid first) · With courier · Delivered ·
  Cancelled · Unpaid (abandoned checkouts: no money taken, nothing to do).
- **Order card:**
  - Home Blend lines show the grind in **bold**.
  - A **packing checklist**: "Grind 1 × 500 g for Pour-over / Filter", or "Pack
    2 × 250 g whole bean".
  - The discounts split into offer, coupon (with its code) and Beanies.
  - **"Intro offer reused"** when two checkouts raced.
  - Copy address, which includes the delivery pin as a Google Maps link when
    the customer gave one.
- **Send to Shiprocket:** check the parcel's weight and box size first. The
  starting values come from the items in the order. Then one click creates the
  order in Shiprocket. Courier, label and pickup are chosen in the Shiprocket
  panel. Refresh from Shiprocket reads the AWB back.
- **Shiprocket not set up or down?** Use **Mark shipped by hand** and enter the
  AWB and courier.
- **Mark delivered** (Beanies are earned) and **Cancel & refund** (full refund,
  Beanies returned or taken back as above).
- **Shiprocket's bill check:** once an order is in Shiprocket, its bill is read
  back and compared with what the customer paid. A green tick means they match.
  A red warning means they do not. A banner at the top lists any order still on
  its way whose bill is wrong. HIOC-S1004 (paid ₹749, Shiprocket's bill ₹301,
  from the offer being taken off twice, since fixed) is the one accepted
  exception. It is listed in `SHIPROCKET_BILL_EXCEPTIONS` in `lib/shop/status.ts`
  by order, Shiprocket order id and the exact wrong amount. It is flagged again
  if Shiprocket's bill changes.
- **Download CSV** (for the accountant): every paid order. Columns, in order:
  Order · Paid at (IST) · Status · Customer · Phone · Email · Address · City ·
  State · Pincode · Map pin · Items · **Channel** · **Line(s)** · **Grind(s)** ·
  Units · Goods (₹) · **Offer** (the offer's name) · **Total discount (₹)** (offer + coupon + Beanies) ·
  **Offer (₹)** · **Coupon code** · **Coupon (₹)** · **Beanies used** ·
  **Beanies (₹)** · **Intro offer reused** · Shipping (₹) · Total paid (₹) ·
  Refunded (₹) · Payment method · Razorpay payment id · Shiprocket order id ·
  AWB · Courier.

---

## 6. Owner launch checklist

Work top to bottom. Each step says where to do it.

1. **Check the database target.** In the Supabase dashboard, open the project
   **Hioc India** → Project Settings → API. Compare its Project URL with
   `NEXT_PUBLIC_SUPABASE_URL` in Vercel and locally. They must match.
   If `NEXT_PUBLIC_SUPABASE_URL` points at the other project, stop and fix it
   first. **Hioc Coffee is retired.** It has taken no orders since early
   November 2026, and nothing should be run or changed there. Never paste a
   key or a full project URL into the repository or into a chat.
2. **Apply the database changes to Hioc India, before the v2 deploy.**
   **Done on 2026-11-18.** Everything in `supabase/2026-11-shop-v2.sql` is on
   Hioc India **except the three Home Blend rows**. They were held back on
   purpose: the v1 code still live uses the cheapest product as its headline
   "MRP per jar", so the ₹1 placeholder rows would have made the live shop say
   "₹1 a jar".
3. **Deploy** the v2 code.
4. **Right after the deploy, add the Home Blend rows.** In Hioc India → SQL
   Editor, run `supabase/2026-11-shop-v2.sql` again. Everything else is
   already there and is skipped. Only the three hidden Home Blend packs are
   added (unlisted, out of stock, ₹1 placeholder).
5. **Verify.** Run `npm run verify:db` with the variables pointing at Hioc
   India. Check that **SHOP-1**, **SHOP-2** and **SHOP-3** pass. SHOP-3 fails
   on "the three Home Blend sizes exist" until step 4 is done.
6. **Shiprocket** (v1 steps, still valid):
   - Shiprocket panel → Settings → API → Configure → **create an API user**. Use
     an email that is *different* from your main login.
   - Panel → Settings → Pickup addresses: note the pickup address **nickname**.
   - Recharge the Shiprocket wallet.
   - In Vercel, set `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD`, and set
     `SHIPROCKET_PICKUP_LOCATION` if the nickname isn't `Primary`.
7. **Razorpay** (v1 step, still valid): the keys already used for café payments
   are enough. Check that the webhook `https://hioc.in/api/payments/webhook` is
   on, with the events `payment.captured`, `order.paid` and `payment.failed`.
   It catches payments when a customer closes the tab early. Tell Razorpay
   support that you now also sell packaged coffee shipped across India.
8. **Price and list the Home Blend packs.** On `/owner/shop` → Products, set the
   price of the 250 g, 500 g and 1 kg packs, add a one-line description to each,
   mark them in stock and **list** them. They stay hidden until you do.
9. **Weigh the parcels.** The weights set the 6 kg limit and the Shiprocket
   parcel. The box is added once, by `BOX_WEIGHT_KG`, so weigh the goods and the
   box separately and never enter the weight of a whole boxed parcel.
   - a. For each product (each Home Blend pack, and each instant jar; each has
     its own weight field on the Products card), weigh one unit as it goes into
     the parcel: in its own wrap, without the outer box. Enter that as its
     packed weight. There is no single jar weight.
   - b. Weigh an empty shipping box with the filler you will really use. If it
     is not about 0.1 kg, change `BOX_WEIGHT_KG` in `lib/shop/catalog.ts`.
   - c. Box sizes come from `defaultPackageForLines()` in `lib/shop/catalog.ts`.
     They can be changed for any order in the Send to Shiprocket dialog.
10. **Replace the Home Blend illustration with a photo (when you have one).**
   The shop shows a drawn stand-in of the pack today (see "Images" below). For
   a real photo, save a transparent PNG over `public/images/shop/home-blend.png`
   (one pack, about 800 px tall) and `public/images/shop/home-blend-hero.png`
   (a wide scene, 880×476), keep the names, and deploy. Then change
   `HOME_BLEND_IMAGE_ALT` in `lib/shop/catalog.ts` from "Illustration of…" to a
   description of the photo.
11. **Review the money settings** on `/owner/shop`: the shipping fee (₹49), the
    free-shipping minimum (₹749), the Beanies cap (5%) and the introductory
    offer tiers.
12. **Create the shop coupons.** Owner → Promotions → Coupons. For each one set
    **Where it works** to **Shop** or **Both**. A coupon set to Café does not
    work online.
13. **Emails** (optional but recommended). With `RESEND_API_KEY` and
    `RESEND_FROM` set, the owner gets "New online order" and the customer gets
    confirmation, shipped and refund emails. `SHOP_ALERT_EMAILS` adds more
    recipients, for example whoever packs.
14. **Switch on the shop.** Set `NEXT_PUBLIC_FLAG_SHOP=true` in Vercel and
    redeploy. This shows `/shop`, the Shop link, the home-page "Order online"
    popup, the Shop orders item in the owner menu, and the shop wording on the
    policy pages.
15. **Test once end to end, with a real ₹ payment.** Order one 250 g Home Blend
    pack with a grind and one instant jar. Pay. In `/owner/shop`, Send to
    Shiprocket, then Mark delivered. Check that the customer's Beanies show the
    expected amount. Then Cancel & refund, and check the refund and that the
    emails arrived.
16. **GST and HSN (ask the CA).** Roasted coffee (Home Blend) likely has a
    different GST rate and HSN code from instant coffee. Ask the CA to confirm
    the rate, HSN and invoice format for each line. The prices shown are
    all-inclusive. Other states mean IGST.
17. **FSSAI and the label.** For the Home Blend packs, confirm the printed label
    details: manufacturer or packer name and address, net quantity, MRP
    (inclusive of all taxes), country of origin and customer care. Confirm with
    your FSSAI consultant that the licence covers selling roasted coffee by post.
    Enter the details on the product pages and on the packs.
18. **Dispatch promise.** Confirm the timing for the ground-to-order packs. The
    default is "within 2 working days". It is set in `DISPATCH_WITHIN` in
    `lib/shop/catalog.ts`, and delivery in `DELIVERY_TAKES`.
19. **Optional: the delivery map pin.** "Use my current location" works without
    anything. For the draggable map, enable the Maps JavaScript API in Google
    Cloud, create a key restricted to HTTP referrers on `hioc.in` and to that
    API, and set `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` in Vercel. Set a budget alert.

`/owner/shop` also has a setup checklist at the top, which lists what is still
missing.

---

## 7. Open items for the owner

- Prices for the 250 g, 500 g and 1 kg packs, and their real packed weights.
- Home Blend images, and tasting notes or roast level for the description.
- FSSAI label details and the GST/HSN for roasted coffee (likely different from
  instant). Confirm with the CA.
- The dispatch promise for ground-to-order packs (default "within 2 working
  days").

## 8. Out of scope (for later)

- Subscriptions.
- Cash on delivery.
- International shipping.
- Gift wrap.
- Shipping rates per courier.
- Live pincode serviceability checks with Shiprocket.

---

## Not verified yet

The Shiprocket client (`lib/shop/shiprocket.ts`) follows Shiprocket's published
API (login, create a custom order, read an order back, cancel). It reads the
answers loosely and has not been run against a live account from the build
environment. Do the test order (step 15) before the first real customer. If
Shiprocket answers differently, the error shows on the order card, and **Mark
shipped by hand** still works. The tracking link is
`https://shiprocket.co/tracking/<AWB>`. The delivery pin is sent as a Google
Maps link in the order comment.

## Images

`public/images/shop/` holds the jars: `hero-jars.png` (all three) and
`jar-<flavour>.png`. They are cut from the launch poster with a
background-removal model (transparent PNGs with a soft shadow). For sharper
pictures on big screens, swap in studio shots under the same names (transparent
PNG, about 900 px tall for one jar).

The Home Blend images are an **illustration**, not a photo: a drawn charcoal
pouch with the HIOC. label and roasted beans, made from the SVG sources
`home-blend.svg` (one pack: the phone thumbnail and the ordering card) and
`home-blend-hero.svg` (the wide scene on the product card). The alt text says
"Illustration of…". The real bag may look different, so swap in studio photos
under the same PNG names when they exist (step 10).

## Files

- `supabase/2026-11-shop-v2.sql`: the v2 tables, columns, constraints, RLS and
  the verification block
- `supabase/2026-11-instant-coffee-shop.sql`, `supabase/2026-11-shop-shiprocket-total.sql`: v1 (run first, if not already)
- `lib/shop/pricing.ts`: the one price function (`quoteShopCart`) and the offer
  helpers
- `lib/shop/catalog.ts`: copy, grinds, SKUs, parcel sizes, dispatch and delivery
  promises
- `lib/shop/lifecycle.ts`: Beanies and money over an order's life
- `lib/shop/status.ts`: status rules, Shiprocket bill check and exceptions
- `lib/shop/shiprocket.ts`: Shiprocket client
- `app/shop/`, `components/shop/`: the customer pages
- `app/account/`, `components/account/`: the account (Orders, Addresses,
  Beanies, Profile)
- `app/owner/shop/`, `components/owner/shop/`, `app/api/owner/shop/`: owner
- `app/api/shop/`: quote, checkout, verify, order status
- `app/api/payments/webhook/route.ts`: shared Razorpay webhook (shop first)
- `tests/shop*.test.ts`
