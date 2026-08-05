-- ===========================================================================
-- Phase 4 · VAL-2 — link a counter order to a customer's loyalty account.
--
-- Decision D4-3, option (b). Two different questions were being asked of one
-- column, and answering both with `orders.user_id` would have corrupted the
-- answer to the first:
--
--   orders.user_id          = THE SESSION THAT PLACED THIS ORDER.
--                             Deliberately NULL on a staff order — the staff
--                             member is not the customer, and staff attribution
--                             lives in created_by (app/api/orders/route.ts).
--                             Phase-3 channel analytics and the guest-order
--                             claim (lib/account/claim.ts, which backfills
--                             user_id on orders with user_id IS NULL) both read
--                             it with that meaning. Setting it for a walk-in
--                             would reclassify every counter order as a
--                             logged-in web order and would make claim silently
--                             skip orders it should still be able to link.
--
--   orders.customer_user_id = WHOSE LOYALTY ACCOUNT THIS ORDER BELONGS TO.
--                             Set only by the server, only from a phone that
--                             matches a profile with phone_verified = true, and
--                             NEVER from a request body — a client that can name
--                             the beneficiary can spend anyone's points.
--
-- The loyalty ledger resolves the beneficiary as customer_user_id ?? user_id
-- (lib/loyalty/beneficiary.ts), so a linked counter order earns on completion
-- and reverses on reject/cancel exactly like a web order.
--
-- No backfill. Past counter orders are left unlinked on purpose: retro-crediting
-- points for orders whose customers were never told they were earning would
-- invent a liability out of history.
--
-- Safe to re-run. Apply BEFORE deploying the VAL-1/VAL-2 code.
-- ===========================================================================

alter table orders
  add column if not exists customer_user_id uuid references auth.users(id) on delete set null;

comment on column orders.customer_user_id is
  'VAL-2/D4-3: whose loyalty account this order belongs to. Server-derived from a VERIFIED phone only. Distinct from user_id, which is the session that placed the order (NULL for staff orders).';

-- Every earn/reverse reads it by order id, so no index is needed for that; this
-- one serves the other direction — "all orders belonging to this account",
-- which is what a customer's history and any future per-customer view ask.
create index if not exists idx_orders_customer_user_id on orders (customer_user_id);

-- ---------------------------------------------------------------------------
-- Verify:
--   -- 1. the column exists and is nullable with no default:
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_name = 'orders' and column_name = 'customer_user_id';
--
--   -- 2. the invariant D4-3 protects — staff orders keep user_id NULL:
--   select channel,
--          count(*)                                          as orders,
--          count(user_id)                                    as with_session_user,
--          count(customer_user_id)                           as linked_to_account
--     from orders
--    group by channel;
--   -- staff_pos MUST show with_session_user = 0. linked_to_account > 0 there is
--   -- VAL-2 working.
--
--   -- 3. a linked counter order actually earned:
--   select o.order_number, o.channel, o.total_inr, t.type, t.points
--     from orders o
--     join loyalty_transactions t on t.order_id = o.id
--    where o.customer_user_id is not null
--    order by o.created_at desc
--    limit 10;
-- ---------------------------------------------------------------------------
