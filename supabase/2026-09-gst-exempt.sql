-- ===========================================================================
-- Per-item GST exemption.
--
-- GST (store_settings.gst_percent, added on top or included per
-- store_settings.gst_inclusive) used to apply to every line. Some items are
-- sold without GST; the owner marks them in the menu editor.
--
--   menu_items.gst_exempt   the current setting, editable
--   order_items.gst_exempt  SNAPSHOT taken when the line is sold, like the
--                           price snapshot: voiding or adding lines later
--                           recomputes GST from the snapshot, so changing an
--                           item's setting never rewrites an existing bill.
--
-- Bill GST = rate × (sum of the order's non-voided, non-exempt lines) — see
-- computeBill() in lib/store/hours.ts.
--
-- Safe to re-run. Apply BEFORE deploying the code: the order insert writes
-- order_items.gst_exempt.
-- ===========================================================================

alter table menu_items
  add column if not exists gst_exempt boolean not null default false;

alter table order_items
  add column if not exists gst_exempt boolean not null default false;

-- ---------------------------------------------------------------------------
-- Verify:
--   select name, gst_exempt from menu_items where gst_exempt;
-- ---------------------------------------------------------------------------
