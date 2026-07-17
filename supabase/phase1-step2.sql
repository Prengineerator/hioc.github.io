-- HIOC Phase 1 — STEP 2 of 2. Run this whole file in the Supabase SQL editor
-- AFTER running the 4 enum ALTERs from STEP 1 (supabase/phase1-step1.sql) and
-- letting them commit. Everything below is idempotent (safe to re-run).

-- SECTION 2 — New enums for order type & payment  (run after Section 1 commits)
-- ===========================================================================

do $$ begin
  create type order_type as enum ('takeaway', 'dine_in', 'delivery');
exception when duplicate_object then null; end $$;

-- Payment tracking is fulfillment-independent, so it lives in its own enum/
-- column rather than muddying order_status. Phase 1 only records manual
-- counter payments (STF-041); the gateway states are reserved for Phase 2.
do $$ begin
  create type payment_status as enum ('unpaid', 'payment_pending', 'paid', 'refunded', 'partially_refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_method as enum ('cash', 'upi', 'card', 'online');
exception when duplicate_object then null; end $$;

-- ===========================================================================
-- SECTION 3 — orders: new columns  (F1, S3/S7, C1/C4/C5)
-- ===========================================================================

alter table orders add column if not exists order_type         order_type not null default 'takeaway';
alter table orders add column if not exists promised_ready_at   timestamptz;                    -- ETA set by staff on accept (STF-006)
alter table orders add column if not exists pickup_code         text;                           -- shown to customer / verified at counter (CUS-056)
alter table orders add column if not exists pickup_slot_start   timestamptz;                    -- structured slot (CUS-026) — replaces free-text pickup_time
alter table orders add column if not exists pickup_slot_label   text not null default '';       -- e.g. 'ASAP (~15 min)', '1:30 PM'
alter table orders add column if not exists tax_inr             integer not null default 0 check (tax_inr >= 0);   -- GST breakup (CUS-031)
alter table orders add column if not exists packaging_inr       integer not null default 0 check (packaging_inr >= 0);
alter table orders add column if not exists discount_inr        integer not null default 0 check (discount_inr >= 0);
alter table orders add column if not exists total_inr           integer;                        -- grand total snapshot (subtotal + tax + packaging - discount)
alter table orders add column if not exists payment_status      payment_status not null default 'unpaid';
alter table orders add column if not exists payment_method      payment_method;                 -- null until collected (STF-041)
alter table orders add column if not exists reject_reason       text not null default '';       -- populated on rejected/cancelled (STF-003)
alter table orders add column if not exists version             integer not null default 0;     -- optimistic-concurrency guard (F1 double-transition)

-- Backfill total_inr for existing rows so metric views don't see nulls.
update orders
  set total_inr = subtotal_inr + tax_inr + packaging_inr - discount_inr
  where total_inr is null;

-- NOTE: the legacy free-text `pickup_time` column is retained (deprecated).
-- New orders write pickup_slot_start/pickup_slot_label; read paths should
-- prefer the slot fields and fall back to pickup_time for old rows.

create index if not exists idx_orders_payment_status on orders (payment_status);
create index if not exists idx_orders_promised_ready on orders (promised_ready_at);

-- ===========================================================================
-- SECTION 4 — order_status_events: timestamped, attributed transitions  (F1)
-- ===========================================================================
-- One row per lifecycle transition. Written by the server Route Handlers
-- (service role) as part of each status change — NOT by a DB trigger, because
-- the acting staff user (actor_id) is only known at the app layer. This table
-- is the source of truth for SLA metrics (OWN-008) and the audit trail.
create table if not exists order_status_events (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  from_status   order_status,                 -- null for the initial 'received' event
  to_status     order_status not null,
  actor_id      uuid references auth.users(id) on delete set null,   -- null for customer/system actions
  actor_role    text not null default 'system' check (actor_role in ('customer', 'staff', 'owner', 'system')),
  reason        text not null default '',      -- required on reject/cancel
  created_at    timestamptz not null default now()
);

create index if not exists idx_order_status_events_order on order_status_events (order_id, created_at);
create index if not exists idx_order_status_events_to on order_status_events (to_status);

-- ===========================================================================
-- SECTION 5 — menu_items: photo + 86/snooze  (S6, C6)
-- ===========================================================================
alter table menu_items add column if not exists image_url         text not null default '';
alter table menu_items add column if not exists unavailable_until  timestamptz;   -- 86 auto-reenable (STF-032); null = not snoozed

-- order_items: per-line special instructions (CUS-021, C4). Snapshotted on the
-- line at order time like every other order_item field, so later edits never
-- rewrite history.
alter table order_items add column if not exists special_instructions text not null default '';

-- ===========================================================================
-- SECTION 6 — notifications: delivery log  (F4)
-- ===========================================================================
create table if not exists notifications (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  channel       text not null check (channel in ('whatsapp', 'sms', 'push', 'email')),
  event         text not null check (event in ('accepted', 'ready', 'rejected', 'cancelled')),
  status        text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  provider_ref  text not null default '',      -- gateway/provider message id
  error         text not null default '',
  attempts      integer not null default 0,
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  -- idempotency: one successful send per (order, event, channel)
  unique (order_id, event, channel)
);

create index if not exists idx_notifications_order on notifications (order_id);
create index if not exists idx_notifications_status on notifications (status);

-- ===========================================================================
-- SECTION 7 — store_settings: single-row config  (O5)
-- ===========================================================================
-- Singleton config row that the customer site (hours/slots/tax) and staff ETA
-- defaults read from, editable by the owner without a redeploy. `is_singleton`
-- + unique index guarantees exactly one row.
create table if not exists store_settings (
  id                    uuid primary key default gen_random_uuid(),
  is_singleton          boolean not null default true,
  -- Weekly hours as JSON: { "mon": [{"open":"10:00","close":"24:00"}], ... }
  opening_hours         jsonb not null default '{}'::jsonb,
  holidays              jsonb not null default '[]'::jsonb,          -- ["2026-08-15", ...]
  last_order_cutoff_min integer not null default 30,                 -- stop taking orders N min before close
  pickup_slot_len_min   integer not null default 15,                 -- slot granularity (CUS-026)
  pickup_slot_capacity  integer not null default 0,                  -- max orders per slot; 0 = unlimited
  default_prep_min      integer not null default 15,                 -- default ETA on accept (STF-006)
  busy_buffer_min       integer not null default 15,                 -- extra ETA when busy mode on (STF-043)
  accepting_orders      boolean not null default true,               -- pause switch (STF-043)
  store_open_override   text not null default 'auto' check (store_open_override in ('auto', 'force_open', 'force_closed')),
  gst_percent           numeric(5,2) not null default 5.00,          -- GST rate (CUS-031/O5)
  gst_inclusive         boolean not null default false,              -- price incl. tax vs added on top
  packaging_charge_inr  integer not null default 0 check (packaging_charge_inr >= 0),
  updated_at            timestamptz not null default now()
);

create unique index if not exists idx_store_settings_singleton on store_settings (is_singleton);

-- Seed the one settings row (no-op if it already exists). Seeds the cafe's real
-- hours (10:00 AM–12:00 AM daily, per lib/constants.ts CAFE_HOURS) so the store
-- reads as OPEN immediately — an empty opening_hours ('{}') would make
-- computeStoreOpenState treat every hour as closed and block all checkouts.
insert into store_settings (is_singleton, opening_hours) values (
  true,
  '{"mon":[{"open":"10:00","close":"24:00"}],"tue":[{"open":"10:00","close":"24:00"}],"wed":[{"open":"10:00","close":"24:00"}],"thu":[{"open":"10:00","close":"24:00"}],"fri":[{"open":"10:00","close":"24:00"}],"sat":[{"open":"10:00","close":"24:00"}],"sun":[{"open":"10:00","close":"24:00"}]}'::jsonb
)
on conflict (is_singleton) do nothing;

create trigger trg_store_settings_updated_at
  before update on store_settings
  for each row execute function set_updated_at();

-- ===========================================================================
-- SECTION 8 — RBAC: add 'owner' role + role-change audit  (F3)
-- ===========================================================================
-- Widen the profiles.role check to include 'owner'. The inline check from
-- schema.sql is auto-named profiles_role_check.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('staff', 'customer', 'owner'));

-- Audit every role change (who changed whom, when). Written by whatever
-- performs the change (SQL editor / admin route); no self-service role change.
create table if not exists role_change_audit (
  id            uuid primary key default gen_random_uuid(),
  target_user   uuid not null references auth.users(id) on delete cascade,
  old_role      text,
  new_role      text not null,
  changed_by    uuid references auth.users(id) on delete set null,
  changed_at    timestamptz not null default now()
);

-- Trigger to auto-record role transitions on the profiles table.
create or replace function log_role_change()
returns trigger as $$
begin
  if new.role is distinct from old.role then
    insert into role_change_audit (target_user, old_role, new_role, changed_by)
    values (new.id, old.role, new.role, auth.uid());
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_profiles_role_change on profiles;
create trigger trg_profiles_role_change
  after update of role on profiles
  for each row execute function log_role_change();

-- ===========================================================================
-- SECTION 9 — Row Level Security for the new tables
-- ===========================================================================
-- Consistent with schema.sql: customer/anon order data never touches the anon
-- key (server service-role only); staff/owner reads are gated to authenticated.
-- (These policies intentionally do not distinguish staff vs owner at the RLS
-- layer for reads — route guards + getStaffUser()/getOwnerUser() enforce the
-- surface split; RLS is the backstop that blocks anon access entirely.)

alter table order_status_events enable row level security;
alter table notifications        enable row level security;
alter table store_settings       enable row level security;
alter table role_change_audit    enable row level security;

create policy order_status_events_staff_read on order_status_events
  for select to authenticated using (true);

create policy notifications_staff_read on notifications
  for select to authenticated using (true);

-- store_settings: public may READ (customer site needs hours/tax/slots),
-- only authenticated staff/owner may WRITE (enforced further by route guard).
create policy store_settings_public_read on store_settings
  for select using (true);
create policy store_settings_staff_write on store_settings
  for update to authenticated using (true) with check (true);

create policy role_change_audit_owner_read on role_change_audit
  for select to authenticated using (true);

-- ===========================================================================
-- SECTION 10 — Analytics views for the Owner dashboard v1  (F5, O1–O4)
-- ===========================================================================
-- Start with plain (non-materialized) views for correctness and zero refresh
-- overhead. If a range query gets slow at volume, convert the hot ones to
-- materialized views + a pg_cron refresh (noted per view). All revenue uses
-- the SNAPSHOTTED order totals so historical menu edits never rewrite history.

-- Orders considered "valid revenue": not rejected/cancelled.
create or replace view v_valid_orders as
  select *
  from orders
  where status not in ('rejected', 'cancelled');

-- Daily sales (OWN-003): revenue, order count, AOV per calendar day (IST).
create or replace view v_daily_sales as
  select
    (created_at at time zone 'Asia/Kolkata')::date as sale_date,
    count(*)                                        as orders,
    coalesce(sum(total_inr), 0)                     as revenue_inr,
    coalesce(round(avg(total_inr)), 0)              as aov_inr
  from v_valid_orders
  group by 1
  order by 1 desc;

-- Item sales (OWN-005): units + revenue per item, from snapshots.
create or replace view v_item_sales as
  select
    oi.menu_item_id,
    oi.name_snapshot                       as item_name,
    sum(oi.quantity)                       as units_sold,
    coalesce(sum(oi.line_total_inr), 0)    as revenue_inr
  from order_items oi
  join v_valid_orders o on o.id = oi.order_id
  group by oi.menu_item_id, oi.name_snapshot
  order by revenue_inr desc;

-- Peak-hours heatmap (OWN-007): day-of-week × hour order counts (IST).
create or replace view v_hourly_orders as
  select
    extract(dow  from (created_at at time zone 'Asia/Kolkata')) as dow,   -- 0=Sun
    extract(hour from (created_at at time zone 'Asia/Kolkata')) as hour_of_day,
    count(*)                                                    as orders,
    coalesce(sum(total_inr), 0)                                as revenue_inr
  from v_valid_orders
  group by 1, 2;

-- SLA / prep-time (OWN-008): per-order stage durations from the event log.
-- accept_secs = received→accepted, prep_secs = accepted→ready,
-- fulfil_secs = received→completed. Nulls where a stage didn't occur.
create or replace view v_order_durations as
  select
    e.order_id,
    (created_at at time zone 'Asia/Kolkata')::date as order_date,
    extract(epoch from (
      min(created_at) filter (where to_status = 'accepted')
      - min(created_at) filter (where to_status = 'received')
    ))::int as accept_secs,
    extract(epoch from (
      min(created_at) filter (where to_status = 'ready')
      - min(created_at) filter (where to_status = 'accepted')
    ))::int as prep_secs,
    extract(epoch from (
      min(created_at) filter (where to_status = 'completed')
      - min(created_at) filter (where to_status = 'received')
    ))::int as fulfil_secs
  from order_status_events e
  group by e.order_id, order_date;

-- Reason breakdown (OWN-003 orders analytics): rejection/cancellation reasons.
create or replace view v_reject_reasons as
  select
    status,
    coalesce(nullif(reject_reason, ''), 'unspecified') as reason,
    count(*)                                            as cnt
  from orders
  where status in ('rejected', 'cancelled')
  group by 1, 2
  order by cnt desc;

-- ===========================================================================
-- END OF PHASE 1 MIGRATION
-- Remember: mirror all of the above in lib/types.ts when this is applied,
-- and confirm the RLS matrix in review (NFR-004).
-- ===========================================================================
