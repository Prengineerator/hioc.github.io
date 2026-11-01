-- ===========================================================================
-- Manager discount: a manager (or the owner) types an amount and a reason at
-- the POS, and that many rupees come off the bill.
--
--   orders.manual_discount_inr     The rupees the manager took off. It is INSIDE
--                                  discount_inr (like offer_discount_inr), so
--                                    total_inr = subtotal_inr + tax_inr
--                                              + packaging_inr - discount_inr
--                                              - pass_discount_inr
--                                  is unchanged and GST is charged on the bill
--                                  after it, as for a coupon.
--   orders.manual_discount_reason  Why — always given with the discount.
--   orders.manual_discount_by      The manager or owner who gave it.
--
-- The rules live in lib/orders/manualDiscount.ts and lib/orders/billPricing.ts.
-- It comes off last: after HIOC Ritual cups, offers, a coupon and Beanies, and
-- never more than the bill has left. POST /api/orders refuses it from anyone
-- who isn't a manager or the owner. A void or edit on the order keeps it
-- (lowered only when the bill falls below it).
--
-- Safe to apply before or after the app update that reads it: the columns are
-- only written on an order that has a manager discount. Safe to re-run.
-- ===========================================================================

alter table orders add column if not exists manual_discount_inr integer not null default 0
  check (manual_discount_inr >= 0);
alter table orders add column if not exists manual_discount_reason text not null default '';
alter table orders add column if not exists manual_discount_by uuid references auth.users(id) on delete set null;

-- Owner reports look up "which orders had a manager discount" by date.
create index if not exists idx_orders_manual_discount
  on orders (created_at)
  where manual_discount_inr > 0;

-- ---------------------------------------------------------------------------
-- Verify:
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns
--    where table_name = 'orders'
--      and column_name in ('manual_discount_inr', 'manual_discount_reason', 'manual_discount_by');
--   -- expect 3 rows: integer 0 NOT NULL, text '' NOT NULL, uuid NULL.
--
--   -- Recent manager discounts:
--   select order_number, created_at, manual_discount_inr, manual_discount_reason, manual_discount_by
--     from orders where manual_discount_inr > 0 order by created_at desc limit 20;
-- ---------------------------------------------------------------------------
