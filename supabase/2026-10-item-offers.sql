-- ===========================================================================
-- Multi-buy offers: "Instant Coffee: 1 for ₹299, 2 for ₹499, 3 for ₹599".
--
-- An offer is its own record, created by the owner in Promotions → Offers.
-- The menu item is never changed: it keeps its regular price (₹399 a jar) on
-- the menu and on every order line, and the offer comes off the bill as its
-- own discount row, so the customer sees the saving:
--
--   2 × Instant Coffee        ₹798
--   Instant Coffee offer     −₹299
--   Total                     ₹499
--
--   menu_offers                  One offer on one menu item: its name (printed
--                                on the bill), what 1, 2, 3 … units cost
--                                together (tier_prices, e.g. {299,499,599}),
--                                on/off, and an optional start/end. Any mix of
--                                the item's sizes counts. Past the last tier
--                                the units go in full groups of the biggest
--                                tier, then the tier for the rest (4 = 599 +
--                                299). Add-ons are charged in full on top. At
--                                most one switched-on offer per item.
--   order_items.offer_id         The offer the line was sold under (a
--   order_items.offer_name       snapshot) and one unit's price before
--   order_items.offer_prices     add-ons. Null on every other line. A void, a
--   order_items.offer_unit_inr   lowered quantity or an item added to a
--                                running tab works the offer out again from
--                                the lines that remain, with the offer as it
--                                was sold — editing or ending an offer never
--                                changes an open bill.
--   orders.offer_discount_inr    The part of discount_inr that is the offer.
--                                It is INSIDE discount_inr, so
--                                  total_inr = subtotal_inr + tax_inr
--                                            + packaging_inr - discount_inr
--                                            - pass_discount_inr
--                                is unchanged, and every report and GST
--                                export reads the bill as before.
--
-- The rules live in lib/orders/offers.ts (pure; the server prices with it and
-- every screen and printout labels with it). The offer is applied after HIOC
-- Ritual cups and before a coupon and Beanies; a Ritual cup never pays for a
-- line on an offer.
--
-- Safe to apply before or after the app update that reads it: orders work
-- either way (no offer can exist until this is applied, and the offer columns
-- are only written on lines and orders that have one). Safe to re-run.
-- ===========================================================================

create table if not exists menu_offers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) between 1 and 60),
  menu_item_id  uuid not null references menu_items(id) on delete cascade,
  -- 1–10 tiers, whole rupees above zero. (Never cheaper for more units is
  -- checked by the app, which ignores an offer that breaks it.)
  tier_prices   integer[] not null
                  check (cardinality(tier_prices) between 1 and 10 and 0 < all (tier_prices)),
  active        boolean not null default true,
  valid_from    timestamptz,
  valid_to      timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (valid_from is null or valid_to is null or valid_to > valid_from)
);

-- One switched-on offer per item, so two can never stack on the same jars.
create unique index if not exists menu_offers_one_active_per_item
  on menu_offers (menu_item_id) where active;

-- Read and written only by the server (service role): the order routes and
-- app/api/offers (manager / owner).
alter table menu_offers enable row level security;
revoke all on menu_offers from anon, authenticated;

alter table order_items
  add column if not exists offer_id uuid references menu_offers(id) on delete set null,
  add column if not exists offer_name text,
  add column if not exists offer_prices integer[],
  add column if not exists offer_unit_inr integer;

alter table orders
  add column if not exists offer_discount_inr integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_offer_unit_inr_check') then
    alter table order_items
      add constraint order_items_offer_unit_inr_check
      check (offer_unit_inr is null or offer_unit_inr >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_offer_discount_inr_check') then
    alter table orders
      add constraint orders_offer_discount_inr_check
      check (offer_discount_inr >= 0);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Verify:
--   select o.name, m.name as item, o.tier_prices, o.active, o.valid_from, o.valid_to
--     from menu_offers o join menu_items m on m.id = o.menu_item_id;
--   select order_number, discount_inr, offer_discount_inr, total_inr
--     from orders where offer_discount_inr > 0 order by created_at desc limit 20;
-- ---------------------------------------------------------------------------
