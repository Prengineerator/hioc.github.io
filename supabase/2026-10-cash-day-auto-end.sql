-- A cash day nobody closed ends on its own (owner request, 2026-10-07).
--
-- A day still open at 3:00 am IST the morning after its date has ENDED: its
-- figures stop at 3:00 am, and the counter asks the next person who logs in to
-- count the drawer and close it, then to open the new day. The rule lives in
-- the app (lib/cash/autoEnd.ts) and needs nothing from the database; this
-- column only RECORDS that a day ended on its own, for the owner's report and
-- the cash day log. It is written by the 3 am job (/api/cron/end-cash-day) or,
-- if that has not run, by the close.
--
-- Additive and idempotent: safe to re-run, and safe to apply before or after
-- the code (the app reads and writes the column only where it exists).

alter table cash_days add column if not exists auto_ended_at timestamptz;

comment on column cash_days.auto_ended_at is
  'When the day ended on its own because nobody closed it (3:00 am IST the morning after business_date). NULL for a day closed by staff before then.';

-- Verify:
--   select business_date, status, auto_ended_at, closed_at from cash_days
--    order by opened_at desc limit 10;
