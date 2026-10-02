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
-- No app behaviour changes: every read of these tables in the app goes
-- through the service-role client (createAdminSupabaseClient), which
-- bypasses RLS. Policy names are kept, so the schema shape is unchanged.
--
-- Reversible: supabase/2026-10-staff-only-reads.down.sql restores the old
-- policies exactly. Idempotent: safe to re-run.
--
-- Verify (as a signed-in non-staff user, e.g. via the API with a customer
-- session): each table returns zero rows. As staff: rows as before.
-- ===========================================================================

begin;

drop policy if exists order_payments_staff_read on public.order_payments;
create policy order_payments_staff_read on public.order_payments
  for select to authenticated using (public.is_staff());

drop policy if exists order_amendments_staff_read on public.order_amendments;
create policy order_amendments_staff_read on public.order_amendments
  for select to authenticated using (public.is_staff());

drop policy if exists cash_days_staff_read on public.cash_days;
create policy cash_days_staff_read on public.cash_days
  for select to authenticated using (public.is_staff());

drop policy if exists role_permissions_read on public.role_permissions;
create policy role_permissions_read on public.role_permissions
  for select to authenticated using (public.is_staff());

drop policy if exists permission_change_audit_read on public.permission_change_audit;
create policy permission_change_audit_read on public.permission_change_audit
  for select to authenticated using (public.is_staff());

commit;
