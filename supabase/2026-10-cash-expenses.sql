-- Store expenses from the cash drawer (owner request, 2026-09-29).
--
-- Ice cubes, water, a milk run — small things paid in cash at the counter.
-- Until now only a manager could record money leaving the drawer (Cash out), so
-- an expense the staff paid either went unrecorded (and read as a shortage at
-- the next count) or was never tracked at all (a cash leak).
--
-- An expense is a cash_movements row with direction 'out' and a CATEGORY.
-- Being a cash-out, the drawer chain (cash_counts) and the cash day's expected
-- cash already subtract it; the category tells the owner where it went. Plain
-- manager cash out / cash in rows keep category NULL.
--
-- Any staffer may punch an expense: permission key 'cash_expense', seeded at
-- 'staff' (the owner can raise it to manager). Categories are validated in the
-- app (lib/cash/expenses.ts), not by a CHECK, so adding one needs no migration.
--
-- Also freezes the day's expense total onto cash_days at close, like the other
-- flows, so the owner's history never re-derives it.
--
-- Additive and idempotent: safe to re-run. Apply BEFORE deploying the code —
-- POST /api/cash-expenses writes the category column.

alter table cash_movements add column if not exists category text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cash_movements_expense_is_out'
  ) then
    alter table cash_movements
      add constraint cash_movements_expense_is_out
      check (category is null or (direction = 'out' and length(trim(category)) > 0));
  end if;
end $$;

-- Approval + undo (owner request, 2026-09-29). A staffer's expense is PENDING
-- until a manager or the owner approves it; while pending, the person who
-- punched it (or a manager) can UNDO it, e.g. a wrong amount. Undo never
-- deletes: the row is voided (kept for the owner's audit trail) and every
-- reader of cash_movements skips voided rows, so it leaves the drawer math.
-- An approved expense cannot be undone. Undo is also refused once the drawer
-- has been counted or the day closed after the punch (that count already
-- reflected the money out) — lib/cash/expenses.ts undoProblem.
-- Pending expenses still count as money out: the cash really left the drawer.
alter table cash_movements
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists voided_by   uuid references auth.users(id) on delete set null,
  add column if not exists voided_at   timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cash_movements_expense_review_shape'
  ) then
    alter table cash_movements
      add constraint cash_movements_expense_review_shape
      check (
        (approved_at is null or voided_at is null)            -- never both
        and ((approved_at is null and voided_at is null) or category is not null)  -- expenses only
      );
  end if;
end $$;

create index if not exists cash_movements_expense_created
  on cash_movements (created_at desc) where category is not null;

-- The day's expenses over [opened_at, closed_at] (already inside cash_out_inr).
alter table cash_days add column if not exists expenses_inr integer
  check (expenses_inr is null or expenses_inr >= 0);

-- MIRROR IN lib/permissions.ts + lib/types.ts.
insert into role_permissions (permission_key, min_role) values
  ('cash_expense', 'staff')
on conflict (permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- Verify:
--   select column_name from information_schema.columns
--    where (table_name = 'cash_movements'
--           and column_name in ('category', 'approved_by', 'approved_at', 'voided_by', 'voided_at'))
--       or (table_name = 'cash_days' and column_name = 'expenses_inr');   -- 6 rows
--   select permission_key, min_role from role_permissions where permission_key = 'cash_expense';
--
--   -- this must FAIL (an expense is always money out):
--   -- insert into cash_movements (direction, amount_inr, reason, recorded_by, category)
--   --   values ('in', 10, 'test', '<uuid>', 'ice');
--
--   -- where the petty cash went, last 30 days:
--   select category, count(*), sum(amount_inr) from cash_movements
--    where category is not null and voided_at is null and created_at > now() - interval '30 days'
--    group by category order by 3 desc;
--
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
