-- ===========================================================================
-- Expire abandoned online orders every 5 minutes (pg_cron + pg_net).
--
-- An online order that was started but never paid (status 'placed',
-- payment_status 'payment_pending') — a menu order or a HIOC Ritual pass-sale
-- order (order_kind = 'coffee_pass') — is auto-cancelled by
-- app/api/cron/expire-orders/route.ts once it is 30 minutes old, after asking
-- Razorpay whether it was actually paid (a paid-but-tab-closed order is
-- recovered into the staff queue, not cancelled). The Vercel plan only runs
-- crons daily, though (vercel.json: "0 3 * * *"), so until now those orders sat
-- "awaiting payment" for up to a day. Postgres can tick faster: pg_cron fires
-- every 5 minutes and pg_net sends the HTTP POST the way a Vercel Cron trigger
-- would, carrying the same CRON_SECRET Bearer token the route already checks —
-- read out of Vault, never hard-coded here. The daily Vercel cron stays as a
-- backstop.
--
-- The route accepts POST (app/api/cron/expire-orders/route.ts) —
-- net.http_post issues a POST, not a GET, so the route must export both.
--
-- Vault: the `cron_secret` entry must equal the CRON_SECRET setting in Vercel.
-- It already exists in production (the feedback-requests-poll job in
-- supabase/2026-10-order-feedback.sql reads the same entry); nothing to add.
--
-- Job ownership: `cron.schedule` records whichever role RUNS this migration as
-- the job's owner, and pg_cron executes the job AS that owner. Applied through
-- the SQL editor or the CLI this is `postgres`, which already has SELECT on
-- `vault.decrypted_secrets` and EXECUTE on `net.http_post`. If it is ever
-- applied through a more restricted role, re-check both grants — failures land
-- silently in `cron.job_run_details.return_message` (see Verify).
--
-- Idempotent: safe to re-run (any existing `expire-orders-poll` job is
-- unscheduled first, then scheduled again).
-- ===========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'expire-orders-poll') then
    perform cron.unschedule('expire-orders-poll');
  end if;
end $$;

select cron.schedule(
  'expire-orders-poll',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://hioc.in/api/cron/expire-orders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'cron_secret'
        limit 1
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ===========================================================================
-- Verify
-- ===========================================================================
--   -- the vault secret exists (it should already, from the feedback job):
--   select name from vault.secrets where name = 'cron_secret';
--
--   -- the cron job is scheduled:
--   select jobname, schedule, active from cron.job where jobname = 'expire-orders-poll';
--   -- expect: expire-orders-poll | */5 * * * * | t
--
--   -- the job has actually been firing (after a few minutes):
--   select jobid, status, return_message, start_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'expire-orders-poll')
--    order by start_time desc limit 5;
--
--   -- what the route answered (pg_net keeps responses for ~6 hours):
--   select id, status_code, created
--     from net._http_response
--    order by created desc limit 10;
--   -- expect status_code = 200. A 401 means Vault `cron_secret` does not match
--   -- Vercel's CRON_SECRET; a 405 means the deployed route lacks the POST export.
--
-- To undo:
--   select cron.unschedule('expire-orders-poll');
-- ===========================================================================
