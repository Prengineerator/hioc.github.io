-- Menu changes need the owner's approval (owner request, 2026-10-19).
--
-- Until now anyone with the 'menu_edit' permission could create, edit or delete
-- a menu item straight from the POS. From now on a staff member's or manager's
-- create / edit / delete is stored here as a PENDING request and the owner
-- approves or rejects it from the owner app. The owner's own edits (POS or
-- owner app) still apply at once. Sold-out / snooze toggles, add-on option
-- toggles, category and size switches and recipes are NOT requests — they keep
-- changing the menu instantly.
--
--   menu_change_requests  one row per request. `payload` holds the proposed
--                         values (every field for a create, only the fields that
--                         differ for an update, null for a delete); `snapshot`
--                         holds the item's full values when the request was made,
--                         so the owner sees before / after even if the item has
--                         moved on. menu_item_id goes null if the item is later
--                         deleted; item_name keeps the row readable.
--   is_owner()            like is_staff() (security-rls-fix.sql) for role 'owner'.
--   menu write policies   menu_items, menu_item_variants and
--                         menu_item_addon_groups were writable by any is_staff()
--                         session through PostgREST, which would let a staff
--                         member walk straight around the approval. They are now
--                         owner-only. The app writes with the service-role key,
--                         which bypasses RLS, so no route changes behaviour.
--                         addon_groups / addon_options / store_settings are left
--                         alone (add-on toggles stay instant).
--
-- Idempotent: safe to re-run. Apply BEFORE deploying the code — the menu routes
-- answer 409 until the table exists (a staff edit is never applied silently).

create table if not exists public.menu_change_requests (
  id                uuid primary key default gen_random_uuid(),
  action            text not null check (action in ('create', 'update', 'delete')),
  menu_item_id      uuid references public.menu_items(id) on delete set null,
  item_name         text not null default '',
  payload           jsonb,
  snapshot          jsonb,
  status            text not null default 'pending'
                      check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by      uuid references public.profiles(id) on delete set null,
  requested_by_name text,
  requested_at      timestamptz not null default now(),
  decided_by        uuid references public.profiles(id) on delete set null,
  decided_at        timestamptz,
  decision_note     text,
  -- A create or update always carries its proposed values; only a delete is bare.
  constraint menu_change_requests_payload_present
    check (action = 'delete' or payload is not null),
  -- Nobody has decided a pending request (an approval that fails to apply is put
  -- back to pending with these cleared).
  constraint menu_change_requests_pending_undecided
    check (status <> 'pending' or (decided_by is null and decided_at is null))
);

create index if not exists menu_change_requests_status_requested
  on public.menu_change_requests (status, requested_at desc);

create index if not exists menu_change_requests_pending_item
  on public.menu_change_requests (menu_item_id) where status = 'pending';

-- Service-role only: the routes (staff and owner) use the admin client.
alter table public.menu_change_requests enable row level security;
revoke all on public.menu_change_requests from anon, authenticated;

-- ---------------------------------------------------------------------------
-- is_owner() — mirrors is_staff(): SECURITY DEFINER so it can read the caller's
-- own profile row regardless of RLS, and only ever checks the CURRENT user.
-- Grants as 2026-09-security-advisor-fixes.sql 2c gave is_staff(): policies run
-- it as `authenticated`; anon never needed it.
-- ---------------------------------------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner'
  );
$$;

revoke execute on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Direct menu writes: is_staff() -> is_owner(). Public READ policies stay.
-- The old *_staff_* policies are dropped and the owner-only ones are created
-- under *_owner_* names, so pg_policies says what each one is. Do not re-run
-- security-rls-fix.sql after this: it would put the *_staff_* ones back.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['menu_items', 'menu_item_variants'] loop
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

-- The add-on link table never had an update policy: a link is added or removed.
drop policy if exists menu_item_addon_groups_staff_write on public.menu_item_addon_groups;
drop policy if exists menu_item_addon_groups_staff_delete on public.menu_item_addon_groups;
drop policy if exists menu_item_addon_groups_owner_write on public.menu_item_addon_groups;
drop policy if exists menu_item_addon_groups_owner_delete on public.menu_item_addon_groups;
create policy menu_item_addon_groups_owner_write on public.menu_item_addon_groups
  for insert to authenticated with check (public.is_owner());
create policy menu_item_addon_groups_owner_delete on public.menu_item_addon_groups
  for delete to authenticated using (public.is_owner());

-- ---------------------------------------------------------------------------
-- Verify:
--   select policyname, cmd from pg_policies
--    where tablename in ('menu_items', 'menu_item_variants', 'menu_item_addon_groups')
--    order by tablename, cmd;                 -- writes now *_owner_*, reads *_public_read
--   select has_table_privilege('authenticated', 'public.menu_change_requests', 'select');  -- false
-- ---------------------------------------------------------------------------
