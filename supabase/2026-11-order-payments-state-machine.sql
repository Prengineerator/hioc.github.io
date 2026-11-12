-- ===========================================================================
-- Order payments state machine — the refund cap, made race-safe.
--
-- lib/orders/refundStateMachine.ts now CLAIMS a gateway refund as a 'pending'
-- row (with its Idempotency-Key) before Razorpay is asked to move money, and
-- leaves it 'pending' when the gateway's answer is unknown (a timeout, a 5xx):
-- the money may have moved. Two things in guard_refund_total
-- (2026-08-counter-refunds.sql) did not fit that, and one never did:
--
--   1. It only checked 'processed' rows, and only on INSERT. A pending claim
--      skipped the cap entirely, and pending → processed is an UPDATE, so a
--      gateway refund was never capped by the database at all (Razorpay's own
--      cap and the route's were the only ones). Now a pending row is capped
--      when it is inserted, and pending rows count against what is left — the
--      same rule the route applies (refundedOrPendingInr).
--
--   2. No row lock. Two refunds inserted at the same moment each summed the
--      refunds before the other committed, so both passed a cap that together
--      they exceed (phase2-hardening.sql's comment calling it race-safe was
--      wrong). The trigger now locks the order row first: concurrent refunds on
--      one order run one after the other, and the second sees the first.
--
-- 'failed' rows still never count. Nothing else changes: the trigger is
-- replaced in place (create or replace) and re-attached exactly as before.
--
-- Safe to re-run. The app works without it: the route still checks the cap
-- itself (counting pending claims), and a pending insert simply isn't capped
-- by the database until this is applied.
-- ===========================================================================

create or replace function public.guard_refund_total()
returns trigger language plpgsql as $$
declare v_paid integer; v_refunded integer;
begin
  if new.status not in ('processed', 'pending') then return new; end if;

  -- Serialise refunds per order: the sums below then see every refund that
  -- committed before this one (READ COMMITTED re-snapshots each statement).
  perform 1 from orders where id = new.order_id for update;

  if new.payment_id is not null then
    -- Gateway refund: capped at the captured payment.
    select amount_inr into v_paid from payments where id = new.payment_id;
    select coalesce(sum(amount_inr), 0) into v_refunded from refunds
      where payment_id = new.payment_id and status in ('processed', 'pending') and id <> new.id;
  else
    -- REF-1 counter refund: cap against what the till actually took.
    select coalesce(
             (select sum(amount_inr) from order_payments where order_id = new.order_id),
             (select coalesce(total_inr, subtotal_inr) from orders where id = new.order_id)
           ) into v_paid;
    select coalesce(sum(amount_inr), 0) into v_refunded from refunds
      where order_id = new.order_id and payment_id is null and status in ('processed', 'pending')
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
--   select prosrc like '%for update%' as locks, prosrc like '%pending%' as counts_pending
--     from pg_proc where proname = 'guard_refund_total';
--   -- refunds still waiting on the gateway's answer (check each in Razorpay):
--   select id, order_id, payment_id, amount_inr, created_at
--     from refunds where status = 'pending' order by created_at;
-- ---------------------------------------------------------------------------
