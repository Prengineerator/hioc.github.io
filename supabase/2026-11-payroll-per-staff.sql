-- ===========================================================================
-- Payroll is finalized PER STAFFER, not per month.
--
-- Until now a payroll run covered a whole month: one finalize froze everyone,
-- and one active run per period was enforced by idx_payroll_runs_active_period.
-- The owner now finalizes each person on their own (after choosing which of
-- their proposed deductions to take), so a run belongs to ONE staffer:
--
--   * payroll_runs.user_id — whose run it is.
--   * one ACTIVE run per (period, staffer). A reversed run stays on the record
--     and does not block a corrected re-run, exactly as before.
--   * an active run MUST name its staffer. A whole-month run may survive only
--     as reversed history.
--
-- The attendance-correction lock (app/api/owner/attendance/sessions) reads
-- this per staffer too: finalizing Umesh's October no longer freezes anyone
-- else's October.
--
-- Apply BEFORE deploying the code that finalizes per staffer. Safe to re-run.
-- ===========================================================================

alter table payroll_runs
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- An active whole-month run cannot be split after the fact. Refuse loudly
-- rather than leave it half-understood by the per-staff code.
do $$
begin
  if exists (select 1 from payroll_runs where user_id is null and status <> 'reversed') then
    raise exception
      'An active whole-month payroll run exists. Reverse it on the owner Payroll screen, then re-run this migration.';
  end if;
end $$;

alter table payroll_runs drop constraint if exists payroll_runs_active_has_user;
alter table payroll_runs add constraint payroll_runs_active_has_user
  check (user_id is not null or status = 'reversed');

drop index if exists idx_payroll_runs_active_period;
create unique index if not exists idx_payroll_runs_active_period_user
  on payroll_runs (period_start, period_end, user_id) where status <> 'reversed';

create index if not exists idx_payroll_runs_user
  on payroll_runs (user_id, period_start desc);
