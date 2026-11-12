-- ===========================================================================
-- Warehouse access per person (docs/WAREHOUSE-SPEC.md, WH-D16).
--
-- The warehouse side of a transfer (recording what left the warehouse, and
-- sending store stock back to it) was a manager's or the owner's. Some staff
-- do the warehouse run without being managers, and making them managers would
-- also hand them discounts, voids, refunds and the cash close. This switch
-- gives one staffer just the warehouse side:
--
--   staff_accounts.warehouse_access   true: may record what was sent from the
--                                     warehouse (the dispatch) and send stock
--                                     back to it (a return). Default false.
--
-- Nothing else changes. Whoever dispatched or carried a transfer still can't
-- count it in at the POS, so the store's count is still checked against the
-- warehouse's. Counting a return in at the warehouse and settling a difference
-- stay the owner's. A manager or the owner has warehouse access already; the
-- switch only matters for the 'staff' role.
--
-- The owner sets it on Staff → Edit ("Warehouse runs"). The app reads it on
-- the server only (service role); staff_accounts keeps its lockdown (RLS on,
-- no policies). Until this file is applied the app reads every staffer as
-- false, exactly as before.
--
-- Additive and safe to re-run.
-- ===========================================================================

alter table staff_accounts
  add column if not exists warehouse_access boolean not null default false;
