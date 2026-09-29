-- Backfill: categorise store expenses that were entered as a plain Cash out
-- before the Expenses option existed (owner request, 2026-09-29).
--
-- Run AFTER supabase/2026-10-cash-expenses.sql. Only touches cash_movements
-- rows that are direction 'out' AND still uncategorised, and matches on the
-- reason the manager typed. First matching rule wins. It never touches:
--   * the day-close handover row ('Day close handover …'),
--   * money to the owner / bank deposits / float or change / salary advances —
--     those are real cash-outs, not store expenses.
-- Anything no rule recognises stays a plain Cash out; the owner can tag it by
-- hand on the owner Cash screen.
--
-- The drawer math does not change: the row is already a cash-out, the
-- category only says where the money went. Idempotent: safe to re-run.
--
-- STEP 1 (dry run) — see what would be tagged, and what stays a cash-out:
--
--   select id, created_at, amount_inr, reason, cash_expense_category_guess(reason) as guess
--     from cash_movements
--    where direction = 'out' and category is null
--    order by created_at;
--
-- STEP 2 — apply (the UPDATE at the bottom of this file).

create or replace function cash_expense_category_guess(reason text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case
    when r is null or r = '' then null
    -- Never an expense: handover, owner/bank, float/change, staff pay.
    when r ~ '^day close handover'                                   then null
    when r ~ '\m(owner|bank|deposit|float|change|salary|advance|payout|withdraw\w*)\M' then null
    -- Store expenses, most specific first.
    when r ~ '\m(ice|ice ?cubes?|baraf|barf)\M'                       then 'ice'
    when r ~ '\m(water|bisleri|kinley|aquafina|pani|paani)\M'         then 'water'
    when r ~ '\m(milk|doodh|dudh|curd|dahi|paneer|butter|cream|amul|dairy)\M' then 'milk_dairy'
    when r ~ '\m(gas|cylinder|lpg|petrol|diesel|fuel)\M'              then 'gas_fuel'
    when r ~ '\m(clean\w*|phenyl|detergent|soap|harpic|tissues?|broom|mop|garbage|dustbin)\M' then 'cleaning'
    when r ~ '\m(packag\w*|parcel|boxe?s?|containers?|straws?|carry ?bags?|foil)\M' then 'packaging'
    when r ~ '\m(auto|rickshaw|rapido|uber|ola|porter|transport|courier|travel|fare)\M' then 'transport'
    when r ~ '\m(repair\w*|plumber|electrician|mechanic|maintenance|servic\w*)\M' then 'repairs'
    when r ~ '\m(staff (food|meal|lunch|dinner|tea)|lunch|dinner|breakfast|snacks?)\M' then 'staff_food'
    when r ~ '\m(grocer\w*|vegetables?|veggies|sabzi|sabji|fruits?|lemons?|nimbu|sugar|bread|eggs?|onions?|tomato\w*|masala)\M' then 'groceries'
    else null
  end
  from (select lower(trim(reason)) as r) s
$$;
-- Maintenance helper only: not an API for the app's clients.
revoke execute on function cash_expense_category_guess(text) from public, anon, authenticated;

-- A manager already recorded these, before approval existed: file them as
-- approved (approved_by NULL = approved by this backfill), not pending.
update cash_movements
   set category = cash_expense_category_guess(reason),
       approved_at = coalesce(approved_at, now())
 where direction = 'out'
   and category is null
   and cash_expense_category_guess(reason) is not null;

-- Closed days froze no expense total before this feature: fill it in from the
-- movements now categorised, over the same (opened_at, closed_at] window the
-- drawer math uses (lib/cash/checkpoints.ts).
update cash_days d
   set expenses_inr = (
         select coalesce(sum(m.amount_inr), 0)
           from cash_movements m
          where m.direction = 'out'
            and m.category is not null
            and m.voided_at is null
            and m.created_at > d.opened_at
            and m.created_at <= d.closed_at
       )
 where d.status = 'closed'
   and d.closed_at is not null;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- what got tagged
--   select category, count(*), sum(amount_inr) from cash_movements
--    where category is not null group by category order by 3 desc;
--   -- what is still a plain cash-out (tag the real expenses by hand)
--   select created_at, amount_inr, reason from cash_movements
--    where direction = 'out' and category is null order by created_at desc;
-- ---------------------------------------------------------------------------
