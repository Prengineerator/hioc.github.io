-- ===========================================================================
-- Multi-buy offers: "Instant Coffee: 1 for ₹299, 2 for ₹499, 3 for ₹599".
--
-- The item keeps its regular price (₹399 a jar) on the menu and on every order
-- line, and the offer comes off the bill as its own discount row, so the
-- customer sees the saving:
--
--   2 × Instant Coffee        ₹798
--   Instant Coffee offer     −₹299
--   Total                     ₹499
--
--   menu_items.offer_prices      What 1, 2, 3 … units cost together, e.g.
--                                {299,499,599}. Null = no offer. Any mix of
--                                the item's sizes counts. Past the last tier
--                                the units go in full groups of the biggest
--                                tier, then the tier for the rest (4 = 599 +
--                                299). Add-ons are charged in full on top.
--   order_items.offer_prices     The offer the line was sold under (a
--   order_items.offer_unit_inr   snapshot) and one unit's price before
--                                add-ons. Null on every other line. A void,
--                                a lowered quantity or an item added to a
--                                running tab works the offer out again from
--                                the lines that remain.
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
-- either way, and the offer columns are only ever written on lines and orders
-- that have an offer. Safe to re-run.
--
-- Turn an offer on, change it, or end it (menu editor support is a follow-up):
--   update menu_items set offer_prices = '{299,499,599}' where id = '<item id>';
--   update menu_items set offer_prices = null           where id = '<item id>';
-- Orders already placed keep the offer they were sold under.
-- ===========================================================================

alter table menu_items
  add column if not exists offer_prices integer[];

alter table order_items
  add column if not exists offer_prices integer[],
  add column if not exists offer_unit_inr integer;

alter table orders
  add column if not exists offer_discount_inr integer not null default 0;

do $$
begin
  -- 1–10 tiers, each a whole rupee price above zero. (Never cheaper for more
  -- units is checked by the app, which ignores an offer that breaks it.)
  if not exists (select 1 from pg_constraint where conname = 'menu_items_offer_prices_check') then
    alter table menu_items
      add constraint menu_items_offer_prices_check
      check (offer_prices is null or (cardinality(offer_prices) between 1 and 10 and 0 < all (offer_prices)));
  end if;
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
--   select name, offer_prices from menu_items where offer_prices is not null;
--   select order_number, discount_inr, offer_discount_inr, total_inr
--     from orders where offer_discount_inr > 0 order by created_at desc limit 20;
-- ---------------------------------------------------------------------------
