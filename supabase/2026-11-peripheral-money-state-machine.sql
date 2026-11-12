-- ===========================================================================
-- Peripheral money state machines — the two guards only the database can give.
--
-- Optional, additive, safe to re-run. The app works with or without it (see
-- each part); applying it closes the races the TypeScript can only narrow.
--
-- 1. Loyalty: one earn, one redeem and one reverse row per order.
--    lib/loyalty/orderLedger.ts makes the per-order lifecycle explicit
--    (none → redeemed → earned → reversed) and lib/loyalty/ledger.ts checks it
--    before every write. But the check is a read: two requests for the same
--    order (a refund and a cancel landing together) can both find "not yet"
--    and both insert, reversing the order's Beanies twice. Without these
--    indexes the app removes the later row itself (it reads the rows back
--    after inserting), which narrows that window but cannot close it. With
--    them the second insert is refused (23505) and the app reads that as
--    "already written".
--    Each index is created only if the table holds no duplicates for it
--    already; if it does, a NOTICE says how many orders, and the index is
--    skipped rather than the whole file failing. Fix those rows (keep the
--    earliest) and re-run.
--
-- 2. HIOC Ritual: no pass on a sale that was cancelled or rejected before its
--    payment landed. coffee_pass_complete_on_paid() already leaves such an
--    order alone, but coffee_pass_issue_on_paid() did not look at the order's
--    status, so a late capture on a cancelled sale issued a live pass the
--    customer could spend while also being owed a refund. The function below
--    is IDENTICAL to supabase/2026-10-coffee-pass-per-drink.sql's except for
--    the one guard marked "2026-11". Without it, a late capture issues the
--    pass as before (the cancel and reconcile paths are where that is
--    prevented in the app).
--
-- Not here, on purpose: spend offers. "Once per customer" counts only
-- redemptions whose ORDER is live (not cancelled or rejected), which a unique
-- index cannot see, so the app checks after inserting instead
-- (lib/orders/offersServer.ts recordSpendRedemption).
-- ===========================================================================

-- ── 1. Loyalty: one row of each type per order ─────────────────────────────
do $$
declare
  v_type text;
  v_dupes integer;
begin
  foreach v_type in array array['earn', 'redeem', 'reverse'] loop
    select count(*) into v_dupes from (
      select order_id
        from public.loyalty_transactions
       where type = v_type and order_id is not null
       group by order_id
      having count(*) > 1
    ) d;
    if v_dupes > 0 then
      raise notice 'loyalty_transactions: % order(s) already have more than one % row — index loyalty_tx_one_%_per_order NOT created', v_dupes, v_type, v_type;
    else
      execute format(
        'create unique index if not exists %I on public.loyalty_transactions (order_id) where type = %L and order_id is not null',
        'loyalty_tx_one_' || v_type || '_per_order',
        v_type
      );
    end if;
  end loop;
end $$;

-- ── 2. HIOC Ritual: the issuing trigger, with the dead-order guard ─────────
create or replace function public.coffee_pass_issue_on_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
  v_plan public.coffee_pass_plans%rowtype;
  v_user uuid;
  v_terms jsonb;
  v_name text;
  v_drinks integer;
  v_value integer;
  v_days integer;
  v_cap integer;
  v_sold boolean := false;
  v_drink_item uuid := null;
  v_drink_label text := '';
begin
  if new.order_kind is distinct from 'coffee_pass'
     or new.payment_status is distinct from 'paid'
     or (tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid') then
    return null;
  end if;

  -- 2026-11: a sale cancelled or rejected before its payment landed (a late
  -- capture) issues nothing. The customer is owed their money back, not a pass
  -- on an order the café has called off; coffee_pass_complete_on_paid leaves
  -- such an order where it is for the same reason. Warn, never raise: this runs
  -- inside the transaction that records the payment.
  if new.status::text in ('rejected', 'cancelled') then
    raise warning 'coffee pass: order % was paid after it was %, so no pass was issued — it needs refunding', new.id, new.status;
    return null;
  end if;

  select oi.coffee_pass_plan_id, oi.line_total_inr, oi.coffee_pass_terms
    into v_line
    from public.order_items oi
   where oi.order_id = new.id and oi.coffee_pass_plan_id is not null and not oi.voided
   order by oi.id
   limit 1;
  if not found then
    raise warning 'coffee pass: order % is paid but has no pass line — no pass issued', new.id;
    return null;
  end if;

  select * into v_plan from public.coffee_pass_plans where id = v_line.coffee_pass_plan_id;
  if not found then
    raise warning 'coffee pass: order % names a plan that no longer exists — no pass issued', new.id;
    return null;
  end if;

  v_user := coalesce(new.customer_user_id, new.user_id);
  if v_user is null then
    raise warning 'coffee pass: order % is paid but has no account to issue the pass to — no pass issued', new.id;
    return null;
  end if;

  -- The terms the pass was sold with. Checked by pattern before any cast (SQL
  -- does not promise AND short-circuits, so a cast may not share an expression
  -- with the check that makes it safe): every key present, a name of 1-60
  -- characters, whole numbers for the counts, and max_per_day a whole number or
  -- JSON null (no cap). The bounds are the plan table's own, so a pass can
  -- never be issued that a plan could not have described. drink_value_inr is now
  -- the price of the size the customer chose (CP-D23), not a plan setting.
  v_terms := v_line.coffee_pass_terms;
  if v_terms is not null then
    if jsonb_typeof(v_terms) = 'object'
       and v_terms ?& array['plan_name', 'drinks_total', 'drink_value_inr', 'validity_days', 'max_per_day']
       and jsonb_typeof(v_terms -> 'plan_name') = 'string'
       and length(trim(v_terms ->> 'plan_name')) between 1 and 60
       and jsonb_typeof(v_terms -> 'drinks_total') = 'number'
       and (v_terms ->> 'drinks_total') ~ '^[0-9]{1,6}$'
       and jsonb_typeof(v_terms -> 'drink_value_inr') = 'number'
       and (v_terms ->> 'drink_value_inr') ~ '^[0-9]{1,9}$'
       and jsonb_typeof(v_terms -> 'validity_days') = 'number'
       and (v_terms ->> 'validity_days') ~ '^[0-9]{1,6}$'
       and (jsonb_typeof(v_terms -> 'max_per_day') = 'null'
            or (jsonb_typeof(v_terms -> 'max_per_day') = 'number'
                and (v_terms ->> 'max_per_day') ~ '^[0-9]{1,6}$')) then
      v_name   := v_terms ->> 'plan_name';
      v_drinks := (v_terms ->> 'drinks_total')::integer;
      v_value  := (v_terms ->> 'drink_value_inr')::integer;
      v_days   := (v_terms ->> 'validity_days')::integer;
      v_cap    := (v_terms ->> 'max_per_day')::integer;   -- JSON null -> SQL NULL
      v_sold   := v_drinks between 1 and 50
              and v_value >= 1
              and v_days between 1 and 365
              and (v_cap is null or v_cap >= 1);
    end if;
    if not v_sold then
      raise warning 'coffee pass: order % carries unreadable sold terms (%) — issuing from the live plan instead',
        new.id, left(v_terms::text, 200);
    end if;
  end if;

  if v_sold then
    -- The drink the customer chose (CP-D25). Both keys are OPTIONAL and never
    -- a reason to refuse a sale: an id that is not a uuid, or names a menu item
    -- that no longer exists, is ignored (the pass simply has no drink), and a
    -- label that is not a string of up to 80 characters is dropped. The uuid is
    -- matched by pattern before the cast for the same reason as above. The row
    -- is locked FOR KEY SHARE, so the menu item cannot be deleted between this
    -- check and the insert below (a foreign-key error there would roll the
    -- payment back).
    if jsonb_typeof(v_terms -> 'drink_menu_item_id') = 'string'
       and (v_terms ->> 'drink_menu_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select m.id into v_drink_item
        from public.menu_items m
       where m.id = (v_terms ->> 'drink_menu_item_id')::uuid
         for key share;
    end if;
    if jsonb_typeof(v_terms -> 'drink_label') = 'string'
       and length(v_terms ->> 'drink_label') <= 80 then
      v_drink_label := v_terms ->> 'drink_label';
    end if;
  else
    -- No readable sold terms: the live plan. It has a cup value only if it still
    -- carries a legacy one (CP-D24 clears them), so this can now come up empty.
    v_name   := v_plan.name;
    v_drinks := v_plan.drinks_total;
    v_value  := v_plan.drink_value_inr;
    v_days   := v_plan.validity_days;
    v_cap    := v_plan.max_per_day;
    if v_value is null then
      raise warning 'coffee pass: order % has no readable sold terms and plan % has no cup value — no pass issued',
        new.id, v_plan.id;
      return null;
    end if;
  end if;

  insert into public.coffee_passes (
    user_id, plan_id, order_id, plan_name, drinks_total, drink_value_inr, price_inr,
    max_per_day, starts_at, expires_at, issued_by, drink_menu_item_id, drink_label
  ) values (
    v_user, v_plan.id, new.id, v_name, v_drinks, v_value,
    v_line.line_total_inr, v_cap, now(),
    (((now() at time zone 'Asia/Kolkata')::date + v_days)::timestamp)
      at time zone 'Asia/Kolkata',
    new.created_by, v_drink_item, v_drink_label
  )
  on conflict (order_id) do nothing;

  -- The BEFORE trigger completed the order; leave the trail the kitchen board
  -- and the SLA metrics expect (a system actor: nobody clicked it).
  if new.status::text = 'completed' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    insert into public.order_status_events (order_id, from_status, to_status, actor_role, reason)
    values (new.id, case when tg_op = 'UPDATE' then old.status else null end,
            new.status, 'system', 'HIOC Ritual issued');
  end if;
  return null;
end $$;

-- CREATE OR REPLACE keeps the old grants; restating them makes this file the
-- whole truth about who may call it.
revoke execute on function public.coffee_pass_issue_on_paid() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- the three indexes (expect 3 rows, unless a NOTICE said otherwise):
--   select indexname from pg_indexes
--    where tablename = 'loyalty_transactions' and indexname like 'loyalty_tx_one_%_per_order';
--
--   -- the issuing trigger has the guard (expect true):
--   select pg_get_functiondef('public.coffee_pass_issue_on_paid()'::regprocedure) like '%was paid after it was%';
--
--   -- passes on dead sale orders issued before this (each one needs looking at):
--   select p.id, p.plan_name, o.order_number, o.status, o.payment_status
--     from coffee_passes p join orders o on o.id = p.order_id
--    where o.status in ('cancelled', 'rejected');
-- ---------------------------------------------------------------------------
