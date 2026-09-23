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
--
-- NOTE: section 3 (the over-refund trigger) was added after this file was first
-- applied. Re-run the whole file — every statement is idempotent.
-- ===========================================================================

-- 1. A counter refund has no gateway payment to reference.
alter table refunds alter column payment_id drop not null;

-- 2. Which tender the refund was issued on. Null = legacy row (pre-REF-1),
--    which the drawer math treats by the old rule.
alter table refunds add column if not exists method payment_method;

create index if not exists idx_refunds_method on refunds (method);

-- 3. Teach the over-refund guard about counter refunds.
--
-- phase2-hardening.sql installs a BEFORE INSERT trigger that caps refunds at the
-- captured gateway payment. It reads `payments` by new.payment_id — which is
-- NULL for a counter refund, making v_paid NULL, coalesce(v_paid,0) = 0, and
-- ANY positive amount raise 'refund total exceeds captured payment'. Without
-- this, every counter refund fails at the database.
--
-- The invariant it protects is right and worth keeping: you may never refund
-- more than was taken. For a counter refund "what was taken" is the sum of the
-- POS4-1 parts, or the order total for an order settled before that table
-- existed. Gateway and counter refunds are capped against their own bucket,
-- which matches how the app computes per-tender balances.
create or replace function public.guard_refund_total()
returns trigger language plpgsql as $$
declare v_paid integer; v_refunded integer;
begin
  if new.status <> 'processed' then return new; end if;

  if new.payment_id is not null then
    -- Gateway refund — unchanged behaviour.
    select amount_inr into v_paid from payments where id = new.payment_id;
    select coalesce(sum(amount_inr), 0) into v_refunded from refunds
      where payment_id = new.payment_id and status = 'processed' and id <> new.id;
  else
    -- REF-1 counter refund: cap against what the till actually took.
    select coalesce(
             (select sum(amount_inr) from order_payments where order_id = new.order_id),
             (select coalesce(total_inr, subtotal_inr) from orders where id = new.order_id)
           ) into v_paid;
    select coalesce(sum(amount_inr), 0) into v_refunded from refunds
      where order_id = new.order_id and payment_id is null and status = 'processed'
        and id <> new.id;
  end if;

  if v_refunded + new.amount_inr > coalesce(v_paid, 0) then
    raise exception 'refund total exceeds captured payment';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_refund_total on refunds;
create trigger trg_guard_refund_total before insert on refunds
  for each row execute function public.guard_refund_total();

-- ---------------------------------------------------------------------------
-- Verify:
--   select method, status, count(*), sum(amount_inr)
--     from refunds group by method, status;
--   -- counter refunds have a null payment_id and a non-null method:
--   select id, order_id, payment_id, method, amount_inr, status
--     from refunds order by created_at desc limit 10;
-- ---------------------------------------------------------------------------
