-- ===========================================================================
-- Beanies account update on WhatsApp (docs/BEANIES-UPDATE-SPEC.md)
--
-- RUN THIS ON: Supabase project "Hioc India" (SQL editor). Never on Hioc Coffee.
--
-- What it does:
--   Widens the notifications delivery-log CHECK (notifications_event_check) so
--   `event` also accepts 'beanies'. Each Beanies account update the café sends
--   after an order that earned Beanies is logged under that event, one per
--   order, so a failed or skipped send can be traced like a bill and is never
--   sent twice (notifications is UNIQUE on order_id, event, channel).
--
-- The allowed events become exactly:
--   accepted, ready, rejected, cancelled, bill, feedback, beanies
--
-- 'feedback' is kept on purpose. The live database already allows it, but no
-- migration on main adds it yet (open pull request #75 would). Listing it here
-- means this file is correct whether or not that one has been applied.
-- ORDER NOTE: apply this file AFTER the feedback one if both are going in. If
-- the feedback file were run second, it would put the constraint back without
-- 'beanies' and the Beanies sends would be refused until this file is re-run
-- (re-running is harmless).
--
-- Nothing else changes: no table, column, policy or data is touched. Existing
-- rows already use only the older values, so the new CHECK validates cleanly.
--
-- Safe to run twice: the drop is `if exists`, and drop + add run in one
-- transaction so the table is never left without the constraint.
--
-- Safe to apply before OR after deploying the code. Until it is applied, the
-- Beanies log insert is refused by the CHECK; the send is best-effort and the
-- bill and order flow are not affected. The previous build never writes
-- 'beanies', so it keeps working on the new schema.
--
-- What the owner sees once applied: nothing new on screen. Beanies updates
-- begin to appear in the delivery log once the WhatsApp template is approved.
-- ===========================================================================

begin;

alter table notifications drop constraint if exists notifications_event_check;
alter table notifications add constraint notifications_event_check
  check (event in ('accepted', 'ready', 'rejected', 'cancelled', 'bill', 'feedback', 'beanies'));

commit;

-- Verify: (read-only, run after applying)
--
-- 1. The constraint lists all seven events. Expect one row whose definition
--    contains accepted, ready, rejected, cancelled, bill, feedback and beanies:
--      select pg_get_constraintdef(oid)
--        from pg_constraint
--       where conrelid = 'public.notifications'::regclass
--         and conname = 'notifications_event_check';
--
-- 2. Only one constraint of that name exists. Expect 1:
--      select count(*) from pg_constraint
--       where conrelid = 'public.notifications'::regclass
--         and conname = 'notifications_event_check';
--
-- 3. No existing row breaks the rule. Expect 0 rows:
--      select distinct event from notifications
--       where event not in ('accepted','ready','rejected','cancelled','bill','feedback','beanies');
