-- Add-on changes need the owner's approval too (owner request, 2026-10-22).
--
-- Add-on groups ("Choice of Milk") and their options ("Oat milk +₹40") could
-- only be changed in the database. Staff can now create an add-on group and edit
-- one (its name, its pick-one / pick-several rule, its options and their prices)
-- from POS → Menu → Add-ons. Like a menu item change
-- (2026-10-menu-change-requests.sql), a staff member's or manager's change is a
-- PENDING request the owner approves or rejects in the owner app; the owner's
-- own change applies at once. Switching an option off or on (POS → Menu →
-- On / off) stays instant, as before.
--
--   menu_change_requests.target          'menu_item' (every existing row) or
--                                        'addon_group'. One table, so the owner
--                                        decides everything in one inbox and the
--                                        pending counts already include add-ons.
--   menu_change_requests.addon_group_id  the group an add-on update is about
--                                        (set on a create once approved); goes
--                                        null if the group is later deleted.
--                                        item_name keeps the row readable.
--   add-on write policies                addon_groups / addon_options were
--                                        writable by any is_staff() session
--                                        through PostgREST, which would let a
--                                        staff member walk around the approval.
--                                        They are now owner-only, as the menu
--                                        item tables already are. The app writes
--                                        with the service-role key, which
--                                        bypasses RLS: the on/off switch and the
--                                        Coffey add-on traits keep working.
--
-- An add-on request is a create or an update: add-on groups and options are
-- never deleted from the app, because past orders, stock recipes and Coffey
-- traits point at option ids. An option the café stops offering is switched off.
--
-- Idempotent: safe to re-run. Menu item requests and the owner's own add-on
-- edits work before this is applied; a staff add-on change answers 409 until it
-- is.
-- ===========================================================================

alter table public.menu_change_requests
  add column if not exists target text not null default 'menu_item';

alter table public.menu_change_requests
  add column if not exists addon_group_id uuid references public.addon_groups(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'menu_change_requests_target_check'
      and conrelid = 'public.menu_change_requests'::regclass
  ) then
    alter table public.menu_change_requests
      add constraint menu_change_requests_target_check
      check (target in ('menu_item', 'addon_group'));
  end if;

  -- An item request never names an add-on group; an add-on request never names
  -- a menu item and is only ever a create or an update.
  if not exists (
    select 1 from pg_constraint
    where conname = 'menu_change_requests_target_shape'
      and conrelid = 'public.menu_change_requests'::regclass
  ) then
    alter table public.menu_change_requests
      add constraint menu_change_requests_target_shape
      check (
        (target = 'menu_item' and addon_group_id is null)
        or (target = 'addon_group' and menu_item_id is null and action in ('create', 'update'))
      );
  end if;
end $$;

create index if not exists menu_change_requests_pending_addon_group
  on public.menu_change_requests (addon_group_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Direct add-on writes: is_staff() -> is_owner() (is_owner() comes from
-- 2026-10-menu-change-requests.sql). Public READ policies stay. The old
-- *_staff_* policies are dropped and owner-only ones created under *_owner_*
-- names, as for the menu item tables.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['addon_groups', 'addon_options'] loop
    execute format('drop policy if exists %I on public.%I', t || '_staff_write', t);
    execute format('drop policy if exists %I on public.%I', t || '_staff_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_staff_delete', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_write', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_delete', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_owner())', t || '_owner_write', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_owner()) with check (public.is_owner())', t || '_owner_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_owner())', t || '_owner_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Verify:
--   select target, count(*) from menu_change_requests group by target;  -- all 'menu_item' at first
--   select policyname, cmd from pg_policies
--    where tablename in ('addon_groups', 'addon_options') order by tablename, cmd;
--                                              -- writes *_owner_*, reads *_public_read
-- ---------------------------------------------------------------------------
