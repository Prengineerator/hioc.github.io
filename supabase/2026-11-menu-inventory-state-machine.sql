-- ===========================================================================
-- State machines: menu change requests and stock requests — the database half
-- of lib/menu/changeRequestStatus.ts and lib/inventory/rules.ts
-- STOCK_REQUEST_TRANSITIONS. Optional: the app works the same without it
-- (each part says what it does without it). Additive and safe to re-run.
--
-- 1. menu_change_requests.applied_at
--    Approving a request claims the row (pending -> approved) and then applies
--    the change with several writes. If the server stopped in between, the row
--    said "approved" with the change never made, and nothing told it apart from
--    a finished approval. applied_at is stamped once the change is in, so an
--    approved request that stays unstamped shows the owner "Approved, but not
--    confirmed as applied" (approvalUnconfirmed). Approvals made before this
--    file are stamped with their decision time when the column is added.
--    Without the column the app writes nothing new and can only flag what the
--    row itself shows (an approved create with no item, an approved delete
--    whose item is still there).
--
-- 2. inventory_pick / inventory_receive refuse the wrong route
--    Both predate the warehouse (supabase/2026-11-warehouse.sql) and checked
--    only the status. The app already sends each route to its own function
--    (rules.ts stepWriter) and its guards refuse the rest, but the functions
--    themselves would have:
--      - picked a from_warehouse request (so its stock never left the
--        warehouse sheet — warehouse_dispatch is the one that does that);
--      - received a to_warehouse return (it is created 'picked'), adding to the
--        store stock that had already left with it.
--    Re-created from supabase/2026-10-inventory.sql — the latest definition of
--    each (nothing after it re-defines them) — with ONLY the route check added,
--    marked "Added by this file". The route is read through to_jsonb, so this
--    also works on a database without 2026-11-warehouse.sql (every request
--    reads as store_room, exactly as before). Without this file the app's
--    route checks still stand; only a caller going around the app is unchecked.
--
-- Not moved to SQL: the second-person rule (whoever picked or carried a
-- transfer can't be the one who counts it in, unless a manager) stays in
-- rules.ts canReceive. inventory_receive is not told the actor's role, and
-- giving it one would change its signature for every caller.
-- ===========================================================================

-- ── 1. menu_change_requests.applied_at ──────────────────────────────────────
do $$
begin
  if to_regclass('public.menu_change_requests') is null then
    return; -- supabase/2026-10-menu-change-requests.sql not applied yet
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'menu_change_requests' and column_name = 'applied_at'
  ) then
    alter table public.menu_change_requests add column applied_at timestamptz;
    -- Only when the column is first added, so a re-run never stamps an
    -- approval that was interrupted after this file went in.
    update public.menu_change_requests
       set applied_at = coalesce(decided_at, now())
     where status = 'approved';
  end if;

  -- Only an approved request has been applied (a failed approval goes back to
  -- pending before anything stamps it).
  if not exists (
    select 1 from pg_constraint
     where conname = 'menu_change_requests_applied_shape'
       and conrelid = 'public.menu_change_requests'::regclass
  ) then
    alter table public.menu_change_requests
      add constraint menu_change_requests_applied_shape
      check (applied_at is null or status = 'approved');
  end if;
end $$;

-- ── 2. inventory_pick / inventory_receive: the route ────────────────────────

-- The assignee records what they picked. Status-guarded: only an 'assigned'
-- request, only by the person it is assigned to (or p_is_manager), and only a
-- store-room request.
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
  -- Added by this file: only a store-room request is picked here. A warehouse
  -- transfer's dispatch takes stock off the warehouse sheet (warehouse_dispatch)
  -- and a return is never picked; picking either here would move no stock.
  if coalesce(to_jsonb(r) ->> 'route', 'store_room') <> 'store_room' then
    raise exception 'inventory: this request is not picked from the store room';
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
-- For a request, exactly one line per request line (qty 0 = did not arrive),
-- and never a return to the warehouse.
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
    -- Added by this file: a return to the warehouse is counted in there
    -- (warehouse_receive_return). Receiving it here would add to the store
    -- stock that already left with it.
    if coalesce(to_jsonb(r) ->> 'route', 'store_room') = 'to_warehouse' then
      raise exception 'inventory: a return is counted in at the warehouse, not at the POS';
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

  perform inventory_refresh_availability();
  return jsonb_build_object('batches', v_lines, 'has_discrepancy', v_discrepancy);
end $$;

-- Unchanged grants (create or replace keeps them; restated so this file stands alone).
revoke execute on function inventory_pick(uuid, uuid, boolean, jsonb) from public, anon, authenticated;
revoke execute on function inventory_receive(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function inventory_pick(uuid, uuid, boolean, jsonb) to service_role;
grant execute on function inventory_receive(uuid, uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Verify:
--   select column_name from information_schema.columns
--    where table_name = 'menu_change_requests' and column_name = 'applied_at';   -- 1 row
--   select count(*) from menu_change_requests where status = 'approved' and applied_at is null;
--     -- 0 right after applying; later, approvals that did not finish applying
--   select prosrc like '%not picked from the store room%' from pg_proc where proname = 'inventory_pick';           -- true
--   select prosrc like '%counted in at the warehouse, not at the POS%' from pg_proc where proname = 'inventory_receive'; -- true
-- ---------------------------------------------------------------------------
