# Instant Coffee shop — order online, ship with Shiprocket

HIOC. Premium Instant Coffee (Signature Classic, Nutty Hazelnut, French Vanilla;
50 g jars) sold on the website, paid by Razorpay, shipped with Shiprocket.
Only the owner sees these orders.

## The rules

| | |
|---|---|
| Price | ₹399 a jar, any mix of flavours (from `shop_products`, not the browser) |
| Shipping | ₹49 an order for 1–2 jars, **free from 3 jars** (`lib/shop/pricing.ts`) |
| Payment | Prepaid only, Razorpay (UPI, cards, netbanking). No cash on delivery |
| Order size | Up to 12 jars online; more is a wholesale enquiry |
| Launch offer | The poster's 1 for ₹299 / 2 for ₹499 / 3 for ₹599 stays a **counter** offer (the café's Promotions → Offers). The website says so |

## How it works

```
Customer: /shop → flavours + address → Pay (Razorpay)
            │
            ▼  verify / webhook / order-page poll (whichever first)
shop_orders: payment_pending → paid ──── email: owner "New online order", customer "Confirmed"
            │
Owner: /owner/shop → "Send to Shiprocket" (checks weight & box size)
            ▼
         sent_to_shiprocket  ── in the Shiprocket panel: choose courier, print label, schedule pickup
            │  "Refresh from Shiprocket" reads the AWB back
            ▼
         shipped ──── email: customer "Shipped" with the tracking link
            ▼
         delivered
   (any paid state) → "Cancel & refund" → cancelled, full refund via Razorpay
```

- Shop orders live in their **own tables** (`shop_products`, `shop_orders`),
  not the café's `orders`. They never reach the counter board, KOT printing,
  the cash day, Beanies, stock, or the café's Reports and GST. They are counted
  on `/owner/shop` and in its **Download CSV** (for the accountant).
- Razorpay: the same keys and the **same webhook URL** as café orders. The
  webhook asks "is this a shop order?" first (`lib/shop/payments.ts`) and
  otherwise handles café orders exactly as before.
- Shiprocket: the one click creates the order in Shiprocket ("custom order").
  That spends nothing. Courier choice, label and pickup happen in the
  Shiprocket panel, as usual. If the API isn't set up or is down, **Mark
  shipped by hand** takes an AWB from anywhere.
- The customer's order page `/shop/order/<id>` shows status and tracking, but
  not the street address, phone or email (the link is the only key).

## Launch checklist (owner)

1. **Database** — Supabase → SQL Editor → run
   `supabase/2026-11-instant-coffee-shop.sql`. Then `npm run verify:db`
   (look for `SHOP-1`).
2. **Razorpay** — keys already set for café payments are enough. Make sure the
   webhook (Dashboard → Webhooks → `https://hioc.in/api/payments/webhook`,
   events `payment.captured`, `order.paid`, `payment.failed`) is on: it catches
   payments when a customer closes the tab early. **Tell Razorpay support** you
   now also sell packaged coffee shipped across India, so payments aren't
   flagged as outside your approved business.
3. **Shiprocket**
   - Panel → Settings → API → Configure → **create an API user** (a
     *different* email from your main login).
   - Panel → Settings → Pickup addresses: note the pickup address **nickname**.
   - Recharge the Shiprocket wallet.
   - In Vercel: `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`, and
     `SHIPROCKET_PICKUP_LOCATION` (if the nickname isn't `Primary`).
4. **Parcel size** — weigh one packed box of 1, 2 and 3 jars and correct
   `defaultPackage()` in `lib/shop/catalog.ts` (starting guess: 0.1 kg box +
   0.3 kg a jar). The owner can change it per order in the send dialog anyway.
5. **Words on the website** — check and adjust, then they go live with the flag:
   - dispatch and delivery times: `DISPATCH_WITHIN` (2 working days) and
     `DELIVERY_TAKES` (3–7 working days) in `lib/shop/catalog.ts`;
   - the shop section of **Refund & Cancellation** (damaged items within 48
     hours with a photo, no returns of opened jars, cancel until shipped);
   - the **Shipping & Delivery** shop section.
6. **Packaged-food details** — the product page shows net quantity, MRP
   (inclusive of all taxes), the seller and customer care. Add the
   **manufacturer / packer name and address** and **country of origin** as
   printed on the jar label, and confirm with your FSSAI consultant that your
   licence covers selling packaged coffee by post.
7. **GST** — jars shipped are goods (not café service), and other states mean
   IGST. Confirm the rate and invoicing with your CA. The ₹399 is the
   all-inclusive price.
8. **Emails** (optional but recommended) — with `RESEND_API_KEY` /
   `RESEND_FROM` set, the owner gets "New online order" and the customer gets
   confirmation / shipped / refund emails. `SHOP_ALERT_EMAILS` adds more
   recipients (e.g. whoever packs).
9. **Switch on** — `NEXT_PUBLIC_FLAG_SHOP=true` in Vercel, redeploy. This shows
   `/shop`, the **Shop** link in the header, **Order online** on the home-page
   popup, **Shop orders** in the owner nav, and the shop wording on the policy
   pages (Shipping & Delivery, Refund & Cancellation, Terms, Privacy).
10. **Test once with a real ₹ payment** (1 jar), send it to Shiprocket, refresh,
    then cancel & refund it — and check the emails arrive.

`/owner/shop` works before step 9, with a setup checklist at the top.

## Owner page

- Tabs: **To ship** (oldest paid first) · With courier · Delivered · Cancelled
  · Unpaid (abandoned checkouts — no money taken, nothing to do).
- On each order: Copy address · Send to Shiprocket · Refresh from Shiprocket ·
  Mark shipped by hand (AWB + courier) · Mark delivered · Cancel & refund.
- Flavours in stock: switch a flavour off when it runs out.
- Download CSV: every paid order with address, items, amounts, refund,
  Razorpay payment id, Shiprocket id and AWB.

## Not verified yet

The Shiprocket client (`lib/shop/shiprocket.ts`) follows Shiprocket's
published API (auth/login, orders/create/adhoc, orders/show, orders/cancel) and
reads its answers loosely, but it hasn't been run against a live account (the
docs host wasn't reachable from the build environment). Do step 10 before the
first real customer; if Shiprocket answers differently, the error is shown on
the order card and "Mark shipped by hand" still works. The tracking link uses
`https://shiprocket.co/tracking/<AWB>`.

## Files

- `supabase/2026-11-instant-coffee-shop.sql` — tables, seed, lockdown
- `lib/shop/` — pricing, address checks, status rules, Shiprocket client,
  Razorpay capture, emails, data access
- `app/shop/`, `components/shop/` — the customer pages
- `app/api/shop/` — checkout, verify, order status
- `app/owner/shop/`, `components/owner/shop/`, `app/api/owner/shop/` — owner
- `app/api/payments/webhook/route.ts` — shared webhook, shop first
- `tests/shop*.test.ts`
