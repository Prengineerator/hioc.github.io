-- ===========================================================================
-- "Send pickup reminder" on Ready orders.
--
-- Staff can resend the approved "order ready" WhatsApp (order_ready_1) to a
-- customer who has not collected their order. The rate limit is one reminder
-- per order per 5 minutes, and the card shows when the last one went out
-- ("Reminded 3 min ago"). Both need the send time stored on the order itself,
-- so the limit holds across tablets and refreshes rather than living in one
-- browser's memory.
--
--   orders.pickup_reminded_at  — when the last reminder was sent (null = never).
--
-- POST /api/orders/[id]/remind claims the cooldown with a single conditional
-- UPDATE (pickup_reminded_at is null or older than 5 minutes), so two staff
-- tapping at once cannot both send. No index: the column is only ever read
-- alongside the order's primary key.
--
-- Idempotent — safe to run more than once. Adds one nullable column; no
-- backfill, no data change, no RLS change (the route uses the service role,
-- like every other order write).
--
-- Verify:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'orders'
--      and column_name  = 'pickup_reminded_at';
--   -- expect one row: pickup_reminded_at | timestamp with time zone | YES
--
--   select count(*) from public.orders where pickup_reminded_at is not null;
--   -- expect 0 right after applying
-- ===========================================================================

alter table public.orders
  add column if not exists pickup_reminded_at timestamptz;

comment on column public.orders.pickup_reminded_at is
  'When staff last resent the "order ready" WhatsApp for this order. Null = never. Drives the 5-minute per-order cooldown on POST /api/orders/[id]/remind.';
