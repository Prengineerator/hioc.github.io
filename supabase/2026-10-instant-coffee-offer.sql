-- ===========================================================================
-- Instant coffee offer, as an offer (not a menu change).
--
--   1 jar   ₹399  − ₹100 offer  = ₹299
--   2 jars  ₹798  − ₹299 offer  = ₹499   any flavours
--   3 jars  ₹1197 − ₹598 offer  = ₹599   any flavours
--
-- Needs supabase/2026-10-item-offers.sql (the offers table) and the app update
-- that reads it (lib/orders/offers.ts). RUN THIS AFTER THAT UPDATE IS LIVE:
-- the live app before it cannot apply an offer, so the jars would ring up at
-- ₹399 with nothing taken off.
--
-- This
--   1. puts the "Instant Coffee" menu item back exactly as it was before the
--      first version of this offer: Classic / Hazelnut / French Vanilla at
--      ₹399, no description, nothing else on the In-store menu;
--   2. removes that first version, which priced the offer into the menu (the
--      single jar at ₹299, the "Instant Coffee 2-Jar Offer" (₹499) and
--      "3-Jar Offer" (₹599) items and their "Jar 1/2/3 flavour" add-on
--      groups). Order lines that sold them keep their own name and price
--      snapshot (order_items.menu_item_id is on delete set null), exactly as
--      when an item is deleted in the menu editor; and
--   3. creates the offer itself, "Instant Coffee offer" — the same as making it
--      in Promotions → Offers, where it can be edited, switched off or deleted
--      from then on.
--
-- Safe to re-run.
-- ===========================================================================

begin;

-- 1. The menu item as it was ------------------------------------------------------

update menu_item_variants
set price_inr = 399
where menu_item_id = 'f3299544-0c5e-4478-9ad3-029741e35279'
  and price_inr = 299;

update menu_items
set description = ''
where id = 'f3299544-0c5e-4478-9ad3-029741e35279'
  and description like 'Offer:%';

-- 2. Remove the first (menu) version ----------------------------------------------

delete from menu_items
where id in ('5341e97d-723e-4714-acfc-eef5f0b023f7',   -- Instant Coffee 2-Jar Offer
             'e8075076-8826-4fcc-8ca2-d7fa349ee685');  -- Instant Coffee 3-Jar Offer

delete from addon_groups
where id in ('1afe3bbf-fbca-4e22-a91c-4c8b0fd38e62',   -- Jar 1 flavour
             '7c33ba8a-f7d1-4314-b1eb-0e573931a785',   -- Jar 2 flavour
             'f06e8b72-4cc1-47bf-8b20-a03f829c76f5');  -- Jar 3 flavour

-- 3. The offer ------------------------------------------------------------------

insert into menu_offers (id, name, menu_item_id, tier_prices, active)
select 'b1c7e6a2-3f4d-4e58-9a61-2d7c0e5f8a93', 'Instant Coffee offer',
       'f3299544-0c5e-4478-9ad3-029741e35279', '{299,499,599}', true
where exists (select 1 from menu_items where id = 'f3299544-0c5e-4478-9ad3-029741e35279')
  and not exists (
    select 1 from menu_offers
    where menu_item_id = 'f3299544-0c5e-4478-9ad3-029741e35279' and active
  )
on conflict (id) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- Verify:
--   select m.name, v.label, v.price_inr
--     from menu_items m join menu_item_variants v on v.menu_item_id = m.id
--    where m.name ilike 'instant coffee%' order by m.name, v.sort_order;
--   -- expect only "Instant Coffee": Classic / Hazelnut / French Vanilla at 399
--   select name, tier_prices, active from menu_offers;
--   -- expect "Instant Coffee offer" {299,499,599} on
-- ---------------------------------------------------------------------------
