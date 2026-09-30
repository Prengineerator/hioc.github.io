-- ===========================================================================
-- Coffee Pass — prepaid coffee plans, sold and redeemed on the website and at
-- the POS. Spec and deploy requirement sheet: docs/COFFEE-PASS-SPEC.md.
-- Customer-facing, the program is branded "HIOC Ritual" (its plans are
-- "Weekly Ritual" / "Monthly Ritual"); every technical name — tables,
-- functions, columns, order_kind — stays coffee_pass_*.
--
-- The model this stores:
--
--   1. A PLAN is data (coffee_pass_plans): drinks given, drinks paid for
--      (display only), validity in days, the value one drink covers, the
--      price, an optional per-day cap. Both seeded plans are INACTIVE until
--      the owner confirms prices and GST treatment (spec §9 B).
--   2. SELLING a pass is an ordinary order (orders.order_kind = 'coffee_pass')
--      with one line that carries coffee_pass_plan_id. Every money path — split
--      tender, cash day, refunds, receipts, Razorpay — already works on orders,
--      so none of it is duplicated here.
--   3. When that order's payment_status becomes 'paid' — by ANY path (counter
--      settle, Razorpay verify, webhook, reconcile poll, cron) — a trigger
--      below issues the pass and completes the sale order so it never sits on
--      the kitchen board. It is idempotent: coffee_passes.order_id is unique.
--   4. A pass is DRINKS with a value. Redeeming one on a normal order writes a
--      row to coffee_pass_redemptions (through coffee_pass_redeem(), which
--      row-locks the pass so two checkouts cannot both spend the last drink).
--   5. Drinks left are NOT a column. They are derived in
--      v_coffee_pass_balances = drinks_total + credited − non-reversed used,
--      so the balance can never disagree with the history it is computed from
--      (the loyalty and inventory ledgers work the same way).
--   6. Credits come back on their own: triggers reverse a redemption when its
--      order is rejected, cancelled or fully refunded, or when its line is
--      voided. No route can forget, and a partial refund returns nothing.
--
-- Every table is service-role only (RLS on, no policies, explicit REVOKE —
-- the same double lock as inventory and the cash tables); the API routes are
-- the authorization gate and customers read their own passes through routes
-- scoped by session. The functions are security definer with search_path
-- pinned to '', EXECUTE revoked from public/anon/authenticated and granted to
-- service_role. Nothing changes for anyone until the flag is on and a plan is
-- active. Idempotent: safe to re-run.
-- ===========================================================================

-- ── Plans ───────────────────────────────────────────────────────────────────
create table if not exists coffee_pass_plans (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) between 1 and 60),
  description     text not null default '' check (length(description) <= 500),
  -- Drinks the customer GETS (7 on both seeded plans).
  drinks_total    integer not null check (drinks_total between 1 and 50),
  -- Drinks the customer PAYS for (5 / 6). Display only — the price below is
  -- what is charged; this is what "7 for the price of 5" is worked out from.
  drinks_paid     integer not null check (drinks_paid >= 1),
  validity_days   integer not null check (validity_days between 1 and 365),
  -- One pass drink covers up to this much of ONE unit of an eligible drink
  -- (size and add-ons count towards it; anything above is paid as a top-up).
  drink_value_inr integer not null check (drink_value_inr > 0),
  price_inr       integer not null check (price_inr > 0),
  -- NULL = no daily limit. 1 makes it "a coffee a day". Counted per IST day.
  max_per_day     integer check (max_per_day is null or max_per_day >= 1),
  -- GST on a pass is charged when it is SOLD (CP-D11) unless this is set.
  gst_exempt      boolean not null default false,
  -- Seeded false: nothing is sold until the owner switches a plan on.
  is_active       boolean not null default false,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint coffee_pass_plans_paid_le_total check (drinks_paid <= drinks_total)
);
create unique index if not exists coffee_pass_plans_name_ci
  on coffee_pass_plans (lower(trim(name)));

-- set_updated_at() is the generic helper from schema.sql.
drop trigger if exists trg_coffee_pass_plans_updated_at on coffee_pass_plans;
create trigger trg_coffee_pass_plans_updated_at
  before update on coffee_pass_plans
  for each row execute function set_updated_at();

-- ── Columns on existing tables ──────────────────────────────────────────────
-- A pass sale vs. everything else. POST /api/orders never sets it, so every
-- existing path stays 'menu'.
alter table orders
  add column if not exists order_kind text not null default 'menu'
    check (order_kind in ('menu', 'coffee_pass'));
-- Total covered by pass drinks on this order. Kept SEPARATE from discount_inr
-- (coupon + points only) so reports never count prepaid drinks as a marketing
-- discount. The bill identity every renderer relies on becomes:
--   total_inr = subtotal_inr + tax_inr + packaging_inr − discount_inr − pass_discount_inr
alter table orders
  add column if not exists pass_discount_inr integer not null default 0
    check (pass_discount_inr >= 0);
-- Units of this line covered by a pass, and the rupees they covered.
alter table order_items
  add column if not exists pass_drinks integer not null default 0
    check (pass_drinks >= 0),
  add column if not exists pass_covered_inr integer not null default 0
    check (pass_covered_inr >= 0);
-- Set on the single line of a pass-sale order (menu_item_id is null there).
-- RESTRICT: a plan that has been sold is deactivated, never deleted.
alter table order_items
  add column if not exists coffee_pass_plan_id uuid
    references coffee_pass_plans(id) on delete restrict;
-- CP-D3: which drinks a pass can pay for. Shared by all plans; the owner
-- ticks them on Owner → Passes. Nothing is pre-set.
alter table menu_items
  add column if not exists pass_eligible boolean not null default false;

-- ── Passes: one row per pass SOLD ───────────────────────────────────────────
-- Snapshots of the plan are copied in so editing or deactivating a plan never
-- touches a pass someone already paid for.
create table if not exists coffee_passes (
  id              uuid primary key default gen_random_uuid(),
  -- CASCADE, like loyalty_accounts: closing an account takes its passes with it.
  user_id         uuid not null references auth.users(id) on delete cascade,
  plan_id         uuid not null references coffee_pass_plans(id) on delete restrict,
  -- The sale. unique = one pass per order, however many times the paid trigger
  -- fires. CASCADE: deleting an order (test-order cleanup, create-path
  -- rollback) takes its pass and redemptions with it; the derived balance
  -- restores itself.
  order_id        uuid not null unique references orders(id) on delete cascade,
  plan_name       text not null,
  drinks_total    integer not null check (drinks_total >= 1),
  drink_value_inr integer not null check (drink_value_inr > 0),
  -- What the customer was actually CHARGED for the pass line (before GST).
  price_inr       integer not null check (price_inr >= 0),
  max_per_day     integer check (max_per_day is null or max_per_day >= 1),
  starts_at       timestamptz not null default now(),
  -- The instant the day AFTER the last valid IST day begins (CP-D5).
  expires_at      timestamptz not null,
  -- 'refunded' = the sale was refunded (only possible unused); 'void' = an
  -- owner-side kill switch. Used-up and expired are NOT statuses — they are
  -- derived (v_coffee_pass_balances.state).
  status          text not null default 'active' check (status in ('active', 'refunded', 'void')),
  -- The order's created_by: the staffer who sold it. NULL for an online sale.
  issued_by       uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint coffee_passes_window check (expires_at > starts_at)
);
create index if not exists coffee_passes_user_expires on coffee_passes (user_id, expires_at);

-- ── Redemptions: drinks spent, one row per (order line, pass) ───────────────
create table if not exists coffee_pass_redemptions (
  id              uuid primary key default gen_random_uuid(),
  pass_id         uuid not null references coffee_passes(id) on delete cascade,
  order_id        uuid not null references orders(id) on delete cascade,
  order_item_id   uuid not null references order_items(id) on delete cascade,
  drinks          integer not null check (drinks > 0),
  -- Rupees of the line those drinks covered (≤ drinks × the pass's drink value).
  covered_inr     integer not null check (covered_inr >= 0),
  -- The IST calendar day it was used on — what the daily cap counts.
  business_date   date not null,
  created_at      timestamptz not null default now(),
  -- A reversal is a mark, never a delete: the history stays, the drinks return.
  reversed_at     timestamptz,
  reversed_reason text,
  unique (order_item_id, pass_id)
);
create index if not exists coffee_pass_redemptions_pass on coffee_pass_redemptions (pass_id);
create index if not exists coffee_pass_redemptions_order on coffee_pass_redemptions (order_id);
-- What used_today and drinks_used read: the live (non-reversed) rows of a pass.
create index if not exists coffee_pass_redemptions_live
  on coffee_pass_redemptions (pass_id, business_date) where reversed_at is null;

-- ── Adjustments: the audit trail of manager changes and voids ───────────────
--   extend  +days on expires_at (manager)
--   credit  +drinks given back (manager; e.g. a spilt coffee on a covered order)
--   void    the pass was refunded before first use
--   unvoid  the refund failed and the pass was restored
create table if not exists coffee_pass_adjustments (
  id          uuid primary key default gen_random_uuid(),
  pass_id     uuid not null references coffee_passes(id) on delete cascade,
  kind        text not null check (kind in ('extend', 'credit', 'void', 'unvoid')),
  days        integer check (days is null or days between 1 and 60),
  drinks      integer check (drinks is null or drinks >= 1),
  reason      text not null default '',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint coffee_pass_adjustments_shape check (
    (kind <> 'extend' or days is not null)
    and (kind <> 'credit' or drinks is not null)
    -- A person changing a pass must say why.
    and (kind in ('void', 'unvoid') or length(trim(reason)) > 0)
  )
);
create index if not exists coffee_pass_adjustments_pass on coffee_pass_adjustments (pass_id, created_at);

-- ── The derived balance ─────────────────────────────────────────────────────
--   drinks_used      non-reversed redemptions
--   drinks_credited  'credit' adjustments
--   drinks_remaining drinks_total + credited − used, never below 0
--   used_today       non-reversed drinks used on today's IST calendar day
--   state            refunded | void when the pass has that status;
--                    otherwise expired once now() ≥ expires_at;
--                    otherwise used_up when nothing is left; otherwise active
--
-- security_invoker: evaluated as the CALLER so the tables' RLS holds (see
-- 2026-08-view-security.sql for why a plain view would be a hole), plus the
-- explicit REVOKE below — either alone can be undone by a later replace.
create or replace view v_coffee_pass_balances
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

-- ===========================================================================
-- Functions. Each returns a text reason code instead of raising, so the API
-- can map a refusal to a readable 409 without parsing an exception message.
-- ===========================================================================

-- Redeem pass drinks against an order. The whole call commits or nothing does.
--   p_allocations: [{ "pass_id": uuid, "order_item_id": uuid,
--                     "drinks": int > 0, "covered_inr": int >= 0 }, ...]
-- The APP decides which lines and which passes (lib/passes/rules.ts
-- allocatePassDrinks); this re-checks every rule under a row lock so two
-- checkouts racing for the last drink cannot both win.
--   'ok'            redeemed — or already redeemed for this order (a retry)
--   'bad_input'     malformed allocations, or a line that is not on this order
--   'not_owner'     a pass is not p_user_id's (an unknown pass id reads the same)
--   'inactive'      a pass is refunded or void
--   'expired'       a pass has expired
--   'insufficient'  more drinks asked of a pass than it has left
--   'daily_limit'   the pass's per-day cap would be exceeded (IST day)
create or replace function public.coffee_pass_redeem(
  p_user_id uuid, p_order_id uuid, p_allocations jsonb
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pass    record;
  v_want    integer;
  v_left    integer;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_used_today integer;
  v_pass_ids uuid[];
begin
  if p_user_id is null or p_order_id is null
     or p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    return 'bad_input';
  end if;

  -- Shape check, done by pattern rather than by cast so a malformed value is a
  -- code, never an exception: uuids as strings, counts as whole JSON numbers.
  if exists (
    select 1
      from jsonb_array_elements(p_allocations) e
     where jsonb_typeof(e) <> 'object'
        or jsonb_typeof(e -> 'pass_id') is distinct from 'string'
        or (e ->> 'pass_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(e -> 'order_item_id') is distinct from 'string'
        or (e ->> 'order_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(e -> 'drinks') is distinct from 'number'
        or (e ->> 'drinks') !~ '^[0-9]{1,6}$'
        or jsonb_typeof(e -> 'covered_inr') is distinct from 'number'
        or (e ->> 'covered_inr') !~ '^[0-9]{1,9}$'
  ) then
    return 'bad_input';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_allocations) e where (e ->> 'drinks')::integer < 1
  ) then
    return 'bad_input';
  end if;

  -- Every line must be on THIS order, and no line may spend more drinks than
  -- it has units. (A pass and a line of some other order must never meet.)
  if exists (
    select 1
      from (
        select (e ->> 'order_item_id')::uuid as order_item_id,
               sum((e ->> 'drinks')::integer) as drinks
          from jsonb_array_elements(p_allocations) e
         group by 1
      ) a
      left join public.order_items oi
             on oi.id = a.order_item_id and oi.order_id = p_order_id
     where oi.id is null or a.drinks > oi.quantity
  ) then
    return 'bad_input';
  end if;

  -- One redemption call per order at a time, so a retried request that races
  -- its own first attempt waits, then sees the rows below and returns 'ok'
  -- instead of tripping the (order_item_id, pass_id) unique key.
  perform pg_advisory_xact_lock(hashtext('coffee_pass_redeem:' || p_order_id::text));
  if exists (select 1 from public.coffee_pass_redemptions where order_id = p_order_id) then
    return 'ok';
  end if;

  select coalesce(array_agg(distinct (e ->> 'pass_id')::uuid), '{}')
    into v_pass_ids
    from jsonb_array_elements(p_allocations) e;

  -- A pass that does not exist cannot be locked, so it is never seen below.
  if (select count(*) from public.coffee_passes where id = any(v_pass_ids))
       <> coalesce(array_length(v_pass_ids, 1), 0) then
    return 'not_owner';
  end if;

  -- Lock the passes in id order: two orders naming the same passes in
  -- different orders cannot deadlock. ORDER BY sits under the row lock, so
  -- rows are locked in the order they are returned.
  for v_pass in
    select * from public.coffee_passes
     where id = any(v_pass_ids)
     order by id
       for update
  loop
    if v_pass.user_id is distinct from p_user_id then
      return 'not_owner';
    end if;
    if v_pass.status <> 'active' then
      return 'inactive';
    end if;
    if now() >= v_pass.expires_at then
      return 'expired';
    end if;

    select coalesce(sum((e ->> 'drinks')::integer), 0)
      into v_want
      from jsonb_array_elements(p_allocations) e
     where (e ->> 'pass_id')::uuid = v_pass.id;

    select v_pass.drinks_total
           + coalesce((select sum(x.drinks) from public.coffee_pass_adjustments x
                        where x.pass_id = v_pass.id and x.kind = 'credit'), 0)
           - coalesce((select sum(r.drinks) from public.coffee_pass_redemptions r
                        where r.pass_id = v_pass.id and r.reversed_at is null), 0)
      into v_left;
    if v_want > v_left then
      return 'insufficient';
    end if;

    if v_pass.max_per_day is not null then
      select coalesce(sum(r.drinks), 0)
        into v_used_today
        from public.coffee_pass_redemptions r
       where r.pass_id = v_pass.id and r.reversed_at is null and r.business_date = v_today;
      if v_used_today + v_want > v_pass.max_per_day then
        return 'daily_limit';
      end if;
    end if;
  end loop;

  -- Everything checked out: write. A (line, pass) pair named twice is merged.
  insert into public.coffee_pass_redemptions
    (pass_id, order_id, order_item_id, drinks, covered_inr, business_date)
  select (e ->> 'pass_id')::uuid, p_order_id, (e ->> 'order_item_id')::uuid,
         sum((e ->> 'drinks')::integer), sum((e ->> 'covered_inr')::integer), v_today
    from jsonb_array_elements(p_allocations) e
   group by (e ->> 'pass_id')::uuid, (e ->> 'order_item_id')::uuid;

  return 'ok';
end $$;

-- A manager or the owner changes a pass. Every change is audited.
--   'extend'  expires_at moves by p_days whole IST days (1..60)
--   'credit'  p_drinks (1..drinks_total) are given back
-- Nobody can take drinks away except by redemption (CP-D16).
--   'ok' | 'bad_input' | 'not_found' | 'inactive' (refunded or void)
create or replace function public.coffee_pass_adjust(
  p_pass_id uuid, p_kind text, p_days integer, p_drinks integer, p_reason text, p_actor uuid
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pass public.coffee_passes%rowtype;
  v_reason text := trim(coalesce(p_reason, ''));
begin
  if p_pass_id is null or v_reason = '' or p_kind is null or p_kind not in ('extend', 'credit') then
    return 'bad_input';
  end if;
  if p_kind = 'extend' and (p_days is null or p_days < 1 or p_days > 60) then
    return 'bad_input';
  end if;
  if p_kind = 'credit' and (p_drinks is null or p_drinks < 1) then
    return 'bad_input';
  end if;

  select * into v_pass from public.coffee_passes where id = p_pass_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_pass.status <> 'active' then
    return 'inactive';
  end if;

  if p_kind = 'extend' then
    -- Whole IST calendar days, so the pass still ends at an IST midnight.
    update public.coffee_passes
       set expires_at = ((expires_at at time zone 'Asia/Kolkata') + make_interval(days => p_days))
                          at time zone 'Asia/Kolkata'
     where id = p_pass_id;
    insert into public.coffee_pass_adjustments (pass_id, kind, days, reason, created_by)
    values (p_pass_id, 'extend', p_days, v_reason, p_actor);
  else
    if p_drinks > v_pass.drinks_total then
      return 'bad_input';
    end if;
    insert into public.coffee_pass_adjustments (pass_id, kind, drinks, reason, created_by)
    values (p_pass_id, 'credit', p_drinks, v_reason, p_actor);
  end if;
  return 'ok';
end $$;

-- Refunding a pass (CP-D15): void it BEFORE the money moves, so a drink cannot
-- be spent while the refund is in flight. Refused once any drink is used.
--   'ok' | 'not_found' (no pass for that order) | 'already' (already refunded
--   or void) | 'used' (a non-reversed redemption exists)
create or replace function public.coffee_pass_void_for_refund(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pass public.coffee_passes%rowtype;
begin
  select * into v_pass from public.coffee_passes where order_id = p_order_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_pass.status <> 'active' then
    return 'already';
  end if;
  if exists (
    select 1 from public.coffee_pass_redemptions
     where pass_id = v_pass.id and reversed_at is null
  ) then
    return 'used';
  end if;
  update public.coffee_passes set status = 'refunded' where id = v_pass.id;
  insert into public.coffee_pass_adjustments (pass_id, kind, reason)
  values (v_pass.id, 'void', 'Refunded before first use');
  return 'ok';
end $$;

-- Compensation when the refund's money step failed after the pass was voided:
-- the pass goes back to 'active', but ONLY while the sale order still says
-- 'paid' — if the money did move (or partly), the pass stays refunded.
--   'ok' | 'not_found' | 'not_voided' (the pass is not 'refunded')
--   | 'order_refunded' (the sale order is no longer 'paid')
create or replace function public.coffee_pass_restore_after_failed_refund(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pass public.coffee_passes%rowtype;
  v_paid boolean;
begin
  select * into v_pass from public.coffee_passes where order_id = p_order_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_pass.status <> 'refunded' then
    return 'not_voided';
  end if;
  select (o.payment_status = 'paid') into v_paid from public.orders o where o.id = p_order_id;
  if v_paid is not true then
    return 'order_refunded';
  end if;
  update public.coffee_passes set status = 'active' where id = v_pass.id;
  insert into public.coffee_pass_adjustments (pass_id, kind, reason)
  values (v_pass.id, 'unvoid', 'Refund failed — pass restored');
  return 'ok';
end $$;

-- ===========================================================================
-- Triggers — the part no route can forget.
-- ===========================================================================

-- 1. BEFORE: a pass-sale order that becomes paid is finished the moment it is
--    paid. There is nothing to cook, so it must never appear on the kitchen
--    board. Bumps orders.version like every other transition, so an
--    optimistic-concurrency writer holding the old version loses cleanly.
--    (Named trg_coffee_… so it fires before trg_orders_paid_at and
--    trg_orders_updated_at, which are alphabetical.)
create or replace function public.coffee_pass_complete_on_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.order_kind = 'coffee_pass'
     and new.payment_status = 'paid'
     and (tg_op = 'INSERT' or old.payment_status is distinct from 'paid')
     and new.status::text not in ('completed', 'rejected', 'cancelled') then
    new.status := 'completed';
    if tg_op = 'UPDATE' then
      new.version := old.version + 1;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_coffee_pass_complete_on_paid on orders;
create trigger trg_coffee_pass_complete_on_paid
  before insert or update of payment_status on orders
  for each row execute function public.coffee_pass_complete_on_paid();

-- 2. AFTER: issue the pass. The plan comes from the order's pass line
--    (order_items.coffee_pass_plan_id); the price snapshot is what that line
--    actually charged. The pass goes to the order's account —
--    customer_user_id (the account a counter sale was linked to) or user_id
--    (the session that bought online). With no account there is nobody to give
--    it to: warn loudly and issue nothing (the routes refuse such a sale, so
--    this is a backstop, not a path). expires_at is the start of the IST day
--    AFTER the last valid day (CP-D5): bought Monday with 7 days → valid
--    through Sunday 23:59 → expires Monday 00:00 IST.
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
begin
  if new.order_kind is distinct from 'coffee_pass'
     or new.payment_status is distinct from 'paid'
     or (tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid') then
    return null;
  end if;

  select oi.coffee_pass_plan_id, oi.line_total_inr
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

  insert into public.coffee_passes (
    user_id, plan_id, order_id, plan_name, drinks_total, drink_value_inr, price_inr,
    max_per_day, starts_at, expires_at, issued_by
  ) values (
    v_user, v_plan.id, new.id, v_plan.name, v_plan.drinks_total, v_plan.drink_value_inr,
    v_line.line_total_inr, v_plan.max_per_day, now(),
    (((now() at time zone 'Asia/Kolkata')::date + v_plan.validity_days)::timestamp)
      at time zone 'Asia/Kolkata',
    new.created_by
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

drop trigger if exists trg_coffee_pass_issue_on_paid on orders;
create trigger trg_coffee_pass_issue_on_paid
  after insert or update of payment_status on orders
  for each row execute function public.coffee_pass_issue_on_paid();

-- 3. AFTER: drinks come back on their own (CP-D14). A menu order that is
--    rejected or cancelled, or that is FULLY refunded, gives back every drink
--    it spent — whichever route did it, so no route can forget. A partial
--    refund returns nothing. A reversal is a mark on the row, so the history
--    stays and the derived balance simply counts it again.
--    A pass-sale order that is fully refunded voids its pass: the safety net
--    for any refund path that did not go through coffee_pass_void_for_refund.
create or replace function public.coffee_pass_return_on_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_pass_id uuid;
begin
  if new.order_kind = 'menu' then
    if new.status::text in ('rejected', 'cancelled') and old.status is distinct from new.status then
      v_reason := case when new.status::text = 'rejected' then 'Order rejected' else 'Order cancelled' end;
    elsif new.payment_status = 'refunded' and old.payment_status is distinct from 'refunded' then
      v_reason := 'Order fully refunded';
    end if;
    if v_reason is not null then
      update public.coffee_pass_redemptions
         set reversed_at = now(), reversed_reason = v_reason
       where order_id = new.id and reversed_at is null;
    end if;
  elsif new.order_kind = 'coffee_pass'
        and new.payment_status = 'refunded' and old.payment_status is distinct from 'refunded' then
    update public.coffee_passes set status = 'refunded'
     where order_id = new.id and status = 'active'
    returning id into v_pass_id;
    if v_pass_id is not null then
      insert into public.coffee_pass_adjustments (pass_id, kind, reason)
      values (v_pass_id, 'void', 'Sale refunded');
    end if;
  end if;
  return null;
end $$;

drop trigger if exists trg_coffee_pass_return_on_order on orders;
create trigger trg_coffee_pass_return_on_order
  after update of status, payment_status on orders
  for each row
  when (old.status is distinct from new.status or old.payment_status is distinct from new.payment_status)
  execute function public.coffee_pass_return_on_order();

-- 4. AFTER: a redeemed line that is voided (running-tab void) gives its
--    drinks back.
create or replace function public.coffee_pass_return_on_void()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.voided and not old.voided then
    update public.coffee_pass_redemptions
       set reversed_at = now(), reversed_reason = 'Line voided'
     where order_item_id = new.id and reversed_at is null;
  end if;
  return null;
end $$;

drop trigger if exists trg_coffee_pass_return_on_void on order_items;
create trigger trg_coffee_pass_return_on_void
  after update of voided on order_items
  for each row
  when (old.voided is distinct from new.voided)
  execute function public.coffee_pass_return_on_void();

-- ── Permissions and seeds ───────────────────────────────────────────────────
-- MIRROR IN lib/permissions.ts + lib/types.ts.
-- Selling a pass at the counter is routine (staff); extending or giving back
-- drinks is a money decision (manager). Plans and eligibility are owner-only
-- and need no key.
insert into role_permissions (permission_key, min_role) values
  ('pass_sell',   'staff'),
  ('pass_manage', 'manager')
on conflict (permission_key) do nothing;

-- The two plans the cafe asked for, INACTIVE with placeholder prices: nothing
-- is sold until the owner confirms them (spec §9 B1-B4) and switches them on.
-- Inserted by name so a re-run never duplicates one, and never overwrites an
-- edit the owner has made since.
insert into coffee_pass_plans
  (name, description, drinks_total, drinks_paid, validity_days, drink_value_inr, price_inr,
   max_per_day, gst_exempt, is_active, sort_order)
select 'Weekly Ritual',
       '7 cups for the price of 5 — valid 7 days',
       7, 5, 7, 150, 750, null, false, false, 10
 where not exists (
   select 1 from coffee_pass_plans where lower(trim(name)) = lower('Weekly Ritual')
 );
insert into coffee_pass_plans
  (name, description, drinks_total, drinks_paid, validity_days, drink_value_inr, price_inr,
   max_per_day, gst_exempt, is_active, sort_order)
select 'Monthly Ritual',
       'Pay for 6, get 7 — valid 30 days',
       7, 6, 30, 150, 900, null, false, false, 20
 where not exists (
   select 1 from coffee_pass_plans where lower(trim(name)) = lower('Monthly Ritual')
 );

-- ── Lock down ───────────────────────────────────────────────────────────────
alter table coffee_pass_plans       enable row level security;
alter table coffee_passes           enable row level security;
alter table coffee_pass_redemptions enable row level security;
alter table coffee_pass_adjustments enable row level security;
revoke all on coffee_pass_plans       from anon, authenticated;
revoke all on coffee_passes           from anon, authenticated;
revoke all on coffee_pass_redemptions from anon, authenticated;
revoke all on coffee_pass_adjustments from anon, authenticated;
revoke all on v_coffee_pass_balances  from anon, authenticated;

revoke execute on function public.coffee_pass_redeem(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.coffee_pass_adjust(uuid, text, integer, integer, text, uuid) from public, anon, authenticated;
revoke execute on function public.coffee_pass_void_for_refund(uuid) from public, anon, authenticated;
revoke execute on function public.coffee_pass_restore_after_failed_refund(uuid) from public, anon, authenticated;
revoke execute on function public.coffee_pass_complete_on_paid() from public, anon, authenticated;
revoke execute on function public.coffee_pass_issue_on_paid() from public, anon, authenticated;
revoke execute on function public.coffee_pass_return_on_order() from public, anon, authenticated;
revoke execute on function public.coffee_pass_return_on_void() from public, anon, authenticated;
grant execute on function public.coffee_pass_redeem(uuid, uuid, jsonb) to service_role;
grant execute on function public.coffee_pass_adjust(uuid, text, integer, integer, text, uuid) to service_role;
grant execute on function public.coffee_pass_void_for_refund(uuid) to service_role;
grant execute on function public.coffee_pass_restore_after_failed_refund(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- 4 tables, 1 view, 8 functions, 5 triggers (4 of the spec's, plus the plans updated_at):
--   select relname from pg_class
--    where relname in ('coffee_pass_plans', 'coffee_passes', 'coffee_pass_redemptions',
--                      'coffee_pass_adjustments', 'v_coffee_pass_balances');            -- 5 rows
--   select proname from pg_proc where proname like 'coffee_pass_%';                     -- 8 rows
--   select tgname from pg_trigger where tgname like 'trg_coffee_pass_%' and not tgisinternal;  -- 5 rows
--
--   -- both seeded plans are there, and OFF until the owner switches them on:
--   select name, drinks_total, drinks_paid, validity_days, drink_value_inr, price_inr, is_active
--     from coffee_pass_plans order by sort_order;
--   -- the columns added to existing tables (6 rows):
--   select table_name, column_name from information_schema.columns
--    where (table_name = 'orders'      and column_name in ('order_kind', 'pass_discount_inr'))
--       or (table_name = 'order_items' and column_name in ('pass_drinks', 'pass_covered_inr', 'coffee_pass_plan_id'))
--       or (table_name = 'menu_items'  and column_name = 'pass_eligible');
--   select permission_key, min_role from role_permissions where permission_key like 'pass_%';
--
--   -- the view is security_invoker (expect 'true'):
--   select option_value from pg_options_to_table(
--     (select reloptions from pg_class where relname = 'v_coffee_pass_balances'))
--    where option_name = 'security_invoker';
--
--   -- anon and authenticated must not see or call anything (each fails with
--   -- "permission denied"):
--   set role anon;          select * from coffee_passes;
--                           select * from v_coffee_pass_balances;
--                           select public.coffee_pass_void_for_refund(gen_random_uuid());   reset role;
--
--   -- drinks left on every live pass:
--   select plan_name, drinks_total, drinks_used, drinks_credited, drinks_remaining, used_today,
--          state, expires_at at time zone 'Asia/Kolkata' as expires_ist
--     from v_coffee_pass_balances order by created_at desc limit 20;
--
--   -- outstanding liability (drinks left × what the customer paid per drink):
--   select round(sum(drinks_remaining * (price_inr::numeric / drinks_total))) as liability_inr
--     from v_coffee_pass_balances where state = 'active';
-- ---------------------------------------------------------------------------
