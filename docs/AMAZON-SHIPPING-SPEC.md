# Amazon Shipping next to Shiprocket (/owner/shop)

Product owner spec, 2026-11-20. Builds on `docs/INSTANT-COFFEE-SHOP.md`,
`docs/SHOP-V2-SPEC.md` (E6) and `docs/SHOP-OWNER-ORDERS-SPEC.md`.

Status: **approved by the owner on 2026-11-20.** Being built.

## The short answer

Every paid shop order on **/owner/shop → To ship** gets a second button,
**Ship with Amazon Shipping**, next to **Send to Shiprocket**. Shiprocket keeps
working exactly as it does today.

The Amazon button uses **the café's own Amazon Shipping account** and its rates:

1. The owner checks the parcel (the same weight and size box as the Shiprocket
   dialog, already filled in) and taps **Get Amazon prices**.
2. The page shows each Amazon service it is offered, with **its price in rupees and
   the expected delivery date**. Nothing is booked or charged yet.
3. The owner taps **Book this one**. Amazon books the parcel and the page opens the
   **shipping label** to print. The order moves to **With courier**, and the
   customer gets the usual "your order has shipped" email with an Amazon tracking
   link.
4. **Refresh from Amazon** on the order reads the latest tracking. When Amazon
   says delivered, the order moves to **Delivered** and the customer's Beanies are
   earned, the same as a Shiprocket order.
5. Until the courier collects it, the owner can **Cancel the Amazon label**. The
   order goes back to **To ship**, and can then go by Amazon again or by
   Shiprocket.

## Decisions (owner, 2026-11-20)

| Topic | Decision |
|---|---|
| Shiprocket or Amazon | Both, side by side. The owner chooses for each order. |
| Which Amazon service | The page shows prices and delivery dates first; the owner picks one. Nothing is booked automatically. |
| Whose Amazon account | The café's own Amazon Shipping account (not Amazon as a courier inside Shiprocket). |

## Money: what changes and what doesn't

- **The customer's bill does not change.** Shipping on the website stays as it is
  (free from ₹749). Which courier the owner picks afterwards is invisible to the
  price the customer paid.
- **What the café pays for shipping** comes out of the Amazon Shipping account
  (its wallet or its billing, however that account is set up), not the Shiprocket
  wallet.
- Worked example: a customer buys 3 jars for ₹749 and pays ₹0 shipping. The owner
  taps Get Amazon prices and sees, say, "Standard · ₹62 · by Tue 24 Nov" and
  "Express · ₹95 · by Sun 22 Nov" (example figures; the real ones come from
  Amazon). The owner books Standard. The customer still paid ₹749; Amazon charges
  the café ₹62. The order card shows "Amazon Shipping · Standard · ₹62" so the
  owner can see what each parcel cost.
- **Declared value.** The parcel is declared to Amazon at what the customer paid
  for the goods (after offers, coupons and Beanies), never the pre-discount price.
  This is the same lesson as order HIOC-S1004 on Shiprocket.
- **Cancelling a label** before pickup: Amazon gives the charge back to the café's
  Amazon account under Amazon's own rules. The customer's payment is untouched. To
  refund the customer, use the order's existing **Cancel order**, which also
  cancels the Amazon label if the parcel hasn't been collected.

## What the owner sees

**To ship tab**, on each paid order card:

- **Send to Shiprocket** (unchanged).
- **Ship with Amazon Shipping** (new). It opens a dialog:
  - the parcel, filled in from the order (editable, same limits as today);
  - **Get Amazon prices** → a list of services, cheapest first: service name,
    price in ₹, expected delivery date;
  - **Book this one** on each. One booking at a time: a double tap can't book
    twice;
  - after booking: **Print label** (opens the label PDF) and a note "Hand it to
    the Amazon pickup with the label stuck on the box".
- If Amazon has no service for that pincode, the dialog says so in plain words,
  and the owner can use Shiprocket instead.
- If Amazon Shipping isn't set up yet, the button explains which settings are
  missing, the same way the Shiprocket button does today.

**With courier tab**, on an Amazon order:

- "Amazon Shipping · *service* · ₹*charge*", the tracking number, Amazon's
  latest tracking status;
- **Refresh from Amazon**, **Print label**, **Cancel the Amazon label** (only
  before pickup), and the existing **Mark delivered by hand** and **Cancel order**.

**The customer** (email, order page, their account):

- the same "shipped" email, with "Amazon Shipping" as the courier and an Amazon
  tracking link instead of the Shiprocket one. Nothing else changes for them.

**CSV export** adds two columns: carrier (Shiprocket / Amazon Shipping) and what
the café paid Amazon for the label.

**Staff at the counter:** nothing changes. This is only on the owner's shop page.

## Out of scope

- Choosing Amazon automatically, or comparing Amazon and Shiprocket prices side by
  side in one list. (Shiprocket's prices are still picked in its own panel.)
- Cash on delivery. The shop is prepaid only.
- Booking pickups from this page. Collection follows whatever pickup arrangement
  the café's Amazon Shipping account has (for example a daily pickup). The owner
  confirms that with Amazon.
- Customers choosing a courier at checkout.
- Amazon as a courier inside Shiprocket. That needs no build: in the Shiprocket
  panel, Amazon Shipping can be picked as the courier as today.
- Returns (reverse pickups).

## The owner's steps (before it can work)

These are the owner's own steps. A role does one only when the owner asks for
that exact step in the conversation.

1. **Get API access on the Amazon Shipping account.** In Amazon Shipping (India),
   ask for API / developer access for "direct integration (not an Amazon
   marketplace seller)", register an app, and authorise it for the café's own
   account. That gives three values: a **Client ID**, a **Client Secret** and a
   **Refresh Token**. If the screens aren't obvious, Amazon Shipping's support or
   account manager can switch API access on.
2. **Check the ship-from address** saved in Amazon Shipping is the café's pickup
   address, and that a pickup arrangement is in place.
3. **Run the database file** (it will be in `supabase/`, named in the pull
   request) in the Supabase SQL editor on **Hioc India**, not Hioc Coffee.
4. **Add the settings in Vercel** (Project → Settings → Environment Variables,
   Production): `AMAZON_SHIPPING_CLIENT_ID`, `AMAZON_SHIPPING_CLIENT_SECRET`,
   `AMAZON_SHIPPING_REFRESH_TOKEN`, and the ship-from details the pull request
   lists. These are secrets: they go only into Vercel, never into a chat or a
   file.
5. **Merge the pull request** when you are happy, and try one real order: book the
   cheapest service, print the label, then cancel the label to see it go back to
   To ship.

## For the engineers

Order of work: `database-engineer` first, then `orders-payments-engineer`
(the Amazon client and the owner routes, since they change an order's status and
the courier record), then `web-engineer` (the dialog and the card). One branch.

### Database (`supabase/2026-11-shop-amazon-shipping.sql`, additive, safe to re-run)

- `shop_orders.carrier text check (carrier in ('shiprocket','amazon'))`, null
  until sent. Existing rows with `shiprocket_order_id` count as Shiprocket.
- `amazon_shipment_id text`, `amazon_rate_id`/`amazon_request_token` are **not**
  stored (they expire); `amazon_service_name text`, `amazon_charge_inr
  numeric(10,2)`, `amazon_status text`, `amazon_booking_at timestamptz` (the
  short claim against a double booking, like `shiprocket_sending_at`).
- The tracking number goes in the existing `awb_code`, the courier in
  `courier_name` ("Amazon Shipping").
- Status: an Amazon booking moves `paid` → `shipped` directly (it has a tracking
  number at once). Cancelling the label before pickup moves `shipped` → `paid`
  and clears the Amazon fields, `awb_code`, `courier_name`, `carrier`. No new
  status value, so the tabs and the customer's view keep working.
- Server-only writes (service role); `shop_orders` keeps its lockdown. Update
  `scripts/verify-db.mjs`. Until the file is applied the Amazon button stays
  hidden and everything else works as before.

### Amazon client (`lib/shop/amazonShipping.ts`, like `lib/shop/shiprocket.ts`)

- REST over fetch, no SDK, `server-only`, every function returns a result and
  never throws, a missing setting reads as a clear message.
- Amazon Shipping API v2 (direct integration, India). **Confirm every path, field
  and header against Amazon's current docs before writing them**; the docs site
  could not be reached from the session that wrote this spec. Expected:
  - Login with Amazon token: refresh-token grant with the client id and secret;
    the access token lasts about an hour; cache it per instance and renew on 401.
  - Header `x-amzn-shipping-business-id: AmazonShipping_IN` on every call (the
    API's default is not India), plus the access token.
  - Get rates (`shipFrom` from settings, `shipTo` from the order, one package with
    the confirmed parcel, items with the line names and SKUs, declared value =
    what the customer paid for the goods, channel "external"); purchase from a
    chosen rate (label as PDF); get tracking; get shipment documents (reprint);
    cancel shipment.
- Pure, tested builders: the rates request from an order and parcel, parsing of
  rates (cheapest first, ₹ and delivery date), of a purchase, of tracking, and the
  map from Amazon's tracking status to ours (delivered → `delivered`; nothing
  moves an order backwards).
- `trackingUrl` becomes carrier-aware: Amazon's public tracking page for
  `carrier = 'amazon'`, Shiprocket's as today otherwise.

### Owner routes (owner only, under `app/api/owner/shop/orders/[id]/amazon/`)

- `POST rates`: body = parcel (or none for the default). Paid, unsent orders only.
  Returns the list. Books nothing.
- `POST book`: body = parcel + the chosen `rateId` + `requestToken` from the rates
  answer. Claims the order (`amazon_booking_at`), purchases, saves, sends the
  shipped email after the response. On failure, releases the claim and says why.
  If Amazon booked but saving failed, say so plainly with the shipment id ("don't
  book again"), as the Shiprocket route does.
- `GET label`: returns the label PDF for an Amazon order (owner only, not cached).
- `POST refresh`: reads tracking, maps the status, earns Beanies on delivered
  through the existing path.
- `POST cancel-label`: only before pickup; cancels in Amazon, then returns the
  order to `paid`.
- The existing **Cancel order** route also cancels an Amazon label that hasn't
  been collected, as it does for a Shiprocket order.

### Screens (`components/owner/shop/ShopOrderCard.tsx`, `app/owner/shop/page.tsx`)

- The dialog and card changes described under "What the owner sees". Owner-facing
  words only, no API terms. Works on a phone.

## Acceptance checks

1. With the Amazon settings missing, a paid order shows **Ship with Amazon
   Shipping** with a plain note naming the missing settings, and Send to
   Shiprocket still works.
2. **Get Amazon prices** lists services cheapest first, each with ₹ price and
   delivery date, and books nothing (tests: the route makes no purchase call).
3. **Book this one** books once even on a double tap; the order moves to With
   courier with "Amazon Shipping", the service, the ₹ charge and a tracking
   number; the customer's email has the Amazon tracking link.
4. The declared value sent to Amazon equals what the customer paid for the goods
   (test with an order that has an offer, a coupon and Beanies).
5. **Refresh from Amazon** with a delivered tracking answer moves the order to
   Delivered and earns Beanies once; an in-transit answer never moves it
   backwards.
6. **Cancel the Amazon label** before pickup returns the order to To ship with the
   Amazon fields cleared; after pickup the button isn't offered.
7. Shiprocket orders behave exactly as before (the existing shop tests pass
   unchanged).
8. No key, token or full URL of a private service is in the repository; the
   security gate ends `RESULT: PASS` and the security reviewer passes the branch.
