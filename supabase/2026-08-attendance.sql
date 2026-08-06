-- ===========================================================================
-- Phase 5 · FND5-M — attendance, geofence and payroll.
--
-- Spec: docs/PHASE-5-SPEC.md §6. Security invariants: docs/SECURITY-PLAYBOOK.md
-- A-1..A-9. Apply BEFORE deploying any /api/attendance route.
--
-- THREE INVARIANTS ARE ENFORCED HERE, IN THE DATABASE, RATHER THAN IN APP CODE,
-- because each one is load-bearing for someone's pay and a route is easier to
-- get wrong than a constraint:
--
--   1. The punch TIME comes from the database (`default now()`), never from the
--      caller. A phone's clock is attacker-controlled; if the client can name
--      the time, the whole record is fiction (playbook A-1).
--   2. The BUSINESS DATE is derived by a trigger, not passed in. The cafe runs
--      10:00–24:00, so shifts routinely cross midnight — the whole shift belongs
--      to the date it STARTED, which is the same convention cash_days already
--      uses for the drawer. Two subsystems disagreeing about which day a 00:30
--      event belongs to is a bug nobody finds until month-end.
--   3. ONE OPEN SESSION per staffer, as a partial unique index. Enforcing this
--      by "check then insert" in a route is a race; two taps on a flaky
--      connection would open two shifts and pay for both.
--
-- WHAT IS DELIBERATELY NOT READABLE: attendance_settings (a staffer who knows
-- the geofence radius knows most of what they need to beat it — playbook A-3),
-- staff_employment and payroll_* (salary is owner-only, including one's own).
-- These get RLS with NO policy *and* an explicit REVOKE — either alone can be
-- undone by a later migration that forgets the other.
--
-- Safe to re-run.
-- ===========================================================================

-- Needed for the no-overlapping-employment-periods exclusion constraint below.
create extension if not exists btree_gist;

-- ===========================================================================
-- SECTION 1 — attendance_settings: the singleton rule set  (OPS5-1, GEO-1)
-- ===========================================================================
-- Both halves of the config live here: the geofence (read by the punch route)
-- and the payroll rules (read by the salary engine). Defaults are chosen so an
-- owner who configures nothing still gets sane behaviour — EXCEPT the store
-- coordinates, which are deliberately NULL. There is no safe default for "where
-- is the cafe", and guessing one would silently accept every punch on earth.
create table if not exists attendance_settings (
  id                      uuid primary key default gen_random_uuid(),
  is_singleton            boolean not null default true,

  -- Geofence. NULL lat/lng = not configured = punching is disabled (GEO-1).
  store_lat               numeric(9,6),
  store_lng               numeric(9,6),
  geofence_radius_m       integer not null default 150 check (geofence_radius_m > 0),
  -- A ±2km accuracy circle centred inside a 150m radius proves nothing, so a
  -- reading less precise than this is refused rather than trusted.
  max_accuracy_m          integer not null default 100 check (max_accuracy_m > 0),
  -- Rejects a replayed cached position.
  max_fix_age_sec         integer not null default 60 check (max_fix_age_sec > 0),

  -- Payroll rules (OPS5-1b; read by the engine, not by the punch route).
  grace_period_min        integer not null default 15  check (grace_period_min >= 0),
  late_marks_per_halfday  integer not null default 3   check (late_marks_per_halfday > 0),
  ot_threshold_min        integer not null default 0   check (ot_threshold_min >= 0),
  ot_multiplier           numeric(3,2) not null default 1.00 check (ot_multiplier >= 0),
  auto_break_min          integer not null default 0   check (auto_break_min >= 0),
  auto_break_after_min    integer not null default 360 check (auto_break_after_min > 0),
  half_day_min_minutes    integer not null default 240 check (half_day_min_minutes >= 0),
  absent_below_minutes    integer not null default 120 check (absent_below_minutes >= 0),

  -- Missed clock-out handling (SHEET-3, D5-4).
  auto_close_grace_min    integer not null default 120 check (auto_close_grace_min >= 0),
  max_session_hours       integer not null default 14  check (max_session_hours > 0),

  -- D5-9: raw coordinates are purged after this many days; the derived distance
  -- and the accept/refuse outcome are kept.
  location_retention_days integer not null default 365 check (location_retention_days > 0),

  updated_by              uuid references auth.users(id) on delete set null,
  updated_at              timestamptz not null default now(),

  -- absent <= half_day keeps the day-classification ladder coherent; an owner
  -- should not be able to save a state where a day is both absent and a half day.
  constraint attendance_thresholds_ordered
    check (absent_below_minutes <= half_day_min_minutes)
);

create unique index if not exists idx_attendance_settings_singleton
  on attendance_settings (is_singleton);

insert into attendance_settings (is_singleton) values (true)
on conflict (is_singleton) do nothing;

drop trigger if exists trg_attendance_settings_updated_at on attendance_settings;
create trigger trg_attendance_settings_updated_at
  before update on attendance_settings
  for each row execute function set_updated_at();

-- ===========================================================================
-- SECTION 2 — staff_employment: salary + shift, effective-dated  (SHEET-4)
-- ===========================================================================
-- Effective-dated ON PURPOSE. A raise must not rewrite what last month was paid
-- at, so a change writes a NEW row and closes the old one rather than updating
-- in place. Payroll prices each day with the row in effect on that day.
create table if not exists staff_employment (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  monthly_salary_inr       integer not null check (monthly_salary_inr >= 0),
  contracted_hours_per_day numeric(4,2) not null check (contracted_hours_per_day > 0 and contracted_hours_per_day <= 24),
  shift_start_time         time not null,
  shift_end_time           time not null,
  -- 0 = Sunday .. 6 = Saturday, matching Postgres extract(dow). NULL = no weekly off.
  weekly_off_dow           smallint check (weekly_off_dow between 0 and 6),
  effective_from           date not null,
  effective_to             date,                      -- NULL = still in effect
  created_by               uuid references auth.users(id) on delete set null,
  created_at               timestamptz not null default now(),

  constraint staff_employment_range_valid
    check (effective_to is null or effective_to > effective_from)
);

create index if not exists idx_staff_employment_user on staff_employment (user_id, effective_from desc);

-- Two overlapping employment rows would make "the rate in effect on this day"
-- ambiguous, and payroll would silently pick one. Refuse it at the DB.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'staff_employment_no_overlap'
  ) then
    alter table staff_employment add constraint staff_employment_no_overlap
      exclude using gist (
        user_id with =,
        daterange(effective_from, effective_to, '[)') with &&
      );
  end if;
end $$;

-- ===========================================================================
-- SECTION 3 — attendance_sessions: the core record  (ATT-1, GEO-1/3)
-- ===========================================================================
create table if not exists attendance_sessions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,

  -- Set by trigger from clock_in_at (SECTION 4). Never accepted from a caller.
  business_date         date not null,

  -- INVARIANT A-1: the database supplies the time.
  clock_in_at           timestamptz not null default now(),
  clock_in_lat          numeric(9,6),
  clock_in_lng          numeric(9,6),
  clock_in_accuracy_m   numeric(8,2),
  clock_in_distance_m   numeric(10,2),

  clock_out_at          timestamptz,
  clock_out_lat         numeric(9,6),
  clock_out_lng         numeric(9,6),
  clock_out_accuracy_m  numeric(8,2),
  clock_out_distance_m  numeric(10,2),

  status                text not null default 'open'
                          check (status in ('open', 'closed', 'auto_closed', 'void')),
  -- 'punch' = geofence-verified; 'manual' = the owner entered it (SHEET-2).
  -- The distinction is permanent and surfaced everywhere, including payroll:
  -- a manual entry must never be presentable as a verified punch.
  source                text not null default 'punch' check (source in ('punch', 'manual')),
  -- GEO-2 integrity signals: low_confidence, static_coords, impossible_travel,
  -- implausible_accuracy, auto_closed. Informational — they never block a punch.
  flags                 text[] not null default '{}',

  approved_by           uuid references auth.users(id) on delete set null,
  approved_at           timestamptz,
  notes                 text not null default '',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint attendance_session_times_ordered
    check (clock_out_at is null or clock_out_at > clock_in_at),
  -- An open session has no clock-out; a closed one must have it. Prevents a
  -- half-written row from reading as a completed shift.
  constraint attendance_session_status_consistent
    check (
      (status = 'open' and clock_out_at is null)
      or (status in ('closed', 'auto_closed') and clock_out_at is not null)
      or status = 'void'
    )
);

-- INVARIANT 3: at most one open session per staffer, enforced as a constraint
-- rather than a check-then-insert race in the route.
create unique index if not exists idx_attendance_one_open_session
  on attendance_sessions (user_id) where status = 'open';

create index if not exists idx_attendance_sessions_user_date
  on attendance_sessions (user_id, business_date desc);
create index if not exists idx_attendance_sessions_date
  on attendance_sessions (business_date desc);
-- Drives the auto-close cron (SHEET-3), which scans only open rows.
create index if not exists idx_attendance_sessions_open
  on attendance_sessions (clock_in_at) where status = 'open';

drop trigger if exists trg_attendance_sessions_updated_at on attendance_sessions;
create trigger trg_attendance_sessions_updated_at
  before update on attendance_sessions
  for each row execute function set_updated_at();

-- ===========================================================================
-- SECTION 4 — business-date trigger  (GEO-3, INVARIANT 2)
-- ===========================================================================
-- Asia/Kolkata is UTC+5:30 with no DST, so the offset is a constant and this
-- needs no timezone table lookup. It cannot be a GENERATED column: the
-- AT TIME ZONE family is STABLE, not IMMUTABLE, and generated columns require
-- IMMUTABLE expressions. A trigger is the next-strongest guarantee and, unlike
-- computing it in the route, it holds for every writer including a manual
-- INSERT typed into the SQL editor at 1am.
create or replace function set_attendance_business_date()
returns trigger as $$
begin
  new.business_date := (new.clock_in_at + interval '5 hours 30 minutes')::date;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_attendance_business_date on attendance_sessions;
create trigger trg_attendance_business_date
  before insert or update of clock_in_at on attendance_sessions
  for each row execute function set_attendance_business_date();

-- ===========================================================================
-- SECTION 4b — clock-out RPC  (INVARIANT 1, playbook A-1)
-- ===========================================================================
-- The clock-IN time arrives free, via the column default. The clock-OUT time
-- does not, and PostgREST cannot send `now()` in an UPDATE payload — so without
-- this function the route would have to send its own clock.
--
-- That is not merely inelegant. Vercel and Supabase are different hosts with
-- independently drifting clocks: if the app server is a second or two behind
-- the database, a quick in-then-out writes a clock_out_at EARLIER than a
-- clock_in_at that came from `now()`, and the times-ordered CHECK rejects an
-- entirely legitimate punch. One clock, or intermittent 500s at the counter.
--
-- Status-guarded inside the statement so a concurrent auto-close (SHEET-3) and
-- a real clock-out cannot both win: whoever gets there first closes the row,
-- the loser matches zero rows and returns null.
--
-- Normal UPDATEs are left alone on purpose — owner corrections (SHEET-2)
-- legitimately set an arbitrary clock_out_at, and must not be forced to now().
create or replace function attendance_clock_out(
  p_session_id  uuid,
  p_user_id     uuid,
  p_lat         numeric,
  p_lng         numeric,
  p_accuracy_m  numeric,
  p_distance_m  numeric,
  p_flags       text[]
) returns setof attendance_sessions
language sql
as $$
  update attendance_sessions
     set clock_out_at         = now(),
         clock_out_lat        = p_lat,
         clock_out_lng        = p_lng,
         clock_out_accuracy_m = p_accuracy_m,
         clock_out_distance_m = p_distance_m,
         status               = 'closed',
         flags                = p_flags
   where id      = p_session_id
     and user_id = p_user_id
     and status  = 'open'
  returning *;
$$;

-- Service role only. The route is the authorization gate; nothing in a browser
-- session has any business closing a shift directly.
revoke all on function attendance_clock_out(uuid, uuid, numeric, numeric, numeric, numeric, text[])
  from anon, authenticated;

-- ===========================================================================
-- SECTION 5 — attendance_punch_attempts: refused punches  (GEO-2)
-- ===========================================================================
-- A refusal that leaves no trace is a refusal nobody can learn from. "Tried
-- four times from home, then walked in" is only legible if the failures are
-- recorded — and this table is also the evidence a staffer needs when they say
-- the geofence is rejecting them unfairly.
create table if not exists attendance_punch_attempts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  punch_type  text not null check (punch_type in ('in', 'out')),
  lat         numeric(9,6),
  lng         numeric(9,6),
  accuracy_m  numeric(8,2),
  distance_m  numeric(10,2),
  reason      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_punch_attempts_user
  on attendance_punch_attempts (user_id, created_at desc);

-- ===========================================================================
-- SECTION 6 — attendance_edits: correction audit  (SHEET-2)
-- ===========================================================================
-- Same shape as order_amendments / permission_change_audit: what changed, from
-- what, to what, by whom, when, and why. `reason` is NOT NULL by design — an
-- unexplained edit to someone's pay record is exactly what this table exists to
-- prevent.
create table if not exists attendance_edits (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references attendance_sessions(id) on delete cascade,
  field       text not null,
  old_value   text,
  new_value   text,
  reason      text not null check (length(trim(reason)) > 0),
  edited_by   uuid references auth.users(id) on delete set null,
  edited_at   timestamptz not null default now()
);

create index if not exists idx_attendance_edits_session
  on attendance_edits (session_id, edited_at desc);

-- ===========================================================================
-- SECTION 7 — payroll_runs / payroll_run_lines  (PAY-4)
-- ===========================================================================
-- rules_snapshot freezes the rule set AND the rates actually used. Without it,
-- an owner changing the OT multiplier in November would silently restate
-- October's payslips — the numbers on a run must be the numbers that were paid.
create table if not exists payroll_runs (
  id              uuid primary key default gen_random_uuid(),
  period_start    date not null,
  period_end      date not null,
  status          text not null default 'draft'
                    check (status in ('draft', 'finalized', 'reversed')),
  rules_snapshot  jsonb not null default '{}'::jsonb,
  generated_by    uuid references auth.users(id) on delete set null,
  generated_at    timestamptz not null default now(),
  finalized_at    timestamptz,
  reversed_at     timestamptz,
  reversal_reason text,

  constraint payroll_period_valid check (period_end >= period_start)
);

-- One ACTIVE run per period. A reversed run stays on the record (that is the
-- point of reversing rather than deleting) and does not block a corrected re-run.
create unique index if not exists idx_payroll_runs_active_period
  on payroll_runs (period_start, period_end) where status <> 'reversed';

create table if not exists payroll_run_lines (
  id                       uuid primary key default gen_random_uuid(),
  run_id                   uuid not null references payroll_runs(id) on delete cascade,
  user_id                  uuid not null references auth.users(id) on delete cascade,

  -- Frozen copies of the inputs, not FKs to live rows.
  monthly_salary_inr       integer not null default 0,
  contracted_hours_per_day numeric(4,2) not null default 0,
  per_minute_paise         numeric(12,4) not null default 0,

  days_present             integer not null default 0,
  days_half                integer not null default 0,
  days_absent              integer not null default 0,
  days_off                 integer not null default 0,
  days_paid_leave          integer not null default 0,   -- D5-6

  worked_minutes           integer not null default 0,
  ot_minutes               integer not null default 0,
  late_marks               integer not null default 0,

  base_pay_inr             integer not null default 0,
  ot_pay_inr               integer not null default 0,
  deductions_inr           integer not null default 0,
  -- D5-7: advances / loans / one-off corrections. Signed; a negative value
  -- reduces net pay. Reason lives in `detail`.
  adjustments_inr          integer not null default 0,
  net_pay_inr              integer not null default 0,

  -- Day-by-day derivation. PAY-3 renders this; it is what makes the number
  -- trusted rather than re-checked by hand.
  detail                   jsonb not null default '{}'::jsonb,

  unique (run_id, user_id)
);

create index if not exists idx_payroll_run_lines_run on payroll_run_lines (run_id);

-- ===========================================================================
-- SECTION 8 — Row Level Security
-- ===========================================================================
alter table attendance_settings        enable row level security;
alter table staff_employment           enable row level security;
alter table attendance_sessions        enable row level security;
alter table attendance_punch_attempts  enable row level security;
alter table attendance_edits           enable row level security;
alter table payroll_runs               enable row level security;
alter table payroll_run_lines          enable row level security;

-- The ONE readable surface: a staffer may read their OWN sessions (ATT-4).
-- Note this is SELECT only — every write goes through a service-role route, so
-- nobody can insert themselves a shift.
drop policy if exists attendance_sessions_read_own on attendance_sessions;
create policy attendance_sessions_read_own on attendance_sessions
  for select to authenticated using (auth.uid() = user_id);

-- A staffer may read their own refused attempts, so "why won't it let me clock
-- in" is answerable without asking the owner.
drop policy if exists attendance_attempts_read_own on attendance_punch_attempts;
create policy attendance_attempts_read_own on attendance_punch_attempts
  for select to authenticated using (auth.uid() = user_id);

-- Everything else has RLS enabled and NO policy, which denies all access to
-- anon/authenticated. The service role bypasses RLS, which is how the owner
-- routes read them. The REVOKEs below are the second, independent layer.
revoke all on attendance_settings       from anon, authenticated;
revoke all on staff_employment          from anon, authenticated;
revoke all on attendance_edits          from anon, authenticated;
revoke all on payroll_runs              from anon, authenticated;
revoke all on payroll_run_lines         from anon, authenticated;

-- The two readable tables keep SELECT (their policies narrow it to own-rows)
-- but must never be writable from a browser session.
revoke insert, update, delete on attendance_sessions       from anon, authenticated;
revoke insert, update, delete on attendance_punch_attempts from anon, authenticated;
revoke all                    on attendance_sessions       from anon;
revoke all                    on attendance_punch_attempts from anon;

-- ===========================================================================
-- SECTION 9 — permission keys  (FND3-6 matrix)
-- ===========================================================================
-- MIRROR THESE IN lib/permissions.ts (KNOWN_PERMISSION_KEYS + DEFAULT_MIN_ROLE)
-- AND lib/types.ts (PermissionKey) IN THE SAME CHANGE. hasPermission() fails
-- CLOSED to manager for any key with no row here, so an unseeded key silently
-- escalates the action instead of failing loudly.
--
-- NOTE WHAT IS *NOT* HERE: there is no 'attendance_punch' key. Clocking in and
-- out is gated on a valid staff session ONLY. Gating the one action every
-- staffer performs daily behind a key that fails closed to manager would stop
-- the whole team marking attendance the moment a seed row went missing
-- (playbook A-4; Phase 4's TAB-1 hit this exact trap).
insert into role_permissions (permission_key, min_role) values
  ('attendance_edit',    'manager'),
  ('attendance_approve', 'manager')
on conflict (permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- settings row exists, coordinates still unset (punching disabled):
--   select store_lat, store_lng, geofence_radius_m from attendance_settings;
--
--   -- the two new keys are seeded (else they fail closed to manager):
--   select * from role_permissions where permission_key like 'attendance%';
--
--   -- one-open-session constraint is real (second insert must fail):
--   -- insert into attendance_sessions (user_id) values ('<uuid>'), ('<uuid>');
--
--   -- business_date is trigger-derived, not passed in — a 00:30 IST punch
--   -- belongs to the PREVIOUS day:
--   select clock_in_at, business_date from attendance_sessions order by 1 desc limit 5;
--
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
