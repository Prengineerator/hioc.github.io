-- The café's day runs 3:00 am to 3:00 am IST, not midnight to midnight (owner
-- request, 30 Oct 2026).
--
-- The café runs past midnight, so an order at 12:40 am belongs to the evening
-- before. The app applies the rule itself (lib/businessDay.ts: the POS order
-- board, the Settle screen, the cash day, the owner dashboard, Owner → Reports
-- and the report emails). This makes the one database view that dates sales by
-- day agree: v_daily_sales, behind the dashboard's "Today at a glance" and its
-- revenue trend. Until it is applied, "Today at a glance" still splits the
-- night at midnight; nothing else depends on it.
--
-- "Since now": from business day 2026-10-29 on. Earlier days keep their
-- midnight-to-midnight dates, so no figure already reported moves.
--
-- business_date_ist() must match businessDateOf() in lib/businessDay.ts.
--
-- The view keeps the columns and types of 2026-09-settle-adjustments.sql and
-- the options of 2026-08-view-security.sql. Idempotent: safe to re-run.

create or replace function business_date_ist(ts timestamptz) returns date
language sql immutable set search_path = pg_catalog as $$
  select case
    when ((ts at time zone 'Asia/Kolkata') - interval '3 hours')::date >= date '2026-10-29'
      then ((ts at time zone 'Asia/Kolkata') - interval '3 hours')::date
    else (ts at time zone 'Asia/Kolkata')::date
  end
$$;

comment on function business_date_ist(timestamptz) is
  'The café business date of an instant: 3:00 am to 3:00 am IST from 2026-10-29, the IST calendar date before that. Mirrors lib/businessDay.ts businessDateOf().';

create or replace view v_daily_sales as
  select
    business_date_ist(created_at)                                as sale_date,
    count(*)                                                     as orders,
    coalesce(sum(total_inr - settle_discount_inr), 0)            as revenue_inr,
    coalesce(round(avg(total_inr - settle_discount_inr)), 0)     as aov_inr
  from v_valid_orders
  group by 1
  order by 1 desc;

-- CREATE OR REPLACE VIEW resets the view's options: put back what
-- 2026-08-view-security.sql set.
alter view v_daily_sales set (security_invoker = true);
revoke all on v_daily_sales from anon;
revoke all on v_daily_sales from authenticated;

-- Verify:
--   -- 1. 12:40 am on 30 Oct is the 29th's; 3:00 am starts the 30th; a night
--   --    before the change still splits at midnight:
--   select business_date_ist('2026-10-30 00:40+05:30'),   -- 2026-10-29
--          business_date_ist('2026-10-30 03:00+05:30'),   -- 2026-10-30
--          business_date_ist('2026-10-28 00:40+05:30');   -- 2026-10-28
--   -- 2. The view still reads:
--   select * from v_daily_sales limit 3;
