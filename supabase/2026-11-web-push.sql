-- ===========================================================================
-- Offers as phone notifications / browser push (docs/WEB-PUSH-SPEC.md)
--
-- Run this in the Supabase SQL editor on the project "Hioc India" only.
--
-- Adds:
--   * push_subscriptions   one row per phone or browser a logged-in customer
--                          said yes on: the address the browser gave us for
--                          sending to it (endpoint) and its two keys. Deleted
--                          when the customer switches off, or when the push
--                          service answers 404/410.
--   * push_consent_events  append-only log of each yes and each switch-off.
--                          user_id is a plain uuid with NO foreign key, so
--                          deleting an account never erases the audit trail.
--                          Stores a hash of the endpoint, never the endpoint.
--   * push_sends           one row per push the owner sent from Owner →
--                          Marketing → Push (a broadcast or a test), with how
--                          many phones it reached and how many tapped it.
--
-- One broadcast per IST day is enforced HERE, by a partial unique index on
-- push_sends (sent_on) where kind = 'broadcast'. sent_on is the IST calendar
-- day, computed by the server (lib/api/date.ts), not by the database. A second
-- broadcast the same day fails with a unique violation (23505).
--
-- Access: RLS ON and NO policies on all three tables, with explicit REVOKEs,
-- like owner_report_settings. Only the service role reads or writes them;
-- customers reach their own rows only through the API routes, including the
-- click counter (the route adds 1 to clicked through the service role, capped
-- at device_count). There is no anon-callable function: an earlier draft had
-- push_record_click, and this file drops it if that draft was applied.
--
-- What the owner sees once applied: nothing yet. The Push tab and the
-- customer switch also need the code and the flag NEXT_PUBLIC_FLAG_WEB_PUSH.
--
-- Safe to apply before OR after deploying the code, and safe to re-run. It only
-- adds; the previous build ignores these tables.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- push_subscriptions
-- ---------------------------------------------------------------------------
create table if not exists push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text not null default '',
  created_at      timestamptz not null default now(),
  last_success_at timestamptz
);

-- Named checks, dropped then added, so a re-run is safe. The API trims values
-- first; these stop anything else being stored.
alter table push_subscriptions drop constraint if exists push_subscriptions_sizes_check;
alter table push_subscriptions add constraint push_subscriptions_sizes_check
  check (
    length(endpoint)   between 1 and 1000
    and endpoint ~ '^https://'
    and length(p256dh) between 1 and 200
    and length(auth)   between 1 and 100
    and length(user_agent) <= 300
  );

create index if not exists idx_push_subscriptions_user on push_subscriptions (user_id);

alter table push_subscriptions enable row level security;
revoke all on push_subscriptions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- push_consent_events (append-only)
-- ---------------------------------------------------------------------------
create table if not exists push_consent_events (
  id            uuid primary key default gen_random_uuid(),
  -- Plain uuid on purpose: no FK, no cascade, the log outlives the account.
  user_id       uuid not null,
  action        text not null,
  source        text not null default '',
  -- A hash of the endpoint (hex), never the endpoint itself. Empty for
  -- "turn off on all my devices".
  endpoint_hash text not null default '',
  created_at    timestamptz not null default now()
);

alter table push_consent_events drop constraint if exists push_consent_events_action_check;
alter table push_consent_events add constraint push_consent_events_action_check
  check (action in ('subscribe', 'unsubscribe'));

alter table push_consent_events drop constraint if exists push_consent_events_sizes_check;
alter table push_consent_events add constraint push_consent_events_sizes_check
  check (length(source) <= 40 and length(endpoint_hash) <= 128);

create index if not exists idx_push_consent_events_user
  on push_consent_events (user_id, created_at desc);

-- Append-only: refuse UPDATE and DELETE from every role that is not exempt
-- from triggers. (The service role is not exempt, so the API cannot rewrite
-- the log either. Removing rows is a deliberate act in the SQL editor: disable
-- the trigger first.)
create or replace function push_consent_events_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'push_consent_events is append-only';
end;
$$;

drop trigger if exists push_consent_events_no_change on push_consent_events;
create trigger push_consent_events_no_change
  before update or delete on push_consent_events
  for each row execute function push_consent_events_append_only();

alter table push_consent_events enable row level security;
revoke all on push_consent_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- push_sends
-- ---------------------------------------------------------------------------
create table if not exists push_sends (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  body         text not null,
  url          text not null,
  kind         text not null,
  sent_by      uuid,
  -- The IST calendar day the send was made, set by the server.
  sent_on      date not null,
  device_count integer not null default 0,
  delivered    integer not null default 0,
  failed       integer not null default 0,
  clicked      integer not null default 0,
  created_at   timestamptz not null default now()
);

alter table push_sends drop constraint if exists push_sends_kind_check;
alter table push_sends add constraint push_sends_kind_check
  check (kind in ('broadcast', 'test'));

alter table push_sends drop constraint if exists push_sends_sizes_check;
alter table push_sends add constraint push_sends_sizes_check
  check (
    length(title) between 1 and 40
    and length(body)  between 1 and 120
    and length(url)   between 1 and 300
    and device_count >= 0
    and delivered    >= 0
    and failed       >= 0
    and clicked      >= 0
  );

-- A send cannot report more taps or results than phones it went to. The 0
-- defaults satisfy this. The server sets device_count when it inserts the row.
alter table push_sends drop constraint if exists push_sends_counts_check;
alter table push_sends add constraint push_sends_counts_check
  check (clicked <= device_count and delivered + failed <= device_count);

-- At most one broadcast per IST day. Tests are not limited.
create unique index if not exists push_sends_one_broadcast_per_day
  on push_sends (sent_on)
  where kind = 'broadcast';

create index if not exists idx_push_sends_created on push_sends (created_at desc);

alter table push_sends enable row level security;
revoke all on push_sends from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Remove the click function if an earlier draft of this file created it. Clicks
-- are counted by the API route with the service role, not by anon.
-- ---------------------------------------------------------------------------
drop function if exists public.push_record_click(uuid);

-- PostgREST caches the schema; ask it to reload so the tables
-- are usable straight away.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify: (read-only; run in the SQL editor on Hioc India)
--   -- 1. All three tables exist with RLS on and no policies
--   --    (expect 3 rows, rls_on true, policies 0):
--   select c.relname, c.relrowsecurity as rls_on,
--          (select count(*) from pg_policies p where p.tablename = c.relname) as policies
--     from pg_class c
--    where c.relname in ('push_subscriptions', 'push_consent_events', 'push_sends')
--      and c.relkind = 'r' order by 1;
--
--   -- 2. anon and authenticated hold no table privileges (expect 0 rows):
--   select grantee, table_name, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name in ('push_subscriptions', 'push_consent_events', 'push_sends')
--      and grantee in ('anon', 'authenticated');
--
--   -- 3. One broadcast per IST day (expect 1 row, the index definition
--   --    containing "WHERE (kind = 'broadcast'::text)"):
--   select indexdef from pg_indexes
--    where indexname = 'push_sends_one_broadcast_per_day';
--
--   -- 4. The anon-callable click function does not exist (expect 0 rows):
--   select proname from pg_proc
--    where proname = 'push_record_click' and pronamespace = 'public'::regnamespace;
--
--   -- 5. The append-only trigger is installed (expect 1 row, tgenabled 'O'):
--   select tgname, tgenabled from pg_trigger
--    where tgname = 'push_consent_events_no_change' and not tgisinternal;
--
--   -- 6. The checks are named and present (expect 6 rows):
--   select conname from pg_constraint
--    where conname in ('push_subscriptions_sizes_check', 'push_consent_events_action_check',
--                      'push_consent_events_sizes_check', 'push_sends_kind_check',
--                      'push_sends_sizes_check', 'push_sends_counts_check');
--
--   -- 7. After a first push, one row per send (expect the counts you saw):
--   select created_at, kind, sent_on, device_count, delivered, failed, clicked
--     from push_sends order by created_at desc limit 10;
-- ---------------------------------------------------------------------------
