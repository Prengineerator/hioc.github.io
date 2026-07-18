-- HIOC — Phase-2 hardening patch (QA-REPORT High-severity fixes needing DB).
-- Run once in the Supabase SQL editor. Idempotent.

-- H6 — enforce ONE overall-order review per order. The base table's
-- `unique (order_id, menu_item_id)` never fires when menu_item_id IS NULL
-- (SQL treats NULLs as distinct), so overall reviews could be spammed. A
-- partial unique index closes it; the reviews route already handles the
-- resulting 23505 as "already reviewed".
create unique index if not exists idx_reviews_one_overall
  on reviews (order_id)
  where menu_item_id is null;

-- H1 (coupon usage_limit / loyalty balance double-spend under concurrency) is a
-- TODO that needs an atomic redemption path: move the check+write into a single
-- Postgres function (SELECT ... FOR UPDATE / UPDATE ... WHERE ... RETURNING)
-- called from the order-creation route via .rpc(), replacing the current
-- read-then-insert. Left as a documented follow-up — it changes the checkout
-- transaction and warrants its own test pass. (See docs/QA-REPORT.md H1.)
