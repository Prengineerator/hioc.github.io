-- ===========================================================================
-- Phase 4 · TAB-1 — add lines to an open order (the running tab).
--
-- Before this, the corrections engine could only VOID. "Two more coffees for
-- table 4" therefore created a SECOND order and a second bill; a table's spend
-- was split across rows that nothing tied together. Adding is now a first-class
-- amendment, audited exactly like a void.
--
-- Safe to re-run. Apply BEFORE deploying the TAB-1 route — the add path writes
-- kind='add_item', which the existing CHECK rejects.
-- ===========================================================================

alter table order_amendments drop constraint if exists order_amendments_kind_check;
alter table order_amendments add constraint order_amendments_kind_check
  check (kind in ('void_item', 'add_item', 'change_table', 'comp'));

-- ---------------------------------------------------------------------------
-- Verify:
--   select kind, count(*) from order_amendments group by kind;
-- ---------------------------------------------------------------------------
