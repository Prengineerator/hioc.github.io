-- ===========================================================================
-- Staff-only reads for five back-office tables.
--
-- order_payments, order_amendments, cash_days, role_permissions and
-- permission_change_audit each had a SELECT policy for `authenticated` with
-- `using (true)`. Customers sign in through the same Supabase Auth pool as
-- staff (phone OTP), so those rows were readable by any signed-in customer
-- through PostgREST. These policies are narrowed to public.is_staff()
-- (staff, manager or owner), matching orders, payments and refunds
-- (supabase/security-rls-fix.sql).
--
-- ALTER POLICY changes each policy's condition in place: no drop and
-- re-create, so there is no window without a policy, and names, roles and
-- commands are unchanged.
--
-- No app behaviour changes: every read of these tables in the app goes
-- through the service-role client (createAdminSupabaseClient), which
-- bypasses RLS.
--
-- Reversible: supabase/2026-10-staff-only-reads.down.sql restores
-- `using (true)`. Idempotent: safe to re-run.
--
-- Tested 2026-10-02 on the separate test project (production schema baseline):
--   * before: a signed-in customer (is_staff() = false) read 14 role_permissions rows;
--   * after:  that customer reads 0 rows from all five tables; staff still read 14;
--   * down:   the customer reads 14 again; re-applying returns it to 0.
--
-- Verify after applying (Supabase SQL editor):
--   select tablename, policyname, qual from pg_policies
--    where schemaname = 'public'
--      and tablename in ('order_payments','order_amendments','cash_days',
--                        'role_permissions','permission_change_audit');
--   -- expect qual = is_staff() on all five rows
-- ===========================================================================

alter policy order_payments_staff_read on public.order_payments using (public.is_staff());
alter policy order_amendments_staff_read on public.order_amendments using (public.is_staff());
alter policy cash_days_staff_read on public.cash_days using (public.is_staff());
alter policy role_permissions_read on public.role_permissions using (public.is_staff());
alter policy permission_change_audit_read on public.permission_change_audit using (public.is_staff());
