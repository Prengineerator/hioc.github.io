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
-- part of a split) against the app that took the money, plus
-- `order_payments.reference` for the platform's booking / transaction ID.
-- `orders.payment_method`, `order_payments.method` and `refunds.method` are
-- all this enum already. Like UPI and card, neither value is drawer cash —
-- the cash-day math only ever counts method = 'cash'.
--
-- Safe to re-run. Apply BEFORE deploying the code that offers these buttons:
-- the payment route would otherwise pass validation and fail at the insert.
--
-- NOTE: `alter type ... add value` cannot run inside a transaction block that
-- also uses the new value. Run this file on its own.
--
-- The column MUST exist before the code deploys: every dining-app settle
-- writes it.
-- ===========================================================================

alter type payment_method add value if not exists 'swiggy_dineout';
alter type payment_method add value if not exists 'zomato_district';

-- The platform's booking / transaction ID, asked for at the counter on every
-- dining-app tender. It is what the owner matches each platform's payout
-- statement against, and what stops the same booking being settled twice.
-- Per TENDER, not per order: a bill split across an app and cash has one ID on
-- the app part and none on the cash part. Stored trimmed and upper-cased (the
-- route normalises), so a lookup is an exact match. Null for every other method.
alter table order_payments add column if not exists reference text;

create index if not exists idx_order_payments_reference
  on order_payments (method, reference)
  where reference is not null;

-- Each app's takings for a cash day, frozen at close next to upi_inr/card_inr
-- (2026-09-cash-day-handover.sql). Information only, never in the drawer math.
-- Null on a day closed before this migration. The code writes these in a
-- separate, best-effort update, so closing a day never depends on them.
alter table cash_days
  add column if not exists swiggy_dineout_inr  integer,
  add column if not exists zomato_district_inr integer;

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
--
--   -- every dining-app tender with its booking ID:
--   select o.order_number, p.method, p.reference, p.amount_inr, p.created_at
--     from order_payments p join orders o on o.id = p.order_id
--    where p.method in ('swiggy_dineout', 'zomato_district')
--    order by p.created_at desc limit 20;
-- ---------------------------------------------------------------------------
