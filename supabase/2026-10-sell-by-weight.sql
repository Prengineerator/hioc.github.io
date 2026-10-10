-- ===========================================================================
-- Sell by weight (coffee beans by the gram).
--
-- Every item used to be sold by the unit: a variant has a price, the line has
-- a whole-number quantity. Beans are sold by the gram, so the owner can now
-- mark an item "Sold by weight" in the menu editor.
--
--   menu_items.sold_by_weight  the current setting, editable. When on, each
--                              variant's price_inr is the price PER KG
--                              (e.g. "Whole beans" ₹2400, "Ground" ₹2500).
--   order_items.weight_grams   grams in ONE unit of the line (a 250 g bag),
--                              chosen by the customer or the staffer. Null on
--                              every line of a by-the-unit item.
--
-- The line is priced server-side (lib/orders/lines.ts resolveOrderLines):
--
--   price_inr_snapshot = round(price per kg × weight_grams / 1000) + add-ons
--   line_total_inr     = price_inr_snapshot × quantity
--
-- so 2 × 250 g at ₹2400/kg is quantity 2, ₹600 each, ₹1200 — and every
-- report, bill, refund and GST calculation that reads those columns keeps
-- working unchanged. variant_label_snapshot stays the variant's own label,
-- because recipes and add-on recipes are matched by it; the weight is shown
-- beside it (lib/menu/weight.ts lineSizeLabel).
--
-- Stock: a sold-by-weight item's recipe is written PER GRAM sold (1 g of
-- "House blend beans" for each gram), and a sale uses
-- recipe × weight_grams × quantity (lib/inventory/rules.ts orderUsage).
--
-- Safe to re-run. Apply BEFORE switching any item to "Sold by weight": the
-- order insert writes order_items.weight_grams only on weighed lines, so
-- orders keep working before this runs.
-- ===========================================================================

alter table menu_items
  add column if not exists sold_by_weight boolean not null default false;

alter table order_items
  add column if not exists weight_grams integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'order_items_weight_grams_check'
  ) then
    alter table order_items
      add constraint order_items_weight_grams_check
      check (weight_grams is null or (weight_grams between 1 and 100000));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Verify:
--   select name, sold_by_weight from menu_items where sold_by_weight;
--   select name_snapshot, weight_grams, quantity, price_inr_snapshot
--     from order_items where weight_grams is not null
--     order by id desc limit 20;
-- ---------------------------------------------------------------------------
