-- Cash counts at every clock-in and clock-out (docs/PHASE-5-CASH-COUNTS.md).
--
-- Every count is a CHECKPOINT on one continuous chain for the drawer:
--   expected = previous counted total + cash settled − cash refunded
--              − cash taken out + cash put in        (all since that count)
--   variance = counted − expected   (negative = short)
-- A shortage becomes a cash_shortages row against the person whose count
-- revealed it; the owner approves (→ payroll deduction), waives, or reassigns.
--
-- All tables are service-role only (RLS on, no policies, explicit REVOKE —
-- same double lock as the payroll tables). Idempotent: safe to re-run.

-- ── Switches ────────────────────────────────────────────────────────────────
alter table attendance_settings
  add column if not exists cash_count_required boolean not null default false,
  -- A variance within ±tolerance is recorded but raises no shortage.
  add column if not exists cash_count_tolerance_inr integer not null default 0
    check (cash_count_tolerance_inr >= 0);

-- Kitchen staff who never touch the drawer can be exempted per person.
alter table staff_accounts
  add column if not exists handles_cash boolean not null default true;

-- ── When an order's money actually arrived ───────────────────────────────────
-- The chain needs "cash settled in (from, to]". A split settle has
-- order_payments.created_at; a single-tender settle only flips
-- orders.payment_status, and updated_at is bumped again by every later status
-- change (preparing → ready → completed) — which would count the same cash in
-- a LATER window and charge an honest staffer a phantom shortage. paid_at is
-- stamped once, by the database, the first time an order becomes paid, and
-- never moves again.
alter table orders add column if not exists paid_at timestamptz;

create or replace function set_order_paid_at() returns trigger
language plpgsql as $$
begin
  if new.paid_at is null
     and new.payment_status in ('paid', 'partially_refunded', 'refunded')
     and (tg_op = 'INSERT' or old.payment_status is distinct from new.payment_status) then
    new.paid_at := now();
  end if;
  if tg_op = 'UPDATE' and old.paid_at is not null then
    new.paid_at := old.paid_at;   -- immutable once set
  end if;
  return new;
end $$;

drop trigger if exists trg_orders_paid_at on orders;
create trigger trg_orders_paid_at
  before insert or update of payment_status, paid_at on orders
  for each row execute function set_order_paid_at();

-- Historic paid orders: best available approximation. The cash chain starts
-- at the first count after this migration, so these never enter a window.
update orders set paid_at = coalesce(updated_at, created_at)
where paid_at is null and payment_status in ('paid', 'partially_refunded', 'refunded');

create index if not exists orders_paid_at on orders (paid_at) where paid_at is not null;

-- ── Checkpoints ─────────────────────────────────────────────────────────────
create table if not exists cash_counts (
  id                    uuid primary key default gen_random_uuid(),
  kind                  text not null
                          check (kind in ('clock_in', 'clock_out', 'day_open', 'day_close', 'manual', 'override')),
  user_id               uuid not null references auth.users(id) on delete restrict,  -- who counted (or who was excused)
  attendance_session_id uuid references attendance_sessions(id) on delete set null,
  cash_day_id           uuid references cash_days(id) on delete set null,
  business_date         date not null,
  -- NULL for kind='override' (nothing was counted).
  denoms                jsonb,
  counted_total_inr     integer check (counted_total_inr >= 0),
  -- NULL when there is no previous checkpoint to chain from (the first ever).
  previous_count_id     uuid references cash_counts(id) on delete set null,
  expected_total_inr    integer,
  variance_inr          integer,
  -- Override: a manager/owner excused this punch from counting.
  override_by           uuid references auth.users(id) on delete set null,
  override_reason       text,
  created_at            timestamptz not null default now(),
  constraint cash_counts_override_shape check (
    (kind = 'override') = (override_by is not null and coalesce(length(trim(override_reason)), 0) > 0)
    and (kind = 'override') = (denoms is null and counted_total_inr is null)
  )
);

create index if not exists cash_counts_created on cash_counts (created_at desc);
create index if not exists cash_counts_user_created on cash_counts (user_id, created_at desc);
create unique index if not exists cash_counts_one_per_session_kind
  on cash_counts (attendance_session_id, kind)
  where attendance_session_id is not null and kind in ('clock_in', 'clock_out');

-- ── Cash that leaves or enters the drawer for a reason (bank deposit, petty
--    expense, owner top-up). Without these, the next count reads a deposit as
--    a shortage and charges it to a staffer.
create table if not exists cash_movements (
  id           uuid primary key default gen_random_uuid(),
  direction    text not null check (direction in ('out', 'in')),
  amount_inr   integer not null check (amount_inr > 0),
  reason       text not null check (length(trim(reason)) > 0),
  recorded_by  uuid not null references auth.users(id) on delete restrict,
  created_at   timestamptz not null default now()
);
create index if not exists cash_movements_created on cash_movements (created_at desc);

-- ── Manager/owner permission to skip one upcoming count ─────────────────────
create table if not exists cash_count_overrides (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,     -- the staffer excused
  punch_type  text not null check (punch_type in ('in', 'out')),
  reason      text not null check (length(trim(reason)) > 0),
  granted_by  uuid not null references auth.users(id) on delete restrict,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_count_id uuid references cash_counts(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists cash_count_overrides_user on cash_count_overrides (user_id, created_at desc);

-- ── Shortages, pending the owner's decision ─────────────────────────────────
create table if not exists cash_shortages (
  id              uuid primary key default gen_random_uuid(),
  count_id        uuid not null unique references cash_counts(id) on delete restrict,
  user_id         uuid not null references auth.users(id) on delete restrict,   -- currently attributed to
  original_user_id uuid not null references auth.users(id) on delete restrict,  -- whose count revealed it
  amount_inr      integer not null check (amount_inr > 0),
  business_date   date not null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'waived')),
  decided_by      uuid references auth.users(id) on delete set null,
  decided_at      timestamptz,
  decision_note   text not null default '',
  -- Set when an approved shortage is deducted in a finalized payroll run, so it
  -- is never deducted twice.
  payroll_run_id  uuid references payroll_runs(id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint cash_shortages_decided check ((status = 'pending') = (decided_at is null))
);
create index if not exists cash_shortages_status on cash_shortages (status, business_date);
create index if not exists cash_shortages_user on cash_shortages (user_id, business_date);

-- Payslip line for approved shortages (kept separate from adjustments so the
-- payslip can say what it was).
alter table payroll_run_lines
  add column if not exists cash_shortage_inr integer not null default 0 check (cash_shortage_inr >= 0);

-- ── Lock down ───────────────────────────────────────────────────────────────
alter table cash_counts          enable row level security;
alter table cash_movements       enable row level security;
alter table cash_count_overrides enable row level security;
alter table cash_shortages       enable row level security;
revoke all on cash_counts          from anon, authenticated;
revoke all on cash_movements       from anon, authenticated;
revoke all on cash_count_overrides from anon, authenticated;
revoke all on cash_shortages       from anon, authenticated;
