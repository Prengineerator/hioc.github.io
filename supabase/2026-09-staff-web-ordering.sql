-- ===========================================================================
-- Taking orders on the staff website — off by default.
--
-- Orders are punched in at the POS (an enrolled counter device running the
-- HIOC POS app). The staff website — a phone or laptop browser that is not an
-- enrolled POS — shows orders and the live board but does not take orders
-- unless the owner or a manager turns this on in Settings → Store:
--
--   store_settings.staff_web_ordering  false = only the POS can create orders
--                                      or add items to one (the default)
--
-- Enforced by POST /api/orders (staff path) and the add-items path of
-- POST /api/orders/[id]/amend; the staff website hides New order and Tables
-- while it is off. Customer (website, table QR) ordering is unaffected.
--
-- Safe to re-run. Apply BEFORE deploying the code that reads it.
-- ===========================================================================

alter table store_settings
  add column if not exists staff_web_ordering boolean not null default false;

-- ---------------------------------------------------------------------------
-- Verify:
--   select staff_web_ordering from store_settings where is_singleton;
-- ---------------------------------------------------------------------------
