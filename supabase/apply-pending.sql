-- ===========================================================================
-- PENDING MIGRATIONS — the four `npm run verify:db` is still failing on.
--
-- Generated for convenience: the same four files, concatenated in dependency
-- order so they can be pasted into the Supabase SQL editor in ONE go. Every
-- one is individually idempotent, so re-running this whole file is safe.
--
-- Ordered by what it costs to leave undone:
--   1. refund-idempotency — a double-tapped Refund pays out TWICE, and the
--      bookkeeping row fails to insert after the gateway already moved money.
--   2. rate-limits-rls    — rate_limits is readable by the anon key shipped to
--      every browser; it reveals which keys exist and when to retry.
--   3. counter-loyalty    — a regular buying at the counter can neither earn
--      nor redeem.
--   4. auto-print         — the POS4-3 auto-print switches have nowhere to live.
--
-- Afterwards run `npm run verify:db` — it should print RESULT: PASS.
-- ===========================================================================



-- ======== 2026-08-refund-idempotency.sql ========

-- ===========================================================================
-- Phase 4 · REF-2 — a double-tapped Refund must not pay a customer twice.
--
-- `guard_refund_total` caps the TOTAL refunded against what was taken, but it
-- does not deduplicate: two identical ₹100 refunds against a ₹247 order are
-- each individually under the cap, so both commit. `refunds` has no unique
-- constraint of any kind. On a laggy tablet a manager taps Refund, sees nothing
-- happen, taps again — and ₹200 leaves the drawer.
--
-- Order CREATION got replay protection in POS4-2. Refunds move money OUTWARD
-- and had none.
--
-- The unique index is the hard guarantee; the route's 23505 branch turns a
-- duplicate into "here is the refund you already made" rather than an error.
-- Partial (`where ... is not null`) so historic rows, which have no key, don't
-- collide with each other.
--
-- Safe to re-run. Apply BEFORE deploying the REF-2 route.
-- ===========================================================================

alter table refunds add column if not exists idempotency_key text;

create unique index if not exists idx_refunds_idempotency
  on refunds (idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- Verify:
--   select count(*) filter (where idempotency_key is not null) as keyed,
--          count(*) as total
--     from refunds;
--
--   -- the index must be UNIQUE and partial:
--   select indexname, indexdef from pg_indexes
--    where tablename = 'refunds' and indexname = 'idx_refunds_idempotency';
-- ---------------------------------------------------------------------------


-- ======== 2026-08-rate-limits-rls.sql ========

-- ===========================================================================
-- SECURITY · rate_limits was the only table in the schema with no RLS.
--
-- `rate_limits` (phase2-hardening.sql §M10) backs the OTP abuse limiter. Every
-- other table enables row level security; this one never did, so the public
-- anon key could read the counters — and reading them is enough to learn which
-- keys exist and how close each is to its cap, i.e. exactly when to retry.
--
-- Nothing legitimate reads this table from a client. The limiter runs through
-- `check_rate_limit`, a SECURITY DEFINER function called server-side
-- (lib/api/rateLimit.ts), and SECURITY DEFINER functions are unaffected by RLS
-- on the tables they touch. So enabling RLS with NO policy — deny everyone —
-- leaves the limiter working and shuts the read.
--
-- Note the limiter deliberately FAILS OPEN if the RPC is missing
-- (lib/api/rateLimit.ts) so a partial deploy can't lock customers out of
-- checkout. That trade-off is unchanged here.
--
-- Safe to re-run.
-- ===========================================================================

alter table rate_limits enable row level security;

-- No policy is created on purpose: RLS with zero policies denies every
-- anon/authenticated request, while the service role and SECURITY DEFINER
-- functions still pass. If a policy is ever added here, re-read the comment
-- above first — there is no client that needs to read this table.

-- ---------------------------------------------------------------------------
-- Verify:
--   select relname, relrowsecurity from pg_class
--    where relname = 'rate_limits';   -- expect relrowsecurity = t
--
--   -- and that nothing was granted back:
--   select policyname from pg_policies where tablename = 'rate_limits';  -- expect 0 rows
--
-- Then confirm OTP still works end-to-end — the limiter must keep functioning.
-- ---------------------------------------------------------------------------


-- ======== 2026-08-counter-loyalty.sql ========

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


-- ======== 2026-08-auto-print.sql ========

-- ===========================================================================
-- Phase 4 · POS4-3 — auto-print the KOT on placement and the bill on settle.
--
-- Placing an order printed nothing. The kitchen only saw a ticket if a staffer
-- remembered to reopen the order in the queue and tap Print KOT — so on a busy
-- counter the rail stayed empty and the order was cooked off someone's memory.
-- The print pages already exist (/staff-print/[id]/kot|receipt); what was
-- missing was the cafe's answer to "should this fire on its own?".
--
-- Two switches, not one, because the two prints have opposite defaults:
--   auto_print_kot  — ON. Every kitchen wants its ticket; there is no cafe that
--                     wants an order cooked without one.
--   auto_print_bill — OFF. Plenty of counters hand over no paper unless asked
--                     (the WhatsApp bill is the receipt), and a printer firing
--                     on every settle wastes a roll a day.
--
-- Kept as store_settings columns rather than env vars so the owner can flip
-- them from the settings screen without a redeploy.
--
-- Safe to re-run. Apply BEFORE deploying the POS4-3 client — a missing column
-- is tolerated there (it falls back to these same defaults), so the order of
-- the two doesn't strand anyone.
-- ===========================================================================

alter table store_settings
  add column if not exists auto_print_kot boolean not null default true;

alter table store_settings
  add column if not exists auto_print_bill boolean not null default false;

-- ---------------------------------------------------------------------------
-- Verify:
--   select auto_print_kot, auto_print_bill from store_settings where is_singleton;
--   -- expect: t | f  on a fresh apply
--
--   -- the columns must be NOT NULL with the defaults above, or the client's
--   -- fallback and the stored value will disagree:
--   select column_name, is_nullable, column_default
--     from information_schema.columns
--    where table_name = 'store_settings'
--      and column_name in ('auto_print_kot', 'auto_print_bill');
-- ---------------------------------------------------------------------------
