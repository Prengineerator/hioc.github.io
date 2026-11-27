-- ===========================================================================
-- ONE-OFF DATA FIX: past app-paid orders go back to "App paid" (online)
--
-- Why: when a customer paid on hioc.in through Razorpay, the app overwrote
-- orders.payment_method from 'online' to Razorpay's sub-method ('upi' or
-- 'card'). Those orders then showed up in the counter's UPI and card totals,
-- although the money never passed through the counter. The code now keeps
-- orders.payment_method = 'online' (shown to staff as "App paid") and leaves
-- Razorpay's sub-method on the payments row only. This file moves the orders
-- already affected to 'online' too.
--
-- The owner runs this by hand in the Supabase SQL editor. No agent runs it.
-- Running the WHOLE file is safe: it only reads. The update (STEP 2) is
-- commented out and is run on purpose, after the preview.
--
-- What it changes: orders.payment_method, from 'upi' / 'card' to 'online',
-- and nothing else. An order is changed only when ALL of these hold:
--   * a payments row exists for it with gateway = 'razorpay' and
--     status = 'paid', AND the order's payment_method is exactly that row's
--     method (cast to text). So only orders still holding what the capture
--     wrote are changed. An order whose method differs was changed by staff
--     afterwards and is left alone.
--   * the order's paid_at is NOT clearly earlier than the capture, AND the
--     order was created on or after the first cash count (the earliest
--     cash_counts.created_at, from 2026-09-cash-counts.sql). Capture time is
--     payments.updated_at (the paid row's last write; payments has no separate
--     captured_at column). paid_at is stamped once by the database when an
--     order first becomes paid, but ONLY orders paid after that migration was
--     applied have a trustworthy one. For older orders the migration filled
--     paid_at with coalesce(updated_at, created_at), usually the order's last
--     write, which is AFTER the capture, so a counter-first order from that
--     time would pass the timing test. So older orders are not changed, and
--     they stay as UPI / Card. If no cash count exists yet, the cutoff is
--     null and nothing matches; that is the safe outcome (nothing changes).
--     STEP 1e lists the older orders.
--     For newer orders: if paid_at is more than 2 minutes before the capture,
--     the counter settled the bill first (for example the customer's gateway
--     payment stalled, they paid the counter's UPI QR, staff settled it, and
--     Razorpay captured later). Those are likely counter-first or double-paid
--     orders and are left as they are (STEP 1d). The 2 minute margin covers
--     the small gap between the app marking an order paid and the payments
--     row being written, and clock jitter, so normal app payments are not
--     skipped. An order with no paid_at is also left alone, because the order
--     of events cannot be shown.
--   * it has no order_payments row. Split and counter tenders write one
--     (2026-08-split-payments.sql). Note this is NOT enough on its own: a
--     single-tender counter settle deletes the order's order_payments rows and
--     writes none (lib/orders/settlePayment.ts), so a counter-settled order
--     can have none. The method and paid_at tests above cover that case.
--   * it has no counter refund (a refunds row with payment_id null,
--     2026-08-counter-refunds.sql). The counter refunded on a specific tender,
--     and the drawer math reads that tender against the order's method, so
--     changing the method would mis-state the till. Gateway refunds
--     (payment_id set) do not block the fix.
--
-- Left alone, on purpose:
--   * Shop orders. They live in their own table, shop_orders
--     (2026-11-instant-coffee-shop.sql), not in orders, so this file cannot
--     reach them.
--   * cash_days, payments, order_payments and refunds. None is written.
--   * The likely counter-first / double-paid orders above (STEP 1d) and the
--     older orders from before paid_at was reliable (STEP 1e). The owner can
--     look at them. This file does not change them, and they stay UPI / Card.
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
-- Closed cash days keep their frozen upi_inr / card_inr, but only until a day
-- is REOPENED: reopening a closed day recomputes its upi_inr / card_inr from
-- the orders, and the changed orders will then no longer count as UPI or card.
-- So "closed days do not change" holds only while the day stays closed.
--
-- Undo record: STEP 2 first copies every affected order's id and current
-- method into backup_20261127.app_paid_orders (same pattern as
-- 2026-09-delete-test-orders.sql). The undo statement is at the end of STEP 2.
--
-- Safe to re-run: once an order is 'online' it no longer matches, so a second
-- run changes 0 rows and the backup keeps the original methods.
--
-- HOW TO RUN (Supabase SQL editor, project "Hioc India"):
--   1. Run the file (or just STEP 1). It only reads. Look at 1a-1e.
--   2. If the numbers look right, delete the two marker lines around STEP 2
--      (the opening slash-star and closing star-slash) and run STEP 2 alone.
--      It is one transaction.
--   3. Run the Verify queries at the end.
--
-- Apply order: independent of the code release. Either order is fine.
-- Rollback: previous builds read the same column and value, so nothing breaks.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- STEP 1 — PREVIEW (read-only).
-- ---------------------------------------------------------------------------

-- 1a. What WOULD change: count and rupees by current method.
select o.payment_method, count(*) as orders, sum(o.total_inr) as total_inr
  from orders o
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id
                  and p.gateway = 'razorpay'
                  and p.status = 'paid'
                  and p.method::text = o.payment_method::text
                  and o.paid_at is not null
                  and o.paid_at >= p.updated_at - interval '2 minutes'
                  and o.created_at >= (select min(created_at) from cash_counts))
   and not exists (select 1 from order_payments op where op.order_id = o.id)
   and not exists (select 1 from refunds r
                    where r.order_id = o.id and r.payment_id is null)
 group by o.payment_method
 order by o.payment_method;

-- 1b. A sample of the rows that would change (newest first).
select o.order_number, o.created_at, o.paid_at, o.payment_method, o.payment_status, o.total_inr
  from orders o
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id
                  and p.gateway = 'razorpay'
                  and p.status = 'paid'
                  and p.method::text = o.payment_method::text
                  and o.paid_at is not null
                  and o.paid_at >= p.updated_at - interval '2 minutes'
                  and o.created_at >= (select min(created_at) from cash_counts))
   and not exists (select 1 from order_payments op where op.order_id = o.id)
   and not exists (select 1 from refunds r
                    where r.order_id = o.id and r.payment_id is null)
 order by o.created_at desc
 limit 20;

-- 1c. Razorpay-paid upi/card orders this fix will SKIP, and why (information).
--     An order can have several reasons; each flag is shown.
select o.payment_method,
       exists (select 1 from order_payments op where op.order_id = o.id) as has_order_payments,
       exists (select 1 from refunds r where r.order_id = o.id and r.payment_id is null) as has_counter_refund,
       not exists (select 1 from payments p
                    where p.order_id = o.id and p.gateway = 'razorpay' and p.status = 'paid'
                      and p.method::text = o.payment_method::text) as method_differs_from_capture,
       (o.paid_at is null
        or exists (select 1 from payments p
                    where p.order_id = o.id and p.gateway = 'razorpay' and p.status = 'paid'
                      and o.paid_at < p.updated_at - interval '2 minutes')) as paid_before_capture_or_unknown,
       (o.created_at < (select min(created_at) from cash_counts)
        or (select min(created_at) from cash_counts) is null) as older_than_reliable_paid_at,
       count(*) as orders
  from orders o
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id and p.gateway = 'razorpay' and p.status = 'paid')
   and not (
         exists (select 1 from payments p
                  where p.order_id = o.id and p.gateway = 'razorpay' and p.status = 'paid'
                    and p.method::text = o.payment_method::text
                    and o.paid_at is not null
                    and o.paid_at >= p.updated_at - interval '2 minutes'
                    and o.created_at >= (select min(created_at) from cash_counts))
         and not exists (select 1 from order_payments op where op.order_id = o.id)
         and not exists (select 1 from refunds r where r.order_id = o.id and r.payment_id is null))
 group by 1, 2, 3, 4, 5, 6;

-- 1d. Likely counter-first or double-paid orders, for the owner to look at.
--     Staff settled the bill at the counter more than 2 minutes before
--     Razorpay's capture (or paid_at is missing). They are LEFT AS THEY ARE.
--     (Orders older than the first cash count are listed in 1e instead,
--     because their paid_at is not reliable.)
select o.order_number, o.created_at, o.paid_at,
       p.updated_at as captured_at, o.payment_method, o.total_inr
  from orders o
  join payments p on p.order_id = o.id
                 and p.gateway = 'razorpay' and p.status = 'paid'
 where o.payment_method in ('upi', 'card')
   and o.created_at >= (select min(created_at) from cash_counts)
   and (o.paid_at is null or o.paid_at < p.updated_at - interval '2 minutes')
 order by o.created_at desc;

-- 1e. Older Razorpay-paid upi/card orders, from before paid_at can be trusted
--     (created before the first cash count, or no cash count exists yet).
--     They are LEFT AS THEY ARE and stay UPI / Card. Count and rupees, then rows.
select o.payment_method, count(*) as orders, sum(o.total_inr) as total_inr
  from orders o
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id and p.gateway = 'razorpay' and p.status = 'paid')
   and (o.created_at < (select min(created_at) from cash_counts)
        or (select min(created_at) from cash_counts) is null)
 group by o.payment_method
 order by o.payment_method;

select o.order_number, o.created_at, o.paid_at, o.payment_method, o.total_inr
  from orders o
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id and p.gateway = 'razorpay' and p.status = 'paid')
   and (o.created_at < (select min(created_at) from cash_counts)
        or (select min(created_at) from cash_counts) is null)
 order by o.created_at desc
 limit 50;

-- ---------------------------------------------------------------------------
-- STEP 2 — UPDATE (one transaction). The whole block is inside one comment
-- (opening marker: slash-star on its own line below; closing marker: star-slash
-- on its own line after the UNDO notes), so running the whole file only reads.
-- Run the preview first. Then delete those two marker lines and run the block
-- alone. The undo notes stay as "--" comments, so they cannot run by mistake.
-- The final select returns one row per order changed; the count should match
-- STEP 1a.
-- ---------------------------------------------------------------------------
/*
begin;

create schema if not exists backup_20261127;

create table if not exists backup_20261127.app_paid_orders (
  id             uuid primary key,
  payment_method payment_method,
  backed_up_at   timestamptz not null default now()
);

-- Undo record first: id and current method of every order about to change.
insert into backup_20261127.app_paid_orders (id, payment_method)
select o.id, o.payment_method
  from orders o
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id
                  and p.gateway = 'razorpay'
                  and p.status = 'paid'
                  and p.method::text = o.payment_method::text
                  and o.paid_at is not null
                  and o.paid_at >= p.updated_at - interval '2 minutes'
                  and o.created_at >= (select min(created_at) from cash_counts))
   and not exists (select 1 from order_payments op where op.order_id = o.id)
   and not exists (select 1 from refunds r
                    where r.order_id = o.id and r.payment_id is null)
on conflict (id) do nothing;

revoke all on schema backup_20261127 from anon, authenticated;
revoke all on all tables in schema backup_20261127 from anon, authenticated;

update orders o
   set payment_method = 'online'
 where o.payment_method in ('upi', 'card')
   and exists (select 1 from payments p
                where p.order_id = o.id
                  and p.gateway = 'razorpay'
                  and p.status = 'paid'
                  and p.method::text = o.payment_method::text
                  and o.paid_at is not null
                  and o.paid_at >= p.updated_at - interval '2 minutes'
                  and o.created_at >= (select min(created_at) from cash_counts))
   and not exists (select 1 from order_payments op where op.order_id = o.id)
   and not exists (select 1 from refunds r
                    where r.order_id = o.id and r.payment_id is null)
returning o.id, o.order_number, o.total_inr;

commit;

-- UNDO (only if the owner asks; restores the saved methods, and only for
-- orders still 'online'):
--   update orders o
--      set payment_method = b.payment_method
--     from backup_20261127.app_paid_orders b
--    where b.id = o.id
--      and o.payment_method = 'online';
*/


-- ---------------------------------------------------------------------------
-- Verify (read-only), after STEP 2:
--
--   -- Should return 0 rows: nothing eligible is still upi/card.
--   select o.order_number, o.payment_method
--     from orders o
--    where o.payment_method in ('upi', 'card')
--      and exists (select 1 from payments p where p.order_id = o.id
--                   and p.gateway = 'razorpay' and p.status = 'paid'
--                   and p.method::text = o.payment_method::text
--                   and o.paid_at is not null
--                   and o.paid_at >= p.updated_at - interval '2 minutes'
--                   and o.created_at >= (select min(created_at) from cash_counts))
--      and not exists (select 1 from order_payments op where op.order_id = o.id)
--      and not exists (select 1 from refunds r where r.order_id = o.id and r.payment_id is null);
--
--   -- The backup holds one row per changed order (matches the STEP 2 count):
--   select payment_method, count(*) from backup_20261127.app_paid_orders group by 1;
--
--   -- Every backed-up order now reads 'online' (should be 0 rows):
--   select o.order_number, o.payment_method
--     from orders o join backup_20261127.app_paid_orders b on b.id = o.id
--    where o.payment_method <> 'online';
--
--   -- payments keep Razorpay's sub-method (upi / card rows still present):
--   select method, count(*) from payments
--    where gateway = 'razorpay' and status = 'paid' group by method;
--
--   -- Closed cash days are untouched (until one is reopened):
--   select business_date, upi_inr, card_inr from cash_days
--    order by business_date desc limit 5;
--
--   -- Re-running STEP 2 should change 0 rows.
-- ---------------------------------------------------------------------------
