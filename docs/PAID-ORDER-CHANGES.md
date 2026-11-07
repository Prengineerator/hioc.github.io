# Changing a dine-in order after it is paid

**Owner request (2026-11):** a table pays up front, then wants one more coffee,
or to take the brownie off. Until now every change refused a paid bill ("This
order is already paid — start a new order"), so the counter had to cancel the
order and punch a new one.

Now a **paid dine-in bill** can be changed like an unpaid one — while it is
open, **and after it has been marked Completed, on the same day it was placed**
(tables are usually marked Completed once served, and ask for more after). The
difference is kept on the bill as a **balance** and settled later.

## Setup (once)

Run `supabase/2026-11-paid-order-changes.sql` in the Supabase SQL editor before
deploying. Until it is applied, changing a paid bill is refused with a message
that names the file. Nothing else changes.

## How the counter uses it

Open the order from **Orders** (the "Orders" list shows Completed ones too —
use its Completed filter) or from **Tables**, then:

| The table wants…            | Do this                                                   | Result on the bill                          |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| one more item               | **+ Add items**                                           | Kitchen gets a ticket for just the new items · **balance to collect**. A Completed order goes back to Preparing. |
| an item taken off           | **Void** on the line, or **Edit order** → **Remove**      | **To give back**                            |
| fewer of something          | **Edit order** → **−**                                    | **To give back**                            |
| a different item instead    | **+ Add items** (the new one) first, then remove the old one | The difference either way               |

The only item on a bill can't be removed on its own (that would empty it):
add the replacement first, then remove it — or cancel the order and refund it.

If these buttons don't show on a counter screen that has been open since
before the update, use **Reload app** (account menu, or Ctrl+R).

The bill is recalculated (GST, offers, discounts) exactly as it is for an unpaid
order. Several changes add up into one balance: +₹150 then −₹120 leaves ₹30 to
collect.

Bills with a balance show on the board as **Paid · ₹130 due** / **Paid · ₹105
back**, and on **Settle** next to the unpaid bills:

- **Collect ₹130** — the usual payment step (cash with change, UPI, card, dining
  app, split, ±₹5 round-off), for the balance only. The new money is recorded
  beside what was paid before; nothing is replaced.
  - **Let it go…** — the customer left without paying the difference. Recorded
    as a settlement discount with a reason (a manager for more than ₹50, as for
    any short settle).
- **Give back ₹105** — choose which tender it goes back on (you can't hand back
  more cash than was paid in cash). Recorded as a counter refund, so the drawer
  expects that much less cash. Needs the **Refund** permission (manager by
  default). The bill stays **Paid**.

An order with money still **owed** can't be completed until the balance is
collected (or let go) — the same rule as an unpaid bill. Money owed **back**
does not hold the order. The day-close screen lists bills with money owed among
its "unpaid" warnings.

## What is not covered

- **Completed bills from an earlier day** stay locked: a closed day's sales,
  cash and GST are not rewritten.
- On a **Completed** bill, what completing did stays as it was: the stock its
  items used stays taken (removing one later doesn't put it back), the Beanies
  earned stay earned, and its bill/feedback messages aren't sent again.
- **Takeaway and delivery** bills stay locked once paid, as before.
- **Bills paid online** (website / table QR, through the payment gateway) stay
  locked: that payment can only be refunded through the gateway.
- **Change payment** (re-recording how a bill was paid) is not offered once a
  paid bill has been changed: its tenders were taken at different times.

## How the money stays exact (for whoever maintains this)

- The order stays `payment_status = 'paid'` throughout. The HIOC Ritual and
  `paid_at` triggers act on the move *into* `paid`; flipping back to `unpaid`
  and settling again would redeem cups twice.
- `orders.balance_due_inr` (signed) holds the difference; `paid_amended_at`
  marks the first change.
- The first change writes the original single counter tender as an
  `order_payments` row (same method, amount and `paid_at`), so the drawer,
  reports and refund cap — which prefer tender rows over `total_inr` — keep
  counting what was really taken. Collected balances add rows; given-back
  balances add `refunds` rows.
- Rules: `lib/orders/paidChange.ts`. Changes: `POST /api/orders/[id]/amend`.
  Settling: `POST /api/orders/[id]/balance`. Tests: `tests/paidChange.test.ts`,
  `tests/amendPaid.test.ts`, `tests/orderBalance.test.ts`.
