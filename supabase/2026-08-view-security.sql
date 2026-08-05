-- ===========================================================================
-- SECURITY · analytics views leaked customer PII to the anon key.
--
-- VERIFIED AGAINST THE LIVE DATABASE 2026-08-05, not theorised:
--   orders          (base table) → anon reads 0 rows   ← RLS working
--   v_valid_orders  (view)       → anon reads FULL ROWS including
--                                  customer_name, customer_phone, customer_email
--
-- A Postgres view runs with the privileges of the role that OWNS it, not the
-- role that queries it, unless `security_invoker = true` is set (PG15+). Every
-- v_* view here selects from `orders`, so each one is a hole straight through
-- the row-level security that `security-rls-fix.sql` put on that table.
--
-- This is not a theoretical exposure. NEXT_PUBLIC_SUPABASE_ANON_KEY is shipped
-- to every browser that loads the site, so anyone who opened it could read the
-- customer list. Treat this as a disclosure incident: apply, then verify.
--
-- Two independent layers, because either alone can be undone by a later
-- `create or replace view` that forgets one:
--   1. security_invoker — the view is evaluated as the CALLER, so RLS applies.
--   2. explicit REVOKE  — anon has no business reading analytics at all; the
--                         owner dashboard queries these through the service role.
--
-- Safe to re-run. Views that don't exist in a given environment are skipped.
-- ===========================================================================

do $$
declare v text;
begin
  foreach v in array array[
    'v_valid_orders',
    'v_daily_sales',
    'v_item_sales',
    'v_hourly_orders',
    'v_order_durations',
    'v_reject_reasons',
    'v_channel_mix',
    'v_table_turnover',
    'v_staff_entry_stats'
  ]
  loop
    if exists (
      select 1 from information_schema.views
       where table_schema = 'public' and table_name = v
    ) then
      -- 1. Evaluate as the caller so the base tables' RLS is honoured.
      execute format('alter view public.%I set (security_invoker = true)', v);
      -- 2. And take the grant away regardless — defence in depth.
      execute format('revoke all on public.%I from anon', v);
      execute format('revoke all on public.%I from authenticated', v);
      raise notice 'secured view %', v;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Verify (expect security_invoker=true on every row):
--   select c.relname,
--          (select option_value from pg_options_to_table(c.reloptions)
--            where option_name = 'security_invoker') as security_invoker
--     from pg_class c
--     join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'v'
--    order by 1;
--
-- Then re-run `npm run verify:db`, which probes the anon key directly — the
-- only check that actually proves the hole is closed.
-- ---------------------------------------------------------------------------
