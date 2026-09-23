-- ===========================================================================
-- Phase 5 · SHEET-2 / D5-6 — owner day marks (paid leave).
--
-- A day off is not a session. Someone on paid leave punches nothing, so there
-- is no attendance_sessions row to hang the fact on — which is exactly why
-- "just add a status to sessions" does not work here.
--
-- D5-6 chose the cheap version deliberately: the owner marks individual days
-- from the sheet, and there is no leave BALANCE, no accrual and no approval
-- workflow. If that turns out to be load-bearing in real use, that is the
-- signal to build the real thing — not a reason to have built it now.
--
-- Apply AFTER supabase/2026-08-attendance.sql. Safe to re-run.
-- ===========================================================================

create table if not exists attendance_day_marks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  business_date date not null,
  -- paid_leave  → paid at contracted hours, not deducted (D5-6).
  -- unpaid_leave→ authorised absence: still unpaid, but distinguishable from
  --               an unexplained no-show, which is a distinction owners care
  --               about even though the money is identical.
  mark          text not null check (mark in ('paid_leave', 'unpaid_leave')),
  reason        text not null default '',
  marked_by     uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One mark per person per day. Re-marking updates rather than stacking, so a
  -- day can never be both paid and unpaid leave at once.
  unique (user_id, business_date)
);

create index if not exists idx_attendance_day_marks_date
  on attendance_day_marks (business_date desc);

drop trigger if exists trg_attendance_day_marks_updated_at on attendance_day_marks;
create trigger trg_attendance_day_marks_updated_at
  before update on attendance_day_marks
  for each row execute function set_updated_at();

alter table attendance_day_marks enable row level security;

-- A staffer may see their OWN marks — knowing a day was recorded as paid leave
-- is the kind of thing you should not have to ask about. Writes are owner-only,
-- through the service-role route.
drop policy if exists attendance_day_marks_read_own on attendance_day_marks;
create policy attendance_day_marks_read_own on attendance_day_marks
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on attendance_day_marks from anon, authenticated;
revoke all on attendance_day_marks from anon;

-- ---------------------------------------------------------------------------
-- Verify:
--   select mark, count(*) from attendance_day_marks group by mark;
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
