-- ===========================================================================
-- HIOC Ritual — per-drink pricing (spec §13, CP-D22..D25, owner decision
-- 30 Sep 2026: "the price has to be dynamic according to the drink").
--
-- APPLY AFTER supabase/2026-10-coffee-pass.sql (already applied in production;
-- this file does not touch it) and BEFORE the code that sells by drink deploys.
-- Safe to re-run. Do NOT re-run the first file afterwards: it would put back the
-- old coffee_pass_issue_on_paid() body, which reads the plan's cup value.
--
-- What changes, and why:
--
--   1. A PLAN is now only a recipe: cups given, cups paid for, validity, daily
--      cap, GST-exempt, active. It has no price and no cup value any more, so
--      coffee_pass_plans.price_inr and .drink_value_inr become NULLable and are
--      cleared (CP-D24). Their CHECKs (> 0) still hold for any non-null value.
--      Production had 0 Rituals sold when this was decided, so nothing that
--      already exists depends on the old numbers; the first migration's seed
--      values (₹150 cup, ₹750 / ₹900) are simply unused from now on.
--
--   2. The customer picks a drink and a size when buying (CP-D22): the price is
--      drinks_paid × that size's menu price, and the CUP VALUE is that same menu
--      price, frozen on the sale line (order_items.coffee_pass_terms) when it is
--      sold (CP-D23). The issuing trigger therefore reads the cup value from the
--      SOLD terms, which the first migration's trigger already validates. Only
--      when the terms are missing or unreadable does it fall back to the live
--      plan's cup value, and a plan no longer has one: then it raises a WARNING
--      and issues nothing. It never raises an ERROR, because it runs inside the
--      transaction that records the customer's payment and an exception would
--      roll the payment back (the same rule as before).
--
--   3. The pass remembers its drink (CP-D25): coffee_passes.drink_menu_item_id
--      (SET NULL if the menu item is ever deleted: the pass outlives the menu)
--      and drink_label ("Cappuccino · Large"), copied from two OPTIONAL keys of
--      the sold terms. A pass issued from the live plan (no terms) has no drink:
--      a null item and a '' label.
--
--   4. v_coffee_pass_balances selects p.*, so the two new columns flow through,
--      but CREATE OR REPLACE VIEW cannot put new columns in the middle of a view
--      (they would sit before drinks_used and shift every later column), so the
--      view is DROPPED and created again, in one transaction. A drop takes the
--      grants with it, so security_invoker and the REVOKE are applied again.
--      Nothing in this repo depends on the view. If the DROP is ever refused
--      with "other objects depend on it", something added by hand does: re-create
--      that object afterwards rather than reaching for CASCADE.
--
-- Redemption is untouched: a cup still covers up to the pass's own
-- drink_value_inr on any eligible drink (CP-D9, CP-D23).
-- ===========================================================================

-- ── 1. Plans: no price, no cup value ────────────────────────────────────────
alter table coffee_pass_plans
  alter column price_inr drop not null,
  alter column drink_value_inr drop not null;

-- Clear what the first migration seeded (and anything the owner typed in). The
-- WHERE keeps a re-run from touching updated_at on rows that are already clear.
update coffee_pass_plans
   set price_inr = null, drink_value_inr = null
 where price_inr is not null or drink_value_inr is not null;

-- ── 2. Passes: the drink they were bought for ───────────────────────────────
alter table coffee_passes
  add column if not exists drink_menu_item_id uuid references menu_items(id) on delete set null,
  add column if not exists drink_label text not null default '';

-- ── 3. The balances view, with the new columns ──────────────────────────────
-- Same definition as the first migration (see there for what each column
-- means); only the DROP is new. One transaction, so nobody ever reads a
-- database with no view.
begin;

drop view if exists v_coffee_pass_balances;

create view v_coffee_pass_balances
with (security_invoker = true) as
select
  b.*,
  case
    when b.status = 'refunded'     then 'refunded'
    when b.status = 'void'         then 'void'
    when now() >= b.expires_at     then 'expired'
    when b.drinks_remaining <= 0   then 'used_up'
    else 'active'
  end as state
from (
  select
    p.*,
    coalesce(u.used, 0)::integer                                               as drinks_used,
    coalesce(a.credited, 0)::integer                                           as drinks_credited,
    greatest(0, p.drinks_total + coalesce(a.credited, 0) - coalesce(u.used, 0))::integer
                                                                               as drinks_remaining,
    coalesce(u.used_today, 0)::integer                                         as used_today
  from coffee_passes p
  left join lateral (
    select sum(r.drinks) as used,
           sum(r.drinks) filter (
             where r.business_date = (now() at time zone 'Asia/Kolkata')::date
           ) as used_today
      from coffee_pass_redemptions r
     where r.pass_id = p.id and r.reversed_at is null
  ) u on true
  left join lateral (
    select sum(x.drinks) as credited
      from coffee_pass_adjustments x
     where x.pass_id = p.id and x.kind = 'credit'
  ) a on true
) b;

-- A dropped view loses its grants, so both locks go back on (the security_invoker
-- option above, and this REVOKE: either alone can be undone by a later replace).
revoke all on v_coffee_pass_balances from anon, authenticated;

commit;

-- ── 4. The issuing trigger, reading the cup value from the sold terms ───────
-- Identical to the first migration's coffee_pass_issue_on_paid() EXCEPT:
--   * the plan's cup value is nullable, so the live-plan fallback warns and
--     issues nothing when it is null (never an error);
--   * the optional terms keys drink_menu_item_id and drink_label are copied onto
--     the pass (only from readable terms; a pass issued from the live plan has
--     no drink).
-- Everything else — security definer, search_path '', the account rule, the
-- IST expiry, the status event, the revokes — is unchanged. CREATE OR REPLACE
-- keeps the trigger that calls it.
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
--   -- the plans carry no price and no cup value (both columns nullable, all null):
--   select column_name, is_nullable from information_schema.columns
--    where table_name = 'coffee_pass_plans' and column_name in ('price_inr', 'drink_value_inr');  -- YES, YES
--   select name, drinks_total, drinks_paid, validity_days, price_inr, drink_value_inr, is_active
--     from coffee_pass_plans order by sort_order;                                -- price/value null
--
--   -- the two new columns on passes (2 rows):
--   select column_name, data_type, is_nullable, column_default from information_schema.columns
--    where table_name = 'coffee_passes' and column_name in ('drink_menu_item_id', 'drink_label');
--   -- ...and on the view (a view column list is fixed when it is created):
--   select column_name from information_schema.columns
--    where table_name = 'v_coffee_pass_balances' and column_name in ('drink_menu_item_id', 'drink_label');  -- 2 rows
--
--   -- the view is still security_invoker (expect 'true') and still closed to anon:
--   select option_value from pg_options_to_table(
--     (select reloptions from pg_class where relname = 'v_coffee_pass_balances'))
--    where option_name = 'security_invoker';
--   set role anon; select * from v_coffee_pass_balances;   -- "permission denied"     reset role;
--
--   -- the trigger function reads the cup value from the sold terms (expect true):
--   select pg_get_functiondef('public.coffee_pass_issue_on_paid()'::regprocedure) like '%drink_menu_item_id%';
--
--   -- each Ritual and the drink it was bought for:
--   select plan_name, drink_label, drink_value_inr, price_inr, drinks_remaining, state
--     from v_coffee_pass_balances order by created_at desc limit 20;
--
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
