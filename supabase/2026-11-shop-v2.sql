-- ===========================================================================
-- Shop v2 (docs/SHOP-V2-SPEC.md, on top of docs/INSTANT-COFFEE-SHOP.md):
-- Signature Home Blend beside the instant jars, saved delivery addresses,
-- reorder, one-time introductory offer per customer, shop coupons, and Beanies
-- redeemed on shop orders.
--
-- APPLY TO THE SUPABASE PROJECT "Hioc India" ONLY (the café's live database;
-- "Hioc Coffee" is retired, never touch it). The owner applies it, as a launch
-- checklist step, BEFORE the v2 code is deployed. Apply it just before the v2
-- deploy (the v1 shop stays live until then). Do NOT switch the Home Blend packs
-- in stock on the v1 owner page: v1 has no `listed` filter and would sell them at
-- the Rs 1 placeholder. In v2 the owner sets the price, lists them and marks them
-- in stock on /owner/shop. Additive and safe to re-run:
-- every column / table / index is `if not exists`, constraints are guarded by
-- pg_constraint, functions are `create or replace`, seeds are
-- `on conflict do nothing`.
--
-- Shop orders stay OUT of the café's operations. A shipped bag is still not a
-- café order: no counter board, KOT, cash day, café Reports, GST or stock sees
-- it. The only café systems that now see shop orders are Beanies (earn and
-- redeem, via loyalty_transactions.shop_order_id) and the customer's account
-- (shop orders and café orders listed side by side, kept apart by their own
-- tables). Coupons get a `channel` so a café coupon never works online.
--
-- Objects, in dependency order:
--
--   shop_products     + line ('instant' | 'home_blend'), display_name,
--                       pack_grams, ship_weight_kg (what a pack weighs when
--                       shipped, for Shiprocket and the 6 kg cap), listed (the
--                       owner's "show on the shop" switch), requires_grind,
--                       description. Three Home Blend sizes are seeded HIDDEN
--                       (listed = false, price ₹1 placeholder): the owner sets
--                       the real price on /owner/shop and lists them.
--   shop_settings     + shipping_fee_inr, free_shipping_min_inr (replace the
--                       hard-coded ₹49 / free from 3 jars), beanies_max_redeem_pct
--                       (the cap on Beanies as a share of the bill; 5).
--   customer_addresses  A signed-in customer's saved addresses (max 10, one
--                       default). Read and written by the customer through RLS
--                       (own rows only); never by anon. Created before
--                       shop_orders.customer_address_id points at it.
--   shop_orders       + landmark, the discount split (offer / coupon /
--                       beanies, must add up to discount_inr), coupon_*,
--                       intro_offer_applied / intro_offer_reused,
--                       goods_weight_kg (the 6 kg cap), idempotency_key (a
--                       double click or retry returns the same order),
--                       checkout_fingerprint, save_address_label /
--                       customer_address_id (address saved or reused),
--                       capture_effects_at (side effects of payment done
--                       once). Status gains 'expired' (an abandoned payment).
--                       Grind is validated per line by shop_lines_valid().
--   shop_intro_claims One row per customer who has had the introductory
--                       offer, unique on user, phone and lower-cased email, so
--                       a second order with the same phone or email cannot
--                       claim it twice. Service role only.
--   coupons           + channel ('cafe' | 'shop' | 'both'). Every existing
--                       coupon stays café-only.
--   coupon_redemptions  + shop_order_id, phone; order_id becomes nullable;
--                       exactly one of the two order ids is set.
--   loyalty_transactions + shop_order_id; at most one earn, one redeem and one
--                       reverse per shop order.
--
-- Functions (all SECURITY DEFINER ones set search_path and qualify objects;
-- callable by the service role only, except make_customer_address_default,
-- which is SECURITY INVOKER and runs under the caller's own RLS):
--   shop_lines_valid(jsonb)                       grind + quantity check
--   make_customer_address_default(uuid)           swap the default address
--   claim_shop_intro_offer(uuid)                  'claimed'|'already'|'reused'|'not_applicable'
--   release_shop_intro_claim(uuid)                undo a claim (refund / cancel)
--   coupon_usage_counts(uuid, uuid, text)         total and per-customer uses
--   record_shop_coupon_redemption(uuid)           'recorded'|'already'|'over_limit'|'no_coupon'
--   reserve_shop_beanies(uuid, uuid, int, text)   take Beanies for a shop order
--
-- Only the backfills of offer_discount_inr / intro_offer_applied touch
-- existing data.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. shop_products: the Home Blend line.
-- ---------------------------------------------------------------------------
alter table shop_products
  add column if not exists line            text not null default 'instant' check (line in ('instant', 'home_blend')),
  add column if not exists display_name    text not null default '' check (length(display_name) <= 60),
  add column if not exists pack_grams      integer not null default 50 check (pack_grams > 0),
  add column if not exists ship_weight_kg  numeric(5, 3) not null default 0.300 check (ship_weight_kg between 0.01 and 10),
  add column if not exists listed          boolean not null default true,
  add column if not exists requires_grind  boolean not null default false,
  add column if not exists description     text not null default '' check (length(description) <= 160);

-- The three jars show their existing name.
update shop_products set display_name = name where display_name = '';

-- Hidden until the owner sets the price and lists them. price_inr 1 is a
-- placeholder (the column must be > 0); listed = false keeps it off the v2 shop
-- and in_stock = false makes the still-live v1 code (no `listed` filter) refuse
-- them, so nobody can buy coffee at the placeholder price before v2 ships.
insert into shop_products
  (id, name, sku, price_inr, net_qty, in_stock, sort_order,
   line, display_name, pack_grams, ship_weight_kg, listed, requires_grind)
values
  ('home-blend-250', 'Signature Home Blend', 'HIOC-HB-250G', 1, '250 g', false, 11,
   'home_blend', 'Signature Home Blend 250 g', 250, 0.30, false, true),
  ('home-blend-500', 'Signature Home Blend', 'HIOC-HB-500G', 1, '500 g', false, 12,
   'home_blend', 'Signature Home Blend 500 g', 500, 0.55, false, true),
  ('home-blend-1kg', 'Signature Home Blend', 'HIOC-HB-1KG',  1, '1 kg',  false, 13,
   'home_blend', 'Signature Home Blend 1 kg', 1000, 1.10, false, true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. shop_settings: shipping fee, free-shipping threshold, Beanies cap.
-- ---------------------------------------------------------------------------
alter table shop_settings
  add column if not exists shipping_fee_inr       integer not null default 49  check (shipping_fee_inr between 0 and 500),
  add column if not exists free_shipping_min_inr  integer not null default 749 check (free_shipping_min_inr between 0 and 100000),
  add column if not exists beanies_max_redeem_pct integer not null default 5   check (beanies_max_redeem_pct between 0 and 50);

-- ---------------------------------------------------------------------------
-- 3. customer_addresses: saved delivery addresses. Same field rules as
--    shop_orders, so a saved address always makes a valid order.
-- ---------------------------------------------------------------------------
create table if not exists customer_addresses (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  label            text not null default 'Home' check (length(btrim(label)) between 1 and 20),
  customer_name    text not null check (length(btrim(customer_name)) between 2 and 60),
  phone            text not null check (phone ~ '^\+91[6-9][0-9]{9}$'),
  address_line1    text not null check (length(btrim(address_line1)) between 5 and 120),
  address_line2    text not null default '' check (length(address_line2) <= 120),
  landmark         text not null default '' check (length(landmark) <= 80),
  city             text not null check (length(btrim(city)) between 2 and 50),
  state            text not null check (length(btrim(state)) between 2 and 50),
  pincode          text not null check (pincode ~ '^[1-9][0-9]{5}$'),
  location_lat     numeric(9, 6) check (location_lat between 6 and 38),
  location_lng     numeric(9, 6) check (location_lng between 68 and 98),
  location_source  text check (location_source in ('gps', 'map')),
  is_default       boolean not null default false,
  last_used_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One default per customer.
create unique index if not exists customer_addresses_one_default
  on customer_addresses (user_id) where is_default;
create index if not exists customer_addresses_user_recent
  on customer_addresses (user_id, last_used_at desc nulls last);

-- At most 10 saved addresses per customer. The app shows a friendly message
-- for 'customer_addresses_limit'.
create or replace function customer_addresses_limit() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (select count(*) from public.customer_addresses where user_id = new.user_id) >= 10 then
    raise exception 'customer_addresses_limit' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists customer_addresses_limit on customer_addresses;
create trigger customer_addresses_limit
  before insert on customer_addresses
  for each row execute function customer_addresses_limit();

create or replace function customer_addresses_touch() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists customer_addresses_touch on customer_addresses;
create trigger customer_addresses_touch
  before update on customer_addresses
  for each row execute function customer_addresses_touch();

alter table customer_addresses enable row level security;
revoke all on customer_addresses from anon;
grant select, insert, update, delete on customer_addresses to authenticated;

drop policy if exists customer_addresses_select_own on customer_addresses;
create policy customer_addresses_select_own on customer_addresses
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists customer_addresses_insert_own on customer_addresses;
create policy customer_addresses_insert_own on customer_addresses
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists customer_addresses_update_own on customer_addresses;
create policy customer_addresses_update_own on customer_addresses
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists customer_addresses_delete_own on customer_addresses;
create policy customer_addresses_delete_own on customer_addresses
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Make one address the default. SECURITY INVOKER: RLS limits both statements
-- to the caller's own rows. Unsets the others first so the partial unique
-- index is never violated.
create or replace function make_customer_address_default(p_address_id uuid) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.customer_addresses
     set is_default = false
   where user_id = auth.uid() and is_default and id <> p_address_id;

  update public.customer_addresses
     set is_default = true
   where id = p_address_id and user_id = auth.uid();
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end $$;

revoke all on function make_customer_address_default(uuid) from public, anon;
grant execute on function make_customer_address_default(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. shop_orders.
-- ---------------------------------------------------------------------------
alter table shop_orders
  add column if not exists landmark              text not null default '' check (length(landmark) <= 80),
  add column if not exists offer_discount_inr    integer not null default 0 check (offer_discount_inr >= 0),
  add column if not exists coupon_discount_inr   integer not null default 0 check (coupon_discount_inr >= 0),
  add column if not exists beanies_redeemed      integer not null default 0 check (beanies_redeemed >= 0),
  add column if not exists beanies_discount_inr  integer not null default 0 check (beanies_discount_inr >= 0),
  add column if not exists coupon_id             uuid references coupons(id) on delete set null,
  add column if not exists coupon_code           text check (length(coupon_code) <= 40),
  add column if not exists intro_offer_applied   boolean not null default false,
  add column if not exists intro_offer_reused    boolean not null default false,
  add column if not exists goods_weight_kg       numeric(6, 3) check (goods_weight_kg is null or goods_weight_kg <= 6),
  add column if not exists idempotency_key       uuid,
  add column if not exists checkout_fingerprint  text,
  add column if not exists save_address_label    text check (save_address_label is null or length(btrim(save_address_label)) between 1 and 20),
  add column if not exists customer_address_id   uuid references customer_addresses(id) on delete set null,
  add column if not exists capture_effects_at    timestamptz;

-- Backfill BEFORE the add-up constraint below: until now the whole discount was
-- the introductory offer.
update shop_orders
   set offer_discount_inr = discount_inr
 where offer_discount_inr = 0 and coupon_discount_inr = 0 and beanies_discount_inr = 0
   and discount_inr > 0;
update shop_orders
   set intro_offer_applied = true
 where offer_name is not null and discount_inr > 0 and not intro_offer_applied;

-- Keeps the v1 checkout working between applying this SQL and deploying v2:
-- v1 inserts only discount_inr (+ offer_name), which would break
-- shop_orders_discounts_add_up. A v1-style row (a discount but no split) is
-- read as the introductory offer. v2 always sends the split, so this never
-- fires for it.
create or replace function shop_orders_legacy_discount() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.discount_inr > 0
     and new.offer_discount_inr + new.coupon_discount_inr + new.beanies_discount_inr = 0 then
    new.offer_discount_inr := new.discount_inr;
    new.intro_offer_applied := (new.offer_name is not null);
  end if;
  return new;
end $$;

drop trigger if exists shop_orders_legacy_discount on shop_orders;
create trigger shop_orders_legacy_discount
  before insert on shop_orders
  for each row execute function shop_orders_legacy_discount();

-- Grind and quantity on every line. Immutable so it can sit in a CHECK. Lines
-- without a grind (the jars) are fine.
create or replace function shop_lines_valid(p_lines jsonb) returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_lines is null or jsonb_typeof(p_lines) <> 'array' then false
    else not exists (
      select 1
        from jsonb_array_elements(p_lines) as e(line)
       where jsonb_typeof(e.line) <> 'object'
          or not (
               coalesce(e.line -> 'grind', 'null'::jsonb) = 'null'::jsonb
               or e.line ->> 'grind' in ('whole_bean', 'espresso', 'moka', 'filter', 'french_press')
             )
          or jsonb_typeof(e.line -> 'quantity') is distinct from 'number'
          or case when jsonb_typeof(e.line -> 'quantity') = 'number'
                  then not ((e.line ->> 'quantity')::numeric > 0
                            and (e.line ->> 'quantity')::numeric = trunc((e.line ->> 'quantity')::numeric))
                  else true end
    )
  end
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_discounts_add_up') then
    alter table shop_orders
      add constraint shop_orders_discounts_add_up
      check (discount_inr = offer_discount_inr + coupon_discount_inr + beanies_discount_inr);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_units_max') then
    alter table shop_orders add constraint shop_orders_units_max check (jar_count <= 12);
  end if;
  -- Hard 50% ceiling on Beanies. The 5% cap itself lives in
  -- shop_settings.beanies_max_redeem_pct and the TypeScript pricing.
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_beanies_ceiling') then
    alter table shop_orders
      add constraint shop_orders_beanies_ceiling
      check (beanies_discount_inr * 100 <= greatest(subtotal_inr - offer_discount_inr - coupon_discount_inr, 0) * 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_lines_valid') then
    alter table shop_orders add constraint shop_orders_lines_valid check (shop_lines_valid(lines));
  end if;
end $$;
-- shop_orders_total_adds_up (subtotal - discount + shipping) is kept as is.

-- Status gains 'expired' (a payment_pending order nobody paid for).
alter table shop_orders drop constraint if exists shop_orders_status_check;
alter table shop_orders
  add constraint shop_orders_status_check
  check (status in ('payment_pending', 'paid', 'sent_to_shiprocket', 'shipped', 'delivered', 'cancelled', 'expired'));

-- A retry or double click with the same key finds the same order.
create unique index if not exists shop_orders_idempotency_key
  on shop_orders (idempotency_key) where idempotency_key is not null;
create index if not exists shop_orders_user_created on shop_orders (user_id, created_at desc);
create index if not exists shop_orders_phone on shop_orders (phone);
create index if not exists shop_orders_email_lower on shop_orders (lower(email));
-- The sweeper that expires abandoned payments only looks at these.
create index if not exists shop_orders_pending_created
  on shop_orders (created_at) where status = 'payment_pending';

-- ---------------------------------------------------------------------------
-- 5. shop_intro_claims: the introductory offer, once per customer.
-- ---------------------------------------------------------------------------
create table if not exists shop_intro_claims (
  shop_order_id  uuid primary key references shop_orders(id) on delete cascade,
  user_id        uuid unique references auth.users(id) on delete set null,
  phone          text not null unique,
  email          text not null unique,   -- stored lower-cased
  created_at     timestamptz not null default now()
);

alter table shop_intro_claims enable row level security;
revoke all on shop_intro_claims from anon, authenticated;

-- Called once the order is paid. 'claimed' = this order took the offer;
-- 'reused' = the same customer (user, phone or email) had already had it (two
-- tabs raced past the checkout check): the order is honoured and flagged
-- intro_offer_reused for the owner; 'already' = this order was claimed before
-- (webhook and poll both ran); 'not_applicable' = no offer on the order or not
-- paid.
create or replace function claim_shop_intro_offer(p_shop_order_id uuid) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.shop_orders%rowtype;
  v_rows  integer;
begin
  select * into v_order from public.shop_orders where id = p_shop_order_id;
  if not found
     or not v_order.intro_offer_applied
     or v_order.status not in ('paid', 'sent_to_shiprocket', 'shipped', 'delivered') then
    return 'not_applicable';
  end if;

  if exists (select 1 from public.shop_intro_claims where shop_order_id = p_shop_order_id) then
    return 'already';
  end if;

  insert into public.shop_intro_claims (shop_order_id, user_id, phone, email)
  values (v_order.id, v_order.user_id, v_order.phone, lower(v_order.email))
  on conflict do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    -- Webhook and poll racing on the SAME order: the other insert has now
    -- committed, and this new statement sees it (READ COMMITTED). Not a reuse.
    if exists (select 1 from public.shop_intro_claims where shop_order_id = p_shop_order_id) then
      return 'already';
    end if;
    update public.shop_orders set intro_offer_reused = true where id = p_shop_order_id;
    return 'reused';
  end if;
  return 'claimed';
end $$;

-- Cancelled or refunded: the customer gets their one introductory offer back.
create or replace function release_shop_intro_claim(p_shop_order_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.shop_intro_claims where shop_order_id = p_shop_order_id;
end $$;

revoke all on function claim_shop_intro_offer(uuid) from public, anon, authenticated;
revoke all on function release_shop_intro_claim(uuid) from public, anon, authenticated;
grant execute on function claim_shop_intro_offer(uuid) to service_role;
grant execute on function release_shop_intro_claim(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. coupons: which channel a coupon works on. Existing coupons stay café-only.
-- ---------------------------------------------------------------------------
alter table coupons
  add column if not exists channel text not null default 'cafe' check (channel in ('cafe', 'shop', 'both'));

-- ---------------------------------------------------------------------------
-- 7. coupon_redemptions: shop redemptions beside café ones. Guests have no
--    user_id, so a shop redemption also keeps the phone.
-- ---------------------------------------------------------------------------
alter table coupon_redemptions
  add column if not exists shop_order_id uuid references shop_orders(id) on delete cascade,
  add column if not exists phone text;
alter table coupon_redemptions alter column order_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'coupon_redemptions_one_order') then
    alter table coupon_redemptions
      add constraint coupon_redemptions_one_order check (num_nonnulls(order_id, shop_order_id) = 1);
  end if;
end $$;

create unique index if not exists coupon_redemptions_coupon_shop_order
  on coupon_redemptions (coupon_id, shop_order_id) where shop_order_id is not null;
create index if not exists coupon_redemptions_shop_order
  on coupon_redemptions (shop_order_id) where shop_order_id is not null;

-- How many times a coupon has been used: café redemptions on orders that were
-- not cancelled or rejected, plus shop redemptions on paid orders.
-- mine_used is this customer's: by account when signed in, else by phone.
create or replace function coupon_usage_counts(p_coupon_id uuid, p_user_id uuid, p_phone text)
returns table (total_used integer, mine_used integer)
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer,
         (count(*) filter (where case when p_user_id is not null
                                      then u.user_id = p_user_id
                                      else u.phone is not null and u.phone = p_phone end))::integer
    from (
      select cr.user_id, cr.phone
        from public.coupon_redemptions cr
        join public.orders o on o.id = cr.order_id
       where cr.coupon_id = p_coupon_id
         and o.status not in ('cancelled', 'rejected')
      union all
      select cr.user_id, cr.phone
        from public.coupon_redemptions cr
        join public.shop_orders so on so.id = cr.shop_order_id
       where cr.coupon_id = p_coupon_id
         and so.status in ('paid', 'sent_to_shiprocket', 'shipped', 'delivered')
    ) u
$$;

-- Must be called AFTER the order is marked paid, otherwise coupon_usage_counts
-- leaves out this redemption and under-reports 'over_limit'. Takes the café's
-- per-coupon lock so two orders capturing at once count accurately.
-- The row is kept even when 'over_limit': the
-- money was taken, so the order is honoured and the owner sees the overrun.
create or replace function record_shop_coupon_redemption(p_shop_order_id uuid) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  public.shop_orders%rowtype;
  v_coupon public.coupons%rowtype;
  v_rows   integer;
  v_total  integer;
  v_mine   integer;
begin
  select * into v_order from public.shop_orders where id = p_shop_order_id;
  if not found or v_order.coupon_id is null then
    return 'no_coupon';
  end if;

  perform pg_advisory_xact_lock(hashtext('coupon:' || v_order.coupon_id::text));

  insert into public.coupon_redemptions (coupon_id, shop_order_id, user_id, phone, discount_inr)
  values (v_order.coupon_id, v_order.id, v_order.user_id, v_order.phone, v_order.coupon_discount_inr)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 'already';
  end if;

  select * into v_coupon from public.coupons where id = v_order.coupon_id;
  if not found then
    return 'recorded';
  end if;

  select c.total_used, c.mine_used into v_total, v_mine
    from public.coupon_usage_counts(v_order.coupon_id, v_order.user_id, v_order.phone) c;

  if (v_coupon.usage_limit > 0 and v_total > v_coupon.usage_limit)
     or (v_coupon.per_user_limit > 0 and v_mine > v_coupon.per_user_limit) then
    return 'over_limit';
  end if;
  return 'recorded';
end $$;

revoke all on function coupon_usage_counts(uuid, uuid, text) from public, anon, authenticated;
revoke all on function record_shop_coupon_redemption(uuid) from public, anon, authenticated;
grant execute on function coupon_usage_counts(uuid, uuid, text) to service_role;
grant execute on function record_shop_coupon_redemption(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. loyalty_transactions: Beanies on shop orders.
-- ---------------------------------------------------------------------------
alter table loyalty_transactions
  add column if not exists shop_order_id uuid references shop_orders(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loyalty_tx_one_order') then
    alter table loyalty_transactions
      add constraint loyalty_tx_one_order check (order_id is null or shop_order_id is null);
  end if;
end $$;

-- One earn, one redeem, one reverse per shop order: a retry cannot pay twice.
create unique index if not exists loyalty_tx_shop_order_type
  on loyalty_transactions (shop_order_id, type) where shop_order_id is not null;
create index if not exists loyalty_tx_shop_order
  on loyalty_transactions (shop_order_id) where shop_order_id is not null;

-- Take Beanies for a shop order before the payment window opens. The advisory
-- lock is the café's own ('loyalty:' || user_id, as in try_redeem_points in
-- phase2-hardening.sql), so it serialises ALL of a customer's spends, café and
-- shop: a café checkout and a shop checkout cannot both pass the balance check
-- and spend the same Beanies twice.
create or replace function reserve_shop_beanies(
  p_user_id uuid, p_shop_order_id uuid, p_points integer, p_note text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if p_points is null or p_points <= 0 then
    raise exception 'reserve_shop_beanies: p_points must be > 0';
  end if;

  perform pg_advisory_xact_lock(hashtext('loyalty:' || p_user_id::text));

  if exists (select 1 from public.loyalty_transactions
              where shop_order_id = p_shop_order_id and type = 'redeem') then
    return 'already_reserved';
  end if;

  select coalesce(sum(points), 0) into v_balance
    from public.loyalty_transactions where user_id = p_user_id;
  if v_balance < p_points then
    return 'insufficient';
  end if;

  insert into public.loyalty_transactions (user_id, shop_order_id, type, points, note)
  values (p_user_id, p_shop_order_id, 'redeem', -p_points, coalesce(p_note, ''));
  return 'reserved';
end $$;

revoke all on function reserve_shop_beanies(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function reserve_shop_beanies(uuid, uuid, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- Verify (read-only; run on "Hioc India"):
--   select id, display_name, line, pack_grams, ship_weight_kg, listed, in_stock, requires_grind
--     from shop_products order by sort_order;
--   -- expect the 3 jars (line instant, listed) + home-blend-250/500/1kg (home_blend, listed false, in_stock false)
--   select shipping_fee_inr, free_shipping_min_inr, beanies_max_redeem_pct from shop_settings;
--   -- expect 49 / 749 / 5
--   select count(*) from shop_orders where discount_inr <> offer_discount_inr + coupon_discount_inr + beanies_discount_inr;
--   -- expect 0
--   select conname from pg_constraint where conname in
--     ('shop_orders_discounts_add_up','shop_orders_units_max','shop_orders_beanies_ceiling',
--      'shop_orders_lines_valid','coupon_redemptions_one_order','loyalty_tx_one_order');
--   -- expect 6 rows
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'shop_orders_status_check';
--   -- expect the list to include 'expired'
--   select relname, relrowsecurity from pg_class
--     where relname in ('customer_addresses','shop_intro_claims');
--   -- expect both true
--   select count(*) from coupons where channel <> 'cafe';
--   -- expect 0 until the owner makes a shop coupon
--   select proname, prosecdef from pg_proc where proname in
--     ('claim_shop_intro_offer','release_shop_intro_claim','coupon_usage_counts',
--      'record_shop_coupon_redemption','reserve_shop_beanies','make_customer_address_default',
--      'shop_lines_valid');
--   -- expect 7 rows; prosecdef true for all but make_customer_address_default and shop_lines_valid
--   select * from coupon_usage_counts('00000000-0000-0000-0000-000000000000', null, null);
--   -- expect one row: 0 / 0
-- ---------------------------------------------------------------------------
