-- ===========================================================================
-- Inventory — apply the recipe book from a single function call.
-- Builds on supabase/2026-10-inventory.sql and
-- supabase/2026-10-inventory-addon-scopes.sql (apply those first). Recipe-book
-- workflow that needs this: docs/INVENTORY-RECIPE-BOOK.md.
--
-- WHY. The generated seed used to carry its own logic (a DO block) around a
-- ~400 KB payload, too large to paste into the Supabase SQL editor, and there
-- is no direct database connection from a checkout: only PostgREST with the
-- service-role key. So the LOGIC lives here, in one function, and the data is
-- its argument. `npm run inventory:apply` calls it over REST in one request
-- (one transaction, all or nothing); <book>/seed.sql is now just
-- `select inventory_apply_book(...)` around the same two JSON documents.
--
-- WHAT. inventory_apply_book(p_payload, p_doc, p_dry_run) does what the seed
-- DO block did, step for step:
--
--   0. Saves p_doc — the whole book, drafts and notes included — in
--      inventory_recipe_book (the row `npm run inventory:pull` reads back).
--      p_doc must not be null. If p_payload is null that is ALL it does
--      (SAVE ONLY: no stock item, recipe or setting is touched).
--   1. Auto-hide guard: if no stock has ever been received, turns
--      store_settings.stock_auto_hide off, or every recipe item would read
--      "0 on hand" and vanish from the live menu (INV-D16).
--   2. Unit guard: refuses a stock item whose unit differs from the live one
--      (units lock once an item is used, INV-D15).
--   3. Stock items: adds new ones, updates existing ones, matched by name
--      regardless of case. A par / reorder of 0 leaves the live value alone.
--   4. Existence guards: every menu item, add-on option, and menu item named
--      by an add-on scope must exist live.
--   5. Recipes: each listed menu item's whole recipe through
--      inventory_set_recipe, each listed add-on's whole recipe (every scope)
--      through inventory_set_addon_recipe_scopes. Anything not listed is left
--      as it is.
--
-- p_payload: { "stock_items": [...], "recipes": [...], "addon_recipes": [...] }
--   (the compiled book — lib/inventory/recipeBook.ts compileRecipeBook), or null.
-- p_doc:     the book document (lib/inventory/recipeBook.ts toBookDocument).
-- p_dry_run: runs every step, then raises 'DRY RUN OK (nothing was saved): <result>'
--   so the whole call rolls back. Nothing is written; the message says what
--   WOULD have been. Any other error is a real refusal.
--
-- Returns { "saved": true, "stock_items": n, "recipes": n, "addon_recipes": n,
--           "save_only": bool } — the counts are what was applied (0 for a
-- save-only call). The function's own refusals start with 'inventory seed: '
-- (the recipe functions it calls keep their 'inventory: ' messages).
--
-- Like the other inventory functions it is service-role only (explicit REVOKE):
-- the API's service key is the only way in. Idempotent: safe to re-run, and the
-- function can be re-created at any time.
-- ===========================================================================

create or replace function inventory_apply_book(p_payload jsonb, p_doc jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_save_only boolean := (p_payload is null or jsonb_typeof(p_payload) = 'null');
  v_bad       text;
  v_lines     jsonb;
  v_total     int;
  v_found     int;
  v_result    jsonb;
  r           record;
begin
  -- Up front: the shape of what was sent (a JSON null counts as missing).
  if p_doc is null or jsonb_typeof(p_doc) = 'null' then
    raise exception 'inventory seed: the book document is missing';
  end if;
  if jsonb_typeof(p_doc) <> 'object' then
    raise exception 'inventory seed: the book document must be a JSON object';
  end if;
  if not v_save_only then
    if jsonb_typeof(p_payload) <> 'object' then
      raise exception 'inventory seed: the payload must be a JSON object with stock_items, recipes and addon_recipes lists';
    end if;
    if jsonb_typeof(p_payload->'stock_items') is distinct from 'array' then
      raise exception 'inventory seed: payload.stock_items must be a JSON array';
    end if;
    if jsonb_typeof(p_payload->'recipes') is distinct from 'array' then
      raise exception 'inventory seed: payload.recipes must be a JSON array';
    end if;
    if jsonb_typeof(p_payload->'addon_recipes') is distinct from 'array' then
      raise exception 'inventory seed: payload.addon_recipes must be a JSON array';
    end if;
  end if;

  -- 0. The book's permanent home (docs/INVENTORY-RECIPE-BOOK.md): drafts and
  --    notes included, so `npm run inventory:pull` can restore it anywhere.
  insert into inventory_recipe_book (id, book, saved_at) values (true, p_doc, now())
  on conflict (id) do update set book = excluded.book, saved_at = excluded.saved_at;

  if not v_save_only then
    -- 1. Before any stock has been received, every recipe would read "0 on hand"
    --    and auto-hide would pull those items off the live menu (INV-D16) — even
    --    with the app flag off. Keep it off until the opening stock is in.
    if not exists (select 1 from inventory_batches) then
      update store_settings set stock_auto_hide = false where is_singleton and stock_auto_hide;
    end if;

    -- 2. Units lock once an item is used (INV-D15): never silently change one.
    select string_agg(format('%s (live %s, book %s)', i.name, i.unit, s.unit), '; ')
      into v_bad
      from jsonb_to_recordset(p_payload->'stock_items') s(name text, unit text)
      join inventory_items i on lower(trim(i.name)) = lower(trim(s.name))
     where i.unit <> s.unit;
    if v_bad is not null then
      raise exception 'inventory seed: unit differs from the live stock item: %', v_bad;
    end if;

    -- 3. Stock items: add new ones, update existing ones (matched by name).
    insert into inventory_items (name, unit, category, par_level, reorder_qty, tracks_expiry)
    select trim(s.name), s.unit, s.category, s.par_level, s.reorder_qty, s.tracks_expiry
      from jsonb_to_recordset(p_payload->'stock_items')
           s(name text, unit text, category text, par_level numeric, reorder_qty numeric, tracks_expiry boolean)
    on conflict ((lower(trim(name)))) do update
       set category      = case when excluded.category <> '' then excluded.category else inventory_items.category end,
           par_level     = case when excluded.par_level > 0 then excluded.par_level else inventory_items.par_level end,
           reorder_qty   = case when excluded.reorder_qty > 0 then excluded.reorder_qty else inventory_items.reorder_qty end,
           tracks_expiry = excluded.tracks_expiry,
           is_active     = true,
           updated_at    = now();

    -- 4. Every menu item and add-on in the book must exist live (add-on scopes
    --    name menu items too).
    select string_agg(format('%s (%s)', x.name, x.id), '; ') into v_bad
      from jsonb_to_recordset(p_payload->'recipes') x(id uuid, name text)
     where not exists (select 1 from menu_items m where m.id = x.id);
    if v_bad is not null then
      raise exception 'inventory seed: menu items not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;
    end if;
    select string_agg(format('%s (%s)', x.name, x.id), '; ') into v_bad
      from jsonb_to_recordset(p_payload->'addon_recipes') x(id uuid, name text)
     where not exists (select 1 from addon_options o where o.id = x.id);
    if v_bad is not null then
      raise exception 'inventory seed: add-on options not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;
    end if;
    select string_agg(distinct format('%s (%s)', x.name, l.menu_item_id), '; ') into v_bad
      from jsonb_to_recordset(p_payload->'addon_recipes') x(name text, lines jsonb),
           jsonb_to_recordset(x.lines) l(menu_item_id uuid)
     where l.menu_item_id is not null
       and not exists (select 1 from menu_items m where m.id = l.menu_item_id);
    if v_bad is not null then
      raise exception 'inventory seed: add-on scopes name menu items not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;
    end if;

    -- 5. Recipes, through the same functions the POS editor uses.
    for r in select * from jsonb_to_recordset(p_payload->'recipes') x(id uuid, name text, lines jsonb) loop
      select count(*), count(i.id),
             coalesce(jsonb_agg(jsonb_build_object('size_label', l.size_label, 'item_id', i.id, 'qty', l.qty))
                        filter (where i.id is not null), '[]'::jsonb)
        into v_total, v_found, v_lines
        from jsonb_to_recordset(r.lines) l(size_label text, ingredient text, qty numeric)
        left join inventory_items i on lower(trim(i.name)) = lower(trim(l.ingredient));
      if v_found <> v_total then
        raise exception 'inventory seed: a line of "%" names a stock item that does not exist', r.name;
      end if;
      perform inventory_set_recipe(r.id, null, v_lines);
    end loop;

    for r in select * from jsonb_to_recordset(p_payload->'addon_recipes') x(id uuid, name text, lines jsonb) loop
      select count(*), count(i.id),
             coalesce(jsonb_agg(jsonb_build_object('menu_item_id', l.menu_item_id, 'size_label', l.size_label, 'item_id', i.id, 'qty', l.qty))
                        filter (where i.id is not null), '[]'::jsonb)
        into v_total, v_found, v_lines
        from jsonb_to_recordset(r.lines) l(menu_item_id uuid, size_label text, ingredient text, qty numeric)
        left join inventory_items i on lower(trim(i.name)) = lower(trim(l.ingredient));
      if v_found <> v_total then
        raise exception 'inventory seed: a line of "%" names a stock item that does not exist', r.name;
      end if;
      perform inventory_set_addon_recipe_scopes(r.id, null, v_lines);
    end loop;
  end if;

  v_result := jsonb_build_object(
    'saved',         true,
    'stock_items',   case when v_save_only then 0 else jsonb_array_length(p_payload->'stock_items') end,
    'recipes',       case when v_save_only then 0 else jsonb_array_length(p_payload->'recipes') end,
    'addon_recipes', case when v_save_only then 0 else jsonb_array_length(p_payload->'addon_recipes') end,
    'save_only',     v_save_only);

  -- A dry run has done every step; ending in an error rolls all of it back.
  if coalesce(p_dry_run, false) then
    raise exception 'DRY RUN OK (nothing was saved): %', v_result::text;
  end if;
  return v_result;
end $$;

-- ── Lock down ───────────────────────────────────────────────────────────────
revoke execute on function inventory_apply_book(jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function inventory_apply_book(jsonb, jsonb, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- the function is installed, once:
--   select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'inventory_apply_book';
--     -- p_payload jsonb, p_doc jsonb, p_dry_run boolean  (1 row)
--   -- closed to anon and authenticated, open to the service role:
--   select has_function_privilege('anon', 'inventory_apply_book(jsonb, jsonb, boolean)', 'execute'),          -- false
--          has_function_privilege('authenticated', 'inventory_apply_book(jsonb, jsonb, boolean)', 'execute'), -- false
--          has_function_privilege('service_role', 'inventory_apply_book(jsonb, jsonb, boolean)', 'execute');  -- true
--   -- nothing is written by a dry run (this raises 'DRY RUN OK (nothing was saved): ...'):
--   select inventory_apply_book(null, '{"version": 1}'::jsonb, true);
--   -- PostgREST only sees a new function once its schema cache reloads (it does
--   -- so on its own within moments); to force it:  notify pgrst, 'reload schema';
-- ---------------------------------------------------------------------------
