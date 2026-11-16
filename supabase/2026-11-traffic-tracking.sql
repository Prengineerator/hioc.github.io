-- ===========================================================================
-- First-party traffic tracking (docs/TRAFFIC-TRACKING.md)
--
-- Adds:
--   * traffic_events   one row per view of an ordering or Shop page, plus one
--                      row per order placed from a tracked visit. Written by
--                      POST /api/traffic (views) and by POST /api/orders and
--                      POST /api/shop/checkout (orders); read by Owner → Traffic.
--
-- Why: Vercel's free analytics plan keeps 31 days and cannot read campaign
-- tags, and it cannot say which visits ended in an order. This keeps the
-- linking site, the utm_* tags and the order a visit led to, in our own
-- database.
--
-- Privacy: no IP address, no User-Agent, no cookie and no lasting visitor id
-- are stored. session_id is a random id the browser keeps in sessionStorage for
-- one visit (it ends with the tab or after 30 idle minutes), and it is never
-- tied to an account. route is the page's pattern ('/order/[id]'), never an
-- order id or a table's QR token. referrer_host is a hostname, never a full
-- URL. Rows older than 13 months are deleted by /api/cron/purge-traffic, as
-- the privacy policy says.
--
-- Access: RLS ON and NO policies, like pairing_events. Only the service role
-- reads or writes the table; the browser never queries it.
--
-- Every CHECK below is NAMED and dropped-then-added, so this file is safe to
-- re-run and a future change can widen one by name. The vocabularies mirror
-- lib/traffic/types.ts (TRAFFIC_EVENTS, PAGE_GROUPS, TRAFFIC_SOURCES,
-- TRAFFIC_DEVICES); tests/trafficMigration.test.ts pins them. Change both
-- together or neither.
--
-- Safe to apply before OR after deploying the code. Until it is applied the
-- inserts fail quietly (they are best-effort and always answer 204) and Owner →
-- Traffic shows a note asking for this file.
--
-- Once applied: run `npm run verify:db`, open the ordering site in a private
-- window, then check Owner → Traffic.
-- ===========================================================================

create table if not exists traffic_events (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  event          text not null,
  session_id     text not null,
  page_group     text not null,
  route          text not null,
  landing        boolean not null default false,
  source         text not null,
  referrer_host  text,
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  utm_content    text,
  utm_term       text,
  device         text,
  country        text,
  city           text,
  -- The order a visit ended in. Deleting the order clears the reference and
  -- keeps the row, so visit counts survive.
  order_id       uuid references orders(id) on delete set null,
  shop_order_id  uuid,
  value_inr      integer
);

-- TRAFFIC_EVENTS. 'order' and 'shop_order' are written by the server only.
alter table traffic_events drop constraint if exists traffic_events_event_check;
alter table traffic_events add constraint traffic_events_event_check
  check (event in ('view', 'order', 'shop_order'));

-- PAGE_GROUPS.
alter table traffic_events drop constraint if exists traffic_events_page_group_check;
alter table traffic_events add constraint traffic_events_page_group_check
  check (page_group in ('orders', 'shop'));

-- TRAFFIC_SOURCES.
alter table traffic_events drop constraint if exists traffic_events_source_check;
alter table traffic_events add constraint traffic_events_source_check
  check (source in ('direct', 'google', 'instagram', 'facebook', 'whatsapp', 'email', 'print',
                    'other_search', 'other_social', 'other_site', 'other_campaign'));

-- TRAFFIC_DEVICES.
alter table traffic_events drop constraint if exists traffic_events_device_check;
alter table traffic_events add constraint traffic_events_device_check
  check (device is null or device in ('mobile', 'tablet', 'desktop'));

-- Sizes: the API cleans every value first; these stop anything else.
alter table traffic_events drop constraint if exists traffic_events_sizes_check;
alter table traffic_events add constraint traffic_events_sizes_check
  check (
    length(session_id) between 8 and 64
    and length(route) <= 64
    and (referrer_host is null or length(referrer_host) <= 253)
    and (utm_source   is null or length(utm_source)   <= 100)
    and (utm_medium   is null or length(utm_medium)   <= 100)
    and (utm_campaign is null or length(utm_campaign) <= 100)
    and (utm_content  is null or length(utm_content)  <= 100)
    and (utm_term     is null or length(utm_term)     <= 100)
    and (country      is null or country ~ '^[A-Z]{2}$')
    and (city         is null or length(city) <= 80)
    and (value_inr    is null or value_inr >= 0)
  );

-- shop_orders comes from supabase/2026-11-instant-coffee-shop.sql. Link to it
-- only where that file has been applied, so this one applies either way.
do $$
begin
  if to_regclass('public.shop_orders') is not null
     and not exists (select 1 from pg_constraint where conname = 'traffic_events_shop_order_id_fkey') then
    alter table traffic_events
      add constraint traffic_events_shop_order_id_fkey
      foreign key (shop_order_id) references shop_orders(id) on delete set null;
  end if;
end $$;

-- Owner → Traffic reads a date range; the purge deletes by age.
create index if not exists idx_traffic_events_created on traffic_events (created_at);

alter table traffic_events enable row level security;

-- PostgREST caches the schema; ask it to reload so the table is usable straight
-- away (npm run verify:db probes it through PostgREST).
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify:
--   -- the table exists, with RLS on and no policies (rls_on true, policies 0):
--   select c.relname, c.relrowsecurity as rls_on,
--          (select count(*) from pg_policies p where p.tablename = c.relname) as policies
--     from pg_class c
--    where c.relname = 'traffic_events' and c.relkind = 'r';
--
--   -- after a visit to the ordering site, the latest rows:
--   select created_at, event, route, source, referrer_host, utm_source, utm_campaign
--     from traffic_events order by created_at desc limit 10;
-- ---------------------------------------------------------------------------
