-- Applied 2026-11-03 to Hioc Coffee (migration 2026_11_pos_latency_indexes_rls);
-- carried to Hioc India by the Mumbai migration dump.
create extension if not exists pg_trgm with schema extensions;

create index if not exists idx_legacy_customers_phone_prefix on public.legacy_customers (phone text_pattern_ops);
create index if not exists idx_profiles_phone_prefix on public.profiles (phone text_pattern_ops);
create index if not exists idx_orders_customer_phone_prefix on public.orders (customer_phone text_pattern_ops);
create index if not exists idx_legacy_customers_name_trgm on public.legacy_customers using gin (name extensions.gin_trgm_ops);
create index if not exists idx_profiles_name_trgm on public.profiles using gin (name extensions.gin_trgm_ops);
create index if not exists idx_orders_customer_name_trgm on public.orders using gin (customer_name extensions.gin_trgm_ops);
create index if not exists idx_legacy_customers_last_order on public.legacy_customers (last_order_at desc nulls last);

create index if not exists idx_order_items_menu_item on public.order_items (menu_item_id);
create index if not exists idx_order_items_variant on public.order_items (variant_id);
create index if not exists idx_order_item_addons_option on public.order_item_addons (addon_option_id);
create index if not exists idx_menu_item_addon_groups_group on public.menu_item_addon_groups (addon_group_id);
create index if not exists idx_loyalty_tx_order on public.loyalty_transactions (order_id);
create index if not exists idx_coupon_redemptions_order on public.coupon_redemptions (order_id);
create index if not exists idx_cash_drawer_opens_order on public.cash_drawer_opens (order_id);
create index if not exists idx_idempotency_keys_order on public.idempotency_keys (order_id);

alter policy attendance_day_marks_read_own on public.attendance_day_marks using ((select auth.uid()) = user_id);
alter policy attendance_attempts_read_own on public.attendance_punch_attempts using ((select auth.uid()) = user_id);
alter policy attendance_sessions_read_own on public.attendance_sessions using ((select auth.uid()) = user_id);
alter policy taste_profiles_own_read on public.customer_taste_profiles using ((select auth.uid()) = user_id);
alter policy favorites_own_delete on public.favorites using ((select auth.uid()) = user_id);
alter policy favorites_own_insert on public.favorites with check ((select auth.uid()) = user_id);
alter policy favorites_own_read on public.favorites using ((select auth.uid()) = user_id);
alter policy leave_requests_read_own on public.leave_requests using ((select auth.uid()) = user_id);
alter policy loyalty_accounts_own_read on public.loyalty_accounts using ((select auth.uid()) = user_id);
alter policy loyalty_tx_own_read on public.loyalty_transactions using ((select auth.uid()) = user_id);
alter policy profiles_select_own on public.profiles using ((select auth.uid()) = id);
alter policy reviews_own_insert on public.reviews with check ((select auth.uid()) = user_id);
alter policy reviews_own_read on public.reviews using ((select auth.uid()) = user_id);
