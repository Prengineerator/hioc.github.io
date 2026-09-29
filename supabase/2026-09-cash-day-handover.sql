-- Cash day: Open -> Close -> Handover (owner request, 2026-09-29).
--
-- Production showed only ONE cash day ever opened, closed before the first
-- sale, and every later count "expecting" more and more cash because what was
-- taken home at night was never recorded. The day is now a real lifecycle:
--
--   OPEN     count the float by denomination and compare it with the float
--            left at the last close (per denomination + total). A difference
--            needs a reason, which is stored.
--   DURING   cash sales / refunds / cash-in / cash-out since opened_at.
--   CLOSE    count the drawer; expected = float + cash sales - cash refunds
--            + cash in - cash out over [opened_at, closed_at]. A variance
--            needs a reason. Blocked while orders created since opening are
--            still unpaid (a manager/owner can override with a reason).
--   HANDOVER "cash taken out" and "float left for tomorrow", by denomination
--            (taken out = counted - float left). Tomorrow's OPEN compares
--            against float_left_denoms.
--   REOPEN   a manager/owner can reopen the most recent closed day (mistaken
--            close) with a reason; each reopen is appended to reopen_log.
--
-- Every figure below is computed by the server from the raw denomination
-- counts and the day's payments; nothing here is a client-sent total.
--
-- Everything is additive: all new columns are nullable or defaulted, so the
-- rows already in cash_days stay valid (a legacy closed day simply has NULL
-- handover columns, and tomorrow's open then has nothing to compare against).
-- The drawer checkpoint chain (cash_counts) needs no schema change: the close
-- writes a cash_movements 'out' row for the handover so the next count does not
-- read the cash taken home as a shortage (see app/api/cash-days/route.ts).
--
-- One cash day per business date is no longer enforced: a café that closes for
-- an afternoon break, or reopens after a mistaken close, needs a second day
-- record on the same IST date. The real invariant - at most ONE OPEN day at a
-- time - stays enforced by idx_cash_days_one_open.
--
-- Idempotent: safe to re-run.

alter table cash_days
  -- OPEN: the float left at the previous close (NULL when there was none to
  -- compare against) and the difference the opener explained.
  add column if not exists open_expected_total_inr integer,
  add column if not exists open_variance_inr       integer,
  add column if not exists open_reason             text not null default '',
  -- CLOSE: the variance explanation (notes stays as a free-form handover note).
  add column if not exists close_reason            text not null default '',
  -- The day's flows over [opened_at, closed_at], frozen at close so the owner's
  -- history never re-derives them from orders that may later change.
  add column if not exists cash_sales_inr          integer,
  add column if not exists cash_sales_count        integer,
  add column if not exists cash_refunds_inr        integer,
  add column if not exists cash_in_inr             integer,
  add column if not exists cash_out_inr            integer,
  add column if not exists upi_inr                 integer,   -- information only
  add column if not exists card_inr                integer,   -- information only
  -- HANDOVER: cash_taken = counted - float left, by denomination.
  add column if not exists handover_inr            integer check (handover_inr is null or handover_inr >= 0),
  add column if not exists float_left_denoms       jsonb,
  add column if not exists float_left_total_inr    integer check (float_left_total_inr is null or float_left_total_inr >= 0),
  -- Closing with unpaid orders still open needs a manager/owner and a reason.
  add column if not exists unpaid_count_at_close   integer,
  add column if not exists unpaid_override_reason  text,
  -- REOPEN: the latest reopen, plus the whole history (each entry keeps the
  -- close it undid: { at, by, reason, prev_closed_at, prev_counted_inr, prev_handover_inr }).
  add column if not exists reopened_at             timestamptz,
  add column if not exists reopened_by             uuid references auth.users(id) on delete set null,
  add column if not exists reopen_reason           text,
  add column if not exists reopen_log              jsonb not null default '[]'::jsonb;

-- Drop the one-row-per-date unique constraint (whatever it is named).
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'public'
       and rel.relname = 'cash_days'
       and con.contype = 'u'
       and array_length(con.conkey, 1) = 1
       and exists (
         select 1 from pg_attribute a
          where a.attrelid = rel.oid
            and a.attnum = con.conkey[1]
            and a.attname = 'business_date'
       )
  loop
    execute format('alter table public.cash_days drop constraint %I', c.conname);
  end loop;
end $$;

-- "Latest day" lookups (reopen, float left at last close) and the owner log.
create index if not exists idx_cash_days_opened_at on cash_days (opened_at desc);
create index if not exists idx_cash_days_business_date on cash_days (business_date);

-- ---------------------------------------------------------------------------
-- Verify:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_name = 'cash_days'
--      and column_name in ('open_expected_total_inr', 'open_variance_inr', 'open_reason',
--                          'close_reason', 'cash_sales_inr', 'cash_sales_count', 'cash_refunds_inr', 'cash_in_inr',
--                          'cash_out_inr', 'upi_inr', 'card_inr', 'handover_inr',
--                          'float_left_denoms', 'float_left_total_inr', 'unpaid_count_at_close', 'unpaid_override_reason',
--                          'reopened_at', 'reopened_by', 'reopen_reason', 'reopen_log')
--    order by column_name;                         -- 20 rows
--
--   -- no unique constraint on business_date any more; the one-open index remains
--   select indexname from pg_indexes
--    where tablename = 'cash_days' order by indexname;
--
--   -- after a close: taken out + float left = counted, and the handover shows up
--   -- on the drawer chain as a cash-out
--   select business_date, counted_total_inr, handover_inr, float_left_total_inr,
--          counted_total_inr - coalesce(handover_inr, 0) - coalesce(float_left_total_inr, 0) as should_be_0
--     from cash_days where status = 'closed' and handover_inr is not null
--    order by opened_at desc limit 10;
--   select created_at, direction, amount_inr, reason
--     from cash_movements where reason like 'Day close handover%'
--    order by created_at desc limit 10;
--
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
