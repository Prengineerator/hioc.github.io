-- ===========================================================================
-- Shop orders added by the owner (docs/SHOP-OWNER-ORDERS-SPEC.md).
--
-- When a customer phones or WhatsApps, the owner adds a shipped shop order by
-- hand on /owner/shop. It is paid either by a Razorpay payment link (the order
-- waits as payment_pending until paid; the link expires after 48 hours) or
-- "already paid" offline (UPI straight to the café, cash or bank transfer, with
-- a reference). Pricing is the website's, plus an optional owner discount with a
-- reason, capped at 50% of the goods after offers. Email is optional.
--
-- APPLY TO THE SUPABASE PROJECT "Hioc India" ONLY (the café's live database;
-- "Hioc Coffee" is retired, never touch it). The owner's developer applies it in
-- Supabase -> SQL editor. Additive and safe to re-run. Either order with the
-- code is safe: the new code treats the new columns as absent until this is
-- applied, and the previous build keeps working on this schema (every new column
-- has a default, nothing is dropped or renamed, old checkout rows still pass).
--
-- What it adds on shop_orders:
--   source                   'web' (checkout, the default) | 'owner'
--   created_by               the owner's auth user, for owner-added orders
--   payment_channel          'checkout' (default) | 'payment_link' | 'offline'
--   offline_method           'upi_direct' | 'cash' | 'bank_transfer'; only for
--                            payment_channel = 'offline'
--   payment_reference        3-60 characters, required for offline payments
--   owner_discount_inr       the owner's own discount, whole rupees
--   owner_discount_reason    why (3-80 characters when a discount is given)
--   razorpay_payment_link_id, payment_link_url, payment_link_expires_at
--                            the Razorpay payment link; all three set when
--                            payment_channel = 'payment_link' and the order is
--                            paid, sent, shipped or delivered (an unpaid,
--                            expired or cancelled link order may lack them)
-- Constraints:
--   shop_orders_offline_method_pairing, shop_orders_offline_reference_required,
--   shop_orders_owner_discount_reason, shop_orders_owner_discount_ceiling (50%),
--   shop_orders_payment_link_fields, shop_orders_email_optional (email may be ''
--   meaning "no email", else 3-254 characters; the column stays NOT NULL),
--   shop_orders_discounts_add_up (replaced: now also counts owner_discount_inr).
-- Functions (re-created with create or replace, grants unchanged):
--   shop_orders_legacy_discount()   its "no split given" test counts the owner
--                                   discount too
--   claim_shop_intro_offer(uuid)    stores a missing email as NULL
-- shop_intro_claims.email becomes nullable (several customers can have no
-- email; a unique column allows many NULLs but not many '').
-- Indexes: shop_orders (source, created_at desc); a partial index over payment
-- links still waiting to be paid; a unique partial index on the link id.
--
-- No new RLS: shop_orders and shop_intro_claims are already service-role only
-- and nothing is granted to anon or authenticated.
--
-- What the owner will see once applied: nothing changes by itself. Existing rows
-- become source 'web', payment_channel 'checkout', owner discount 0. The "add an
-- order" form on /owner/shop works once the code is deployed.
--
-- Only existing-row effect: none beyond the column defaults above (no data fix).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------
alter table shop_orders
  add column if not exists source                    text not null default 'web' check (source in ('web', 'owner')),
  add column if not exists created_by                uuid references auth.users(id) on delete set null,
  add column if not exists payment_channel           text not null default 'checkout' check (payment_channel in ('checkout', 'payment_link', 'offline')),
  add column if not exists offline_method            text check (offline_method in ('upi_direct', 'cash', 'bank_transfer')),
  add column if not exists payment_reference         text check (payment_reference is null or length(btrim(payment_reference)) between 3 and 60),
  add column if not exists owner_discount_inr        integer not null default 0 check (owner_discount_inr >= 0),
  add column if not exists owner_discount_reason     text not null default '' check (length(owner_discount_reason) <= 80),
  add column if not exists razorpay_payment_link_id  text,
  add column if not exists payment_link_url          text,
  add column if not exists payment_link_expires_at   timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Legacy-discount trigger: an owner discount counts as "a split was given".
--    (Same function, same trigger; only the test changes.)
-- ---------------------------------------------------------------------------
create or replace function shop_orders_legacy_discount() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.discount_inr > 0
     and new.offer_discount_inr + new.coupon_discount_inr + new.beanies_discount_inr + new.owner_discount_inr = 0 then
    new.offer_discount_inr := new.discount_inr;
    new.intro_offer_applied := (new.offer_name is not null);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Constraints. Existing rows all pass: source 'web', channel 'checkout',
--    owner discount 0, no offline method, no reference, no link.
-- ---------------------------------------------------------------------------
do $$
declare
  v_email_attnum smallint;
  v_old          record;
begin
  -- The discounts must add up, now including the owner's. Replace the old
  -- three-way check only if it does not mention owner_discount_inr yet.
  if exists (select 1 from pg_constraint
              where conname = 'shop_orders_discounts_add_up'
                and conrelid = 'public.shop_orders'::regclass
                and pg_get_constraintdef(oid) not like '%owner_discount_inr%') then
    alter table shop_orders drop constraint shop_orders_discounts_add_up;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'shop_orders_discounts_add_up'
                    and conrelid = 'public.shop_orders'::regclass) then
    alter table shop_orders
      add constraint shop_orders_discounts_add_up
      check (discount_inr = offer_discount_inr + coupon_discount_inr + beanies_discount_inr + owner_discount_inr);
  end if;

  -- offline_method is set exactly when the order was paid offline.
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_offline_method_pairing'
                  and conrelid = 'public.shop_orders'::regclass) then
    alter table shop_orders
      add constraint shop_orders_offline_method_pairing
      check ((payment_channel = 'offline') = (offline_method is not null));
  end if;

  -- An offline payment must carry its reference.
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_offline_reference_required'
                  and conrelid = 'public.shop_orders'::regclass) then
    alter table shop_orders
      add constraint shop_orders_offline_reference_required
      check (payment_channel <> 'offline' or payment_reference is not null);
  end if;

  -- A discount needs a reason.
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_owner_discount_reason'
                  and conrelid = 'public.shop_orders'::regclass) then
    alter table shop_orders
      add constraint shop_orders_owner_discount_reason
      check (owner_discount_inr = 0 or length(btrim(owner_discount_reason)) >= 3);
  end if;

  -- Hard 50% ceiling on the owner's discount, of the goods after offers.
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_owner_discount_ceiling'
                  and conrelid = 'public.shop_orders'::regclass) then
    alter table shop_orders
      add constraint shop_orders_owner_discount_ceiling
      check (owner_discount_inr * 100 <= greatest(subtotal_inr - offer_discount_inr - coupon_discount_inr, 0) * 50);
  end if;

  -- A payment-link order carries its link once it is paid (or shipped etc.).
  -- While it is unpaid (payment_pending, expired, cancelled) it may have no
  -- link fields: the order row is written before Razorpay creates the link, and
  -- an order is never deleted once a link might exist.
  if exists (select 1 from pg_constraint
              where conname = 'shop_orders_payment_link_fields'
                and conrelid = 'public.shop_orders'::regclass
                and pg_get_constraintdef(oid) not like '%payment_pending%') then
    alter table shop_orders drop constraint shop_orders_payment_link_fields;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_payment_link_fields'
                  and conrelid = 'public.shop_orders'::regclass) then
    alter table shop_orders
      add constraint shop_orders_payment_link_fields
      check (payment_channel <> 'payment_link'
             or status in ('payment_pending', 'expired', 'cancelled')
             or (razorpay_payment_link_id is not null
                 and payment_link_url is not null
                 and payment_link_expires_at is not null));
  end if;

  -- Email is optional: '' means "no email". Find the original inline check on
  -- email (a single-column CHECK on the email column) by its definition, not by
  -- a guessed name, and drop it. Then add the relaxed one.
  select attnum into v_email_attnum
    from pg_attribute
   where attrelid = 'public.shop_orders'::regclass and attname = 'email' and not attisdropped;

  for v_old in
    select conname
      from pg_constraint
     where conrelid = 'public.shop_orders'::regclass
       and contype = 'c'
       and conkey = array[v_email_attnum]
       and conname <> 'shop_orders_email_optional'
       and pg_get_constraintdef(oid) like '%length(email)%'
       and pg_get_constraintdef(oid) not like '%= 0%'
  loop
    execute format('alter table public.shop_orders drop constraint %I', v_old.conname);
  end loop;

  if not exists (select 1 from pg_constraint where conname = 'shop_orders_email_optional'
                  and conrelid = 'public.shop_orders'::regclass) then
    alter table shop_orders
      add constraint shop_orders_email_optional
      check (email = '' or length(email) between 3 and 254);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Indexes.
-- ---------------------------------------------------------------------------
create unique index if not exists shop_orders_payment_link_id
  on shop_orders (razorpay_payment_link_id) where razorpay_payment_link_id is not null;
create index if not exists shop_orders_source_created
  on shop_orders (source, created_at desc);
-- The sweeper that expires unpaid links only looks at these.
create index if not exists shop_orders_awaiting_link
  on shop_orders (payment_link_expires_at)
  where status = 'payment_pending' and payment_channel = 'payment_link';

-- ---------------------------------------------------------------------------
-- 5. shop_intro_claims: an order with no email has no email to claim on.
-- ---------------------------------------------------------------------------
alter table shop_intro_claims alter column email drop not null;

-- Same function as in 2026-11-shop-v2.sql (race logic, SECURITY DEFINER,
-- search_path and grants unchanged); only the email stored changes.
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
  values (v_order.id, v_order.user_id, v_order.phone, nullif(lower(btrim(v_order.email)), ''))
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

revoke all on function claim_shop_intro_offer(uuid) from public, anon, authenticated;
grant execute on function claim_shop_intro_offer(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Verify (read-only; run on "Hioc India" after applying):
--   select column_name, is_nullable, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'shop_orders'
--      and column_name in ('source','created_by','payment_channel','offline_method',
--        'payment_reference','owner_discount_inr','owner_discount_reason',
--        'razorpay_payment_link_id','payment_link_url','payment_link_expires_at')
--    order by column_name;
--   -- expect 10 rows; source/payment_channel not null with defaults 'web' / 'checkout';
--   -- owner_discount_inr not null default 0; owner_discount_reason not null default ''
--
--   select conname from pg_constraint
--    where conrelid = 'public.shop_orders'::regclass and conname in
--      ('shop_orders_discounts_add_up','shop_orders_offline_method_pairing',
--       'shop_orders_offline_reference_required','shop_orders_owner_discount_reason',
--       'shop_orders_owner_discount_ceiling','shop_orders_payment_link_fields',
--       'shop_orders_email_optional');
--   -- expect 7 rows
--
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'shop_orders_discounts_add_up' and conrelid = 'public.shop_orders'::regclass;
--   -- expect it to mention owner_discount_inr
--
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'shop_orders_payment_link_fields' and conrelid = 'public.shop_orders'::regclass;
--   -- expect it to mention payment_pending, expired and cancelled
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.shop_orders'::regclass and contype = 'c'
--      and pg_get_constraintdef(oid) like '%length(email)%';
--   -- expect exactly 1 row: shop_orders_email_optional (the old email check is gone)
--
--   select is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'shop_intro_claims' and column_name = 'email';
--   -- expect YES
--
--   select count(*) from shop_orders
--    where discount_inr <> offer_discount_inr + coupon_discount_inr + beanies_discount_inr + owner_discount_inr;
--   -- expect 0
--
--   select source, payment_channel, count(*) from shop_orders group by 1, 2;
--   -- expect only web / checkout until the owner adds an order
--
--   select indexname from pg_indexes where tablename = 'shop_orders' and indexname in
--     ('shop_orders_payment_link_id','shop_orders_source_created','shop_orders_awaiting_link');
--   -- expect 3 rows
--
--   select pg_get_functiondef('claim_shop_intro_offer(uuid)'::regprocedure) like '%nullif(lower(btrim%' as ok,
--          pg_get_functiondef('shop_orders_legacy_discount()'::regprocedure) like '%owner_discount_inr%' as ok2;
--   -- expect true / true
--
--   select has_function_privilege('anon', 'claim_shop_intro_offer(uuid)', 'execute') as anon_can,
--          has_function_privilege('service_role', 'claim_shop_intro_offer(uuid)', 'execute') as service_can;
--   -- expect false / true
-- ---------------------------------------------------------------------------
