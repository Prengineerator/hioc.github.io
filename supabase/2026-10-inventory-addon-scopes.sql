-- ===========================================================================
-- Inventory — add-on recipes scoped to a menu item and size, and the recipe
-- book's permanent home in the database.
-- Builds on supabase/2026-10-inventory.sql (apply that first). Recipe-book
-- workflow that needs this: docs/INVENTORY-RECIPE-BOOK.md.
--
-- WHY. An add-on's usage depends on what it is added to. The café's Petpooja
-- inventory setup has, for "Sugar — Normal", 20 g on a Latte Extra Large and
-- 10 g on an Espresso. addon_recipe_lines held ONE recipe per add-on option
-- (unique on addon_option_id + item_id), so a single number had to serve every
-- drink and every size: the stock count drifted from the first busy day.
--
-- WHAT. A line of an add-on's recipe now has a SCOPE:
--
--   menu_item_id null, size_label ''       general — any item, any size
--   menu_item_id M,    size_label ''       everything M is sold in (all sizes)
--   menu_item_id M,    size_label 'Large'  M in that size only
--
-- For an order line (menu item M, size S) and add-on option O the most
-- specific scope that has at least one line wins — item+size, else item, else
-- general — and it REPLACES the less specific ones; they are never summed
-- (lib/inventory/rules.ts addonRecipeFor; the same "own recipe replaces the
-- base one" rule as recipe_lines, INV-D11). An order line whose menu item has
-- since been deleted only sees the general lines.
--
-- Sizes are matched by LABEL, not by menu_item_variants.id, for the same
-- reason as recipe_lines: saving a menu item re-creates its variant rows, so
-- an id-keyed row would vanish on every price edit.
--
-- Existing rows keep working untouched: they get menu_item_id null and
-- size_label '' — general lines, exactly what they were.
--
-- WRITES.
--   * inventory_set_addon_recipe (the POS editor) still replaces an add-on's
--     recipe, but now ONLY its general lines. The editor cannot show per-item
--     amounts, and must not wipe what the recipe book put there.
--   * inventory_set_addon_recipe_scopes (the recipe-book seed) replaces ALL of
--     an add-on's lines, every scope, in one go — the book is the source of
--     truth for the whole set.
--
-- inventory_recipe_book is a single-row table that keeps the whole recipe book
-- (drafts and notes included) so that it has a permanent home and can be
-- pulled back into a fresh checkout. The GitHub repository is public and the
-- recipes are not: like the inventory tables it is service-role only (RLS on,
-- no policies, explicit REVOKE).
--
-- Idempotent: safe to re-run. Order matters once: re-running
-- 2026-10-inventory.sql AFTER this file puts the old inventory_set_addon_recipe
-- (which deletes every scope) back, so re-run this file after it.
-- ===========================================================================

-- ── Scope columns ───────────────────────────────────────────────────────────
-- A deleted menu item takes its scoped lines with it.
alter table addon_recipe_lines
  add column if not exists menu_item_id uuid references menu_items(id) on delete cascade,
  add column if not exists size_label   text not null default '';

alter table addon_recipe_lines drop constraint if exists addon_recipe_lines_size_trimmed;
alter table addon_recipe_lines add constraint addon_recipe_lines_size_trimmed
  check (size_label = trim(size_label));

-- A size only means something on a menu item.
alter table addon_recipe_lines drop constraint if exists addon_recipe_lines_size_needs_item;
alter table addon_recipe_lines add constraint addon_recipe_lines_size_needs_item
  check (size_label = '' or menu_item_id is not null);

-- ── Uniqueness moves from (option, ingredient) to (option, scope, ingredient)
-- The inline `unique (addon_option_id, item_id)` of 2026-10-inventory.sql got
-- Postgres's default name below; left in place it would refuse the same
-- ingredient in two scopes (sugar for a Latte AND for an Espresso).
alter table addon_recipe_lines drop constraint if exists addon_recipe_lines_addon_option_id_item_id_key;

-- NULL menu_item_id would make every general line distinct, so it is folded to
-- the nil uuid for uniqueness (NULLS NOT DISTINCT needs Postgres 15).
create unique index if not exists addon_recipe_lines_scope_unique
  on addon_recipe_lines (
    addon_option_id,
    coalesce(menu_item_id, '00000000-0000-0000-0000-000000000000'::uuid),
    size_label,
    item_id
  );
create index if not exists addon_recipe_lines_menu_item
  on addon_recipe_lines (menu_item_id) where menu_item_id is not null;

-- ── The recipe book's home ──────────────────────────────────────────────────
-- One row: id can only be true. The seed upserts it; inventory:pull reads it.
create table if not exists inventory_recipe_book (
  id       boolean primary key default true check (id),
  book     jsonb not null,
  saved_at timestamptz not null default now()
);

-- ===========================================================================
-- Functions. Errors meant for the person at the screen start with
-- 'inventory: ', as in 2026-10-inventory.sql.
-- ===========================================================================

-- Replace an add-on option's GENERAL recipe (what one extra shot / oat-milk
-- swap uses per serving it is added to, whatever it is added to). Lines scoped
-- to a menu item or size (menu_item_id is not null) are left exactly as they
-- are: the POS editor only sees and edits the general lines. To replace every
-- scope, use inventory_set_addon_recipe_scopes.
-- p_lines: [{ "item_id": uuid, "qty": number }, ...]
create or replace function inventory_set_addon_recipe(p_option_id uuid, p_actor uuid, p_lines jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count int;
begin
  perform 1 from addon_options where id = p_option_id for update;
  if not found then
    raise exception 'inventory: add-on not found';
  end if;
  delete from addon_recipe_lines where addon_option_id = p_option_id and menu_item_id is null;
  insert into addon_recipe_lines (addon_option_id, item_id, qty, updated_by)
  select p_option_id, (e->>'item_id')::uuid, (e->>'qty')::numeric, p_actor
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Replace an add-on option's WHOLE recipe — the general lines and every
-- per-item / per-size scope — in one go. Used by the recipe-book seed.
-- p_lines: [{ "menu_item_id": uuid | null, "size_label": "" | "Large",
--             "item_id": uuid, "qty": number }, ...]
-- menu_item_id null (or absent) is a general line, and then size_label must be
-- ''. A size must be one of that menu item's current size labels, as in
-- inventory_set_recipe. Returns the number of lines saved.
create or replace function inventory_set_addon_recipe_scopes(p_option_id uuid, p_actor uuid, p_lines jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count int;
begin
  perform 1 from addon_options where id = p_option_id for update;
  if not found then
    raise exception 'inventory: add-on not found';
  end if;
  delete from addon_recipe_lines where addon_option_id = p_option_id;
  insert into addon_recipe_lines (addon_option_id, menu_item_id, size_label, item_id, qty, updated_by)
  select p_option_id,
         nullif(e->>'menu_item_id', '')::uuid,
         trim(coalesce(e->>'size_label', '')),
         (e->>'item_id')::uuid,
         (e->>'qty')::numeric,
         p_actor
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e;
  get diagnostics v_count = row_count;

  if exists (
    select 1 from addon_recipe_lines l
     where l.addon_option_id = p_option_id and l.size_label <> ''
       and not exists (
         select 1 from menu_item_variants v
          where v.menu_item_id = l.menu_item_id and trim(v.label) = l.size_label))
  then
    raise exception 'inventory: that size does not belong to this menu item';
  end if;
  return v_count;
end $$;

-- ── Lock down ───────────────────────────────────────────────────────────────
alter table inventory_recipe_book enable row level security;
revoke all on inventory_recipe_book from anon, authenticated;

revoke execute on function inventory_set_addon_recipe(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function inventory_set_addon_recipe_scopes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function inventory_set_addon_recipe(uuid, uuid, jsonb) to service_role;
grant execute on function inventory_set_addon_recipe_scopes(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- the two new columns (menu_item_id uuid null, size_label text not null default ''):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_name = 'addon_recipe_lines' and column_name in ('menu_item_id', 'size_label');
--   -- the scope index exists, and the old (option, ingredient) unique is gone:
--   select indexname from pg_indexes
--    where tablename = 'addon_recipe_lines' and indexname in ('addon_recipe_lines_scope_unique', 'addon_recipe_lines_menu_item');  -- 2 rows
--   select conname from pg_constraint
--    where conrelid = 'addon_recipe_lines'::regclass and conname = 'addon_recipe_lines_addon_option_id_item_id_key';              -- 0 rows
--   -- the new function is installed (and the POS one is still there):
--   select proname from pg_proc where proname in ('inventory_set_addon_recipe', 'inventory_set_addon_recipe_scopes');              -- 2 rows
--   -- the recipe book's table exists, holds at most one row, and is closed to anon:
--   select count(*) from inventory_recipe_book;                     -- 0 until a seed is applied, never more than 1
--   set role anon; select * from inventory_recipe_book; reset role; -- permission denied
-- ---------------------------------------------------------------------------
