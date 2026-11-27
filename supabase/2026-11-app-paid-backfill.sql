-- ===========================================================================
-- ONE-OFF DATA FIX: past app-paid orders go back to "App paid" (online)
--
-- Why: when a customer paid on hioc.in through Razorpay, the app overwrote
-- orders.payment_method from 'online' to Razorpay's sub-method ('upi' or
-- 'card'). Those orders then showed up in the counter's UPI and card totals,
-- although the money never passed through the counter. The code now keeps
-- orders.payment_method = 'online' (shown to staff as "App paid") and leaves
-- Razorpay's sub-method on the payments row only. This file moves the orders
-- already affected to 'online' too. The owner approved this fix.
--
-- What it changes: orders.payment_method, from 'upi' / 'card' to 'online',
-- and nothing else. Only orders that have a payments row with
-- gateway = 'razorpay' and status = 'paid' are touched, and only if they
-- are not excluded below.
--
-- Left alone, on purpose:
--   * Orders with ANY order_payments row (split or counter-settled tenders,
--     2026-08-split-payments.sql). Their payment_method is the largest part
--     of a counter settlement, not a gateway overwrite.
--   * Orders with a counter refund (a refunds row with payment_id null,
--     2026-08-counter-refunds.sql). The counter refunded on a tender, and
--     the drawer math reads that tender against the order's method. Changing
--     the method under it would mis-state the till. Gateway refunds
--     (payment_id set) do not block the fix.
--   * Shop orders. They live in their own table, shop_orders
--     (2026-11-instant-coffee-shop.sql), not in orders, so this file cannot
--     reach them.
--   * cash_days (closed days keep their frozen upi_inr / card_inr), payments,
--     order_payments and refunds. None is written.
--
-- Triggers on orders that fire on UPDATE (searched every file in supabase/):
--   * trg_orders_updated_at (schema.sql): sets updated_at = now() on the rows
--     changed. Harmless. paid_at is the cash-count clock and is separate, so
--     the cash chain does not move.
--   * trg_orders_paid_at (2026-09-cash-counts.sql): fires only on
--     "update of payment_status, paid_at". Not on payment_method. Does not fire.
--   * trg_coffee_pass_complete_on_paid and trg_coffee_pass_issue_on_paid
--     (2026-10-coffee-pass.sql): fire only on "update of payment_status".
--     Do not fire.
--   * trg_coffee_pass_return_on_order (2026-10-coffee-pass.sql): fires only on
--     "update of status, payment_status" and only when one of them changed.
--     Does not fire.
--   * No loyalty, notification or version trigger exists on orders. Loyalty
--     and notifications are written by the app, not by the database.
-- So changing payment_method alone is harmless to every trigger.
--
-- What the owner sees afterwards: the affected orders read "App paid", and
-- the counter's UPI and card totals for OPEN days drop by those amounts.
-- Closed cash days do not change.
--
-- Safe to re-run: once an order is 'online' it no longer matches, so a second
-- run changes 0 rows.
--
-- HOW TO RUN (Supabase SQL editor, project "Hioc India"):
--   1. Run STEP 1 (preview) alone. Read the counts. Nothing is changed.
--   2. If the numbers look right, run STEP 2 (the update). It is one
--      transaction and shows how many rows it changed.
--   3. Run the Verify queries at the end.
--
-- Apply order: independent of the code release. Either order is fine.
-- Rollback: previous builds read the same column and value, so nothing breaks.
-- To undo, the update's returned ids (STEP 2) are the only record; copy them
-- before closing the editor if you want an undo list.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- STEP 1 — PREVIEW (read-only). Run this first.
-- ---------------------------------------------------------------------------

-- 1a. Count and rupees by current method.
select o.payment_method, count(*) as orders, sum(o.total_inr) as total_inr
  from orders o
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id
                  and p.gateway = 'razorpay'
                  and p.status = 'paid')
   and not exists (select 1 from order_payments op where op.order_id = o.id)
   and not exists (select 1 from refunds r
                    where r.order_id = o.id and r.payment_id is null)
 group by o.payment_method
 order by o.payment_method;

-- 1b. A sample of the rows that would change (newest first).
select o.order_number, o.created_at, o.payment_method, o.payment_status, o.total_inr
  from orders o
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id
                  and p.gateway = 'razorpay'
                  and p.status = 'paid')
   and not exists (select 1 from order_payments op where op.order_id = o.id)
   and not exists (select 1 from refunds r
                    where r.order_id = o.id and r.payment_id is null)
 order by o.created_at desc
 limit 20;

-- 1c. Razorpay-paid orders this fix will SKIP, and why (for information).
select o.payment_method,
       exists (select 1 from order_payments op where op.order_id = o.id) as has_order_payments,
       exists (select 1 from refunds r where r.order_id = o.id and r.payment_id is null) as has_counter_refund,
       count(*) as orders
  from orders o
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id and p.gateway = 'razorpay' and p.status = 'paid')
   and (exists (select 1 from order_payments op where op.order_id = o.id)
        or exists (select 1 from refunds r where r.order_id = o.id and r.payment_id is null))
 group by 1, 2, 3;


-- ---------------------------------------------------------------------------
-- STEP 2 — UPDATE (one transaction). Run after the preview looks right.
-- Returns one row per order changed; the count should match STEP 1a.
-- ---------------------------------------------------------------------------
begin;

update orders o
   set payment_method = 'online'
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id
                  and p.gateway = 'razorpay'
                  and p.status = 'paid')
   and not exists (select 1 from order_payments op where op.order_id = o.id)
   and not exists (select 1 from refunds r
                    where r.order_id = o.id and r.payment_id is null)
returning o.id, o.order_number, o.total_inr;

commit;


-- ---------------------------------------------------------------------------
-- Verify (read-only), after STEP 2:
--
--   -- Should return 0 rows: no Razorpay-paid, non-excluded order is still upi/card.
--   select o.order_number, o.payment_method
--     from orders o
--    where o.payment_method in ('upi', 'card')
--      and exists (select 1 from payments p where p.order_id = o.id
--                   and p.gateway = 'razorpay' and p.status = 'paid')
--      and not exists (select 1 from order_payments op where op.order_id = o.id)
--      and not exists (select 1 from refunds r where r.order_id = o.id and r.payment_id is null);
--
--   -- Should show the 'online' count grown by the number STEP 2 returned:
--   select payment_method, count(*) from orders group by payment_method order by 1;
--
--   -- payments keep Razorpay's sub-method (upi / card rows still present):
--   select method, count(*) from payments
--    where gateway = 'razorpay' and status = 'paid' group by method;
--
--   -- Closed cash days are untouched: compare a few against your records.
--   select business_date, upi_inr, card_inr from cash_days
--    order by business_date desc limit 5;
--
--   -- Re-running STEP 2 should change 0 rows.
-- ---------------------------------------------------------------------------
