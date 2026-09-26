-- ===========================================================================
-- Inventory — stock items, stock requests, POS-verified receiving with expiry
-- dates, recipes, and automatic usage when an order completes.
-- Spec and deploy requirement sheet: docs/INVENTORY-SPEC.md.
--
-- The flow this stores:
--
--   1. Anyone on the team taps "Request stock" (stock_requests + lines).
--   2. A manager or the owner assigns the request to a staffer to pick.
--   3. The assignee picks it and records what they actually picked.
--   4. At the POS, someone OTHER than the picker (or a manager) verifies what
--      arrived, line by line, entering the expiry date of each batch. Only
--      this step adds stock. A received quantity that differs from the picked
--      one marks the request as having a discrepancy for the owner.
--   5. Recipes (recipe_lines) say what one sale of a menu item uses. When an
--      order completes, its lines × recipes are taken out of stock, earliest
--      expiry first.
--
-- Stock on hand is NOT a column: it is the sum of inventory_batches.
-- qty_remaining for the item, so it can never disagree with the batches the
-- expiry warnings are computed from. A sale that needs more than the batches
-- hold takes what there is and records the rest as a shortfall on the item
-- ("count needed") — stock never goes negative and a sale is never refused.
--
-- Every write that touches more than one row goes through a function below so
-- it commits or fails whole. All tables are service-role only (RLS on, no
-- policies, explicit REVOKE), same double lock as the cash tables; the API
-- routes are the authorization gate. Idempotent: safe to re-run.
-- ===========================================================================

-- ── Stock items ─────────────────────────────────────────────────────────────
create table if not exists inventory_items (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null check (length(trim(name)) between 1 and 80),
  -- Quantities of this item (stock, requests, recipes) are all in this unit.
  -- It cannot change once the item has any movement (enforced by the API).
  unit                  text not null check (unit in ('g', 'kg', 'ml', 'l', 'pcs', 'pack')),
  category              text not null default '',
  -- At or below this much on hand, the item shows as low. 0 = never low.
  par_level             numeric(12,3) not null default 0 check (par_level >= 0),
  -- Pre-filled quantity when the item is requested. 0 = top up to par.
  reorder_qty           numeric(12,3) not null default 0 check (reorder_qty >= 0),
  -- Perishables: receiving requires an expiry date for every batch.
  tracks_expiry         boolean not null default true,
  is_active             boolean not null default true,
  -- Sold more than the batches held since the last count. >0 means the
  -- records are behind reality: count the item.
  shortfall_since_count numeric(12,3) not null default 0 check (shortfall_since_count >= 0),
  last_counted_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists inventory_items_name_ci on inventory_items (lower(trim(name)));

-- ── Stock requests (the "Request stock" button) ─────────────────────────────
create table if not exists stock_requests (
  id                 uuid primary key default gen_random_uuid(),
  request_number     integer generated always as identity (start with 1),
  status             text not null default 'requested'
                       check (status in ('requested', 'assigned', 'picked', 'received', 'cancelled')),
  note               text not null default '',
  requested_by       uuid not null references auth.users(id) on delete restrict,
  assigned_to        uuid references auth.users(id) on delete set null,
  assigned_by        uuid references auth.users(id) on delete set null,
  assigned_at        timestamptz,
  picked_by          uuid references auth.users(id) on delete set null,
  picked_at          timestamptz,
  -- Verified at the POS: who counted it in, on which enrolled device.
  received_by        uuid references auth.users(id) on delete set null,
  received_at        timestamptz,
  received_device_id uuid,
  -- Some line arrived in a different quantity than was picked.
  has_discrepancy    boolean not null default false,
  cancelled_by       uuid references auth.users(id) on delete set null,
  cancel_reason      text not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint stock_requests_assigned_shape check (status = 'requested' or status = 'cancelled' or assigned_to is not null),
  constraint stock_requests_picked_shape   check (status not in ('picked', 'received') or picked_at is not null),
  constraint stock_requests_received_shape check ((status = 'received') = (received_at is not null))
);
create index if not exists stock_requests_status on stock_requests (status, created_at desc);
create index if not exists stock_requests_assignee on stock_requests (assigned_to, status);

create table if not exists stock_request_lines (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references stock_requests(id) on delete cascade,
  item_id       uuid not null references inventory_items(id) on delete restrict,
  qty_requested numeric(12,3) not null check (qty_requested > 0),
  qty_picked    numeric(12,3) check (qty_picked >= 0),
  qty_received  numeric(12,3) check (qty_received >= 0),
  expiry_date   date,
  unique (request_id, item_id)
);

-- ── Batches: what is on the shelf, with its expiry ──────────────────────────
create table if not exists inventory_batches (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references inventory_items(id) on delete cascade,
  qty_received  numeric(12,3) not null check (qty_received > 0),
  qty_remaining numeric(12,3) not null check (qty_remaining >= 0),
  expiry_date   date,
  -- NULL for a direct delivery or a count surplus.
  request_id    uuid references stock_requests(id) on delete set null,
  source        text not null default 'receive' check (source in ('receive', 'count')),
  received_by   uuid references auth.users(id) on delete set null,
  received_at   timestamptz not null default now(),
  constraint inventory_batches_remaining_le check (qty_remaining <= qty_received)
);
create index if not exists inventory_batches_live
  on inventory_batches (item_id, expiry_date) where qty_remaining > 0;

-- ── Ledger: every change to stock, and why ──────────────────────────────────
create table if not exists inventory_movements (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references inventory_items(id) on delete cascade,
  kind       text not null check (kind in ('receive', 'sale', 'waste', 'count')),
  -- Signed: + into stock, − out of it. What actually moved.
  qty_delta  numeric(12,3) not null,
  -- Sale only: the part of the recipe quantity the batches could not cover.
  shortfall  numeric(12,3) not null default 0 check (shortfall >= 0),
  batch_id   uuid references inventory_batches(id) on delete set null,
  request_id uuid references stock_requests(id) on delete set null,
  order_id   uuid references orders(id) on delete set null,
  reason     text not null default '',
  actor_id   uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint inventory_movements_moved check (qty_delta <> 0 or shortfall > 0 or kind = 'count')
);
create index if not exists inventory_movements_item on inventory_movements (item_id, created_at desc);
-- An order's usage is taken once per item, however many times completion is
-- retried.
create unique index if not exists inventory_movements_sale_once
  on inventory_movements (order_id, item_id) where kind = 'sale';

-- ── Recipes ─────────────────────────────────────────────────────────────────
-- What ONE unit of a menu item uses. variant_id NULL = the item's base recipe;
-- a variant with lines of its own uses those INSTEAD of the base recipe
-- (lib/inventory/rules.ts recipeUsage).
create table if not exists recipe_lines (
  id           uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references menu_items(id) on delete cascade,
  variant_id   uuid references menu_item_variants(id) on delete cascade,
  item_id      uuid not null references inventory_items(id) on delete restrict,
  qty          numeric(12,3) not null check (qty > 0),
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create unique index if not exists recipe_lines_unique
  on recipe_lines (menu_item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid), item_id);
create index if not exists recipe_lines_item on recipe_lines (item_id);

-- ===========================================================================
-- Functions. Errors meant for the person at the screen are raised with a
-- message starting 'inventory: ' — the API strips the prefix and returns the
-- rest as a 409.
-- ===========================================================================

-- Takes up to p_qty out of an item's batches, earliest expiry first (undated
-- batches last), and returns how much it actually took. The caller must hold
-- the item's row lock (every caller below takes it first), so two sales of
-- the same item can never read the same batch balance.
create or replace function inventory_take_fefo(p_item_id uuid, p_qty numeric)
returns numeric
language plpgsql
set search_path = public
as $$
declare
  v_left numeric := p_qty;
  v_take numeric;
  b record;
begin
  if p_qty is null or p_qty <= 0 then
    return 0;
  end if;
  for b in
    select id, qty_remaining
      from inventory_batches
     where item_id = p_item_id and qty_remaining > 0
     order by expiry_date asc nulls last, received_at asc, id
  loop
    exit when v_left <= 0;
    v_take := least(b.qty_remaining, v_left);
    update inventory_batches set qty_remaining = qty_remaining - v_take where id = b.id;
    v_left := v_left - v_take;
  end loop;
  return p_qty - v_left;
end $$;

-- "Request stock": the request and its lines in one go.
-- p_lines: [{ "item_id": uuid, "qty": number }, ...]
create or replace function inventory_create_request(p_actor uuid, p_note text, p_lines jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'inventory: add at least one item to the request';
  end if;
  insert into stock_requests (requested_by, note)
  values (p_actor, coalesce(trim(p_note), ''))
  returning id into v_id;

  insert into stock_request_lines (request_id, item_id, qty_requested)
  select v_id, (e->>'item_id')::uuid, (e->>'qty')::numeric
    from jsonb_array_elements(p_lines) e;

  if exists (
    select 1 from stock_request_lines l
      join inventory_items i on i.id = l.item_id
     where l.request_id = v_id and not i.is_active
  ) then
    raise exception 'inventory: one of those items is no longer stocked';
  end if;
  return v_id;
end $$;

-- The assignee records what they picked. Status-guarded: only an 'assigned'
-- request, only by the person it is assigned to (or p_is_manager).
-- p_lines: [{ "item_id": uuid, "qty": number }, ...] — one per request line.
create or replace function inventory_pick(p_request_id uuid, p_actor uuid, p_is_manager boolean, p_lines jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  r stock_requests%rowtype;
begin
  select * into r from stock_requests where id = p_request_id for update;
  if not found then
    raise exception 'inventory: request not found';
  end if;
  if r.status <> 'assigned' then
    raise exception 'inventory: this request is % — it can no longer be picked', r.status;
  end if;
  if r.assigned_to is distinct from p_actor and not p_is_manager then
    raise exception 'inventory: this request is assigned to someone else';
  end if;
  if (select count(*) from stock_request_lines where request_id = p_request_id)
       <> (select count(distinct e->>'item_id') from jsonb_array_elements(p_lines) e)
     or exists (
       select 1 from jsonb_array_elements(p_lines) e
        where not exists (
          select 1 from stock_request_lines s
           where s.request_id = p_request_id and s.item_id = (e->>'item_id')::uuid))
  then
    raise exception 'inventory: give a picked quantity for every line of the request';
  end if;

  update stock_request_lines s
     set qty_picked = (e->>'qty')::numeric
    from jsonb_array_elements(p_lines) e
   where s.request_id = p_request_id and s.item_id = (e->>'item_id')::uuid;

  update stock_requests
     set status = 'picked', picked_by = p_actor, picked_at = now(), updated_at = now()
   where id = p_request_id;
end $$;

-- Verified receiving at the POS — the only way stock comes in.
-- p_request_id NULL = a direct delivery with no request behind it.
-- p_lines: [{ "item_id": uuid, "qty": number, "expiry_date": "YYYY-MM-DD" | null }, ...]
-- For a request, exactly one line per request line (qty 0 = did not arrive).
create or replace function inventory_receive(p_request_id uuid, p_actor uuid, p_device_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r stock_requests%rowtype;
  l record;
  v_item inventory_items%rowtype;
  v_picked numeric;
  v_batch uuid;
  v_discrepancy boolean := false;
  v_lines int := 0;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'inventory: nothing to receive';
  end if;

  if p_request_id is not null then
    select * into r from stock_requests where id = p_request_id for update;
    if not found then
      raise exception 'inventory: request not found';
    end if;
    if r.status <> 'picked' then
      raise exception 'inventory: this request is % — only a picked request can be received', r.status;
    end if;
    if (select count(*) from stock_request_lines where request_id = p_request_id)
         <> (select count(distinct e->>'item_id') from jsonb_array_elements(p_lines) e)
       or exists (
         select 1 from jsonb_array_elements(p_lines) e
          where not exists (
            select 1 from stock_request_lines s
             where s.request_id = p_request_id and s.item_id = (e->>'item_id')::uuid))
    then
      raise exception 'inventory: count every line of the request';
    end if;
  end if;

  for l in
    select (e->>'item_id')::uuid as item_id,
           (e->>'qty')::numeric as qty,
           nullif(e->>'expiry_date', '')::date as expiry_date
      from jsonb_array_elements(p_lines) e
  loop
    if l.qty is null or l.qty < 0 then
      raise exception 'inventory: a received quantity cannot be negative';
    end if;
    select * into v_item from inventory_items where id = l.item_id for update;
    if not found then
      raise exception 'inventory: unknown stock item';
    end if;
    if l.qty > 0 and v_item.tracks_expiry and l.expiry_date is null then
      raise exception 'inventory: enter the expiry date for %', v_item.name;
    end if;

    if p_request_id is not null then
      update stock_request_lines
         set qty_received = l.qty, expiry_date = case when l.qty > 0 then l.expiry_date end
       where request_id = p_request_id and item_id = l.item_id
      returning qty_picked into v_picked;
      if v_picked is distinct from l.qty then
        v_discrepancy := true;
      end if;
    end if;

    if l.qty > 0 then
      insert into inventory_batches (item_id, qty_received, qty_remaining, expiry_date, request_id, received_by)
      values (l.item_id, l.qty, l.qty, l.expiry_date, p_request_id, p_actor)
      returning id into v_batch;
      insert into inventory_movements (item_id, kind, qty_delta, batch_id, request_id, actor_id)
      values (l.item_id, 'receive', l.qty, v_batch, p_request_id, p_actor);
      v_lines := v_lines + 1;
    end if;
  end loop;

  if p_request_id is not null then
    update stock_requests
       set status = 'received', received_by = p_actor, received_at = now(),
           received_device_id = p_device_id, has_discrepancy = v_discrepancy, updated_at = now()
     where id = p_request_id;
  end if;

  return jsonb_build_object('batches', v_lines, 'has_discrepancy', v_discrepancy);
end $$;

-- An order's usage, from its lines × recipes (computed by the app,
-- lib/inventory/rules.ts orderUsage). Idempotent per (order, item): a retried
-- completion takes nothing twice. Never refuses: what the batches cannot
-- cover is recorded as a shortfall on the item.
-- p_lines: [{ "item_id": uuid, "qty": number }, ...]
create or replace function inventory_apply_sale(p_order_id uuid, p_actor uuid, p_lines jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  l record;
  v_taken numeric;
  v_applied int := 0;
begin
  for l in
    select (e->>'item_id')::uuid as item_id, sum((e->>'qty')::numeric) as qty
      from jsonb_array_elements(p_lines) e
     group by 1
  loop
    continue when l.qty is null or l.qty <= 0;
    perform 1 from inventory_items where id = l.item_id for update;
    continue when not found;
    continue when exists (
      select 1 from inventory_movements
       where kind = 'sale' and order_id = p_order_id and item_id = l.item_id);

    v_taken := inventory_take_fefo(l.item_id, l.qty);
    insert into inventory_movements (item_id, kind, qty_delta, shortfall, order_id, actor_id)
    values (l.item_id, 'sale', -v_taken, l.qty - v_taken, p_order_id, p_actor);
    if l.qty > v_taken then
      update inventory_items
         set shortfall_since_count = shortfall_since_count + (l.qty - v_taken), updated_at = now()
       where id = l.item_id;
    end if;
    v_applied := v_applied + 1;
  end loop;
  return v_applied;
end $$;

-- Manager corrections.
--   'waste': p_qty > 0 thrown away — from p_batch_id (an expired batch) or,
--            without one, earliest expiry first. Refused if there isn't that much.
--   'count': p_qty >= 0 is what is physically on the shelf. The difference is
--            taken out earliest-expiry-first, or added as an undated batch, and
--            the item's shortfall is cleared.
create or replace function inventory_adjust(
  p_item_id  uuid,
  p_actor    uuid,
  p_kind     text,
  p_qty      numeric,
  p_batch_id uuid,
  p_reason   text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_on_hand numeric;
  v_delta numeric;
  v_left numeric;
  v_taken numeric;
  v_batch uuid;
begin
  perform 1 from inventory_items where id = p_item_id for update;
  if not found then
    raise exception 'inventory: unknown stock item';
  end if;
  select coalesce(sum(qty_remaining), 0) into v_on_hand
    from inventory_batches where item_id = p_item_id;

  if p_kind = 'waste' then
    if p_qty is null or p_qty <= 0 then
      raise exception 'inventory: enter how much was thrown away';
    end if;
    if p_batch_id is not null then
      select qty_remaining into v_left
        from inventory_batches where id = p_batch_id and item_id = p_item_id for update;
      if not found then
        raise exception 'inventory: that batch is not part of this item';
      end if;
      if v_left < p_qty then
        raise exception 'inventory: that batch only has % left', trim_scale(v_left);
      end if;
      update inventory_batches set qty_remaining = qty_remaining - p_qty where id = p_batch_id;
    else
      if v_on_hand < p_qty then
        raise exception 'inventory: only % in stock', trim_scale(v_on_hand);
      end if;
      v_taken := inventory_take_fefo(p_item_id, p_qty);
    end if;
    insert into inventory_movements (item_id, kind, qty_delta, batch_id, reason, actor_id)
    values (p_item_id, 'waste', -p_qty, p_batch_id, coalesce(p_reason, ''), p_actor);
    return jsonb_build_object('on_hand', v_on_hand - p_qty);
  end if;

  if p_kind = 'count' then
    if p_qty is null or p_qty < 0 then
      raise exception 'inventory: enter the quantity counted';
    end if;
    v_delta := p_qty - v_on_hand;
    if v_delta < 0 then
      v_taken := inventory_take_fefo(p_item_id, -v_delta);
    elsif v_delta > 0 then
      insert into inventory_batches (item_id, qty_received, qty_remaining, source, received_by)
      values (p_item_id, v_delta, v_delta, 'count', p_actor)
      returning id into v_batch;
    end if;
    insert into inventory_movements (item_id, kind, qty_delta, batch_id, reason, actor_id)
    values (p_item_id, 'count', v_delta, v_batch, coalesce(p_reason, ''), p_actor);
    update inventory_items
       set shortfall_since_count = 0, last_counted_at = now(), updated_at = now()
     where id = p_item_id;
    return jsonb_build_object('on_hand', p_qty);
  end if;

  raise exception 'inventory: unknown adjustment';
end $$;

-- Replace a menu item's whole recipe in one go.
-- p_lines: [{ "variant_id": uuid | null, "item_id": uuid, "qty": number }, ...]
create or replace function inventory_set_recipe(p_menu_item_id uuid, p_actor uuid, p_lines jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count int;
begin
  perform 1 from menu_items where id = p_menu_item_id for update;
  if not found then
    raise exception 'inventory: menu item not found';
  end if;
  delete from recipe_lines where menu_item_id = p_menu_item_id;
  insert into recipe_lines (menu_item_id, variant_id, item_id, qty, updated_by)
  select p_menu_item_id, nullif(e->>'variant_id', '')::uuid, (e->>'item_id')::uuid, (e->>'qty')::numeric, p_actor
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e;
  get diagnostics v_count = row_count;

  if exists (
    select 1 from recipe_lines rl
     where rl.menu_item_id = p_menu_item_id and rl.variant_id is not null
       and not exists (
         select 1 from menu_item_variants v
          where v.id = rl.variant_id and v.menu_item_id = p_menu_item_id))
  then
    raise exception 'inventory: that size does not belong to this menu item';
  end if;
  return v_count;
end $$;

-- ── Lock down ───────────────────────────────────────────────────────────────
alter table inventory_items     enable row level security;
alter table stock_requests      enable row level security;
alter table stock_request_lines enable row level security;
alter table inventory_batches   enable row level security;
alter table inventory_movements enable row level security;
alter table recipe_lines        enable row level security;
revoke all on inventory_items     from anon, authenticated;
revoke all on stock_requests      from anon, authenticated;
revoke all on stock_request_lines from anon, authenticated;
revoke all on inventory_batches   from anon, authenticated;
revoke all on inventory_movements from anon, authenticated;
revoke all on recipe_lines        from anon, authenticated;

revoke execute on function inventory_take_fefo(uuid, numeric) from public, anon, authenticated;
revoke execute on function inventory_create_request(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function inventory_pick(uuid, uuid, boolean, jsonb) from public, anon, authenticated;
revoke execute on function inventory_receive(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function inventory_apply_sale(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function inventory_adjust(uuid, uuid, text, numeric, uuid, text) from public, anon, authenticated;
revoke execute on function inventory_set_recipe(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function inventory_take_fefo(uuid, numeric) to service_role;
grant execute on function inventory_create_request(uuid, text, jsonb) to service_role;
grant execute on function inventory_pick(uuid, uuid, boolean, jsonb) to service_role;
grant execute on function inventory_receive(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function inventory_apply_sale(uuid, uuid, jsonb) to service_role;
grant execute on function inventory_adjust(uuid, uuid, text, numeric, uuid, text) to service_role;
grant execute on function inventory_set_recipe(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Verify:
--   select count(*) from inventory_items;                          -- 0 on a fresh apply
--   select proname from pg_proc where proname like 'inventory_%';  -- 7 functions
--   -- anon must not see anything:
--   set role anon; select * from inventory_items; reset role;     -- permission denied
-- ---------------------------------------------------------------------------
