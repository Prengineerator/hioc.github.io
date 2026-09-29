-- ===========================================================================
-- Loyalty earn rate: 10% of the order value (0.1 point per ₹1).
--
-- A ₹250 order now earns 25 points instead of 250. Points already earned are
-- untouched — only orders completed after this runs earn at the new rate.
-- Idempotent: safe to re-run.
-- ===========================================================================

alter table loyalty_config alter column points_per_inr set default 0.100;

update loyalty_config
   set points_per_inr = 0.100,
       updated_at     = now()
 where is_singleton;
