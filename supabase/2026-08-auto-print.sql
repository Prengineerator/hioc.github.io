-- ===========================================================================
-- Phase 4 · POS4-3 — auto-print the KOT on placement and the bill on settle.
--
-- Placing an order printed nothing. The kitchen only saw a ticket if a staffer
-- remembered to reopen the order in the queue and tap Print KOT — so on a busy
-- counter the rail stayed empty and the order was cooked off someone's memory.
-- The print pages already exist (/staff-print/[id]/kot|receipt); what was
-- missing was the cafe's answer to "should this fire on its own?".
--
-- Two switches, not one, because the two prints have opposite defaults:
--   auto_print_kot  — ON. Every kitchen wants its ticket; there is no cafe that
--                     wants an order cooked without one.
--   auto_print_bill — OFF. Plenty of counters hand over no paper unless asked
--                     (the WhatsApp bill is the receipt), and a printer firing
--                     on every settle wastes a roll a day.
--
-- Kept as store_settings columns rather than env vars so the owner can flip
-- them from the settings screen without a redeploy.
--
-- Safe to re-run. Apply BEFORE deploying the POS4-3 client — a missing column
-- is tolerated there (it falls back to these same defaults), so the order of
-- the two doesn't strand anyone.
-- ===========================================================================

alter table store_settings
  add column if not exists auto_print_kot boolean not null default true;

alter table store_settings
  add column if not exists auto_print_bill boolean not null default false;

-- ---------------------------------------------------------------------------
-- Verify:
--   select auto_print_kot, auto_print_bill from store_settings where is_singleton;
--   -- expect: t | f  on a fresh apply
--
--   -- the columns must be NOT NULL with the defaults above, or the client's
--   -- fallback and the stored value will disagree:
--   select column_name, is_nullable, column_default
--     from information_schema.columns
--    where table_name = 'store_settings'
--      and column_name in ('auto_print_kot', 'auto_print_bill');
-- ---------------------------------------------------------------------------
