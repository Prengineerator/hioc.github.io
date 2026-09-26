-- ===========================================================================
-- KOT counters — split the kitchen ticket by counter.
--
-- The cafe prepares different menu categories at different counters (coffee
-- bar, waffle counter, kitchen) but has ONE printer. A single KOT listing every
-- item meant someone had to read it and walk each line to the right counter.
-- With counters configured, a KOT prints as one slip per counter — just that
-- counter's items, its name in large type, the paper cut between slips — plus
-- an optional full slip with every item for whoever checks the order is
-- complete. See lib/print/kotRouting.ts.
--
-- One jsonb column rather than two tables: it is a single store-wide setting
-- that is always read and saved whole (POS → Settings → KOT counters), so a
-- column on the singleton store_settings row gives atomic saves for free.
-- Shape (validated by normalizeKotRouting() before every write):
--
--   { "counters": [ { "id": "c1", "name": "Coffee Bar",
--                     "categories": ["Coffee", "Iced Coffee"] }, ... ],
--     "full_copy": false }
--
-- A category belongs to at most one counter; a category on no counter prints
-- on an "Other items" slip, so an unmapped item is never dropped. No counters
-- at all (the default) prints exactly the single KOT the cafe had before.
--
-- Safe to re-run. The client tolerates a missing column (it reads as the
-- default below), so this can be applied before or after the deploy.
-- ===========================================================================

alter table store_settings
  add column if not exists kot_routing jsonb not null
    default '{"counters": [], "full_copy": false}'::jsonb;

-- ---------------------------------------------------------------------------
-- Verify:
--   select kot_routing from store_settings where is_singleton;
--   -- expect: {"counters": [], "full_copy": false} on a fresh apply
-- ---------------------------------------------------------------------------
