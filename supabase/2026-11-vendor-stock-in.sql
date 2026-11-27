-- ===========================================================================
-- Stock from vendor: stock bought straight from a vendor (the dairy, the
-- bakery, a cash-and-carry run) and counted in at the store's POS, with no
-- stock request or warehouse transfer behind it (docs/INVENTORY-SPEC.md,
-- INV-D14).
--
-- Before this, a direct delivery went in through inventory_receive with
-- p_request_id = null: the stock went up, but nothing said where it came
-- from. Now the vendor's name is kept on every batch it delivered, and the
-- ledger row says who sold it and on which bill:
--
--   inventory_batches.supplier   The vendor's name ('' for every other batch:
--                                a request, a count, a transfer back).
--   inventory_movements.reason   'Vendor: Sharma Dairy · Bill 1043 · Paid cash'
--                                (the bill number and note only when given).
--
--   inventory_receive_vendor(p_actor, p_device_id, p_supplier, p_bill_ref,
--                            p_note, p_lines)
--       The direct-delivery half of inventory_receive, plus the vendor. Same
--       rules: at least one line, no negative quantities, an expiry date for a
--       perishable that arrived, the item row locked while its batch is
--       written. A line of 0 adds nothing. A blank vendor is refused. Ends by
--       re-checking which menu items stock can make (auto-hide, INV-D16).
--
-- inventory_receive is unchanged, and still receives requests and warehouse
-- transfers. POST /api/inventory/receipts calls the new function and falls
-- back to inventory_receive while this file is not applied, so the stock still
-- goes in (without the vendor's name).
--
-- Batches keep source 'receive' (2026-11-warehouse.sql's constraint allows
-- receive / count / transit_back), so the Stock screen, FEFO and auto-hide
-- treat vendor stock exactly like any other delivery.
--
-- Additive and safe to re-run, before or after the app update.
-- ===========================================================================

alter table inventory_batches add column if not exists supplier text not null default '';

create or replace function inventory_receive_vendor(
  p_actor uuid,
  p_device_id uuid,
  p_supplier text,
  p_bill_ref text,
  p_note text,
  p_lines jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  l record;
  v_item inventory_items%rowtype;
  v_batch uuid;
  v_lines int := 0;
  v_supplier text := btrim(coalesce(p_supplier, ''));
  v_reason text;
begin
  if v_supplier = '' then
    raise exception 'inventory: enter the vendor''s name';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'inventory: nothing to receive';
  end if;

  -- 'Vendor: Sharma Dairy · Bill 1043 · Paid cash' — the empty parts left out.
  v_reason := concat_ws(' · ',
    'Vendor: ' || v_supplier,
    'Bill ' || nullif(btrim(coalesce(p_bill_ref, '')), ''),
    nullif(btrim(coalesce(p_note, '')), ''));

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

    if l.qty > 0 then
      insert into inventory_batches (item_id, qty_received, qty_remaining, expiry_date, request_id, received_by, supplier)
      values (l.item_id, l.qty, l.qty, l.expiry_date, null, p_actor, v_supplier)
      returning id into v_batch;
      insert into inventory_movements (item_id, kind, qty_delta, batch_id, request_id, reason, actor_id)
      values (l.item_id, 'receive', l.qty, v_batch, null, v_reason, p_actor);
      v_lines := v_lines + 1;
    end if;
  end loop;

  if v_lines = 0 then
    raise exception 'inventory: nothing to receive';
  end if;

  perform inventory_refresh_availability();
  return jsonb_build_object('batches', v_lines);
end $$;

revoke execute on function inventory_receive_vendor(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function inventory_receive_vendor(uuid, uuid, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- 1. The column exists, '' by default:
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns
--    where table_name = 'inventory_batches' and column_name = 'supplier';
--   -- expect: text, ''::text, NO.
--
--   -- 2. The function is installed (an empty delivery is refused, nothing written):
--   select inventory_receive_vendor(null, null, 'Test', '', '', '[]'::jsonb);
--   -- expect: ERROR  inventory: nothing to receive
--
--   -- 3. Recent vendor deliveries:
--   select b.received_at, i.name, b.qty_received, b.supplier, b.expiry_date
--     from inventory_batches b join inventory_items i on i.id = b.item_id
--    where b.supplier <> '' order by b.received_at desc limit 20;
--
--   -- then `npm run verify:db` (the "INV-13 · stock from vendor" section).
-- ---------------------------------------------------------------------------
