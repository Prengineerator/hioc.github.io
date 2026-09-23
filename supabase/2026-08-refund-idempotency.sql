-- ===========================================================================
-- Phase 4 · REF-2 — a double-tapped Refund must not pay a customer twice.
--
-- `guard_refund_total` caps the TOTAL refunded against what was taken, but it
-- does not deduplicate: two identical ₹100 refunds against a ₹247 order are
-- each individually under the cap, so both commit. `refunds` has no unique
-- constraint of any kind. On a laggy tablet a manager taps Refund, sees nothing
-- happen, taps again — and ₹200 leaves the drawer.
--
-- Order CREATION got replay protection in POS4-2. Refunds move money OUTWARD
-- and had none.
--
-- The unique index is the hard guarantee; the route's 23505 branch turns a
-- duplicate into "here is the refund you already made" rather than an error.
-- Partial (`where ... is not null`) so historic rows, which have no key, don't
-- collide with each other.
--
-- Safe to re-run. Apply BEFORE deploying the REF-2 route.
-- ===========================================================================

alter table refunds add column if not exists idempotency_key text;

create unique index if not exists idx_refunds_idempotency
  on refunds (idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- Verify:
--   select count(*) filter (where idempotency_key is not null) as keyed,
--          count(*) as total
--     from refunds;
--
--   -- the index must be UNIQUE and partial:
--   select indexname, indexdef from pg_indexes
--    where tablename = 'refunds' and indexname = 'idx_refunds_idempotency';
-- ---------------------------------------------------------------------------
