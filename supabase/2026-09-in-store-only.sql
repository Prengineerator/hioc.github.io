-- ===========================================================================
-- In-store-only menu items.
--
-- Some things are sold only at the counter — water bottles, carry bags — and
-- must never appear on the website menu, the table-QR menu or in suggestions,
-- nor be orderable online. `in_store_only` marks them:
--
--   GET /api/menu            hides them unless a signed-in counter asks with
--                            includeInStore=true (the POS and the menu editor)
--   POST /api/orders         refuses them on customer_web and table_qr orders;
--                            only a staff_pos order may carry one
--   suggestions / reorder    never offer them
--
-- The menu_items read policy is unchanged (the rows aren't secret — they are
-- simply not offered); the rule that matters is the order route's refusal.
--
-- Safe to re-run. Apply BEFORE deploying the code that filters on it.
-- ===========================================================================

alter table menu_items
  add column if not exists in_store_only boolean not null default false;

-- ---------------------------------------------------------------------------
-- Verify:
--   select name, category, in_store_only from menu_items where in_store_only;
-- ---------------------------------------------------------------------------
