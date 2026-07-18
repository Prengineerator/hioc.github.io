-- HIOC — Post-deploy security gate (S3). Run in the Supabase SQL editor after
-- applying migrations. EVERY row must report ok = true. Any false = the deploy
-- is missing a security migration and must NOT be considered production-ready.
--
-- Covers: RLS role helper + gated policies (security-rls-fix.sql), atomic
-- redemption + rate limiter + refund guard (phase2-hardening.sql), and the
-- verified-phone uniqueness index (2026-07-phone-unique.sql).

with checks as (
  select 'is_staff() exists' as check_name,
         to_regprocedure('public.is_staff()') is not null as ok
  union all
  select 'check_rate_limit() exists',
         to_regprocedure('public.check_rate_limit(text,integer,integer)') is not null
  union all
  select 'try_redeem_coupon() exists',
         to_regprocedure('public.try_redeem_coupon(uuid,uuid,uuid,integer,integer,integer)') is not null
  union all
  select 'try_redeem_points() exists',
         to_regprocedure('public.try_redeem_points(uuid,uuid,integer,integer)') is not null
  union all
  select 'rate_limits table exists',
         to_regclass('public.rate_limits') is not null
  union all
  select 'refund-total guard trigger exists',
         exists (select 1 from pg_trigger where tgname = 'trg_guard_refund_total')
  union all
  select 'orders staff-read policy exists',
         exists (select 1 from pg_policies where tablename = 'orders' and policyname = 'orders_staff_read')
  union all
  select 'orders has NO client update policy',
         not exists (select 1 from pg_policies where tablename = 'orders' and cmd = 'UPDATE')
  union all
  select 'reviews own-read policy is user-scoped',
         exists (select 1 from pg_policies where tablename = 'reviews' and policyname = 'reviews_own_read')
  union all
  select 'verified-phone unique index exists',
         to_regclass('public.idx_profiles_phone_verified_unique') is not null
)
select check_name, ok,
       case when ok then 'PASS' else '*** FAIL — apply the missing migration ***' end as verdict
from checks
order by ok, check_name;
