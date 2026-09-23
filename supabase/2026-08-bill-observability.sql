-- ===========================================================================
-- Phase 4 · BILL-3 / BILL-5 — make a bill that DIDN'T send visible.
--
-- Until now the notification engine skipped a channel silently: no phone, or a
-- missing env var, and nothing was written at all. "Why didn't this customer
-- get their bill?" was unanswerable from the data. A skip is now a first-class
-- logged outcome with a reason.
--
-- Safe to re-run. Apply BEFORE deploying the Phase-4 notification engine — the
-- engine writes status='skipped', which the old CHECK constraint rejects.
-- ===========================================================================

-- 1. 'skipped' joins the delivery-status vocabulary.
alter table notifications drop constraint if exists notifications_status_check;
alter table notifications add constraint notifications_status_check
  check (status in ('queued', 'sent', 'failed', 'skipped'));

-- 2. Why it was skipped — machine-readable, e.g.
--    'no_phone' | 'no_email' | 'not_configured:WHATSAPP_TPL_BILL'
alter table notifications add column if not exists skip_reason text not null default '';

-- 3. The owner delivery log (BILL-5) reads newest-first, usually filtered to the
--    'bill' event or to failures.
create index if not exists idx_notifications_created on notifications (created_at desc);
create index if not exists idx_notifications_event on notifications (event);

-- ---------------------------------------------------------------------------
-- Verify:
--   select status, count(*) from notifications group by status;
--   select event, channel, status, skip_reason, error
--     from notifications where event = 'bill' order by created_at desc limit 20;
-- ---------------------------------------------------------------------------
