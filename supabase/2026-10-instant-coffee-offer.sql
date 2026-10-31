-- ===========================================================================
-- Instant coffee offer, as a discount on the bill (menu data only).
--
--   1 jar   ₹399  − ₹100 offer  = ₹299
--   2 jars  ₹798  − ₹299 offer  = ₹499   any flavours
--   3 jars  ₹1197 − ₹598 offer  = ₹599   any flavours
--
-- Needs supabase/2026-10-item-offers.sql (the offer columns) and the app
-- update that reads them (lib/orders/offers.ts). RUN THIS AFTER THAT UPDATE IS
-- LIVE: until then the app does not read offer_prices, so the jars would ring
-- up at ₹399 with nothing taken off.
--
-- "Instant Coffee" (In-store, counter only, no GST) has one size per flavour:
-- Classic / Hazelnut / French Vanilla. This
--   1. sets each flavour back to its regular ₹399 (the bill shows the saving),
--   2. puts the offer on the item: offer_prices {299,499,599}, so staff add
--      jars in any flavours and the bill takes off "Instant Coffee offer"
--      by itself (4 jars = 599 + 299, 5 = 599 + 499, …), and
--   3. removes the first version of the offer, which priced it into the menu:
--      the single jar at ₹299 and the "Instant Coffee 2-Jar Offer" (₹499) /
--      "3-Jar Offer" (₹599) items with their "Jar 1/2/3 flavour" add-on
--      groups. Order lines that sold them keep their own name and price
--      snapshot (order_items.menu_item_id is on delete set null), exactly as
--      when an item is deleted in the menu editor.
--
-- To end the offer:
--   update menu_items set offer_prices = null where id = 'f3299544-0c5e-4478-9ad3-029741e35279';
--
-- Safe to re-run.
-- ===========================================================================

begin;

-- 1. Regular price on every flavour --------------------------------------------

update menu_item_variants
set price_inr = 399
where menu_item_id = 'f3299544-0c5e-4478-9ad3-029741e35279'
  and price_inr = 299;

-- 2. The offer --------------------------------------------------------------------

update menu_items
set offer_prices = '{299,499,599}',
    description = 'Offer: ₹100 off one jar (₹299). Any 2 jars ₹499, any 3 jars ₹599. Taken off the bill automatically.'
where id = 'f3299544-0c5e-4478-9ad3-029741e35279';

-- 3. Remove the first (price-update) version ----------------------------------------

delete from menu_items
where id in ('5341e97d-723e-4714-acfc-eef5f0b023f7',   -- Instant Coffee 2-Jar Offer
             'e8075076-8826-4fcc-8ca2-d7fa349ee685');  -- Instant Coffee 3-Jar Offer

delete from addon_groups
where id in ('1afe3bbf-fbca-4e22-a91c-4c8b0fd38e62',   -- Jar 1 flavour
             '7c33ba8a-f7d1-4314-b1eb-0e573931a785',   -- Jar 2 flavour
             'f06e8b72-4cc1-47bf-8b20-a03f829c76f5');  -- Jar 3 flavour

commit;

-- ---------------------------------------------------------------------------
-- Verify:
--   select m.name, m.offer_prices, v.label, v.price_inr
--     from menu_items m join menu_item_variants v on v.menu_item_id = m.id
--    where m.name ilike 'instant coffee%'
--    order by m.name, v.sort_order;
--   -- expect only "Instant Coffee": three flavours at 399, offer {299,499,599}
-- ---------------------------------------------------------------------------
