-- ===========================================================================
-- Warehouse — a second stock location, owned by the owner, that fills the
-- store's stock requests; stock in transit between the two; who carries it;
-- matching what left against what arrived, in both directions; and an alert
-- to the owner when a request is placed.
-- Spec and deploy requirement sheet: docs/WAREHOUSE-SPEC.md.
-- Needs supabase/2026-10-inventory.sql first (it extends those tables).
--
-- The flow this stores:
--
--   Store → warehouse request ("Request stock", route 'from_warehouse')
--     1. Anyone at the store raises a request. The owner is alerted.
--     2. The owner or a manager chooses who delivers it: a team member, or
--        someone without a login (a driver), by name and phone.
--     3. The warehouse side (owner or manager) records what was DISPATCHED.
--        That quantity leaves the warehouse sheet (earliest expiry first) and
--        is in transit.
--     4. At the store's POS, someone other than the deliverer counts it in
--        (supabase/2026-10-inventory.sql inventory_receive, unchanged). Store
--        stock goes up by what ARRIVED.
--     5. A line that arrived different from what was dispatched marks the
--        transfer for the owner to settle, line by line:
--          short  → 'lost' (written off in transit) or 'back_to_origin'
--                   (it never left: back on the warehouse sheet)
--          over   → 'origin_sent_extra' (the warehouse sent more than it
--                   recorded: the extra comes off the warehouse sheet) or
--                   'accepted' (leave the warehouse sheet as it is)
--
--   Store → warehouse return ("Send back to warehouse", route 'to_warehouse')
--     A manager sends stock back, naming who carries it. It leaves the store
--     at once and is in transit; the owner counts it in at the warehouse; a
--     difference is settled the same way, with the store as the origin.
--
--   'store_room' is every request made before this migration, or while the
--   warehouse is switched off: it behaves exactly as before (picking moves no
--   stock). The route is fixed on the row when it is created, so switching
--   the warehouse on or off never changes a request already in flight.
--
-- Warehouse stock on hand is NOT a column: it is the sum of
-- warehouse_batches.qty_remaining, the same rule as the store's. The
-- warehouse has its own batches and ledger rather than a "location" column
-- on the store's: every store calculation (auto-hide, FEFO, the Stock
-- screen) keeps reading only store stock, with nothing to filter.
--
-- Every write that touches more than one row is a function below. All new
-- tables are service-role only (RLS on, no policies, explicit REVOKE), like
-- the rest of inventory. Errors for the person at the screen start with
-- 'inventory: ' (lib/inventory/rules.ts inventoryErrorMessage). Idempotent:
-- safe to re-run, and 2026-10-inventory.sql can be re-run after it.
-- ===========================================================================

-- ── Stock requests: route, deliverer, settlement ────────────────────────────
alter table stock_requests add column if not exists route text not null default 'store_room';
alter table stock_requests drop constraint if exists stock_requests_route_check;
alter table stock_requests add constraint stock_requests_route_check
  check (route in ('store_room', 'from_warehouse', 'to_warehouse'));

-- Someone without a login who carries a warehouse transfer (a driver).
-- Either assigned_to (a team member) or deliverer_name, never both.
alter table stock_requests add column if not exists deliverer_name  text not null default '';
alter table stock_requests add column if not exists deliverer_phone text not null default '';

-- The owner settled a transfer that arrived different from what was sent.
alter table stock_requests add column if not exists resolved_by     uuid references auth.users(id) on delete set null;
alter table stock_requests add column if not exists resolved_at     timestamptz;
alter table stock_requests add column if not exists resolution_note text not null default '';

alter table stock_requests drop constraint if exists stock_requests_assigned_shape;
alter table stock_requests add constraint stock_requests_assigned_shape
  check (status in ('requested', 'cancelled') or assigned_to is not null or deliverer_name <> '');
alter table stock_requests drop constraint if exists stock_requests_one_deliverer;
alter table stock_requests add constraint stock_requests_one_deliverer
  check (assigned_to is null or deliverer_name = '');
alter table stock_requests drop constraint if exists stock_requests_deliverer_route;
alter table stock_requests add constraint stock_requests_deliverer_route
  check (route <> 'store_room' or (deliverer_name = '' and deliverer_phone = ''));
alter table stock_requests drop constraint if exists stock_requests_resolved_shape;
alter table stock_requests add constraint stock_requests_resolved_shape
  check (resolved_at is null or (status = 'received' and has_discrepancy));

create index if not exists stock_requests_route on stock_requests (route, status);

-- Per line: the expiry date of the first batch dispatched (a hint for whoever
-- counts it in), and how the owner settled a line that arrived different.
alter table stock_request_lines add column if not exists dispatch_expiry date;
alter table stock_request_lines add column if not exists resolution text;
alter table stock_request_lines add column if not exists resolved_qty numeric(12,3);
alter table stock_request_lines drop constraint if exists stock_request_lines_resolution_check;
alter table stock_request_lines add constraint stock_request_lines_resolution_check
  check (resolution is null or resolution in ('lost', 'back_to_origin', 'origin_sent_extra', 'accepted'));
alter table stock_request_lines drop constraint if exists stock_request_lines_resolved_qty_check;
alter table stock_request_lines add constraint stock_request_lines_resolved_qty_check
  check ((resolution is null) = (resolved_qty is null) and (resolved_qty is null or resolved_qty > 0));

-- ── Store-side ledger: stock sent back, and settlements of returns ──────────
--   return_out     left the store for the warehouse
--   transit_back   a return's short line that never left: back on the shelf
--   transit_extra  the store sent more than it recorded: taken off the shelf
alter table inventory_movements drop constraint if exists inventory_movements_kind_check;
alter table inventory_movements add constraint inventory_movements_kind_check
  check (kind in ('receive', 'sale', 'waste', 'count', 'return_out', 'transit_back', 'transit_extra'));
alter table inventory_batches drop constraint if exists inventory_batches_source_check;
alter table inventory_batches add constraint inventory_batches_source_check
  check (source in ('receive', 'count', 'transit_back'));

-- ── The warehouse sheet ─────────────────────────────────────────────────────
-- One row per stock item the warehouse has dealt with (created on first use),
-- holding what is the warehouse's own: when it is low, and whether its
-- records have fallen behind. The item itself (name, unit, perishable) is the
-- shared inventory_items row, so a quantity means the same thing everywhere.
create table if not exists warehouse_items (
  item_id               uuid primary key references inventory_items(id) on delete cascade,
  -- At or below this much in the warehouse, the item shows as low (time to
  -- buy). 0 = never low.
  par_level             numeric(12,3) not null default 0 check (par_level >= 0),
  -- Dispatched more than the warehouse batches held since the last count.
  shortfall_since_count numeric(12,3) not null default 0 check (shortfall_since_count >= 0),
  last_counted_at       timestamptz,
  updated_by            uuid references auth.users(id) on delete set null,
  updated_at            timestamptz not null default now()
);

create table if not exists warehouse_batches (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references inventory_items(id) on delete cascade,
  qty_received  numeric(12,3) not null check (qty_received > 0),
  qty_remaining numeric(12,3) not null check (qty_remaining >= 0),
  expiry_date   date,
  --   purchase      bought in by the owner
  --   return        sent back from the store
  --   count         a count found more than the records
  --   transit_back  a short line that never left (settlement)
  source        text not null default 'purchase'
                  check (source in ('purchase', 'return', 'count', 'transit_back')),
  request_id    uuid references stock_requests(id) on delete set null,
  supplier      text not null default '',
  received_by   uuid references auth.users(id) on delete set null,
  received_at   timestamptz not null default now(),
  constraint warehouse_batches_remaining_le check (qty_remaining <= qty_received)
);
create index if not exists warehouse_batches_live
  on warehouse_batches (item_id, expiry_date) where qty_remaining > 0;

create table if not exists warehouse_movements (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references inventory_items(id) on delete cascade,
  kind       text not null
               check (kind in ('purchase', 'dispatch', 'return_in', 'waste', 'count', 'transit_back', 'transit_extra')),
  -- Signed: + into the warehouse, − out of it. What actually moved.
  qty_delta  numeric(12,3) not null,
  -- dispatch / transit_extra: the part the batches could not cover.
  shortfall  numeric(12,3) not null default 0 check (shortfall >= 0),
  batch_id   uuid references warehouse_batches(id) on delete set null,
  request_id uuid references stock_requests(id) on delete set null,
  reason     text not null default '',
  actor_id   uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint warehouse_movements_moved check (qty_delta <> 0 or shortfall > 0 or kind = 'count')
);
create index if not exists warehouse_movements_item on warehouse_movements (item_id, created_at desc);
-- A request is dispatched once per item, however the call is retried.
create unique index if not exists warehouse_movements_dispatch_once
  on warehouse_movements (request_id, item_id) where kind = 'dispatch';

-- ── Owner alerts ────────────────────────────────────────────────────────────
-- Who the owner wants told (Owner → Warehouse → Alerts). Email goes to every
-- owner account's login email unless switched off, plus the extra addresses;
-- WhatsApp goes to the numbers listed once a template is approved
-- (WHATSAPP_TPL_STOCK_ALERT, docs/WAREHOUSE-SPEC.md §WhatsApp).
create table if not exists warehouse_alert_settings (
  is_singleton       boolean primary key default true check (is_singleton),
  enabled            boolean not null default true,
  email_owner_logins boolean not null default true,
  emails             text[] not null default '{}' check (cardinality(emails) <= 10),
  whatsapp_phones    text[] not null default '{}' check (cardinality(whatsapp_phones) <= 5),
  updated_by         uuid references auth.users(id) on delete set null,
  updated_at         timestamptz not null default now()
);
insert into warehouse_alert_settings (is_singleton) values (true)
on conflict (is_singleton) do nothing;

-- One row per alert attempt, per channel and address.
create table if not exists warehouse_alerts (
  id           uuid primary key default gen_random_uuid(),
  event        text not null check (event in ('request_placed', 'return_sent', 'arrived_different')),
  request_id   uuid not null references stock_requests(id) on delete cascade,
  channel      text not null check (channel in ('email', 'whatsapp')),
  to_address   text not null default '',
  status       text not null check (status in ('sent', 'failed', 'skipped')),
  detail       text not null default '',
  provider_ref text not null default '',
  created_at   timestamptz not null default now()
);
-- The same alert reaches an address once, however many times it is retried.
create unique index if not exists warehouse_alerts_sent_once
  on warehouse_alerts (event, request_id, channel, to_address) where status = 'sent';
create index if not exists warehouse_alerts_created on warehouse_alerts (created_at desc);

-- ===========================================================================
-- Functions
-- ===========================================================================

-- Makes sure the item has its warehouse row and takes that row's lock, so two
-- writes to the same item's warehouse stock queue up instead of both reading
-- the same batch balance. Every function below that changes warehouse batches
-- calls this first.
create or replace function warehouse_lock_item(p_item_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if not exists (select 1 from inventory_items where id = p_item_id) then
    raise exception 'inventory: unknown stock item';
  end if;
  insert into warehouse_items (item_id) values (p_item_id) on conflict (item_id) do nothing;
  perform 1 from warehouse_items where item_id = p_item_id for update;
end $$;

-- Takes up to p_qty out of an item's WAREHOUSE batches, earliest expiry first
-- (undated last), and returns how much it took. The caller holds the lock.
create or replace function warehouse_take_fefo(p_item_id uuid, p_qty numeric)
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
      from warehouse_batches
     where item_id = p_item_id and qty_remaining > 0
     order by expiry_date asc nulls last, received_at asc, id
  loop
    exit when v_left <= 0;
    v_take := least(b.qty_remaining, v_left);
    update warehouse_batches set qty_remaining = qty_remaining - v_take where id = b.id;
    v_left := v_left - v_take;
  end loop;
  return p_qty - v_left;
end $$;

-- "Request stock" while the warehouse is on: the same request, routed to the
-- warehouse, in one transaction.
create or replace function warehouse_create_request(p_actor uuid, p_note text, p_lines jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  v_id := inventory_create_request(p_actor, p_note, p_lines);
  update stock_requests set route = 'from_warehouse' where id = v_id;
  return v_id;
end $$;

-- The warehouse records what it sent. Only an 'assigned' from_warehouse
-- request. p_lines: [{ "item_id": uuid, "qty": number }, ...] — one per
-- request line, 0 = none sent. What leaves comes off the warehouse sheet,
-- earliest expiry first; what the batches cannot cover is a shortfall on the
-- warehouse item ("count needed"), never a refusal: the goods are physically
-- on their way, so the records are what is behind.
create or replace function warehouse_dispatch(p_request_id uuid, p_actor uuid, p_lines jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r stock_requests%rowtype;
  l record;
  v_taken numeric;
  v_expiry date;
  v_total numeric := 0;
  v_short jsonb := '[]'::jsonb;
begin
  select * into r from stock_requests where id = p_request_id for update;
  if not found then
    raise exception 'inventory: request not found';
  end if;
  if r.route <> 'from_warehouse' then
    raise exception 'inventory: this request is not filled from the warehouse';
  end if;
  if r.status = 'requested' then
    raise exception 'inventory: choose who delivers it before dispatching';
  end if;
  if r.status <> 'assigned' then
    raise exception 'inventory: this request is % — it can no longer be dispatched', r.status;
  end if;
  if jsonb_typeof(p_lines) <> 'array'
     or (select count(*) from stock_request_lines where request_id = p_request_id)
          <> (select count(distinct e->>'item_id') from jsonb_array_elements(p_lines) e)
     or jsonb_array_length(p_lines) <> (select count(*) from stock_request_lines where request_id = p_request_id)
     or exists (
       select 1 from jsonb_array_elements(p_lines) e
        where not exists (
          select 1 from stock_request_lines s
           where s.request_id = p_request_id and s.item_id = (e->>'item_id')::uuid))
  then
    raise exception 'inventory: give a dispatched quantity for every line of the request';
  end if;

  for l in
    select (e->>'item_id')::uuid as item_id, (e->>'qty')::numeric as qty
      from jsonb_array_elements(p_lines) e
     order by 1
  loop
    if l.qty is null or l.qty < 0 then
      raise exception 'inventory: a dispatched quantity cannot be negative';
    end if;
    v_expiry := null;
    if l.qty > 0 then
      perform warehouse_lock_item(l.item_id);
      select expiry_date into v_expiry
        from warehouse_batches
       where item_id = l.item_id and qty_remaining > 0
       order by expiry_date asc nulls last, received_at asc, id
       limit 1;
      v_taken := warehouse_take_fefo(l.item_id, l.qty);
      insert into warehouse_movements (item_id, kind, qty_delta, shortfall, request_id, actor_id)
      values (l.item_id, 'dispatch', -v_taken, l.qty - v_taken, p_request_id, p_actor);
      if l.qty > v_taken then
        update warehouse_items
           set shortfall_since_count = shortfall_since_count + (l.qty - v_taken), updated_at = now()
         where item_id = l.item_id;
        v_short := v_short || jsonb_build_object('item_id', l.item_id, 'shortfall', l.qty - v_taken);
      end if;
      v_total := v_total + l.qty;
    end if;
    update stock_request_lines
       set qty_picked = l.qty, dispatch_expiry = v_expiry
     where request_id = p_request_id and item_id = l.item_id;
  end loop;

  if v_total = 0 then
    raise exception 'inventory: nothing was dispatched — cancel the request instead';
  end if;

  update stock_requests
     set status = 'picked', picked_by = p_actor, picked_at = now(), updated_at = now()
   where id = p_request_id;
  return jsonb_build_object('short', v_short);
end $$;

-- "Send back to warehouse": a manager sends store stock to the warehouse,
-- naming who carries it (p_assignee, a team member, OR p_deliverer_name).
-- Created already dispatched: the stock leaves the store now, earliest expiry
-- first, and is in transit until the owner counts it in. Refused when the
-- store's records hold less than is being sent: count the item first.
-- p_lines: [{ "item_id": uuid, "qty": number }, ...], each > 0, each item once.
create or replace function warehouse_create_return(
  p_actor           uuid,
  p_note            text,
  p_assignee        uuid,
  p_deliverer_name  text,
  p_deliverer_phone text,
  p_lines           jsonb
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_name text := coalesce(trim(p_deliverer_name), '');
  l record;
  v_item inventory_items%rowtype;
  v_on_hand numeric;
  v_expiry date;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'inventory: add at least one item to send back';
  end if;
  if (p_assignee is null) = (v_name = '') then
    raise exception 'inventory: say who is taking it to the warehouse';
  end if;

  insert into stock_requests (
    requested_by, note, route, status,
    assigned_to, assigned_by, assigned_at, deliverer_name, deliverer_phone,
    picked_by, picked_at
  ) values (
    p_actor, coalesce(trim(p_note), ''), 'to_warehouse', 'picked',
    p_assignee, p_actor, now(),
    case when p_assignee is null then v_name else '' end,
    case when p_assignee is null then coalesce(trim(p_deliverer_phone), '') else '' end,
    p_actor, now()
  ) returning id into v_id;

  insert into stock_request_lines (request_id, item_id, qty_requested, qty_picked)
  select v_id, (e->>'item_id')::uuid, (e->>'qty')::numeric, (e->>'qty')::numeric
    from jsonb_array_elements(p_lines) e;

  for l in
    select id, item_id, qty_picked as qty from stock_request_lines where request_id = v_id order by item_id
  loop
    select * into v_item from inventory_items where id = l.item_id for update;
    select coalesce(sum(qty_remaining), 0) into v_on_hand from inventory_batches where item_id = l.item_id;
    if v_on_hand < l.qty then
      raise exception 'inventory: the store only has % % of % — count it before sending it back',
        trim_scale(v_on_hand), v_item.unit, v_item.name;
    end if;
    select expiry_date into v_expiry
      from inventory_batches
     where item_id = l.item_id and qty_remaining > 0
     order by expiry_date asc nulls last, received_at asc, id
     limit 1;
    perform inventory_take_fefo(l.item_id, l.qty);
    insert into inventory_movements (item_id, kind, qty_delta, request_id, reason, actor_id)
    values (l.item_id, 'return_out', -l.qty, v_id, 'sent to the warehouse', p_actor);
    update stock_request_lines set dispatch_expiry = v_expiry where id = l.id;
  end loop;

  perform inventory_refresh_availability();
  return v_id;
end $$;

-- The owner counts a return in at the warehouse. Exactly one line per request
-- line (0 = did not arrive). A perishable needs the batch's expiry date.
-- p_lines: [{ "item_id": uuid, "qty": number, "expiry_date": "YYYY-MM-DD" | null }, ...]
create or replace function warehouse_receive_return(p_request_id uuid, p_actor uuid, p_lines jsonb)
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
begin
  select * into r from stock_requests where id = p_request_id for update;
  if not found then
    raise exception 'inventory: request not found';
  end if;
  if r.route <> 'to_warehouse' then
    raise exception 'inventory: this is not a return to the warehouse';
  end if;
  if r.status <> 'picked' then
    raise exception 'inventory: this return is % — it can no longer be counted in', r.status;
  end if;
  if jsonb_typeof(p_lines) <> 'array'
     or (select count(*) from stock_request_lines where request_id = p_request_id)
          <> (select count(distinct e->>'item_id') from jsonb_array_elements(p_lines) e)
     or jsonb_array_length(p_lines) <> (select count(*) from stock_request_lines where request_id = p_request_id)
     or exists (
       select 1 from jsonb_array_elements(p_lines) e
        where not exists (
          select 1 from stock_request_lines s
           where s.request_id = p_request_id and s.item_id = (e->>'item_id')::uuid))
  then
    raise exception 'inventory: count every line of the return';
  end if;

  for l in
    select (e->>'item_id')::uuid as item_id,
           (e->>'qty')::numeric as qty,
           nullif(e->>'expiry_date', '')::date as expiry_date
      from jsonb_array_elements(p_lines) e
     order by 1
  loop
    if l.qty is null or l.qty < 0 then
      raise exception 'inventory: a received quantity cannot be negative';
    end if;
    select * into v_item from inventory_items where id = l.item_id;
    if l.qty > 0 and v_item.tracks_expiry and l.expiry_date is null then
      raise exception 'inventory: enter the expiry date for %', v_item.name;
    end if;
    update stock_request_lines
       set qty_received = l.qty, expiry_date = case when l.qty > 0 then l.expiry_date end
     where request_id = p_request_id and item_id = l.item_id
    returning qty_picked into v_picked;
    if v_picked is distinct from l.qty then
      v_discrepancy := true;
    end if;
    if l.qty > 0 then
      perform warehouse_lock_item(l.item_id);
      insert into warehouse_batches (item_id, qty_received, qty_remaining, expiry_date, source, request_id, received_by)
      values (l.item_id, l.qty, l.qty, l.expiry_date, 'return', p_request_id, p_actor)
      returning id into v_batch;
      insert into warehouse_movements (item_id, kind, qty_delta, batch_id, request_id, actor_id)
      values (l.item_id, 'return_in', l.qty, v_batch, p_request_id, p_actor);
    end if;
  end loop;

  update stock_requests
     set status = 'received', received_by = p_actor, received_at = now(),
         has_discrepancy = v_discrepancy, updated_at = now()
   where id = p_request_id;
  return jsonb_build_object('has_discrepancy', v_discrepancy);
end $$;

-- The owner settles a warehouse transfer that arrived different from what was
-- sent. Every line whose arrived quantity differs from the dispatched one is
-- settled once, in one go; lines that matched are not.
--   short (sent > arrived):  'lost'              nothing moves: written off in transit
--                            'back_to_origin'    the difference never left: back into
--                                                the origin's stock (warehouse for a
--                                                request, store for a return)
--   over (arrived > sent):   'origin_sent_extra' the origin sent more than it recorded:
--                                                the extra comes off the origin's stock
--                                                (what its batches can't cover is a
--                                                shortfall there, "count needed")
--                            'accepted'          nothing moves
-- p_lines: [{ "item_id": uuid, "resolution": text }, ...]
create or replace function warehouse_resolve(p_request_id uuid, p_actor uuid, p_note text, p_lines jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r stock_requests%rowtype;
  l record;
  v_line stock_request_lines%rowtype;
  v_diff numeric;
  v_extra numeric;
  v_taken numeric;
  v_batch uuid;
  v_expected int;
  v_store_changed boolean := false;
  v_reason text;
begin
  select * into r from stock_requests where id = p_request_id for update;
  if not found then
    raise exception 'inventory: request not found';
  end if;
  if r.route not in ('from_warehouse', 'to_warehouse') then
    raise exception 'inventory: only warehouse transfers are settled here';
  end if;
  if r.status <> 'received' then
    raise exception 'inventory: only a transfer that has been counted in can be settled';
  end if;
  if not r.has_discrepancy then
    raise exception 'inventory: this transfer arrived as it was sent — there is nothing to settle';
  end if;
  if r.resolved_at is not null then
    raise exception 'inventory: this transfer is already settled';
  end if;

  select count(*) into v_expected
    from stock_request_lines
   where request_id = p_request_id and coalesce(qty_picked, 0) <> coalesce(qty_received, 0);
  if jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) <> v_expected
     or (select count(distinct e->>'item_id') from jsonb_array_elements(p_lines) e) <> v_expected
     or exists (
       select 1 from jsonb_array_elements(p_lines) e
        where not exists (
          select 1 from stock_request_lines s
           where s.request_id = p_request_id and s.item_id = (e->>'item_id')::uuid
             and coalesce(s.qty_picked, 0) <> coalesce(s.qty_received, 0)))
  then
    raise exception 'inventory: settle every line that arrived different, and only those';
  end if;

  v_reason := 'settling #' || r.request_number || coalesce(nullif(': ' || trim(coalesce(p_note, '')), ': '), '');

  for l in
    select (e->>'item_id')::uuid as item_id, e->>'resolution' as resolution
      from jsonb_array_elements(p_lines) e
     order by 1
  loop
    select * into v_line from stock_request_lines where request_id = p_request_id and item_id = l.item_id;
    v_diff := coalesce(v_line.qty_picked, 0) - coalesce(v_line.qty_received, 0);
    if v_diff > 0 and l.resolution is distinct from 'lost' and l.resolution is distinct from 'back_to_origin' then
      raise exception 'inventory: a line that arrived short is either lost in transit or back where it came from';
    end if;
    if v_diff < 0 and l.resolution is distinct from 'origin_sent_extra' and l.resolution is distinct from 'accepted' then
      raise exception 'inventory: a line that arrived over is either taken off where it came from or accepted as it is';
    end if;

    if l.resolution = 'back_to_origin' then
      if r.route = 'from_warehouse' then
        perform warehouse_lock_item(l.item_id);
        insert into warehouse_batches (item_id, qty_received, qty_remaining, expiry_date, source, request_id, received_by)
        values (l.item_id, v_diff, v_diff, v_line.dispatch_expiry, 'transit_back', p_request_id, p_actor)
        returning id into v_batch;
        insert into warehouse_movements (item_id, kind, qty_delta, batch_id, request_id, reason, actor_id)
        values (l.item_id, 'transit_back', v_diff, v_batch, p_request_id, v_reason, p_actor);
      else
        perform 1 from inventory_items where id = l.item_id for update;
        insert into inventory_batches (item_id, qty_received, qty_remaining, expiry_date, request_id, source, received_by)
        values (l.item_id, v_diff, v_diff, v_line.dispatch_expiry, p_request_id, 'transit_back', p_actor)
        returning id into v_batch;
        insert into inventory_movements (item_id, kind, qty_delta, batch_id, request_id, reason, actor_id)
        values (l.item_id, 'transit_back', v_diff, v_batch, p_request_id, v_reason, p_actor);
        v_store_changed := true;
      end if;
    elsif l.resolution = 'origin_sent_extra' then
      v_extra := -v_diff;
      if r.route = 'from_warehouse' then
        perform warehouse_lock_item(l.item_id);
        v_taken := warehouse_take_fefo(l.item_id, v_extra);
        insert into warehouse_movements (item_id, kind, qty_delta, shortfall, request_id, reason, actor_id)
        values (l.item_id, 'transit_extra', -v_taken, v_extra - v_taken, p_request_id, v_reason, p_actor);
        if v_extra > v_taken then
          update warehouse_items
             set shortfall_since_count = shortfall_since_count + (v_extra - v_taken), updated_at = now()
           where item_id = l.item_id;
        end if;
      else
        perform 1 from inventory_items where id = l.item_id for update;
        v_taken := inventory_take_fefo(l.item_id, v_extra);
        insert into inventory_movements (item_id, kind, qty_delta, shortfall, request_id, reason, actor_id)
        values (l.item_id, 'transit_extra', -v_taken, v_extra - v_taken, p_request_id, v_reason, p_actor);
        if v_extra > v_taken then
          update inventory_items
             set shortfall_since_count = shortfall_since_count + (v_extra - v_taken), updated_at = now()
           where id = l.item_id;
        end if;
        v_store_changed := true;
      end if;
    end if;

    update stock_request_lines
       set resolution = l.resolution, resolved_qty = abs(v_diff)
     where id = v_line.id;
  end loop;

  update stock_requests
     set resolved_by = p_actor, resolved_at = now(), resolution_note = coalesce(trim(p_note), ''), updated_at = now()
   where id = p_request_id;
  if v_store_changed then
    perform inventory_refresh_availability();
  end if;
  return jsonb_build_object('lines', v_expected);
end $$;

-- The owner records stock bought into the warehouse. Each line is a batch
-- (the same item twice = two batches, e.g. two expiry dates).
-- p_lines: [{ "item_id": uuid, "qty": number, "expiry_date": "YYYY-MM-DD" | null }, ...]
create or replace function warehouse_purchase(p_actor uuid, p_supplier text, p_note text, p_lines jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  l record;
  v_item inventory_items%rowtype;
  v_batch uuid;
  v_count int := 0;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'inventory: add at least one item';
  end if;
  for l in
    select (e->>'item_id')::uuid as item_id,
           (e->>'qty')::numeric as qty,
           nullif(e->>'expiry_date', '')::date as expiry_date
      from jsonb_array_elements(p_lines) e
     order by 1
  loop
    if l.qty is null or l.qty <= 0 then
      raise exception 'inventory: every quantity must be more than 0';
    end if;
    select * into v_item from inventory_items where id = l.item_id;
    if not found then
      raise exception 'inventory: unknown stock item';
    end if;
    if v_item.tracks_expiry and l.expiry_date is null then
      raise exception 'inventory: enter the expiry date for %', v_item.name;
    end if;
    perform warehouse_lock_item(l.item_id);
    insert into warehouse_batches (item_id, qty_received, qty_remaining, expiry_date, source, supplier, received_by)
    values (l.item_id, l.qty, l.qty, l.expiry_date, 'purchase', coalesce(trim(p_supplier), ''), p_actor)
    returning id into v_batch;
    insert into warehouse_movements (item_id, kind, qty_delta, batch_id, reason, actor_id)
    values (l.item_id, 'purchase', l.qty, v_batch, coalesce(trim(p_note), ''), p_actor);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- The owner's corrections to the warehouse sheet, the same two as the store's
-- (inventory_adjust):
--   'waste': p_qty > 0 thrown away — from p_batch_id or earliest expiry first.
--            Refused if the warehouse doesn't hold that much.
--   'count': p_qty >= 0 is what is physically there. The difference comes off
--            earliest-expiry-first, or is added as an undated batch, and the
--            item's warehouse shortfall is cleared.
create or replace function warehouse_adjust(
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
  perform warehouse_lock_item(p_item_id);
  select coalesce(sum(qty_remaining), 0) into v_on_hand
    from warehouse_batches where item_id = p_item_id;

  if p_kind = 'waste' then
    if p_qty is null or p_qty <= 0 then
      raise exception 'inventory: enter how much was thrown away';
    end if;
    if p_batch_id is not null then
      select qty_remaining into v_left
        from warehouse_batches where id = p_batch_id and item_id = p_item_id for update;
      if not found then
        raise exception 'inventory: that batch is not part of this item';
      end if;
      if v_left < p_qty then
        raise exception 'inventory: that batch only has % left', trim_scale(v_left);
      end if;
      update warehouse_batches set qty_remaining = qty_remaining - p_qty where id = p_batch_id;
    else
      if v_on_hand < p_qty then
        raise exception 'inventory: the warehouse only has %', trim_scale(v_on_hand);
      end if;
      v_taken := warehouse_take_fefo(p_item_id, p_qty);
    end if;
    insert into warehouse_movements (item_id, kind, qty_delta, batch_id, reason, actor_id)
    values (p_item_id, 'waste', -p_qty, p_batch_id, coalesce(p_reason, ''), p_actor);
    return jsonb_build_object('on_hand', v_on_hand - p_qty);
  end if;

  if p_kind = 'count' then
    if p_qty is null or p_qty < 0 then
      raise exception 'inventory: enter the quantity counted';
    end if;
    v_delta := p_qty - v_on_hand;
    if v_delta < 0 then
      v_taken := warehouse_take_fefo(p_item_id, -v_delta);
    elsif v_delta > 0 then
      insert into warehouse_batches (item_id, qty_received, qty_remaining, source, received_by)
      values (p_item_id, v_delta, v_delta, 'count', p_actor)
      returning id into v_batch;
    end if;
    insert into warehouse_movements (item_id, kind, qty_delta, batch_id, reason, actor_id)
    values (p_item_id, 'count', v_delta, v_batch, coalesce(p_reason, ''), p_actor);
    update warehouse_items
       set shortfall_since_count = 0, last_counted_at = now(), updated_by = p_actor, updated_at = now()
     where item_id = p_item_id;
    return jsonb_build_object('on_hand', p_qty);
  end if;

  raise exception 'inventory: unknown adjustment';
end $$;

-- ── Lock down ───────────────────────────────────────────────────────────────
alter table warehouse_items          enable row level security;
alter table warehouse_batches        enable row level security;
alter table warehouse_movements      enable row level security;
alter table warehouse_alert_settings enable row level security;
alter table warehouse_alerts         enable row level security;
revoke all on warehouse_items          from anon, authenticated;
revoke all on warehouse_batches        from anon, authenticated;
revoke all on warehouse_movements      from anon, authenticated;
revoke all on warehouse_alert_settings from anon, authenticated;
revoke all on warehouse_alerts         from anon, authenticated;

revoke execute on function warehouse_lock_item(uuid) from public, anon, authenticated;
revoke execute on function warehouse_take_fefo(uuid, numeric) from public, anon, authenticated;
revoke execute on function warehouse_create_request(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function warehouse_dispatch(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function warehouse_create_return(uuid, text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function warehouse_receive_return(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function warehouse_resolve(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function warehouse_purchase(uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function warehouse_adjust(uuid, uuid, text, numeric, uuid, text) from public, anon, authenticated;
grant execute on function warehouse_lock_item(uuid) to service_role;
grant execute on function warehouse_take_fefo(uuid, numeric) to service_role;
grant execute on function warehouse_create_request(uuid, text, jsonb) to service_role;
grant execute on function warehouse_dispatch(uuid, uuid, jsonb) to service_role;
grant execute on function warehouse_create_return(uuid, text, uuid, text, text, jsonb) to service_role;
grant execute on function warehouse_receive_return(uuid, uuid, jsonb) to service_role;
grant execute on function warehouse_resolve(uuid, uuid, text, jsonb) to service_role;
grant execute on function warehouse_purchase(uuid, text, text, jsonb) to service_role;
grant execute on function warehouse_adjust(uuid, uuid, text, numeric, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Verify:
--   select column_name from information_schema.columns
--    where table_name = 'stock_requests' and column_name in ('route', 'deliverer_name', 'resolved_at');  -- 3 rows
--   select proname from pg_proc where proname like 'warehouse_%';  -- 9 functions
--   select * from warehouse_alert_settings;                        -- 1 row
--   set role anon; select * from warehouse_batches; reset role;    -- permission denied
-- ---------------------------------------------------------------------------
