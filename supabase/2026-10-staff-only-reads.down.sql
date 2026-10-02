-- Rollback for supabase/2026-10-staff-only-reads.sql: restores the previous
-- SELECT condition (`using (true)`) on the five policies. Idempotent.
-- Tested 2026-10-02 on the separate test project.

alter policy order_payments_staff_read on public.order_payments using (true);
alter policy order_amendments_staff_read on public.order_amendments using (true);
alter policy cash_days_staff_read on public.cash_days using (true);
alter policy role_permissions_read on public.role_permissions using (true);
alter policy permission_change_audit_read on public.permission_change_audit using (true);
