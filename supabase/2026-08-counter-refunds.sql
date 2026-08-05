-- ===========================================================================
-- Phase 4 · REF-1 — refunds for counter-settled orders.
--
-- The gap: POST /api/orders/[id]/refund requires a `payments` row carrying a
-- gateway_payment_id, and those are written ONLY by the Razorpay/reconcile
-- paths. A cash, UPI or card order settled at the counter has no payments row
-- at all, so every counter refund has always returned
--   409 "No captured gateway payment found for this order."
-- while the staff UI happily offered the button. Refunding a walk-in customer
-- was impossible in-system.
--
-- Two changes make a counter refund recordable:
--   1. payment_id becomes NULLABLE — there is no gateway payment to point at.
--   2. `method` records WHICH tender the money went back on. That is not
--      cosmetic: OPS-2's expected-cash sums refunds against cash orders, so a
--      UPI reversal counted as drawer cash would make the till read short.
--      With split payments (POS4-1) an order can even have both.
--
-- Safe to re-run. Apply BEFORE deploying the REF-1 refund route.
-- ===========================================================================

-- 1. A counter refund has no gateway payment to reference.
alter table refunds alter column payment_id drop not null;

-- 2. Which tender the refund was issued on. Null = legacy row (pre-REF-1),
--    which the drawer math treats by the old rule.
alter table refunds add column if not exists method payment_method;

create index if not exists idx_refunds_method on refunds (method);

-- ---------------------------------------------------------------------------
-- Verify:
--   select method, status, count(*), sum(amount_inr)
--     from refunds group by method, status;
--   -- counter refunds have a null payment_id and a non-null method:
--   select id, order_id, payment_id, method, amount_inr, status
--     from refunds order by created_at desc limit 10;
-- ---------------------------------------------------------------------------
