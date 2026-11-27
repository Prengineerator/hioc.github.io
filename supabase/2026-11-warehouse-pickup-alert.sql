-- ===========================================================================
-- Delivery person's WhatsApp list (docs/WAREHOUSE-SPEC.md, WH-D17).
--
-- When the owner or a manager chooses who brings a warehouse stock request to
-- the store, that person gets one WhatsApp message with the list of items.
-- Every attempt to send it is logged in warehouse_alerts, like the owner's
-- alerts, as an event named 'pickup_assigned' on channel 'whatsapp'.
--
-- warehouse_alerts.event only allowed request_placed, return_sent and
-- arrived_different, so a 'pickup_assigned' row would have been refused. This
-- file widens that one CHECK to also allow 'pickup_assigned'. Nothing else
-- changes: no table, column, index, policy or grant is added or altered.
--
--   * The unique index warehouse_alerts_sent_once (event, request_id, channel,
--     to_address) where status = 'sent' already covers the new event as it is:
--     a number is never sent the same request's list twice.
--   * warehouse_alerts keeps its lockdown (RLS on, no policies, all privileges
--     revoked from anon and authenticated); only the server (service role)
--     writes and reads it.
--   * Re-running supabase/2026-11-warehouse.sql afterwards does NOT bring the
--     old three-value CHECK back: that file's create table if not exists
--     does nothing once the table exists.
--
-- Run this after 2026-11-warehouse.sql. What the owner sees: nothing changes on
-- screen until the app that sends the message is live; then each attempt shows
-- in the warehouse Alerts tab.
--
-- Until this file is applied, an insert of a 'pickup_assigned' row fails with
-- Postgres error 23514 (check_violation, constraint warehouse_alerts_event_check).
-- The older app never writes that event, so it is unaffected either way.
--
-- Additive (only widens a CHECK) and safe to re-run. The table is tiny, so the
-- brief lock while the CHECK is swapped is not noticeable.
-- ===========================================================================

do $$
declare
  v_name text;
  v_def  text;
begin
  -- The CHECK on the event column, found by what it says (the base file left it
  -- unnamed, so Postgres named it; do not rely on that name).
  select c.conname, pg_get_constraintdef(c.oid)
    into v_name, v_def
    from pg_constraint c
   where c.conrelid = 'warehouse_alerts'::regclass
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%request_placed%'
   limit 1;

  if v_name is not null and v_def like '%pickup_assigned%' then
    return;  -- already widened: nothing to do
  end if;

  if v_name is not null then
    execute format('alter table warehouse_alerts drop constraint %I', v_name);
  end if;

  alter table warehouse_alerts
    add constraint warehouse_alerts_event_check
    check (event in ('request_placed', 'return_sent', 'arrived_different', 'pickup_assigned'));
end $$;

-- Verify (read-only; run after applying, on Hioc India):
--
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'warehouse_alerts'::regclass and contype = 'c'
--      and pg_get_constraintdef(oid) like '%request_placed%';
--   -- one row, listing request_placed, return_sent, arrived_different and
--   -- pickup_assigned.
--
--   select indexdef from pg_indexes
--    where tablename = 'warehouse_alerts' and indexname = 'warehouse_alerts_sent_once';
--   -- one row: unique, on (event, request_id, channel, to_address), where status = 'sent'.
--
--   select relrowsecurity,
--          has_table_privilege('anon', 'warehouse_alerts', 'select') as anon_can_read,
--          has_table_privilege('authenticated', 'warehouse_alerts', 'select') as auth_can_read
--     from pg_class where oid = 'warehouse_alerts'::regclass;
--   -- true, false, false (unchanged).
