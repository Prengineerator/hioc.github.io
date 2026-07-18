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

-- H1 — atomic redemption (coupon usage_limit + loyalty balance double-spend).
-- The order-creation route calls these via .rpc(); each takes a per-coupon /
-- per-user advisory lock so a concurrent second checkout re-reads the fresh
-- count/balance and is rejected (returns false) instead of over-redeeming.
-- Each runs as its own transaction, so the lock releases on return. Inserts
-- only on success, and is idempotent per order.

create or replace function public.try_redeem_coupon(
  p_coupon_id uuid, p_order_id uuid, p_user_id uuid,
  p_discount integer, p_usage_limit integer, p_per_user_limit integer
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_total integer; v_user integer;
begin
  perform pg_advisory_xact_lock(hashtext('coupon:' || p_coupon_id::text));
  if exists (select 1 from coupon_redemptions where coupon_id = p_coupon_id and order_id = p_order_id) then
    return true; -- idempotent
  end if;
  if p_usage_limit > 0 then
    select count(*) into v_total from coupon_redemptions cr
      join orders o on o.id = cr.order_id
      where cr.coupon_id = p_coupon_id and o.status not in ('cancelled', 'rejected');
    if v_total >= p_usage_limit then return false; end if;
  end if;
  if p_per_user_limit > 0 and p_user_id is not null then
    select count(*) into v_user from coupon_redemptions cr
      join orders o on o.id = cr.order_id
      where cr.coupon_id = p_coupon_id and cr.user_id = p_user_id
        and o.status not in ('cancelled', 'rejected');
    if v_user >= p_per_user_limit then return false; end if;
  end if;
  insert into coupon_redemptions (coupon_id, order_id, user_id, discount_inr)
    values (p_coupon_id, p_order_id, p_user_id, p_discount);
  return true;
end $$;

create or replace function public.try_redeem_points(
  p_user_id uuid, p_order_id uuid, p_points integer, p_discount integer
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_balance integer;
begin
  perform pg_advisory_xact_lock(hashtext('loyalty:' || p_user_id::text));
  if exists (select 1 from loyalty_transactions where order_id = p_order_id and type = 'redeem') then
    return true; -- idempotent
  end if;
  select coalesce(sum(points), 0) into v_balance from loyalty_transactions where user_id = p_user_id;
  if v_balance < p_points then return false; end if;
  insert into loyalty_transactions (user_id, order_id, type, points, note)
    values (p_user_id, p_order_id, 'redeem', -p_points, 'Redeemed at checkout');
  insert into loyalty_accounts (user_id, points_balance, updated_at)
    values (p_user_id, v_balance - p_points, now())
    on conflict (user_id) do update set points_balance = v_balance - p_points, updated_at = now();
  return true;
end $$;

grant execute on function public.try_redeem_coupon(uuid, uuid, uuid, integer, integer, integer) to service_role;
grant execute on function public.try_redeem_points(uuid, uuid, integer, integer) to service_role;
