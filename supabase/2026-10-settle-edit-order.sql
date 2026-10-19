-- ===========================================================================
-- Settle → Edit order (owner request, 2026-10-19).
--
-- "We only had one latte, not two" — at the counter, with the bill open on
-- Settle, the cashier used to have to leave for Orders to void a line. They can
-- now lower a line's quantity or take a line off right there, with a reason,
-- before collecting payment (POST /api/orders/[id]/amend { op: 'edit' }).
--
-- Two things make that possible:
--   1. A reduction is audited as its own amendment kind, 'change_qty' (from/to
--      quantity and line total). Removing a line reuses 'void_item'. The kind
--      CHECK has to allow the new one, or the audit row is refused.
--   2. A new permission, 'settle_edit_order', seeded at 'manager' — lowering a
--      bill is money-touching, like void_line. The owner can switch it to
--      "Staff & up" on Owner → Team → Permissions.
--
-- Every kind already allowed is kept (void_item, change_table, comp from the
-- Phase-3 table; add_item from 2026-08-running-tab.sql).
--
-- Safe to re-run. Apply BEFORE deploying — an edit that lowers a quantity writes
-- kind='change_qty', which the existing CHECK rejects.
-- ===========================================================================

alter table order_amendments drop constraint if exists order_amendments_kind_check;
alter table order_amendments add constraint order_amendments_kind_check
  check (kind in ('void_item', 'add_item', 'change_table', 'comp', 'change_qty'));

-- MIRROR IN lib/permissions.ts + lib/types.ts.
insert into role_permissions (permission_key, min_role) values
  ('settle_edit_order', 'manager')
on conflict (permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- Verify:
--   select kind, count(*) from order_amendments group by kind;
--   select permission_key, min_role from role_permissions
--    where permission_key = 'settle_edit_order';
-- ---------------------------------------------------------------------------
