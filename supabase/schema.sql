-- HIOC cafe MVP — Supabase Postgres schema (v2: real menu with size variants
-- and Petpooja-sourced addon customization).
-- Do not execute automatically; run via the Supabase SQL editor or
-- `supabase db push`. Keep lib/types.ts in exact sync with this file.

-- Extensions
create extension if not exists pgcrypto;

-- Enums
create type order_status as enum ('received', 'preparing', 'ready', 'completed');
create type addon_selection_type as enum ('single', 'multi');

-- menu_items: one row per sellable item (e.g. "Latte", "Tripple Choco Waffle").
-- Pricing lives entirely in menu_item_variants, never here — every item has
-- at least one variant (single-price items get one variant labelled 'Regular').
create table menu_items (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  description      text not null default '',
  category         text not null,            -- e.g. 'Coffee', 'Stick Waffles' — the cafe's real POS category names
  parent_category  text not null default '', -- e.g. 'Hot', 'Creme', 'Iced Drinks' — '' when the category has no parent group
  is_veg           boolean not null default true,
  is_available     boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index idx_menu_items_category on menu_items (category);
create index idx_menu_items_available on menu_items (is_available);

-- menu_item_variants: size/portion options for an item, each with its own price.
create table menu_item_variants (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null references menu_items(id) on delete cascade,
  label         text not null,   -- 'Large', 'Extra Large', 'B', 'L', 'Regular', ...
  price_inr     integer not null check (price_inr >= 0),
  sort_order    integer not null default 0
);

create index idx_menu_item_variants_item on menu_item_variants (menu_item_id);

-- addon_groups: shared customization groups (e.g. "Sugar", "ADD ON Milk"),
-- reused across many items — sourced from the cafe's Petpooja POS export.
create table addon_groups (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,  -- internal/matching key, e.g. 'Sugar'
  display_name    text not null,         -- customer-facing label, e.g. 'Choice of Sugar'
  selection_type  addon_selection_type not null,
  min_select      integer not null default 0,
  max_select      integer not null default 1,
  sort_order      integer not null default 0
);

create table addon_options (
  id              uuid primary key default gen_random_uuid(),
  addon_group_id  uuid not null references addon_groups(id) on delete cascade,
  name            text not null,
  price_inr       integer not null default 0 check (price_inr >= 0),
  sort_order      integer not null default 0
);

create index idx_addon_options_group on addon_options (addon_group_id);

-- menu_item_addon_groups: which addon groups apply to which menu item (many-to-many).
create table menu_item_addon_groups (
  menu_item_id    uuid not null references menu_items(id) on delete cascade,
  addon_group_id  uuid not null references addon_groups(id) on delete cascade,
  primary key (menu_item_id, addon_group_id)
);

-- orders
create table orders (
  id                uuid primary key default gen_random_uuid(),
  order_number      integer generated always as identity (start with 1001 increment by 1),
  customer_name     text not null,
  customer_phone    text not null,
  pickup_time       text not null,          -- free-text/ISO time string chosen by customer at checkout, e.g. "ASAP" or "13:30"
  status            order_status not null default 'received',
  subtotal_inr      integer not null check (subtotal_inr >= 0),
  notes             text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index idx_orders_order_number on orders (order_number);
create index idx_orders_status on orders (status);
create index idx_orders_created_at on orders (created_at desc);

-- order_items: line items, snapshotting item/variant name+price at order time
-- so later menu edits never rewrite order history.
create table order_items (
  id                       uuid primary key default gen_random_uuid(),
  order_id                 uuid not null references orders(id) on delete cascade,
  menu_item_id             uuid references menu_items(id) on delete set null,
  variant_id               uuid references menu_item_variants(id) on delete set null,
  name_snapshot            text not null,
  variant_label_snapshot   text not null default '',
  price_inr_snapshot       integer not null check (price_inr_snapshot >= 0),
  quantity                 integer not null check (quantity > 0),
  line_total_inr           integer not null check (line_total_inr >= 0)
);

create index idx_order_items_order_id on order_items (order_id);

-- order_item_addons: selected addon options for a given order line, snapshotted
-- the same way (name + price captured at order time).
create table order_item_addons (
  id                     uuid primary key default gen_random_uuid(),
  order_item_id          uuid not null references order_items(id) on delete cascade,
  addon_option_id        uuid references addon_options(id) on delete set null,
  group_name_snapshot    text not null,
  option_name_snapshot   text not null,
  price_inr_snapshot     integer not null default 0
);

create index idx_order_item_addons_order_item on order_item_addons (order_item_id);

-- updated_at trigger helper
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_menu_items_updated_at
  before update on menu_items
  for each row execute function set_updated_at();

create trigger trg_orders_updated_at
  before update on orders
  for each row execute function set_updated_at();

-- Row Level Security
alter table menu_items enable row level security;
alter table menu_item_variants enable row level security;
alter table addon_groups enable row level security;
alter table addon_options enable row level security;
alter table menu_item_addon_groups enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table order_item_addons enable row level security;

-- Public (anon) read access to the whole menu catalog; only staff (authenticated) can write.
create policy menu_items_public_read on menu_items for select using (true);
create policy menu_items_staff_write on menu_items for insert to authenticated with check (true);
create policy menu_items_staff_update on menu_items for update to authenticated using (true) with check (true);
create policy menu_items_staff_delete on menu_items for delete to authenticated using (true);

create policy menu_item_variants_public_read on menu_item_variants for select using (true);
create policy menu_item_variants_staff_write on menu_item_variants for insert to authenticated with check (true);
create policy menu_item_variants_staff_update on menu_item_variants for update to authenticated using (true) with check (true);
create policy menu_item_variants_staff_delete on menu_item_variants for delete to authenticated using (true);

create policy addon_groups_public_read on addon_groups for select using (true);
create policy addon_groups_staff_write on addon_groups for insert to authenticated with check (true);
create policy addon_groups_staff_update on addon_groups for update to authenticated using (true) with check (true);
create policy addon_groups_staff_delete on addon_groups for delete to authenticated using (true);

create policy addon_options_public_read on addon_options for select using (true);
create policy addon_options_staff_write on addon_options for insert to authenticated with check (true);
create policy addon_options_staff_update on addon_options for update to authenticated using (true) with check (true);
create policy addon_options_staff_delete on addon_options for delete to authenticated using (true);

create policy menu_item_addon_groups_public_read on menu_item_addon_groups for select using (true);
create policy menu_item_addon_groups_staff_write on menu_item_addon_groups for insert to authenticated with check (true);
create policy menu_item_addon_groups_staff_delete on menu_item_addon_groups for delete to authenticated using (true);

-- orders / order_items / order_item_addons: no public select/insert via anon key — all customer
-- reads/writes go through server Route Handlers using the service-role key (which bypasses RLS
-- entirely), so only staff (authenticated) policies are defined below. This deliberately blocks
-- any direct client-side access to order data.
create policy orders_staff_read on orders for select to authenticated using (true);
create policy orders_staff_update on orders for update to authenticated using (true) with check (true);

create policy order_items_staff_read on order_items for select to authenticated using (true);

create policy order_item_addons_staff_read on order_item_addons for select to authenticated using (true);

-- profiles: one row per Supabase Auth user, used purely for role separation
-- (staff vs customer) now that customers also authenticate via Supabase Auth
-- (email OTP / password). Every route that must be staff-only checks this
-- role — see lib/api/auth.ts getStaffUser(), middleware.ts, and
-- app/staff/layout.tsx.
--
-- On a project that already has the rest of this file applied, run ONLY
-- this block (through the backfill insert below) standalone in the SQL
-- Editor — re-running the whole file will fail on "type already exists"
-- before it ever reaches this part.
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null default 'customer' check (role in ('staff', 'customer')),
  created_at  timestamptz not null default now()
);

alter table profiles enable row level security;

-- Users may read only their own profile row. Deliberately NO insert/update/
-- delete policy for `authenticated` — the only way a row is created is the
-- trigger below (runs as the table owner, bypassing RLS), and the only way
-- `role` changes is the cafe owner running SQL directly in the Supabase SQL
-- editor. This is what prevents a customer from self-escalating to staff.
create policy profiles_select_own on profiles for select to authenticated using (auth.uid() = id);

create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, role) values (new.id, 'customer');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill for any auth.users rows created before this migration (e.g.
-- existing staff accounts made via the dashboard, per README) so every
-- existing account gets a profile row too.
insert into public.profiles (id, role)
select id, 'customer' from auth.users
on conflict (id) do nothing;
