-- ===========================================================================
-- Instant Coffee shop: jars ordered on the website, paid by Razorpay, shipped
-- with Shiprocket (docs/INSTANT-COFFEE-SHOP.md).
--
-- Kept apart from the café's `orders` on purpose. A shipped jar is not a café
-- order: it must never reach the counter's board, a KOT, the cash day, the
-- café's Reports and GST, Beanies or stock. Its own tables mean none of those
-- has to learn to skip it. Only the owner sees these orders (/owner/shop).
--
--   shop_products   The three flavours, ₹399 each. `in_stock` is the owner's
--                   switch on /owner/shop; an out-of-stock flavour can't be
--                   ordered. The price is read from here at checkout, never
--                   from the browser.
--   shop_settings   One row: the online offer. Starts as the introductory
--                   offer "1 for ₹399 · 2 for ₹599 · 3 for ₹749" (any
--                   flavours; more jars = full groups of 3, then the rest,
--                   like the café's offers), switched on. The owner can switch
--                   it off or change the prices on /owner/shop.
--   shop_orders     One row per checkout. Created 'payment_pending' when the
--                   Razorpay window opens; 'paid' once Razorpay confirms
--                   (checkout verify, webhook or the status poll, whichever is
--                   first); then 'sent_to_shiprocket' → 'shipped' →
--                   'delivered', or 'cancelled' (refunded) by the owner.
--                   Jars keep their ₹399 on the lines; the offer is its own
--                   discount (discount_inr, offer_name). Shipping is ₹49 an
--                   order below 3 jars, free from 3. An optional delivery pin
--                   (location_*) goes to Shiprocket with the order.
--
-- Read and written only by the server (service role). Additive and safe to
-- re-run (also over the first version of this file). Apply BEFORE switching on
-- NEXT_PUBLIC_FLAG_SHOP.
-- ===========================================================================

create table if not exists shop_products (
  id          text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  name        text not null check (length(btrim(name)) between 1 and 60),
  sku         text not null unique check (length(btrim(sku)) between 1 and 40),
  price_inr   integer not null check (price_inr > 0),
  net_qty     text not null default '50 g',
  in_stock    boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table shop_products enable row level security;
revoke all on shop_products from anon, authenticated;

insert into shop_products (id, name, sku, price_inr, net_qty, sort_order) values
  ('classic',  'Signature Classic', 'HIOC-IC-CLASSIC-50G',  399, '50 g', 1),
  ('hazelnut', 'Nutty Hazelnut',    'HIOC-IC-HAZELNUT-50G', 399, '50 g', 2),
  ('vanilla',  'French Vanilla',    'HIOC-IC-VANILLA-50G',  399, '50 g', 3)
on conflict (id) do nothing;

create sequence if not exists shop_order_number_seq start with 1001;

create table if not exists shop_orders (
  id                      uuid primary key default gen_random_uuid(),
  order_number            bigint not null unique default nextval('shop_order_number_seq'),
  status                  text not null default 'payment_pending'
                            check (status in ('payment_pending', 'paid', 'sent_to_shiprocket',
                                              'shipped', 'delivered', 'cancelled')),

  -- Who and where. phone is +91XXXXXXXXXX.
  customer_name           text not null check (length(btrim(customer_name)) between 2 and 60),
  phone                   text not null check (phone ~ '^\+91[6-9][0-9]{9}$'),
  email                   text not null check (length(email) between 3 and 254),
  address_line1           text not null check (length(btrim(address_line1)) between 5 and 120),
  address_line2           text not null default '' check (length(address_line2) <= 120),
  city                    text not null check (length(btrim(city)) between 2 and 50),
  state                   text not null check (length(btrim(state)) between 2 and 50),
  pincode                 text not null check (pincode ~ '^[1-9][0-9]{5}$'),

  -- What, priced by the server: [{product_id, name, sku, unit_price_inr, quantity, line_total_inr}].
  lines                   jsonb not null check (jsonb_typeof(lines) = 'array'),
  jar_count               integer not null check (jar_count > 0),
  subtotal_inr            integer not null check (subtotal_inr > 0),
  discount_inr            integer not null default 0 check (discount_inr >= 0),
  offer_name              text,
  shipping_inr            integer not null check (shipping_inr >= 0),
  total_inr               integer not null constraint shop_orders_total_positive check (total_inr > 0),

  -- Razorpay.
  razorpay_order_id       text unique,
  razorpay_payment_id     text,
  payment_method          text,
  paid_at                 timestamptz,

  -- Shiprocket. shiprocket_sending_at is a short claim so a double click
  -- can't create the shipment twice.
  shiprocket_order_id     text,
  shiprocket_shipment_id  text,
  shiprocket_status       text,
  shiprocket_sending_at   timestamptz,
  awb_code                text,
  courier_name            text,
  package_weight_kg       numeric(6, 3),
  package_dims_cm         text,
  sent_to_shiprocket_at   timestamptz,
  shipped_at              timestamptz,
  delivered_at            timestamptz,

  -- Cancelled by the owner, with the refund it issued (if it was paid).
  cancelled_at            timestamptz,
  cancel_reason           text not null default '',
  refund_id               text,
  refunded_inr            integer,

  -- The signed-in account that placed it, if any (guests can order too).
  user_id                 uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Over the first version of this file: the offer columns, and the total now
-- takes the offer off (subtotal − discount + shipping).
alter table shop_orders
  add column if not exists discount_inr integer not null default 0 check (discount_inr >= 0),
  add column if not exists offer_name text;

-- The delivery pin the customer may drop at checkout ("Use my current
-- location" or the map): sent to Shiprocket and shown to the owner as a Google
-- Maps link, so the courier finds the door. Optional; inside India.
alter table shop_orders
  add column if not exists location_lat numeric(9, 6) check (location_lat between 6 and 38),
  add column if not exists location_lng numeric(9, 6) check (location_lng between 68 and 98),
  add column if not exists location_accuracy_m integer check (location_accuracy_m >= 0),
  add column if not exists location_source text check (location_source in ('gps', 'map'));
alter table shop_orders drop constraint if exists shop_orders_total_inr_check;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_total_adds_up') then
    alter table shop_orders
      add constraint shop_orders_total_adds_up check (total_inr = subtotal_inr - discount_inr + shipping_inr);
  end if;
end $$;

create index if not exists shop_orders_status_created on shop_orders (status, created_at desc);
create index if not exists shop_orders_created on shop_orders (created_at desc);

alter table shop_orders enable row level security;
revoke all on shop_orders from anon, authenticated;

-- The online offer (one row). offer_tier_prices[n] is what n jars cost, any
-- flavours; more jars than tiers = full groups of the biggest tier, then the
-- tier for the rest (4 jars = ₹749 + ₹399).
create table if not exists shop_settings (
  is_singleton       boolean primary key default true check (is_singleton),
  offer_active       boolean not null default true,
  offer_name         text not null default 'Introductory offer' check (length(btrim(offer_name)) between 1 and 40),
  offer_tier_prices  integer[] not null default '{399,599,749}'
                       check (cardinality(offer_tier_prices) between 2 and 6 and 0 < all (offer_tier_prices)),
  updated_at         timestamptz not null default now()
);

insert into shop_settings (is_singleton) values (true) on conflict (is_singleton) do nothing;

alter table shop_settings enable row level security;
revoke all on shop_settings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Verify:
--   select id, name, price_inr, in_stock from shop_products order by sort_order;
--   -- expect Signature Classic / Nutty Hazelnut / French Vanilla at 399, in stock
--   select offer_active, offer_name, offer_tier_prices from shop_settings;
--   -- expect true / Introductory offer / {399,599,749}
--   select count(*) from shop_orders;
-- ---------------------------------------------------------------------------
