-- ===========================================================================
-- SECURITY · Supabase security-advisor findings on the production project.
--
-- Three independent findings, all confirmed against the current repo SQL and
-- every reader/caller in app/, lib/, components/ (grepped, not guessed):
--
-- 1. security_definer_view (ERROR) — v_customer_stats, v_new_vs_returning,
--    v_payment_mix, v_coupon_performance, v_review_summary (all defined in
--    phase2-migration.sql §10) run as their OWNER, not the querying role, so
--    they bypass the RLS that security-rls-fix.sql put on orders/payments/
--    coupons/reviews. Exactly the same class of hole that
--    2026-08-view-security.sql closed on the Phase-1/3 views — these five were
--    just never added to that migration's list. Best guess why: that file's
--    header says it was written against a *verified* PII leak found by probing
--    v_valid_orders with the anon key on 2026-08-05; it fixed every view
--    reachable from that investigation (the Phase-1 sales/ops views plus the
--    Phase-3 channel/table/staff views) but the Phase-2 retention/payment/
--    coupon/review views from RET-1..4 were never in that anon-key probe and
--    got missed. They carry the same silent risk: NEXT_PUBLIC_SUPABASE_ANON_KEY
--    is public, and today these views would hand back payment totals, coupon
--    codes, and review text to anyone with it, if PostgREST default grants let
--    anon/authenticated reach them at all (see layer 2 below).
--
--    Readers, confirmed by grep — every one goes through the SERVICE-ROLE
--    client (createAdminSupabaseClient, bypasses RLS by design), never the
--    cookie/anon client:
--      v_customer_stats      — no current reader (app/owner/customers/page.tsx
--                               moved to computing this in JS from `orders`
--                               directly, per its own comment; the view is
--                               still live in the DB and still advisor-flagged,
--                               so it's fixed here too, defense in depth).
--      v_new_vs_returning    — lib/analytics/queries.ts getNewVsReturning()
--                               (admin client), read by app/owner/customers.
--      v_payment_mix         — app/owner/payments/page.tsx (admin client).
--      v_coupon_performance  — app/owner/promotions/page.tsx (admin client).
--      v_review_summary      — app/owner/reviews/page.tsx (admin client).
--    Every one of these pages is under app/owner/**, which is owner-gated
--    server-side before the query ever runs. Because the admin client bypasses
--    RLS anyway, switching these views to security_invoker = true changes
--    NOTHING for the app (still full rows, same as today) and closes the hole
--    for anyone who queried them directly with the anon key. No code changes
--    needed — same shape as 2026-08-view-security.sql.
--
-- 2. anon/authenticated can execute SECURITY DEFINER functions via
--    /rest/v1/rpc. Supabase grants EXECUTE on every new function in `public`
--    to PUBLIC by default, so `security definer` + no explicit REVOKE means
--    literally anyone with the anon key can call it over the REST RPC
--    endpoint, arguments and all:
--
--      try_redeem_coupon / try_redeem_points — grepped every `.rpc(...)` call
--        in the repo: both are only ever called from app/api/orders/route.ts,
--        both through `const admin = createAdminSupabaseClient()` (service
--        role). phase2-hardening.sql already `grant`s these to service_role,
--        but never revokes the PUBLIC default, so anon/authenticated keep
--        EXECUTE too — which is exactly the advisor finding, and exactly how
--        someone could POST try_redeem_points straight at /rest/v1/rpc and
--        burn a stranger's loyalty balance. Fix: revoke from public/anon/
--        authenticated, keep the existing service_role grant.
--
--      check_rate_limit — its only caller is lib/api/rateLimit.ts
--        rateLimitOk(), which always builds `createAdminSupabaseClient()`
--        before calling `.rpc('check_rate_limit', ...)`; every route that uses
--        it (OTP request/verify, login, staff reset, suggest, resend-bill,
--        owner password reset, notification test-send) goes through that one
--        helper. 2026-08-rate-limits-rls.sql's own comment already documents
--        this as "a SECURITY DEFINER function called server-side" — the
--        original `grant ... to service_role, authenticated, anon` in
--        phase2-hardening.sql looks like a defensive over-grant from when this
--        was written, not something anything actually needs. Fix: revoke from
--        public/anon/authenticated, keep only service_role.
--
--      handle_new_user / log_role_change — both are wired ONLY as triggers
--        (on_auth_user_created on auth.users, trg_profiles_role_change on
--        profiles.role) — grepped, no `.rpc()` caller anywhere in the repo.
--        Firing a trigger does not require the invoking role to hold EXECUTE
--        on the trigger function (Postgres invokes it as the table owner
--        regardless), so revoking EXECUTE from public/anon/authenticated here
--        does not touch signup or role-change auditing at all. Fix: revoke
--        from public/anon/authenticated; nothing needs it re-granted.
--
--      is_staff() — grepped every policy and function that calls it: all 24
--        call sites are in security-rls-fix.sql, and every single policy that
--        calls it is `to authenticated` (menu/orders/payments/coupons/
--        announcements/reviews/etc. writes and staff reads). None is `to
--        public` or `to anon`. So `authenticated` must keep EXECUTE (RLS
--        policies run is_staff() as the querying role, and revoking it would
--        break every staff/owner page that reads through RLS instead of the
--        admin client) — but the current
--        `grant execute on function public.is_staff() to authenticated, anon`
--        hands anon a definer function that reads auth.uid()-scoped profile
--        data for no policy that ever needs it. Fix: revoke from public/anon,
--        keep authenticated (+ service_role for completeness).
--
-- 3. function_search_path_mutable (lower priority) — set_updated_at,
--    guard_refund_total, set_attendance_business_date, attendance_clock_out,
--    set_order_paid_at have no `SET search_path`, so a session-level
--    search_path change could redirect an unqualified reference inside them.
--    All five already qualify every table reference or live in a single
--    schema by convention, so this is hardening, not a live bug. Signatures
--    below are copied verbatim from their current `create or replace
--    function` in the repo (schema.sql, 2026-08-counter-refunds.sql [the
--    latest of the two guard_refund_total definitions — it supersedes
--    phase2-hardening.sql's], 2026-08-attendance.sql, 2026-09-cash-counts.sql).
--
-- Leaked-password protection is a dashboard auth setting, not SQL — skipped
-- here, left for the coordinator to flip in the Supabase dashboard.
--
-- Safe to re-run. Every ALTER/REVOKE/GRANT below is idempotent; the view loop
-- skips any view not present in a given environment.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Views — security_invoker, same two-layer pattern as
--    2026-08-view-security.sql (invoker mode + explicit revoke from
--    anon/authenticated, since Supabase's default privileges on a new view
--    otherwise hand those roles table-level access that RLS alone is relied
--    on to gate).
-- ---------------------------------------------------------------------------
do $$
declare v text;
begin
  foreach v in array array[
    'v_customer_stats',
    'v_new_vs_returning',
    'v_payment_mix',
    'v_coupon_performance',
    'v_review_summary'
  ]
  loop
    if exists (
      select 1 from information_schema.views
       where table_schema = 'public' and table_name = v
    ) then
      execute format('alter view public.%I set (security_invoker = true)', v);
      execute format('revoke all on public.%I from anon', v);
      execute format('revoke all on public.%I from authenticated', v);
      raise notice 'secured view %', v;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2a. State-changing SECURITY DEFINER RPCs — admin-client-only callers.
--     Revoke the PUBLIC default grant, keep service_role.
-- ---------------------------------------------------------------------------
revoke execute on function public.try_redeem_coupon(uuid, uuid, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.try_redeem_coupon(uuid, uuid, uuid, integer, integer, integer)
  to service_role;

revoke execute on function public.try_redeem_points(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.try_redeem_points(uuid, uuid, integer, integer)
  to service_role;

revoke execute on function public.check_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2b. Trigger-only SECURITY DEFINER functions — never called directly, so no
--     role needs EXECUTE at all. (Firing a trigger doesn't check the invoking
--     role's EXECUTE privilege on the trigger function.)
-- ---------------------------------------------------------------------------
revoke execute on function public.handle_new_user()
  from public, anon, authenticated;

revoke execute on function public.log_role_change()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2c. is_staff() — called from RLS policies that are all `to authenticated`;
--     none is `to public`/`to anon`. Keep authenticated (and service_role,
--     which never needed the grant to bypass RLS but costs nothing to have
--     explicitly); drop the anon grant this function never needed.
-- ---------------------------------------------------------------------------
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. function_search_path_mutable — pin search_path on the flagged trigger/
--    RPC functions. Signatures copied verbatim from their current
--    definitions in the repo.
-- ---------------------------------------------------------------------------
alter function public.set_updated_at() set search_path = public, pg_temp;
alter function public.guard_refund_total() set search_path = public, pg_temp;
alter function public.set_attendance_business_date() set search_path = public, pg_temp;
alter function public.attendance_clock_out(uuid, uuid, numeric, numeric, numeric, numeric, text[])
  set search_path = public, pg_temp;
alter function public.set_order_paid_at() set search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- Verify:
--
--   -- expect security_invoker=true in reloptions for all 5 rows:
--   select relname, reloptions from pg_class
--    where relname in (
--      'v_customer_stats', 'v_new_vs_returning', 'v_payment_mix',
--      'v_coupon_performance', 'v_review_summary'
--    )
--    order by 1;
--
--   -- inspect grants (proacl) — try_redeem_*/check_rate_limit should show
--   -- only service_role with EXECUTE; is_staff() should show authenticated +
--   -- service_role but no anon; handle_new_user/log_role_change should show
--   -- no grants to anon/authenticated/public at all:
--   select proname, proacl from pg_proc
--    where proname in (
--      'check_rate_limit', 'handle_new_user', 'is_staff', 'log_role_change',
--      'try_redeem_coupon', 'try_redeem_points'
--    )
--    order by 1;
--
--   -- expect search_path in proconfig for all 5 rows:
--   select proname, proconfig from pg_proc
--    where proname in (
--      'set_updated_at', 'guard_refund_total', 'set_attendance_business_date',
--      'attendance_clock_out', 'set_order_paid_at'
--    )
--    order by 1;
--
-- Then re-run the Supabase security advisor and confirm all of the above
-- findings are cleared. Also smoke-test: OTP request/verify still works
-- (check_rate_limit), a coupon/points checkout still redeems (try_redeem_*),
-- new-user signup still creates a profiles row (handle_new_user), and every
-- app/owner/** analytics page still renders (v_* views, now invoker but still
-- read through the admin client so nothing should visibly change).
-- ---------------------------------------------------------------------------
