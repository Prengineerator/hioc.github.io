-- ===========================================================================
-- Settle a bill for LESS or MORE than its total, with a reason.
--
-- Owner's rule: short = settlement discount, extra = tip.
--   * Customer pays ₹480 on a ₹500 bill  -> orders.settle_discount_inr = 20.
--     Revenue must show what was actually received, so v_daily_sales now sums
--     (total_inr - settle_discount_inr). A shortfall above ₹50 needs a manager
--     or the owner (enforced in PATCH /api/orders/[id]/payment).
--   * Customer pays ₹520, "keep the change" -> orders.tip_inr = 20. Tips are
--     real cash/UPI in the drawer (order_payments records the ₹520) but are NOT
--     sales, so they are kept out of total_inr and out of revenue.
--   * A reason is always required when there is a difference.
--
-- Pieces:
--   orders.settle_discount_inr / tip_inr / settle_reason — the three columns.
--   v_valid_orders  — recreated with an EXPLICIT column list: every column the
--                     live view has today, in the same order, plus the three new
--                     ones appended. It was created as `select *`, which freezes
--                     the column list at creation time, so the repo cannot say
--                     what the live view holds; this file reads it from the
--                     catalog instead of guessing (CREATE OR REPLACE VIEW may
--                     only append columns — reordering/dropping one errors).
--   v_daily_sales   — revenue and AOV net of the settlement discount.
--
-- Views that also sum total_inr (v_channel_mix, v_payment_mix, v_customer_stats,
-- ...) are deliberately NOT touched here; see the follow-up note in the PR.
--
-- Safe to re-run: columns use IF NOT EXISTS; the view rebuild only appends
-- columns the view does not already have.
-- ===========================================================================

alter table orders add column if not exists settle_discount_inr integer not null default 0
  check (settle_discount_inr >= 0);
alter table orders add column if not exists tip_inr integer not null default 0
  check (tip_inr >= 0);
alter table orders add column if not exists settle_reason text not null default '';

-- v_valid_orders: keep the existing columns (same order), append the new ones.
do $$
declare
  existing_cols text;
  extra_cols    text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
    into existing_cols
    from pg_attribute a
   where a.attrelid = 'public.v_valid_orders'::regclass
     and a.attnum > 0
     and not a.attisdropped;

  -- Only the new columns the view does not already carry (re-run safety).
  select string_agg(quote_ident(c), ', ' order by ord)
    into extra_cols
    from unnest(array['settle_discount_inr', 'tip_inr', 'settle_reason']) with ordinality as t(c, ord)
   where not exists (
     select 1 from pg_attribute a
      where a.attrelid = 'public.v_valid_orders'::regclass
        and a.attname = t.c and a.attnum > 0 and not a.attisdropped
   );

  if extra_cols is not null then
    execute format(
      'create or replace view public.v_valid_orders as
         select %s, %s from public.orders where status not in (''rejected'', ''cancelled'')',
      existing_cols, extra_cols
    );
  end if;

  -- CREATE OR REPLACE VIEW resets the view's options, so put back what
  -- 2026-08-view-security.sql set: evaluated as the caller, no anon/authenticated
  -- grants (the owner dashboard reads these through the service role).
  alter view public.v_valid_orders set (security_invoker = true);
  revoke all on public.v_valid_orders from anon;
  revoke all on public.v_valid_orders from authenticated;
end $$;

-- v_daily_sales: revenue is what was actually received for the bill, so the
-- settlement discount comes off. Same column names and types as before.
create or replace view v_daily_sales as
  select
    (created_at at time zone 'Asia/Kolkata')::date              as sale_date,
    count(*)                                                     as orders,
    coalesce(sum(total_inr - settle_discount_inr), 0)            as revenue_inr,
    coalesce(round(avg(total_inr - settle_discount_inr)), 0)     as aov_inr
  from v_valid_orders
  group by 1
  order by 1 desc;

alter view v_daily_sales set (security_invoker = true);
revoke all on v_daily_sales from anon;
revoke all on v_daily_sales from authenticated;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- 1. The columns exist with the right defaults:
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns
--    where table_name = 'orders'
--      and column_name in ('settle_discount_inr', 'tip_inr', 'settle_reason');
--   -- expect 3 rows: integer 0, integer 0, text '' — all NOT NULL.
--
--   -- 2. The view carries them as its LAST three columns:
--   select attnum, attname from pg_attribute
--    where attrelid = 'public.v_valid_orders'::regclass and attnum > 0 and not attisdropped
--    order by attnum desc limit 3;
--   -- expect settle_reason, tip_inr, settle_discount_inr (descending).
--
--   -- 3. Revenue nets the discount (take an order settled ₹20 short):
--   select sale_date, orders, revenue_inr from v_daily_sales limit 3;
--
--   -- 4. The view is still locked down (expect security_invoker=true):
--   select c.relname,
--          (select option_value from pg_options_to_table(c.reloptions)
--            where option_name = 'security_invoker') as security_invoker
--     from pg_class c
--    where c.relname in ('v_valid_orders', 'v_daily_sales');
--   -- then `npm run verify:db` (probes the anon key directly).
-- ---------------------------------------------------------------------------
