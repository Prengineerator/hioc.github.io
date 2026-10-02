-- Rollback for supabase/2026-10-staff-only-reads.sql: restores the previous
-- SELECT policies (`to authenticated using (true)`) exactly as production had
-- them before. Idempotent.

begin;

drop policy if exists order_payments_staff_read on public.order_payments;
create policy order_payments_staff_read on public.order_payments
  for select to authenticated using (true);

drop policy if exists order_amendments_staff_read on public.order_amendments;
create policy order_amendments_staff_read on public.order_amendments
  for select to authenticated using (true);

drop policy if exists cash_days_staff_read on public.cash_days;
create policy cash_days_staff_read on public.cash_days
  for select to authenticated using (true);

drop policy if exists role_permissions_read on public.role_permissions;
create policy role_permissions_read on public.role_permissions
  for select to authenticated using (true);

drop policy if exists permission_change_audit_read on public.permission_change_audit;
create policy permission_change_audit_read on public.permission_change_audit
  for select to authenticated using (true);

commit;
