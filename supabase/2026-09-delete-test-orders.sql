-- ===========================================================================
-- One-time POS cutover — delete every test order.
--
-- The owner is switching off Petpooja. Every row in `orders` so far (87 rows,
-- 16 Jul – 25 Sep 2026) was punched while shaking the system out on this repo's
-- own POS, not a real sale. Before Petpooja bill numbers continue into
-- orders.order_number, this history needs to be gone — but gone safely: back
-- up first, delete inside ONE transaction, verify, and keep the backup for a
-- week in case something downstream still needed a row.
--
-- Scope (grepped against every create table/alter table in supabase/*.sql):
--   DELETED (directly or via ON DELETE CASCADE from orders):
--     orders, order_items, order_item_addons, order_payments, payments,
--     refunds, order_status_events, notifications (order-linked only),
--     reviews, order_amendments, idempotency_keys (order-linked only),
--     coupon_redemptions (0 rows today), loyalty_transactions (order-linked
--     only — see SECTION 2), suggestion_sessions, suggestion_events,
--     customer_taste_profiles, suggestion_digests (SECTION 4).
--   RECOMPUTED, not deleted: loyalty_accounts.points_balance.
--   UNTOUCHED: profiles, auth.users, menu_items/variants/addons,
--     menu_item_traits, staff_*, attendance_*, payroll_*, leave_*,
--     store_settings, pos_devices, loyalty_config, coupons, rate_limits,
--     tables, cash_days/cash_counts/cash_movements (already empty).
--   NOT reset: the orders.order_number identity sequence
--     (public.orders_order_number_seq, currently at 1095). Petpooja's bill
--     numbers continue from here — resetting it would create a collision
--     the day it's done. See SECTION 3.
--
-- Every referencing FK was checked against the live DB before writing this:
--   coupon_redemptions/idempotency_keys/notifications/order_amendments/
--   order_items/order_payments/order_status_events/payments/refunds/reviews
--   → ON DELETE CASCADE off orders.id (order_item_addons → CASCADE off
--   order_items.id, one level down).
--   loyalty_transactions.order_id / suggestion_events.order_id
--   → ON DELETE SET NULL — these do NOT go away when `orders` is deleted, so
--   they are handled explicitly (SECTION 2 and SECTION 4).
--
-- Schema qualified throughout (public.* / backup_20260925.*) because this
-- script moves data ACROSS schemas — unlike the rest of supabase/*.sql, which
-- can rely on search_path=public.
--
-- Re-run safety: this is a genuine one-time script, not a repeatable
-- migration, so "safe to re-run" would be the wrong guarantee — a second run
-- must NOT silently overwrite the backup with an (by then) empty source. The
-- guard in SECTION 1 makes a second run fail LOUDLY, before touching any
-- data, with a message telling the operator why. Because everything below is
-- inside one `begin; ... commit;` block, that failure aborts the whole
-- transaction: nothing commits, nothing is lost. (The `create table ... as
-- select` lines also intentionally omit `if not exists` as a second,
-- redundant guard — a bare "relation already exists" would abort the same
-- transaction even if the DO block above it were ever removed.)
-- ===========================================================================

begin;

-- ===========================================================================
-- SECTION 0 — the backup schema, and the "already ran" guard.
-- ===========================================================================
create schema if not exists backup_20260925;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'backup_20260925') then
    raise exception
      'backup_20260925 already has tables in it — this script has already been run once. '
      'Refusing to run again: a second pass would try to overwrite last time''s backup, '
      'and if the source tables are already empty that would destroy it. '
      'If you are certain last week''s backup is no longer needed, '
      '`drop schema backup_20260925 cascade;` first, then re-run this file.';
  end if;
end $$;

-- ===========================================================================
-- SECTION 1 — back up everything that is about to be deleted or changed.
-- Order doesn't matter here (plain copies, no FKs inside backup_20260925),
-- so tables are backed up parent-first for readability only.
-- ===========================================================================

create table backup_20260925.orders as
  select * from public.orders;

create table backup_20260925.order_items as
  select * from public.order_items;

create table backup_20260925.order_item_addons as
  select * from public.order_item_addons;

create table backup_20260925.order_payments as
  select * from public.order_payments;

create table backup_20260925.payments as
  select * from public.payments;

create table backup_20260925.refunds as
  select * from public.refunds;

create table backup_20260925.order_status_events as
  select * from public.order_status_events;

-- notifications.order_id is currently NOT NULL in schema.sql, but the live
-- table may carry non-order notifications too (e.g. account/staff events) —
-- the `where` clause is the correct filter either way: it backs up exactly
-- the rows this script's `delete from orders` will cascade away, and leaves
-- any order_id IS NULL rows alone (they aren't touched, so they don't belong
-- in this backup).
create table backup_20260925.notifications as
  select * from public.notifications where order_id is not null;

create table backup_20260925.reviews as
  select * from public.reviews;

create table backup_20260925.order_amendments as
  select * from public.order_amendments;

-- idempotency_keys.order_id is nullable (a key can be claimed before the
-- order row exists). Only order-linked keys cascade-delete; a key with no
-- order behind it is left alone, so only the linked ones are backed up.
create table backup_20260925.idempotency_keys as
  select * from public.idempotency_keys where order_id is not null;

create table backup_20260925.coupon_redemptions as
  select * from public.coupon_redemptions;

-- Full table, not just the order-linked rows: small (4 rows today), and
-- keeping every row together with loyalty_accounts' pre-recompute snapshot
-- gives a complete before/after picture for SECTION 2, not just the slice
-- that gets deleted.
create table backup_20260925.loyalty_transactions as
  select * from public.loyalty_transactions;

create table backup_20260925.loyalty_accounts as
  select * from public.loyalty_accounts;

-- Suggestion engine (SECTION 4) — every row here is derived from the same
-- test-order period, so full tables.
create table backup_20260925.suggestion_sessions as
  select * from public.suggestion_sessions;

create table backup_20260925.suggestion_events as
  select * from public.suggestion_events;

create table backup_20260925.customer_taste_profiles as
  select * from public.customer_taste_profiles;

create table backup_20260925.suggestion_digests as
  select * from public.suggestion_digests;

-- The backup must never be reachable through the API — PostgREST only serves
-- schemas the project explicitly exposes (public by default), so this is
-- defense in depth, matching the revoke pattern the rest of supabase/*.sql
-- already uses for every sensitive table.
revoke all on schema backup_20260925 from anon, authenticated;
revoke all on all tables in schema backup_20260925 from anon, authenticated;

-- ===========================================================================
-- SECTION 2 — loyalty ledger.
--
-- lib/loyalty/ledger.ts is the only writer of loyalty_transactions
-- (earnForOrder / redeemForOrder / reverseForOrder) and it is explicit that
-- the ledger is the source of truth: loyalty_accounts.points_balance is a
-- "best-effort cache", recomputed by summing loyalty_transactions after every
-- write (syncAccountCache). phase2-hardening.sql's try_redeem_points does the
-- same by hand. Grepped every supabase/*.sql for `create trigger` on either
-- table — there is none. So the two statements below are exactly what the
-- app itself would do after deleting these rows: nothing double-counts,
-- nothing needs a trigger disabled.
--
-- Every loyalty_transactions row with an order_id is from a test order (the
-- only way one is created); rows with order_id IS NULL (manual 'adjust' /
-- 'expire' entries, if any) are not order-derived and are left alone.
-- ===========================================================================

delete from public.loyalty_transactions where order_id is not null;

-- Recompute every account's balance from what's left of the ledger —
-- 0 for an account with no remaining transactions, exactly like a fresh
-- syncAccountCache() would produce.
with account_balances as (
  select la.user_id, coalesce(sum(lt.points), 0) as balance
    from public.loyalty_accounts la
    left join public.loyalty_transactions lt on lt.user_id = la.user_id
   group by la.user_id
)
update public.loyalty_accounts la
   set points_balance = ab.balance,
       updated_at     = now()
  from account_balances ab
 where ab.user_id = la.user_id;

-- ===========================================================================
-- SECTION 3 — the orders themselves. Everything FK-CASCADEd off orders.id
-- goes with this one statement (see the header's FK list). Deliberately NOT
-- touching public.orders_order_number_seq — Petpooja bill numbers continue
-- from wherever it currently sits (1095 as of writing); resetting it would
-- let a future order collide with a reused order_number.
-- ===========================================================================

delete from public.orders;

-- ===========================================================================
-- SECTION 4 — suggestion engine test data (supabase/2026-09-suggestion-engine.sql).
--
-- menu_item_traits is config (Opus-tagged, owner-confirmed item metadata,
-- keyed on menu_item_id) — independent of any customer or order, so it is
-- NOT touched here.
--
-- The other four tables are all derived from customer/order activity during
-- the same test period, and none of them is FK-CASCADEd off orders (checked
-- against the live DB: suggestion_events.order_id and
-- customer_taste_profiles/suggestion_sessions have no CASCADE path from
-- orders), so each needs an explicit delete:
--   * suggestion_sessions      — one row per "Help me choose" answer during
--                                testing. suggestion_events references it
--                                ON DELETE CASCADE, so deleting sessions
--                                would take events with it, but events are
--                                deleted first anyway, explicitly, for
--                                clarity and because order matters if this
--                                section is ever copy-pasted elsewhere.
--   * suggestion_events        — the funnel (shown/added/ordered/...) for
--                                those test sessions.
--   * customer_taste_profiles  — the preference cache is, per its own
--                                comment in 2026-09-suggestion-engine.sql,
--                                "derived entirely from orders + favorites,
--                                so deleting a row loses nothing (it is
--                                recomputed on next read)" — exactly the
--                                property this cutover needs.
--   * suggestion_digests       — weekly owner summaries, but every digest
--                                written so far only ever summarized test
--                                sessions/events (the engine only shipped
--                                this quarter), so none of them describes a
--                                real week. Deleted rather than kept, so the
--                                owner's digest history starts clean with
--                                real customers. (Not FK-linked to orders or
--                                sessions at all — it's an aggregate text
--                                table — hence "if relevant": it's relevant
--                                here because of what it summarizes, not
--                                because of any foreign key.)
-- ===========================================================================

delete from public.suggestion_events;
delete from public.suggestion_sessions;
delete from public.customer_taste_profiles;
delete from public.suggestion_digests;

commit;

-- ---------------------------------------------------------------------------
-- Verify (run after commit — every count below should be 0 unless noted):
--
--   select count(*) from public.orders;
--   select count(*) from public.order_items;
--   select count(*) from public.order_item_addons;
--   select count(*) from public.order_payments;
--   select count(*) from public.payments;
--   select count(*) from public.refunds;
--   select count(*) from public.order_status_events;
--   select count(*) from public.reviews;
--   select count(*) from public.order_amendments;
--   select count(*) from public.coupon_redemptions;
--   select count(*) from public.notifications where order_id is not null;
--   select count(*) from public.idempotency_keys where order_id is not null;
--   select count(*) from public.loyalty_transactions where order_id is not null;
--   select count(*) from public.suggestion_sessions;
--   select count(*) from public.suggestion_events;
--   select count(*) from public.customer_taste_profiles;
--   select count(*) from public.suggestion_digests;
--
--   -- every account's cached balance must equal its (now order-free) ledger sum:
--   select la.user_id, la.points_balance,
--          coalesce(sum(lt.points), 0) as ledger_sum
--     from public.loyalty_accounts la
--     left join public.loyalty_transactions lt on lt.user_id = la.user_id
--    group by la.user_id, la.points_balance
--   having la.points_balance <> coalesce(sum(lt.points), 0);
--   -- expect 0 rows
--
--   -- untouched, and unchanged from before this script ran:
--   select last_value from public.orders_order_number_seq;   -- expect 1095
--   select count(*) from public.menu_item_traits;             -- unchanged
--   select count(*) from public.loyalty_accounts;             -- unchanged row COUNT (balances recomputed, rows kept)
--
--   -- the backup must be unreachable through the API (run with the anon key,
--   -- expect a permission-denied / not-found style response, not data):
--   --   curl "$SUPABASE_URL/rest/v1/orders?select=*" \
--   --        -H "apikey: $ANON_KEY" -H "Accept-Profile: backup_20260925"
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Restore (only if something turns out to still need this data — run inside
-- its own `begin; ... commit;`, parents before children so FKs are satisfied):
--
--   begin;
--
--   update public.loyalty_accounts la
--      set points_balance = b.points_balance, updated_at = b.updated_at
--     from backup_20260925.loyalty_accounts b
--    where b.user_id = la.user_id;
--
--   insert into public.orders select * from backup_20260925.orders;
--   insert into public.order_items select * from backup_20260925.order_items;
--   insert into public.order_item_addons select * from backup_20260925.order_item_addons;
--   insert into public.payments select * from backup_20260925.payments;
--   insert into public.order_payments select * from backup_20260925.order_payments;
--   insert into public.refunds select * from backup_20260925.refunds;
--   insert into public.order_status_events select * from backup_20260925.order_status_events;
--   insert into public.notifications select * from backup_20260925.notifications;
--   insert into public.reviews select * from backup_20260925.reviews;
--   insert into public.order_amendments select * from backup_20260925.order_amendments;
--   insert into public.idempotency_keys select * from backup_20260925.idempotency_keys;
--   insert into public.coupon_redemptions select * from backup_20260925.coupon_redemptions;
--   insert into public.loyalty_transactions select * from backup_20260925.loyalty_transactions
--     where order_id is not null;  -- the order-free rows were never deleted
--
--   insert into public.suggestion_sessions select * from backup_20260925.suggestion_sessions;
--   insert into public.suggestion_events select * from backup_20260925.suggestion_events;
--   insert into public.customer_taste_profiles select * from backup_20260925.customer_taste_profiles;
--   insert into public.suggestion_digests select * from backup_20260925.suggestion_digests;
--
--   commit;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Housekeeping — after ~1 week, once the owner has confirmed nothing needed
-- restoring from the backup:
--
--   drop schema backup_20260925 cascade;
-- ---------------------------------------------------------------------------
