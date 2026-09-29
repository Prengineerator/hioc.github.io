-- ===========================================================================
-- Loyalty: redeem from 20 points, points expire 30 days after they're earned.
--
-- Expiry is enforced by the daily /api/cron/expire-points job (oldest points
-- are spent first; whatever is left of points older than the window is
-- written off as an 'expire' ledger row). Idempotent: safe to re-run.
-- ===========================================================================

alter table loyalty_config alter column min_redeem_points set default 20;
alter table loyalty_config alter column points_expiry_days set default 30;

update loyalty_config
   set min_redeem_points  = 20,
       points_expiry_days = 30,
       updated_at         = now()
 where is_singleton;
