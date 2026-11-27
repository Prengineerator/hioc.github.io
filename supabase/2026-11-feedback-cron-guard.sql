-- ===========================================================================
-- Feedback poll: call the site only when there is a feedback request to send.
--
-- supabase/2026-10-order-feedback.sql schedules `feedback-requests-poll` to
-- POST https://hioc.in/api/cron/feedback-requests every 5 minutes: 288 calls a
-- day, each a Vercel function invocation, which count against the plan's
-- monthly allowance. On most of them the route has nothing to do. With
-- feedback switched off (store_settings.feedback_enabled = false, as it is in
-- production today) it returns at once; with it on and nothing due,
-- claim_feedback_requests() claims no rows and it returns.
--
-- This reschedules the same job with the same URL, headers and body, behind a
-- check the database can answer for free: feedback is on AND a request is due
-- under exactly the rule claim_feedback_requests() claims by (status
-- 'pending', scheduled_for <= now(), not claimed in the last 10 minutes). When
-- the check is false, Postgres skips the SELECT list, so net.http_post never
-- runs (the plan is a Result node with a One-Time Filter). When it is true the
-- job behaves exactly as before. A request that falls due is still sent within
-- 5 minutes, and requests that piled up while feedback was off still go out on
-- the first run after it is switched back on.
--
-- Same Vault entry (`cron_secret`), same job owner notes as the original
-- migration. Idempotent: the existing job is unscheduled, then scheduled again.
-- ===========================================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'feedback-requests-poll') then
    perform cron.unschedule('feedback-requests-poll');
  end if;
end $$;

select cron.schedule(
  'feedback-requests-poll',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://hioc.in/api/cron/feedback-requests',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'cron_secret'
        limit 1
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  where exists (select 1 from public.store_settings where feedback_enabled)
    and exists (
      select 1 from public.feedback_requests
      where status = 'pending'
        and scheduled_for <= now()
        and (claimed_at is null or claimed_at < now() - interval '10 minutes')
    );
  $$
);

-- ===========================================================================
-- Verify
-- ===========================================================================
--   select jobname, schedule, active, command from cron.job
--    where jobname = 'feedback-requests-poll';
--   -- expect the command to end with the two `exists` checks
--
--   -- with feedback off or nothing due, runs succeed and send nothing:
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'feedback-requests-poll')
--    order by start_time desc limit 5;
--   select count(*) from net._http_response where created > now() - interval '1 hour';
