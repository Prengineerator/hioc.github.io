# Owner-entered shop orders ("New order" on /owner/shop)

Product owner spec, 2026-11-19. Builds on `docs/SHOP-V2-SPEC.md` and the shop
manual `docs/INSTANT-COFFEE-SHOP.md`.

## The short answer

When a customer calls or WhatsApps for jars or Home Blend to be shipped, the owner
opens **/owner/shop → New order** and types in the order:

- who it is for: name, phone, email (optional) and address;
- what they want: the same products, packs and grinds as the website;
- how they pay. The owner picks one:
  - **Send a payment link.** Razorpay texts and emails the customer a link. The
    order waits, unshipped, until it is paid.
  - **Already paid.** The money came by UPI to the café, cash or bank transfer.
    The owner records how and adds a reference. The order is ready to ship at
    once.

The order is priced by the **same rules as the website**:

- the introductory offer, once per customer;
- shop coupons;
- free shipping from ₹749.

The owner can also give an **owner discount with a reason**. The order then joins
the normal shop list (To ship → Shiprocket → Delivered). It appears in the
customer's account if their phone or email matches one. It earns Beanies once
delivered, the same as a website order.

## Decisions (owner, 2026-11-19)

| Topic | Decision |
|---|---|
| Kind of order | Shipped shop orders only. Café orders (pickup or dine-in) stay on the counter till. |
| Payment | Chosen for each order: a Razorpay payment link, or already paid (UPI to the café, cash or bank transfer) with a reference. |
| Pricing | The website's rules, plus an optional owner discount with a reason. |
| Who can use it | The owner account, the same as everything else under `/owner`. |

## What the owner sees

**/owner/shop** gets a **New order** button at the top. It opens one page, on a
phone or a laptop, in this order:

1. **Customer.**
   - Phone first: a 10-digit Indian mobile number.
   - When the owner types it, the page offers that customer's **saved addresses
     and the details from their last shop order** (if any), with "Use this". That
     covers a returning customer without retyping.
   - Otherwise there is the same address form as the website: name, address
     lines, landmark, pincode (which fills in the state), city, state.
   - Email is optional. Without one, the customer gets no confirmation email, and
     the payment link goes by text only.
2. **Items.** Every listed, in-stock product with a stepper:
   - the jars by flavour;
   - Home Blend by pack, with a required grind on each line, the same choices as
     the website.
3. **Bill**, worked out by the server as items change:
   - subtotal;
   - introductory offer **or** coupon, whichever saves more;
   - owner discount;
   - shipping;
   - total.

   There is an optional coupon code box. Beanies are **not** offered here,
   because the customer isn't signed in to agree to spend them.
4. **Owner discount** (optional):
   - an amount in ₹ and a reason, which is required when there is an amount (for
     example "regular customer", "damaged last parcel");
   - at most **50% of the goods** after offers;
   - it can't bring the total below ₹1.
5. **Payment.** Two big choices:
   - **Send payment link.** Razorpay sends it by SMS (and by email if there is
     one). The page also shows the link with a **Copy** button and a **Share on
     WhatsApp** button, so the owner can paste it into the chat. The link is good
     for **48 hours**.
   - **Already paid.** The owner picks how (UPI to café / Cash / Bank transfer)
     and types a reference: a UPI transaction id or a note, 3 to 60 characters.
6. **Create order.** Then the order card opens, showing the order number.

**In the order list:**
- A hand-entered order carries an **"Added by owner"** tag.
- An order that is waiting for its link to be paid shows under a new **Awaiting
  payment** tab, with **Resend link**, **Copy link** and **Cancel**.
- Once the link is paid, the order moves to **To ship** by itself. Razorpay tells
  the site through the existing webhook.
- An "already paid" order goes straight to **To ship**.
- The CSV gains these columns: source (website / owner), payment method,
  payment reference, owner discount and owner discount reason.

## Worked examples (₹)

1. **A first-time customer.**
   - The order: 2 × Home Blend 250 g (Filter) and 1 Signature Classic jar.
   - Goods: 2 × ₹525 + ₹399 = **₹1,449**.
   - The introductory offer applies to instant jars only. One jar is ₹399 either
     way, so it saves nothing.
   - Shipping is free (₹749 or more).
   - The owner adds a ₹100 discount, reason "launch week friend".
   - **Total ₹1,349.**
2. **A first-time customer, 2 jars** (Hazelnut and Vanilla).
   - Goods: **₹798**.
   - The introductory offer (2 for ₹599) takes off **₹199**.
   - Goods after the offer: ₹599, which is under ₹749, so shipping is **₹49**.
   - **Total ₹648**, exactly what the website charges.
3. **A repeat customer, 1 kg Home Blend** (Espresso).
   - Goods: **₹1,750**.
   - The introductory offer has already been used, and no coupon is entered.
   - Shipping is free.
   - Paid by UPI to the café, with reference `UPI 4321…`.
   - **Total ₹1,750.** It goes straight to To ship.

## Rules that keep it safe

- **The server prices every order.** It uses the same pure pricing function as
  the website (`quoteShopCart`), with the owner discount added as a step after
  offers and coupons and before shipping. The page only displays the server's
  quote.
- **No double orders.** The page sends one idempotency key per attempt, the same
  as the website checkout.
- **Introductory offer, once per customer.** Eligibility uses the same check, by
  phone, email and any matching account. An "already paid" order claims the
  offer when it is created. A link order claims it when the link is paid.
- **The account link.** If the phone or email matches a customer account, the
  order is linked to that account. It shows in their account under **Shop**, and
  its Beanies are earned on delivery.
- **Recorded in the database:**
  - `source` (website or owner) and who created the order;
  - the payment method and reference;
  - the owner discount and its reason;
  - the payment-link id, URL and expiry.

  The discount split stays enforced in SQL: total discount = offer + coupon +
  Beanies + owner discount.
- **Payment links.** The link is created with Razorpay's Payment Links API, using
  the same keys the site has today.
  - A paid link marks the order paid through the existing webhook, in the same
    idempotent capture path as website orders: emails, intro claim and coupon
    redemption.
  - An unpaid link **expires after 48 hours**. The order then becomes
    **Expired**, and nothing was charged. The 30-minute expiry used for website
    checkouts does **not** apply to link orders.
- **Cancel.**
  - An unpaid link order can be cancelled, which also cancels the link.
  - A paid order is cancelled and refunded as today. A Razorpay-paid order is
    refunded through Razorpay. For an already-paid order (UPI, cash or bank), the
    page records "refund by hand" and reminds the owner to send the money back,
    because the site never held it.
- **Messages to the customer.**
  - Razorpay sends the payment-link SMS and email. Razorpay doesn't charge for
    these. Its normal payment fee applies when the customer pays, the same as
    website payments.
  - The site's own "order confirmed" and "shipped" emails go only when an email
    was entered.
  - No WhatsApp message is sent automatically. The WhatsApp button only opens
    WhatsApp on the owner's phone with the link filled in.

## Customer data

The page collects the same details the website checkout does: name, phone,
optional email and address, kept on the order like any shop order. Only the owner
account can open `/owner`. Saved-address suggestions are read on the server for
the phone number the owner typed, and are never sent anywhere else.

## Out of scope

- Café orders (pickup or dine-in) from the owner area.
- Cash on delivery.
- Spending Beanies on an owner-entered order.
- Staff or managers adding shop orders: owner account only.
- Editing an order after it is created. Cancel it and add it again.

## Steps that are the owner's

1. **Database.** Run the new SQL file (to be added in `supabase/`) on **Hioc
   India** before the code is deployed.
2. **Razorpay.**
   - Check that **Payment Links** is enabled on the Razorpay account (Dashboard →
     Payment Links).
   - Add the event `payment_link.paid` (and `payment_link.expired`,
     `payment_link.cancelled`) to the existing webhook at
     `https://hioc.in/api/payments/webhook`.
3. **Staff.** No change at the counter.
