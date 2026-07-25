-- HIOC Phase 3 "Dine-In & Counter Ops" — schema migration.
-- Companion to docs/PHASE-3-SPEC.md §7. ADDITIVE and (where possible)
-- idempotent — run AFTER phase1-migration.sql and phase2-migration.sql.
--
-- HOW TO RUN (Supabase SQL Editor):
--   Run SECTION 1 first on its own and let it commit if it ever adds real enum
--   values (it is a no-op placeholder today — like phase2-migration.sql — since
--   channel / amendment-kind / permission-role are modeled as CHECK-constrained
--   text for flexibility), then run the rest.
--
-- WHAT THIS PHASE ADDS: staff as a second order-entry channel (dine-in / POS).
--  * tables registry (with a QR token reserved for QR-1)
--  * orders gain a channel, a table + label snapshot, and a creating-staff id
--    (orders.customer_email already exists from the link-based e-bill migration;
--     the RCT-2 email-bill work reuses it — no column added here)
--  * order_items can be VOIDED (never deleted) — corrections, not edits (FND3-4)
--  * order_amendments audits every correction (open `kind` enum)
--  * cash_days: denomination-based day-open/close with over/short (OPS-2)
--  * role_permissions: owner-configurable matrix over sensitive actions (FND3-6)
--
-- SECURITY MODEL: identical posture to Phase 1/2. All new operational tables are
-- staff/owner-facing (route guards + `hasPermission()` narrow further); the ONE
-- public-read surface is `tables` (active rows, MINUS qr_token — resolved
-- server-side only). No customer self-read policy changes; staff-created orders
-- with a null user_id are simply invisible to the Phase-2 per-user policies.
--
-- WHEN APPLIED FOR REAL: mirror every change in lib/types.ts in the SAME PR
-- (FND3-M), and run the RLS review (tables / qr_token exposure) + the
-- correction-math and state-machine tests from the Phase-3 DoD.

-- ===========================================================================
-- SECTION 1 — Enum extensions  (no-op placeholder; run first if ever real)
-- ===========================================================================
-- order channel, amendment kind, and permission min-role are all
-- CHECK-constrained text (below), not Postgres enums — so no ALTER TYPE is
-- needed here. Kept as a numbered placeholder so the run order matches the
-- Phase-1/2 migration structure.
select 1;

-- ===========================================================================
-- SECTION 2 — tables registry  (FND3-1, POS-3, QR-1)
-- ===========================================================================
-- Physical tables an order can be pinned to. Created BEFORE the orders.table_id
-- FK in SECTION 3 references it. qr_token is generated at creation and reserved
-- for QR-1 (scan-to-order); it is NEVER exposed to an unauthenticated client
-- payload — resolved server-side only (see SECTION 8).
create table if not exists tables (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,                                          -- e.g. 'T1'
  zone        text not null default '',                               -- e.g. 'Terrace'; '' = none
  capacity    integer not null default 0 check (capacity >= 0),       -- 0 = unspecified
  qr_token    text not null default replace(gen_random_uuid()::text, '-', '') unique,
  is_active   boolean not null default true,                          -- soft-deactivate only
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Case-insensitive unique label (blocks 'T1' vs 't1' duplicates, FND3-1 AC).
create unique index if not exists idx_tables_label_ci on tables (lower(label));
create index if not exists idx_tables_active on tables (is_active);

create trigger trg_tables_updated_at
  before update on tables
  for each row execute function set_updated_at();

-- ===========================================================================
-- SECTION 3 — orders: channel, table, creating staff  (FND3-2/3)
-- ===========================================================================
-- channel: which surface created the order. Existing rows default to
-- 'customer_web' (the only channel before this phase). NOT NULL + default means
-- the backfill is automatic.
alter table orders add column if not exists channel text not null default 'customer_web'
  check (channel in ('customer_web', 'staff_pos', 'table_qr'));

-- table_id + a label SNAPSHOT (survives later table renames, same philosophy as
-- menu-price snapshots). Null for takeaway / web orders.
alter table orders add column if not exists table_id    uuid references tables(id) on delete set null;
alter table orders add column if not exists table_label text not null default '';

-- created_by: the staff/manager/owner who punched a staff_pos order. Null for
-- customer_web / table_qr. profiles.id = auth.users.id, so we reference
-- auth.users(id) exactly as Phase 2's refunds.created_by does.
alter table orders add column if not exists created_by uuid references auth.users(id) on delete set null;

-- NOTE: orders.customer_email is NOT added here — it already exists from the
-- link-based e-bill migration. Phase-3 RCT-2 (email bill) reuses that column.

create index if not exists idx_orders_channel  on orders (channel);
create index if not exists idx_orders_table_id on orders (table_id);
create index if not exists idx_orders_created_by on orders (created_by);

-- ===========================================================================
-- SECTION 4 — order_items: voidable lines  (FND3-4)
-- ===========================================================================
-- A wrongly punched line is VOIDED, never deleted: the row survives for audit
-- and because a KOT may already have fired. Voided lines are excluded from
-- totals by the (server-only) recompute path — enforced in code, not a trigger.
alter table order_items add column if not exists voided      boolean not null default false;
alter table order_items add column if not exists void_reason text not null default '';
alter table order_items add column if not exists voided_by   uuid references auth.users(id) on delete set null;
alter table order_items add column if not exists voided_at   timestamptz;

-- ===========================================================================
-- SECTION 5 — order_amendments: correction audit trail  (FND3-4)
-- ===========================================================================
-- One row per correction to an open order. `kind` is an OPEN check list — if the
-- service model ever adds table-service rounds, they attach here without a
-- schema break (docs/PHASE-3-SPEC.md §7 extensibility note).
create table if not exists order_amendments (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  staff_id    uuid references auth.users(id) on delete set null,      -- who did it (manager for gated actions)
  kind        text not null check (kind in ('void_item', 'change_table', 'comp')),
  payload     jsonb not null default '{}'::jsonb,                      -- {order_item_id, reason, ...}
  created_at  timestamptz not null default now()
);

create index if not exists idx_order_amendments_order on order_amendments (order_id, created_at);

-- ===========================================================================
-- SECTION 6 — cash_days: denomination day-open / day-close  (OPS-2, STF-045)
-- ===========================================================================
-- The cash drawer as a first-class object. Opening float and closing count are
-- entered by DENOMINATION (jsonb: {"500": 3, "200": 5, ...}); the totals are
-- always DERIVED server-side from the denoms — never typed. over_short =
-- counted - expected, where expected = opening + Σ cash settles − Σ cash refunds.
create table if not exists cash_days (
  id                uuid primary key default gen_random_uuid(),
  business_date     date not null unique,
  status            text not null default 'open' check (status in ('open', 'closed')),
  opened_by         uuid references auth.users(id) on delete set null,
  opened_at         timestamptz not null default now(),
  opening_denoms    jsonb not null default '{}'::jsonb,
  opening_total_inr integer not null default 0 check (opening_total_inr >= 0),
  closed_by         uuid references auth.users(id) on delete set null,   -- sign-off (manager by default)
  closed_at         timestamptz,
  closing_denoms    jsonb not null default '{}'::jsonb,
  counted_total_inr integer not null default 0 check (counted_total_inr >= 0),
  expected_cash_inr integer not null default 0,
  over_short_inr    integer not null default 0,                          -- counted - expected (signed)
  notes             text not null default ''
);

-- At most ONE open cash day at a time (OPS-2 AC).
create unique index if not exists idx_cash_days_one_open on cash_days (status) where status = 'open';

-- ===========================================================================
-- SECTION 7 — role_permissions: owner-configurable matrix  (FND3-6, STF-050/051)
-- ===========================================================================
-- Each sensitive action is a key gated at either 'staff' (staff-and-up) or
-- 'manager' (manager-and-up). A single hasPermission() helper (lib/permissions.ts,
-- FND3-6) consults this instead of hard-coded role checks. owner ALWAYS passes;
-- unknown/missing keys fail CLOSED to manager (enforced in the helper, not here).
create table if not exists role_permissions (
  permission_key text primary key,
  min_role       text not null default 'manager' check (min_role in ('staff', 'manager')),
  updated_by     uuid references auth.users(id) on delete set null,
  updated_at     timestamptz not null default now()
);

-- Seed the D4 defaults (money-touching actions = manager; routine ops = staff).
insert into role_permissions (permission_key, min_role) values
  ('pos_order_entry',    'staff'),
  ('settle_payment',     'staff'),
  ('menu_edit',          'staff'),
  ('cash_day_open',      'staff'),
  ('void_line',          'manager'),
  ('comp_order',         'manager'),
  ('refund',             'manager'),
  ('cash_day_close',     'manager')
on conflict (permission_key) do nothing;

-- ===========================================================================
-- SECTION 8 — Row Level Security for the new tables
-- ===========================================================================
-- Pattern (unchanged posture from Phase 1/2):
--  * tables: PUBLIC read of ACTIVE rows for the menu/table UI — but qr_token is
--    column-sensitive, so the public policy is paired with a note that clients
--    must select through the server (which strips qr_token). Writes are
--    authenticated-only (route guard narrows to owner).
--  * order_amendments / cash_days / role_permissions: staff/owner-facing;
--    authenticated read, authenticated write (route guards + hasPermission()
--    enforce owner/manager). Privileged writes go through server routes on the
--    service role, which bypasses RLS entirely.
alter table tables            enable row level security;
alter table order_amendments  enable row level security;
alter table cash_days         enable row level security;
alter table role_permissions  enable row level security;

-- Tables — public read of ACTIVE rows (menu/QR context needs label + zone).
-- NOTE: qr_token must NOT reach an unauthenticated client. App code reads tables
-- via server routes that select an explicit column list excluding qr_token; the
-- token is matched server-side (service role) when resolving /t/<token>.
create policy tables_public_read on tables for select using (is_active = true);
create policy tables_staff_write  on tables for insert to authenticated with check (true);
create policy tables_staff_update on tables for update to authenticated using (true) with check (true);

-- Order amendments — staff/owner read (route guard); writes via service role.
create policy order_amendments_staff_read on order_amendments for select to authenticated using (true);

-- Cash days — staff/owner read; writes via service role (gated by hasPermission).
create policy cash_days_staff_read on cash_days for select to authenticated using (true);

-- Role permissions — authenticated read (UIs need to know what's gated);
-- edits go through the owner-only server route (service role).
create policy role_permissions_read on role_permissions for select to authenticated using (true);

-- ===========================================================================
-- SECTION 9 — Channel & dine-in analytics views  (OPS-1)
-- ===========================================================================
-- IMPORTANT (same gotcha as phase2-migration.sql §10): v_valid_orders was
-- created as `select *`, freezing its column list. SECTION 2 added new orders
-- columns (channel, table_label, ...); refresh the view so they propagate before
-- the views below reference o.channel. CREATE OR REPLACE only appends columns,
-- so the Phase-1/2 views that read v_valid_orders keep working unchanged.
create or replace view v_valid_orders as
  select * from orders where status not in ('rejected', 'cancelled');

-- Orders + revenue by channel and order type (OPS-1): the headline "one order
-- base, every channel" view.
create or replace view v_channel_mix as
  select
    o.channel,
    o.order_type,
    count(*)                                as orders,
    coalesce(sum(o.total_inr), 0)           as revenue_inr,
    coalesce(round(avg(o.total_inr)), 0)    as avg_ticket_inr
  from v_valid_orders o
  group by o.channel, o.order_type
  order by revenue_inr desc;

-- Table turnover (OPS-1): settled orders per table per IST day — how hard each
-- table works. Only dine-in orders that reached a terminal-success state count.
create or replace view v_table_turnover as
  select
    o.table_id,
    o.table_label,
    (o.created_at at time zone 'Asia/Kolkata')::date as business_date,
    count(*)                                         as settled_orders,
    coalesce(sum(o.total_inr), 0)                    as revenue_inr
  from v_valid_orders o
  where o.table_id is not null and o.status = 'completed'
  group by o.table_id, o.table_label, 3
  order by 3 desc;

-- Staff order-entry leaderboard (OPS-1): orders keyed by the creating staff.
create or replace view v_staff_entry_stats as
  select
    o.created_by                            as staff_id,
    (o.created_at at time zone 'Asia/Kolkata')::date as business_date,
    count(*)                                as orders_entered,
    coalesce(sum(o.total_inr), 0)           as revenue_inr
  from v_valid_orders o
  where o.channel = 'staff_pos' and o.created_by is not null
  group by o.created_by, 2
  order by 2 desc;

-- ===========================================================================
-- SECTION 10 — permission_change_audit: who flipped which gate, when  (FND3-6)
-- ===========================================================================
-- Every owner edit to role_permissions is recorded here (FND3-6 AC: changes are
-- audited — who flipped what, when). Mirrors the Phase-1 role_change_audit
-- precedent, but is written by the owner-only permissions route (service role)
-- rather than a trigger: role_permissions.updated_by/updated_at carry the CURRENT
-- value, while this table keeps the full history of transitions.
create table if not exists permission_change_audit (
  id             uuid primary key default gen_random_uuid(),
  permission_key text not null,
  old_min_role   text,
  new_min_role   text not null,
  changed_by     uuid references auth.users(id) on delete set null,
  changed_at     timestamptz not null default now()
);

alter table permission_change_audit enable row level security;

-- Authenticated read (the owner UI may surface the history); writes go through
-- the owner-only server route on the service role, which bypasses RLS.
create policy permission_change_audit_read
  on permission_change_audit for select to authenticated using (true);

-- ===========================================================================
-- SECTION 11 — qr_token column-privilege hardening  (FND3-1 security / QR-1)
-- ===========================================================================
-- RLS is ROW-level and cannot hide a column, so the tables_public_read policy in
-- SECTION 8 still let the anon/authenticated keys SELECT qr_token off active rows
-- (the "minus qr_token" guarantee was enforced only by app convention). Close it
-- at the database with COLUMN privileges: revoke the broad SELECT those roles get
-- by default and re-grant only the non-sensitive columns. The service-role client
-- (all server routes) bypasses these grants and still reads/writes qr_token —
-- QR-1 resolves /t/<token> and QR-2 prints the card, both server-side.
revoke select on tables from anon, authenticated;
grant select (id, label, zone, capacity, is_active, sort_order, created_at, updated_at)
  on tables to anon, authenticated;

-- Writes to the registry are owner-only through the service-role owner route; no
-- client key should write it directly. Drop the permissive authenticated write
-- policies (no policy = deny for anon/authenticated; service role bypasses RLS).
drop policy if exists tables_staff_write  on tables;
drop policy if exists tables_staff_update on tables;

-- ===========================================================================
-- END OF PHASE 3 MIGRATION
-- Remember: mirror all of the above in lib/types.ts (FND3-M), never expose
-- tables.qr_token to unauthenticated clients, and run the RLS + correction-math
-- + state-machine tests from the Phase-3 DoD.
-- ===========================================================================
