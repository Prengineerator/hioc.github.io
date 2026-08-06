-- ===========================================================================
-- Phase 5 · LEAVE — weekly leave planning.
--
-- Staff plan their own off days for next week; a manager approves or declines
-- before the week starts. There is no fixed weekly off — that is the point.
--
-- THE THREE RULES ARE ENFORCED HERE, not only in the UI, because each one
-- decides whether somebody is marked absent on a day they had cleared:
--
--   1. A leave week is identified by its MONDAY. week_start must BE a Monday.
--   2. Only Mon–Fri are requestable. The cafe is busiest at the weekend, so
--      Saturday and Sunday leave does not exist.
--   3. leave_date must fall inside its own week. A row claiming to belong to
--      one week while pointing at a day in another would make the roster and
--      payroll disagree about the same date.
--
-- Postgres `extract(dow ...)`: 0 = Sunday .. 6 = Saturday. Monday is 1,
-- Friday is 5 — hence `between 1 and 5` for the requestable days.
--
-- Apply AFTER supabase/2026-08-attendance.sql. Safe to re-run.
-- ===========================================================================

create table if not exists leave_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  week_start    date not null,
  leave_date    date not null,
  status        text not null default 'requested'
                  check (status in ('requested', 'approved', 'declined', 'withdrawn')),
  reason        text not null default '',
  decided_by    uuid references auth.users(id) on delete set null,
  decided_at    timestamptz,
  decision_note text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint leave_week_start_is_monday check (extract(dow from week_start) = 1),
  constraint leave_date_is_weekday      check (extract(dow from leave_date) between 1 and 5),
  constraint leave_date_within_week     check (
    leave_date >= week_start and leave_date < week_start + 7
  ),

  -- One row per person per day. A re-request updates rather than stacking, so
  -- a single date can never be both approved and declined at once.
  unique (user_id, leave_date)
);

create index if not exists idx_leave_requests_week on leave_requests (week_start, status);
create index if not exists idx_leave_requests_user on leave_requests (user_id, week_start desc);

drop trigger if exists trg_leave_requests_updated_at on leave_requests;
create trigger trg_leave_requests_updated_at
  before update on leave_requests
  for each row execute function set_updated_at();

-- ===========================================================================
-- Reminder log — idempotency for the scheduled nudges.
-- ===========================================================================
-- The cron runs daily and must not send the same nudge twice if it is retried
-- or runs twice in a day. Keyed on (user, week, kind, day) so a Friday nudge
-- and a Saturday last-call are distinct, but a repeat of either is a no-op.
create table if not exists leave_reminder_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  week_start  date not null,
  -- 'staff_submit'   → you have not planned next week yet
  -- 'manager_decide' → there are requests waiting on you
  kind        text not null check (kind in ('staff_submit', 'manager_decide')),
  channel     text not null check (channel in ('whatsapp', 'email', 'inapp')),
  sent_on     date not null,
  status      text not null default 'sent' check (status in ('sent', 'skipped', 'failed')),
  skip_reason text not null default '',
  created_at  timestamptz not null default now(),

  unique (user_id, week_start, kind, channel, sent_on)
);

create index if not exists idx_leave_reminder_week on leave_reminder_log (week_start, kind);

-- ===========================================================================
-- Settings + permission key
-- ===========================================================================
-- How many days one person may have off in a single week. Default 1: the
-- common cafe arrangement is one rostered day off, and a request that would
-- exceed this is refused at the API with a message rather than silently
-- accepted and then declined by hand.
alter table attendance_settings
  add column if not exists max_leave_days_per_week integer not null default 1
    check (max_leave_days_per_week between 0 and 7);

-- Approving leave is a manager act (D5-8 — managers run the floor, only the
-- owner sees money). MIRROR IN lib/permissions.ts + lib/types.ts.
--
-- Note there is deliberately no 'leave_request' key: asking for a day off is
-- gated on a valid staff session only. hasPermission() fails CLOSED to manager
-- for an unseeded key, and a missing seed row would stop the whole team from
-- being able to request leave at all.
insert into role_permissions (permission_key, min_role) values
  ('leave_approve', 'manager')
on conflict (permission_key) do nothing;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table leave_requests    enable row level security;
alter table leave_reminder_log enable row level security;

-- A staffer reads their own requests. Everything else — the team view, every
-- write — goes through a service-role route where the permission gate lives.
drop policy if exists leave_requests_read_own on leave_requests;
create policy leave_requests_read_own on leave_requests
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on leave_requests from anon, authenticated;
revoke all on leave_requests     from anon;
revoke all on leave_reminder_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- the weekday constraint is real (this must FAIL):
--   -- insert into leave_requests (user_id, week_start, leave_date)
--   --   values ('<uuid>', '2026-08-10', '2026-08-15');   -- a Saturday
--
--   -- the Monday constraint is real (this must FAIL):
--   -- insert into leave_requests (user_id, week_start, leave_date)
--   --   values ('<uuid>', '2026-08-11', '2026-08-12');   -- Tuesday week_start
--
--   select permission_key, min_role from role_permissions where permission_key = 'leave_approve';
--   select max_leave_days_per_week from attendance_settings;
--
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
