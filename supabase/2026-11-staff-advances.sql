-- ===========================================================================
-- Staff salary advances, noted on the owner Payroll page.
--
-- The owner pays staff advances during the month (UPI/cash, from their own
-- pocket). Each one is noted down and comes off that person's pay when their
-- month is finalized. If advances exceed the month's pay, net pay is Rs 0 and
-- the rest carries to the next month (worked out by the code, not stored here).
-- Spec: docs/STAFF-ADVANCES-SPEC.md (owner approved 2026-11-24).
--
-- Adds:
--   * staff_advances — one row per advance.
--       user_id     who received it (restrict: a person with advances on record
--                   cannot be deleted from auth by accident)
--       amount_inr  whole rupees, 1 to 100000
--       given_on    the IST calendar date it was given (the API refuses future
--                   dates; a CHECK cannot, because now() is not immutable)
--       note        up to 200 characters, optional
--       created_by / created_at   who noted it, and when
--       removed_at / removed_by   soft delete: a removed advance stays on
--                   record. removed_by may only be set with removed_at.
--     plus an index on (user_id, given_on) for live (not removed) advances.
--   * payroll_run_lines.advance_inr — the advance ACTUALLY taken off net pay
--     in that finalized line (may be less than the advances outstanding).
--
-- Locked down like the payroll tables: row level security ON, NO policies, and
-- all privileges revoked from anon and authenticated. Salary is owner-only, so
-- every read and write goes through owner-only API routes using the service
-- role (which bypasses RLS).
--
-- What the owner sees once applied: nothing changes until the new Payroll
-- screen ships; then they can note, remove and see advances per person, and
-- finalized payslips show the advance taken.
--
-- Additive only: an older build ignores the new table and column and keeps
-- working. Apply on Hioc India before deploying the code that reads it.
-- Safe to run twice.
-- ===========================================================================

create table if not exists staff_advances (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete restrict,
  amount_inr  integer not null check (amount_inr between 1 and 100000),
  given_on    date not null,
  note        text not null default '' check (char_length(note) <= 200),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  uuid references auth.users(id) on delete set null,
  constraint staff_advances_removed_by_needs_removed_at
    check (removed_by is null or removed_at is not null)
);

create index if not exists idx_staff_advances_user_given
  on staff_advances (user_id, given_on) where removed_at is null;

-- The advance actually deducted in a finalized payroll line.
alter table payroll_run_lines
  add column if not exists advance_inr integer not null default 0 check (advance_inr >= 0);

-- ── Lock down ───────────────────────────────────────────────────────────────
alter table staff_advances enable row level security;
revoke all on staff_advances from anon, authenticated;

-- ── Verify: (read-only; run after applying, in Hioc India) ──────────────────
-- 1. Columns of staff_advances; expect 9 rows: id, user_id, amount_inr,
--    given_on, note, created_by, created_at, removed_at, removed_by.
--      select column_name from information_schema.columns
--      where table_schema = 'public' and table_name = 'staff_advances'
--      order by ordinal_position;
-- 2. RLS is on; expect one row with relrowsecurity = true.
--      select relname, relrowsecurity from pg_class
--      where oid = 'public.staff_advances'::regclass;
-- 3. No policies; expect 0 rows.
--      select * from pg_policies where tablename = 'staff_advances';
-- 4. No grants to anon/authenticated; expect 0 rows.
--      select grantee, privilege_type from information_schema.role_table_grants
--      where table_name = 'staff_advances' and grantee in ('anon', 'authenticated');
-- 5. Constraints; expect the primary key, the amount and note checks, the
--    removed_by check (staff_advances_removed_by_needs_removed_at) and 3 foreign keys.
--      select conname, pg_get_constraintdef(oid) from pg_constraint
--      where conrelid = 'public.staff_advances'::regclass order by conname;
-- 6. The index exists; expect 1 row with a "where (removed_at is null)" predicate.
--      select indexdef from pg_indexes where indexname = 'idx_staff_advances_user_given';
-- 7. The payroll column; expect 1 row: integer, NO, default 0.
--      select data_type, is_nullable, column_default from information_schema.columns
--      where table_name = 'payroll_run_lines' and column_name = 'advance_inr';
-- 8. Table is empty at first; expect 0.
--      select count(*) from staff_advances;
