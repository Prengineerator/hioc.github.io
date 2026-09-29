-- ===========================================================================
-- Dining-app payments: Swiggy Dineout and Zomato District.
--
-- A diner who booked through Swiggy Dineout or Zomato District pays the bill
-- inside that app. The café never touches the money at the table — the
-- platform settles it to the café later, net of its commission. Until now the
-- counter had nowhere truthful to record that: marking it "Card" or "UPI"
-- inflates those tenders and hides how much of the takings are owed by each
-- platform.
--
-- Two new `payment_method` values, so the counter can settle a bill (or one
-- part of a split) against the app that took the money. Nothing else changes
-- shape: `orders.payment_method`, `order_payments.method` and `refunds.method`
-- are all this enum already. Like UPI and card, neither value is drawer cash —
-- the cash-day math only ever counts method = 'cash'.
--
-- Safe to re-run. Apply BEFORE deploying the code that offers these buttons:
-- the payment route would otherwise pass validation and fail at the insert.
--
-- NOTE: `alter type ... add value` cannot run inside a transaction block that
-- also uses the new value. Run this file on its own.
-- ===========================================================================

alter type payment_method add value if not exists 'swiggy_dineout';
alter type payment_method add value if not exists 'zomato_district';

-- ---------------------------------------------------------------------------
-- Verify:
--   select unnest(enum_range(null::payment_method));
--   -- expect: cash, upi, card, online, swiggy_dineout, zomato_district
--
--   -- takings per platform, for matching against each platform's payout:
--   select method, count(*), sum(amount_inr)
--     from order_payments
--    where method in ('swiggy_dineout', 'zomato_district')
--    group by method;
-- ---------------------------------------------------------------------------
