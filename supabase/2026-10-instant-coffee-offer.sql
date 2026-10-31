-- ===========================================================================
-- Instant coffee offer (menu data only, no schema change).
--
--   1 jar   ₹299   (₹100 off the regular ₹399)
--   2 jars  ₹499   any flavours
--   3 jars  ₹599   any flavours
--
-- "Instant Coffee" (In-store, counter only) already exists with one size per
-- flavour (Classic / Hazelnut / French Vanilla) at ₹399. The offer is built
-- from ordinary menu rows, so order pricing, bills, GST, voids, refunds and
-- reports all work as they do for every other item:
--
--   * The single jar's three flavours drop from ₹399 to ₹299. They are updated
--     in place, so their variant ids (carts, POS Repeat) stay valid.
--   * Two combo items, "Instant Coffee 2-Jar Offer" (₹499) and
--     "Instant Coffee 3-Jar Offer" (₹599), each carry one required
--     "Jar N flavour" pick per jar. A jar's flavour is then printed on the
--     KOT and the bill, e.g. "Jar 1 flavour: Hazelnut".
--   * The combos copy the single jar's settings: In-store, counter only,
--     no GST, not payable with a HIOC Ritual cup.
--
-- At the counter: 2 jars = the 2-Jar Offer, 3 jars = the 3-Jar Offer. Two
-- single jars ring up ₹598, not ₹499, so pick the combo. 4 jars and more:
-- combine them (4 = 3-Jar Offer + 1 jar, 5 = 3-Jar + 2-Jar, ...).
--
-- If a flavour runs out, switch it off in BOTH places: the single jar's size
-- and the matching option in the three "Jar N flavour" add-on groups.
--
-- To end the offer: switch the two combo items off (or delete them) and set
-- the single jar's three sizes back to ₹399, all in the menu editor.
--
-- Safe to re-run: fixed ids with on conflict do nothing, and the price change
-- only touches sizes still at ₹399.
-- ===========================================================================

begin;

-- 1. Single jar: ₹399 -> ₹299, every flavour --------------------------------

update menu_item_variants
set price_inr = 299
where menu_item_id = 'f3299544-0c5e-4478-9ad3-029741e35279'
  and price_inr = 399;

update menu_items
set description = 'Offer: ₹299 a jar (₹100 off the regular ₹399). Any 2 jars ₹499 and any 3 jars ₹599 with the 2-Jar / 3-Jar Offer.'
where id = 'f3299544-0c5e-4478-9ad3-029741e35279';

-- 2. One flavour pick per jar ------------------------------------------------

insert into addon_groups (id, name, display_name, selection_type, min_select, max_select, sort_order) values
  ('1afe3bbf-fbca-4e22-a91c-4c8b0fd38e62', 'Instant Coffee Jar 1', 'Jar 1 flavour', 'single', 1, 1, 180),
  ('7c33ba8a-f7d1-4314-b1eb-0e573931a785', 'Instant Coffee Jar 2', 'Jar 2 flavour', 'single', 1, 1, 190),
  ('f06e8b72-4cc1-47bf-8b20-a03f829c76f5', 'Instant Coffee Jar 3', 'Jar 3 flavour', 'single', 1, 1, 200)
on conflict (id) do nothing;

insert into addon_options (id, addon_group_id, name, price_inr, sort_order) values
  ('2f75ed67-04da-4451-b4af-0650a18d9755', '1afe3bbf-fbca-4e22-a91c-4c8b0fd38e62', 'Classic',        0,  0),
  ('c90da075-3832-49ec-b61a-5b715663b6d9', '1afe3bbf-fbca-4e22-a91c-4c8b0fd38e62', 'Hazelnut',       0, 10),
  ('6d0e8911-a66d-448d-ac79-ad3bc62ce4fd', '1afe3bbf-fbca-4e22-a91c-4c8b0fd38e62', 'French Vanilla', 0, 20),
  ('af08adee-fee5-4a4b-bfc8-4d28fb776c03', '7c33ba8a-f7d1-4314-b1eb-0e573931a785', 'Classic',        0,  0),
  ('e16f7912-69f8-40a0-aa41-74705efc906f', '7c33ba8a-f7d1-4314-b1eb-0e573931a785', 'Hazelnut',       0, 10),
  ('2ea0dc76-3242-44b6-90f1-e15d60997416', '7c33ba8a-f7d1-4314-b1eb-0e573931a785', 'French Vanilla', 0, 20),
  ('1559e180-89d4-4253-a5ab-8a8c0eb9323e', 'f06e8b72-4cc1-47bf-8b20-a03f829c76f5', 'Classic',        0,  0),
  ('00727cf3-b7a0-4455-bfa5-d73a22a78605', 'f06e8b72-4cc1-47bf-8b20-a03f829c76f5', 'Hazelnut',       0, 10),
  ('27a8e688-8674-4ac8-8195-ac6427a8315a', 'f06e8b72-4cc1-47bf-8b20-a03f829c76f5', 'French Vanilla', 0, 20)
on conflict (id) do nothing;

-- 3. The combos -------------------------------------------------------------

insert into menu_items
  (id, name, description, category, parent_category, is_veg, is_available, sort_order,
   image_url, in_store_only, gst_exempt, pass_eligible, sold_by_weight)
values
  ('5341e97d-723e-4714-acfc-eef5f0b023f7', 'Instant Coffee 2-Jar Offer',
   'Offer: any 2 jars of instant coffee for ₹499 (regular ₹798). Pick a flavour for each jar.',
   'In-store', '', true, true, 0, '', true, true, false, false),
  ('e8075076-8826-4fcc-8ca2-d7fa349ee685', 'Instant Coffee 3-Jar Offer',
   'Offer: any 3 jars of instant coffee for ₹599 (regular ₹1197). Pick a flavour for each jar.',
   'In-store', '', true, true, 0, '', true, true, false, false)
on conflict (id) do nothing;

insert into menu_item_variants (id, menu_item_id, label, price_inr, sort_order) values
  ('3d23caf8-603e-4840-a977-a9a4580ff00a', '5341e97d-723e-4714-acfc-eef5f0b023f7', 'Regular', 499, 0),
  ('ae45460f-1c49-4f80-8832-278b5109bff4', 'e8075076-8826-4fcc-8ca2-d7fa349ee685', 'Regular', 599, 0)
on conflict (id) do nothing;

insert into menu_item_addon_groups (menu_item_id, addon_group_id) values
  ('5341e97d-723e-4714-acfc-eef5f0b023f7', '1afe3bbf-fbca-4e22-a91c-4c8b0fd38e62'),
  ('5341e97d-723e-4714-acfc-eef5f0b023f7', '7c33ba8a-f7d1-4314-b1eb-0e573931a785'),
  ('e8075076-8826-4fcc-8ca2-d7fa349ee685', '1afe3bbf-fbca-4e22-a91c-4c8b0fd38e62'),
  ('e8075076-8826-4fcc-8ca2-d7fa349ee685', '7c33ba8a-f7d1-4314-b1eb-0e573931a785'),
  ('e8075076-8826-4fcc-8ca2-d7fa349ee685', 'f06e8b72-4cc1-47bf-8b20-a03f829c76f5')
on conflict do nothing;

commit;

-- ---------------------------------------------------------------------------
-- Verify:
--   select m.name, v.label, v.price_inr,
--          (select string_agg(g.display_name, ', ' order by g.sort_order)
--             from menu_item_addon_groups l join addon_groups g on g.id = l.addon_group_id
--            where l.menu_item_id = m.id) as flavour_picks
--     from menu_items m join menu_item_variants v on v.menu_item_id = m.id
--    where m.name ilike 'instant coffee%'
--    order by m.name, v.sort_order;
-- ---------------------------------------------------------------------------
