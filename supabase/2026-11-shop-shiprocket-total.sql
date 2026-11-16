-- ===========================================================================
-- Shop orders: what Shiprocket's bill says (docs/INSTANT-COFFEE-SHOP.md).
--
-- Shiprocket works out its own order total from what we send it, and prints
-- that on its invoice, in its emails to the customer and as the parcel's
-- declared value. Order HIOC-S1004 showed how that can go wrong: the customer
-- paid ₹749 and Shiprocket's bill said ₹301 (the offer was taken off twice).
--
--   shop_orders.shiprocket_total_inr   Shiprocket's order total as last read
--                                      back from Shiprocket (after "Send to
--                                      Shiprocket" and on every "Refresh from
--                                      Shiprocket"). Null: not read yet.
--
-- /owner/shop compares it with total_inr (what the customer paid) and warns
-- on the order when the two differ. Written by the server only (service
-- role); shop_orders keeps its lockdown. Until this file is applied the app
-- skips the check and everything else works as before.
--
-- Additive and safe to re-run.
-- ===========================================================================

alter table shop_orders
  add column if not exists shiprocket_total_inr numeric(10, 2);

comment on column shop_orders.shiprocket_total_inr is
  'Shiprocket''s order total as last read back from Shiprocket; compared with total_inr on /owner/shop. Null until read.';
