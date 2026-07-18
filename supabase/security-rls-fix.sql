-- HIOC — SECURITY FIX for QA-REPORT finding C1 (CRITICAL).
-- Run this ONCE in the Supabase SQL editor AFTER phase1 + phase2 migrations.
-- Idempotent (drop-if-exists + create). Safe to re-run.
--
-- PROBLEM: every "staff/owner" RLS policy was written `to authenticated using
-- (true)`. In Supabase `authenticated` = ANY valid session, not a role. Phase-2
-- phone-OTP login gives every CUSTOMER a real authenticated JWT, so customers
-- could call PostgREST directly with the public anon key and bypass all the
-- app's route guards — reading every order/payment, hijacking/updating orders,
-- inserting 100%-off coupons, rewriting global loyalty rates, tampering the
-- menu, editing reviews, etc.
--
-- FIX: gate every privileged policy behind is_staff() (role in staff/manager/
-- owner), and DROP the blanket UPDATE grant on orders (all order writes go
-- through the server on the service-role key, which bypasses RLS anyway).
-- Public reads that the customer site genuinely needs (menu, store hours,
-- announcements, loyalty rates) stay public. Per-user policies (favorites,
-- loyalty balance/ledger, own reviews) were already correct and are untouched.

-- ---------------------------------------------------------------------------
-- Role helper. SECURITY DEFINER so it can read the caller's own profile row
-- regardless of RLS, and only ever checks the CURRENT user's role (no leak).
-- ---------------------------------------------------------------------------
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('staff', 'manager', 'owner')
  );
$$;

grant execute on function public.is_staff() to authenticated, anon;

-- ===========================================================================
-- MENU catalog — keep PUBLIC read; gate writes to staff.  (schema.sql)
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['menu_items','menu_item_variants','addon_groups','addon_options'] loop
    execute format('drop policy if exists %I on %I', t||'_staff_write', t);
    execute format('create policy %I on %I for insert to authenticated with check (public.is_staff())', t||'_staff_write', t);
    execute format('drop policy if exists %I on %I', t||'_staff_update', t);
    execute format('create policy %I on %I for update to authenticated using (public.is_staff()) with check (public.is_staff())', t||'_staff_update', t);
    execute format('drop policy if exists %I on %I', t||'_staff_delete', t);
    execute format('create policy %I on %I for delete to authenticated using (public.is_staff())', t||'_staff_delete', t);
  end loop;
end $$;

drop policy if exists menu_item_addon_groups_staff_write on menu_item_addon_groups;
create policy menu_item_addon_groups_staff_write on menu_item_addon_groups for insert to authenticated with check (public.is_staff());
drop policy if exists menu_item_addon_groups_staff_delete on menu_item_addon_groups;
create policy menu_item_addon_groups_staff_delete on menu_item_addon_groups for delete to authenticated using (public.is_staff());

-- ===========================================================================
-- ORDERS — staff-only READ (needed for the staff board's realtime); NO client
-- UPDATE at all (this was the order-hijack hole).  (schema.sql)
-- ===========================================================================
drop policy if exists orders_staff_read on orders;
create policy orders_staff_read on orders for select to authenticated using (public.is_staff());
-- Intentionally NOT recreated: all order writes go through server routes on the
-- service-role key. A customer must never UPDATE orders directly.
drop policy if exists orders_staff_update on orders;

drop policy if exists order_items_staff_read on order_items;
create policy order_items_staff_read on order_items for select to authenticated using (public.is_staff());
drop policy if exists order_item_addons_staff_read on order_item_addons;
create policy order_item_addons_staff_read on order_item_addons for select to authenticated using (public.is_staff());

-- ===========================================================================
-- Phase-1 additions.  (phase1-migration.sql)
-- ===========================================================================
drop policy if exists order_status_events_staff_read on order_status_events;
create policy order_status_events_staff_read on order_status_events for select to authenticated using (public.is_staff());

drop policy if exists notifications_staff_read on notifications;
create policy notifications_staff_read on notifications for select to authenticated using (public.is_staff());

-- store_settings: keep public read (customer site needs hours/tax); gate write.
drop policy if exists store_settings_staff_write on store_settings;
create policy store_settings_staff_write on store_settings for update to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists role_change_audit_owner_read on role_change_audit;
create policy role_change_audit_owner_read on role_change_audit for select to authenticated using (public.is_staff());

-- ===========================================================================
-- Phase-2 additions.  (phase2-migration.sql)
-- ===========================================================================
-- payments / refunds — staff-only read; no client write (service role only).
drop policy if exists payments_staff_read on payments;
create policy payments_staff_read on payments for select to authenticated using (public.is_staff());
drop policy if exists refunds_staff_read on refunds;
create policy refunds_staff_read on refunds for select to authenticated using (public.is_staff());

-- coupons — staff-only read + write (server validates on the service role).
drop policy if exists coupons_staff_read on coupons;
create policy coupons_staff_read on coupons for select to authenticated using (public.is_staff());
drop policy if exists coupons_staff_write on coupons;
create policy coupons_staff_write on coupons for insert to authenticated with check (public.is_staff());
drop policy if exists coupons_staff_update on coupons;
create policy coupons_staff_update on coupons for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists coupon_redemptions_staff_read on coupon_redemptions;
create policy coupon_redemptions_staff_read on coupon_redemptions for select to authenticated using (public.is_staff());

-- announcements — keep public read (homepage banners); gate writes.
drop policy if exists announcements_staff_write on announcements;
create policy announcements_staff_write on announcements for insert to authenticated with check (public.is_staff());
drop policy if exists announcements_staff_update on announcements;
create policy announcements_staff_update on announcements for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- loyalty_config — keep public read (customer UI shows rates); gate write.
drop policy if exists loyalty_config_staff_write on loyalty_config;
create policy loyalty_config_staff_write on loyalty_config for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- reviews — customer reads only their OWN (the old policy's `or auth.uid() is
-- not null` made it world-readable); staff moderation gated to staff.
drop policy if exists reviews_own_read on reviews;
create policy reviews_own_read on reviews for select to authenticated using (auth.uid() = user_id);
drop policy if exists reviews_staff_update on reviews;
create policy reviews_staff_update on reviews for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- ===========================================================================
-- END. After running, a customer session hitting PostgREST directly can no
-- longer read/write staff data; the server routes (service role) are unaffected.
-- Verify: as a customer JWT, `select * from orders` / `insert into coupons ...`
-- should return 0 rows / permission denied.
-- ===========================================================================
