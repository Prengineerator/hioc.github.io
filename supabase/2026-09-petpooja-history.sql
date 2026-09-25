-- ===========================================================================
-- Petpooja history import — read-only archive tables.
--
-- The owner ran Petpooja POS from Aug 2023 to 25 Sep 2026 and is moving to
-- this app. scripts/import-petpooja.ts loads Petpooja's bill/customer export
-- into these tables so past sales and customer history stay queryable
-- WITHOUT touching `orders` — mixing Petpooja bills into `orders` would
-- pollute this app's own sales/cash/loyalty/analytics and its order-number
-- sequence. See the shared spec at
-- .claude/uploads/a31945b5-35f4-53bf-920a-2378294bc421/SPEC.md (petpooja/) for
-- the full field-by-field mapping from the Petpooja export.
--
-- legacy_orders       — one row per Petpooja bill ('source' + 'bill_no' +
--                        'ordered_at' is the natural key; bill numbers reset
--                        every fiscal year, so bill_no alone is not unique).
-- legacy_order_items  — the bill's line items, parsed from its Items cell.
--                        No quantities in the Petpooja export (quantity is
--                        always NULL); matched to this app's menu on a
--                        best-effort basis (menu_item_id/variant_id nullable).
-- legacy_customers    — the Petpooja customer list, one row per phone,
--                        stats (order_count/total_spend_inr/first & last
--                        order) kept in sync with legacy_orders by
--                        refresh_legacy_customer_stats() below.
--
-- All three: RLS on, NO policies, explicit REVOKE — service-role only (the
-- importer and any owner-side reporting go through the admin client). Same
-- double lock as cash_counts / payroll (2026-09-cash-counts.sql).
--
-- sync_order_number_after_legacy() is the one write this migration lets the
-- importer make outside these three tables: it nudges
-- public.orders_order_number_seq forward past the highest numeric Petpooja
-- bill number in the latest fiscal year (and past any order already placed
-- in this app), so this app's own order numbers never collide with, or fall
-- inside, the imported Petpooja run. It only ever moves the sequence
-- forward.
--
-- Idempotent: safe to re-run.
-- ===========================================================================

-- ── legacy_orders ────────────────────────────────────────────────────────────
create table if not exists legacy_orders (
  id                    uuid primary key default gen_random_uuid(),
  source                text not null default 'petpooja',
  bill_no               text not null,             -- Petpooja 'Order No.'; text ('C1', 'Memo' exist)
  fiscal_year           text not null,              -- '2025-26' (Apr–Mar; sorts correctly as text)
  ordered_at            timestamptz not null,
  client_order_id       text,                       -- aggregator order id (Zomato/Swiggy), when present
  order_type            text not null default '',   -- raw Petpooja 'Order Type'
  sub_order_type        text,                       -- raw Petpooja 'Sub Order Type'
  channel               text not null
                          check (channel in ('counter', 'delivery', 'zomato', 'swiggy', 'qr', 'dine_in')),
  table_label           text not null default '',   -- dine-in table number, else ''
  customer_name         text not null default '',
  customer_phone        text,                       -- '+91XXXXXXXXXX', or null (aggregator bill / unusable number)
  customer_phone_raw    text not null default '',    -- what the export actually said, kept for audit
  customer_address      text not null default '',
  customer_gstin        text not null default '',
  items_text            text not null default '',   -- raw Petpooja 'Items' cell, verbatim
  subtotal_inr          numeric(10, 2) not null default 0,
  discount_inr          numeric(10, 2) not null default 0,
  delivery_charge_inr   numeric(10, 2) not null default 0,
  container_charge_inr  numeric(10, 2) not null default 0,
  tax_inr               numeric(10, 2) not null default 0,
  round_off_inr         numeric(10, 2) not null default 0,
  total_inr             numeric(10, 2) not null default 0,
  payment_type          text not null default '',   -- raw Petpooja 'Payment Type'
  payments              jsonb not null default '[]', -- [{"method": "Cash", "amount_inr": 976}]
  status                text not null check (status in ('completed', 'cancelled')),
  raw                   jsonb not null default '{}', -- original row, keyed by export header
  imported_at           timestamptz not null default now(),
  unique (source, bill_no, ordered_at)
);

create index if not exists legacy_orders_customer_phone_ordered_at
  on legacy_orders (customer_phone, ordered_at desc)
  where customer_phone is not null;

create index if not exists legacy_orders_ordered_at
  on legacy_orders (ordered_at desc);

-- ── legacy_order_items ───────────────────────────────────────────────────────
create table if not exists legacy_order_items (
  id               uuid primary key default gen_random_uuid(),
  legacy_order_id  uuid not null references legacy_orders(id) on delete cascade,
  position         smallint not null,               -- 0-based order within the Items cell
  raw_name         text not null,                    -- exactly as it appeared in the Items cell
  item_name        text not null,                    -- '[n]' marker and '(Variant)' stripped
  variant_label    text not null default '',
  menu_item_id     uuid references menu_items(id) on delete set null,
  variant_id       uuid references menu_item_variants(id) on delete set null,
  quantity         integer,                          -- always NULL — Petpooja export has no quantities
  unique (legacy_order_id, position)
);

create index if not exists legacy_order_items_menu_item_id
  on legacy_order_items (menu_item_id);

-- ── legacy_customers ─────────────────────────────────────────────────────────
create table if not exists legacy_customers (
  phone                 text primary key,            -- '+91XXXXXXXXXX'
  name                  text not null default '',
  email                 text not null default '',
  date_of_birth         date,
  date_of_anniversary   date,
  address               text not null default '',
  locality              text not null default '',
  gstin                 text not null default '',
  is_favourite          boolean not null default false,
  petpooja_created_on   date,                         -- when Petpooja first added this customer
  first_order_at        timestamptz,                  -- completed bills only
  last_order_at         timestamptz,                  -- completed bills only
  order_count           integer not null default 0,   -- completed bills only
  total_spend_inr       numeric(12, 2) not null default 0,  -- completed bills only
  marketing_consent     boolean not null default false,     -- informational only; DPDP consent was never collected
  source                text not null default 'petpooja',
  raw                   jsonb not null default '{}',
  imported_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ── Lock down — service-role only, same as cash_counts / payroll ────────────
alter table legacy_orders      enable row level security;
alter table legacy_order_items enable row level security;
alter table legacy_customers   enable row level security;

revoke all on legacy_orders      from anon, authenticated;
revoke all on legacy_order_items from anon, authenticated;
revoke all on legacy_customers   from anon, authenticated;

-- ---------------------------------------------------------------------------
-- refresh_legacy_customer_stats() — set-based (no per-row loop: this runs
-- over ~10k customers / ~30k bills on every importer run).
--
-- 1. Insert a legacy_customers row for every phone that has bills but no
--    row yet, named from that phone's most recent non-empty customer_name
--    (may still be '' if every bill for that phone had a blank name).
-- 2. Recompute every legacy customer's stats from legacy_orders — completed
--    bills only feed order_count/total_spend/first & last order (0/null
--    when a phone has no completed bills, including phones that were never
--    in legacy_orders at all — those keep their column defaults). A stored
--    name of '' is backfilled from the most recent bill with a name.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_legacy_customer_stats()
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  with distinct_phones as (
    select distinct customer_phone as phone
      from legacy_orders
     where customer_phone is not null
  ),
  latest_name as (
    select distinct on (customer_phone)
           customer_phone as phone, customer_name as name
      from legacy_orders
     where customer_phone is not null
       and customer_name <> ''
     order by customer_phone, ordered_at desc
  )
  insert into legacy_customers (phone, name, source)
  select dp.phone, coalesce(ln.name, ''), 'petpooja'
    from distinct_phones dp
    left join latest_name ln on ln.phone = dp.phone
  on conflict (phone) do nothing;

  with stats as (
    select customer_phone as phone,
           min(ordered_at) filter (where status = 'completed')   as first_order_at,
           max(ordered_at) filter (where status = 'completed')   as last_order_at,
           count(*)        filter (where status = 'completed')   as order_count,
           sum(total_inr)  filter (where status = 'completed')   as total_spend_inr
      from legacy_orders
     where customer_phone is not null
     group by customer_phone
  ),
  latest_name as (
    select distinct on (customer_phone)
           customer_phone as phone, customer_name as name
      from legacy_orders
     where customer_phone is not null
       and customer_name <> ''
     order by customer_phone, ordered_at desc
  ),
  merged as (
    select lc.phone,
           s.first_order_at, s.last_order_at, s.order_count, s.total_spend_inr,
           ln.name as latest_name
      from legacy_customers lc
      left join stats s        on s.phone = lc.phone
      left join latest_name ln on ln.phone = lc.phone
  )
  update legacy_customers lc
     set first_order_at  = merged.first_order_at,
         last_order_at   = merged.last_order_at,
         order_count     = coalesce(merged.order_count, 0),
         total_spend_inr = coalesce(merged.total_spend_inr, 0),
         name            = case when lc.name = '' then coalesce(merged.latest_name, lc.name) else lc.name end,
         updated_at      = now()
    from merged
   where merged.phone = lc.phone;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- sync_order_number_after_legacy() — pushes public.orders_order_number_seq
-- forward past the imported Petpooja history, never backwards.
--
-- N = the highest numeric bill_no (regex '^[0-9]+$', so 'C1'/'Memo' are
--     ignored) among legacy_orders in the LATEST fiscal_year only — bill
--     numbers reset every fiscal year, so a max across all years would be
--     meaningless (and too high).
-- M = greatest(N, max(orders.order_number)) — also never collide with an
--     order this app has already placed.
-- If the sequence's own next value would be <= M, setval it to M (is_called
-- = true) so the NEXT nextval() returns M + 1. If the sequence is already
-- ahead of M, it is left untouched. Returns the next order number that will
-- be issued either way.
-- ---------------------------------------------------------------------------
create or replace function public.sync_order_number_after_legacy()
returns bigint
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_fiscal_year  text;
  v_legacy_max   bigint;
  v_orders_max   bigint;
  v_floor        bigint;
  v_last_value   bigint;
  v_is_called    boolean;
  v_increment_by bigint;
  v_seq_next     bigint;
begin
  select max(fiscal_year) into v_fiscal_year from legacy_orders;

  select max(bill_no::bigint) into v_legacy_max
    from legacy_orders
   where fiscal_year = v_fiscal_year
     and bill_no ~ '^[0-9]+$';

  select max(order_number) into v_orders_max from orders;

  v_floor := greatest(coalesce(v_legacy_max, 0), coalesce(v_orders_max, 0));

  -- is_called only exists on the sequence relation itself, not in the
  -- pg_sequences view. Before the first nextval() the relation reports
  -- last_value = start_value with is_called = false, so that case needs no
  -- special handling.
  select last_value, is_called
    into v_last_value, v_is_called
    from public.orders_order_number_seq;

  select increment_by into v_increment_by
    from pg_sequences
   where schemaname = 'public' and sequencename = 'orders_order_number_seq';

  if v_is_called then
    v_seq_next := v_last_value + coalesce(v_increment_by, 1);
  else
    -- Never read yet, or setval(..., false) with no nextval() since: the next call returns last_value itself.
    v_seq_next := v_last_value;
  end if;

  if v_seq_next <= v_floor then
    perform setval('public.orders_order_number_seq', v_floor, true);
    v_seq_next := v_floor + 1;
  end if;

  return v_seq_next;
end;
$$;

-- Both functions are importer-only (scripts/import-petpooja.ts, service-role
-- client) — revoke the PUBLIC default grant so anon/authenticated can never
-- reach them over /rest/v1/rpc (same fix as 2026-09-security-advisor-fixes.sql).
revoke execute on function public.refresh_legacy_customer_stats()
  from public, anon, authenticated;
grant execute on function public.refresh_legacy_customer_stats()
  to service_role;

revoke execute on function public.sync_order_number_after_legacy()
  from public, anon, authenticated;
grant execute on function public.sync_order_number_after_legacy()
  to service_role;

-- ---------------------------------------------------------------------------
-- Verify:
--
--   -- 1. tables exist, RLS on, no policies, no grants to anon/authenticated:
--   select relname, relrowsecurity
--     from pg_class
--    where relname in ('legacy_orders', 'legacy_order_items', 'legacy_customers');
--   -- expect relrowsecurity = true for all three
--
--   select tablename, policyname from pg_policies
--    where tablename in ('legacy_orders', 'legacy_order_items', 'legacy_customers');
--   -- expect 0 rows
--
--   select table_name, grantee, privilege_type from information_schema.role_table_grants
--    where table_name in ('legacy_orders', 'legacy_order_items', 'legacy_customers')
--      and grantee in ('anon', 'authenticated');
--   -- expect 0 rows
--
--   -- 2. function grants — expect only service_role with EXECUTE on each:
--   select proname, proacl from pg_proc
--    where proname in ('refresh_legacy_customer_stats', 'sync_order_number_after_legacy');
--
--   -- 3. after an import, sanity-check the stats refresh:
--   select count(*) as customers,
--          count(*) filter (where order_count > 0) as with_bills,
--          sum(order_count) as total_completed_bills,
--          sum(total_spend_inr) as total_spend_inr
--     from legacy_customers;
--
--   -- 4. sync_order_number_after_legacy() — run it, then confirm the
--   --    sequence is now strictly ahead of both the legacy max and any real
--   --    order, and that it only ever moved forward:
--   select last_value from public.orders_order_number_seq;   -- before
--   select sync_order_number_after_legacy();                 -- e.g. returns 7776
--   select last_value from public.orders_order_number_seq;   -- after: >= before
--
--   select max(bill_no::int) from legacy_orders
--    where fiscal_year = (select max(fiscal_year) from legacy_orders)
--      and bill_no ~ '^[0-9]+$';                              -- N, e.g. 7775
--   select max(order_number) from orders;                     -- must stay < next returned above
-- ---------------------------------------------------------------------------
