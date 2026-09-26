-- ===========================================================================
-- Menu switches — turn parts of the menu off for now, without deleting them.
-- POS → Menu → Switches (lib/menu/menuSwitches.ts).
--
--   store_settings.hidden_categories      category slugs (menu_items.category)
--                                         switched off: the whole category
--   store_settings.hidden_variant_labels  size names (menu_item_variants.label),
--                                         e.g. 'Extra Large', matched
--                                         case-insensitively
--   addon_options.is_available            false = that add-on option is off
--                                         (e.g. out of oat milk)
--
-- Whatever is off is left off the customer menu, the table QR and the POS, and
-- POST /api/orders and the add-items path refuse it. Switching back on
-- restores it exactly — nothing is deleted.
--
-- Categories and sizes: manager/owner (PATCH /api/store-settings). Add-on
-- options: anyone with menu_edit, like marking an item sold out
-- (PATCH /api/addon-options/[id]). All from the POS only.
--
-- Safe to re-run. Apply BEFORE deploying the code that reads it.
-- ===========================================================================

alter table store_settings
  add column if not exists hidden_variant_labels text[] not null default '{}',
  add column if not exists hidden_categories text[] not null default '{}';

alter table addon_options
  add column if not exists is_available boolean not null default true;

-- ---------------------------------------------------------------------------
-- Verify:
--   select hidden_categories, hidden_variant_labels from store_settings where is_singleton;
--   select count(*) filter (where not is_available) from addon_options;
-- ---------------------------------------------------------------------------
