-- ===========================================================================
-- Marketing agent — WhatsApp points reminders, staged win-back offers and
-- owner-created campaigns, each priced against message cost, offer cost and
-- product cost before it is approved. Run from /owner/marketing.
-- (docs/MARKETING-AGENT-SPEC.md; owner runbook docs/MARKETING-AGENT-SETUP.md.)
--
-- Idempotent: safe to re-run — every statement is create-if-not-exists /
-- create-or-replace / on-conflict-do-nothing / unschedule-then-reschedule.
-- Apply BEFORE deploying the code: the owner APIs answer 409 migration_missing
-- and the crons no-op until these tables exist, but the consent webhook and the
-- account toggle start writing to them the moment the new code is live.
--
-- Pieces:
--   marketing_set_updated_at  this file's own updated_at trigger function (the shared
--                             set_updated_at() may not exist on this database).
--   menu_item_costs          product cost (COGS) per menu VARIANT. Owner-only. A
--                             cost NEVER lives on menu_items / menu_item_variants:
--                             both are publicly readable (the menu), so a cost
--                             column there would publish the cafe's margins to
--                             anyone with the anon key.
--   marketing_settings        the singleton the owner edits: kill switch, budget,
--                             message cost, send window, caps, holdout.
--   marketing_consent         one row per phone — the source of truth for who has
--                             opted in to marketing. (Not profiles.marketing_consent:
--                             that is a bare boolean for logged-in users with no audit
--                             trail, and Petpooja customers were never asked.)
--   marketing_consent_events  append-only audit log of every opt-in / opt-out and
--                             where it came from (DPDP: withdrawal as easy as consent,
--                             and provable).
--   marketing_playbooks       the agent's five automated campaigns, seeded OFF.
--   marketing_campaigns       one row per campaign the agent (or owner) plans.
--   marketing_recipients      one row per phone per campaign: consent-checked audience,
--                             holdout arm, status/receipts, coupon, attribution.
--   coupons                   two new columns: which campaign issued the code and which
--                             phone it is locked to.
--   claim_marketing_recipients(p_limit)
--                             atomic row-claim RPC so two overlapping sender runs can't
--                             message the same recipient twice.
--   pg_cron + pg_net          polls POST /api/cron/marketing-send every 5 minutes. Vercel
--                             cron is daily-only on this plan, so sending is driven from
--                             Postgres exactly as feedback requests are.
--
-- ---------------------------------------------------------------------------
-- ONE-TIME OPERATOR STEP — the pg_cron job below reads the SAME Vault secret the
-- feedback job does ('cron_secret', = the CRON_SECRET env var on Vercel). If
-- 2026-10-order-feedback.sql has been applied and its job is running, it already
-- exists and there is nothing to do. If not, run once, with the REAL secret
-- (never commit it):
--
--   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
--
-- Without the secret the job still fires but sends `Authorization: Bearer null`,
-- and the route rejects it — see the Verify section for how to spot that.
-- ---------------------------------------------------------------------------
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- SECTION 0 — a LOCAL updated_at trigger function
-- ---------------------------------------------------------------------------
-- The four triggers below could not simply reuse the repo's set_updated_at():
-- that function is only defined in the attendance migrations (feature-flagged OFF,
-- possibly never applied in production), so pointing a trigger at it would fail
-- here with "function set_updated_at() does not exist" and abort the whole file.
-- This one is defined right here, so the migration is self-contained. The shared
-- set_updated_at() is deliberately left alone.

create or replace function public.marketing_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- SECTION 1 — menu_item_costs: product cost per variant (owner-only)
-- ---------------------------------------------------------------------------
-- Prices live on menu_item_variants (every item has at least one variant, and
-- order_items carries the variant_id), so cost is keyed the same way: a Cold
-- Coffee's Regular and Large cost different amounts. An order line with no
-- variant_id (legacy) or no cost row falls back to default_food_cost_pct.

create table if not exists public.menu_item_costs (
  variant_id   uuid primary key references public.menu_item_variants(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  cost_inr     numeric(10,2) not null check (cost_inr >= 0),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);

create index if not exists idx_menu_item_costs_item
  on public.menu_item_costs(menu_item_id);

-- ---------------------------------------------------------------------------
-- SECTION 2 — marketing_settings: the owner's singleton
-- ---------------------------------------------------------------------------
-- The bounds here are mirrored, number for number, by lib/marketing/types.ts
-- (SETTINGS_BOUNDS) and enforced before the database by lib/marketing/parse.ts;
-- tests/marketingParse.test.ts fails if the two drift apart.

create table if not exists public.marketing_settings (
  is_singleton            boolean primary key default true check (is_singleton),
  enabled                 boolean not null default false,             -- master kill switch: nothing sends while false
  monthly_budget_inr      int not null default 1000 check (monthly_budget_inr between 0 and 1000000),
  message_cost_inr        numeric(6,3) not null default 1.020 check (message_cost_inr between 0 and 100),
  send_window_start_hour  int not null default 11 check (send_window_start_hour between 0 and 23),
  send_window_end_hour    int not null default 20 check (send_window_end_hour between 1 and 24),
  daily_send_cap          int not null default 200 check (daily_send_cap between 0 and 10000),
  min_days_between        int not null default 7 check (min_days_between between 1 and 60),
  max_per_30_days         int not null default 4 check (max_per_30_days between 1 and 30),
  holdout_pct             int not null default 10 check (holdout_pct between 0 and 50),
  attribution_days        int not null default 7 check (attribution_days between 1 and 30),
  min_margin_pct          int not null default 30 check (min_margin_pct between 0 and 90),
  default_food_cost_pct   int not null default 35 check (default_food_cost_pct between 1 and 95),
  drop_alert_pct          int not null default 15 check (drop_alert_pct between 1 and 90),
  pause_after_unread      int not null default 3 check (pause_after_unread between 0 and 20), -- 0 = never pause
  whatsapp_business_number text not null default '',                   -- E.164, for the wa.me opt-in link
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users(id) on delete set null,
  check (send_window_end_hour > send_window_start_hour)
);

insert into public.marketing_settings (is_singleton) values (true)
on conflict do nothing;

drop trigger if exists trg_marketing_settings_updated_at on public.marketing_settings;
create trigger trg_marketing_settings_updated_at
  before update on public.marketing_settings
  for each row execute function public.marketing_set_updated_at();

-- ---------------------------------------------------------------------------
-- SECTION 3 — consent ledger + audit log
-- ---------------------------------------------------------------------------
-- The agent only ever messages a phone whose row here says 'opted_in' AND that
-- has no whatsapp_opt_outs row. The owner cannot opt anyone in (no import of
-- phone lists as "consented"): a customer opts in themselves — a tap on their
-- profile, or a START message — and every change is logged with its source.

create table if not exists public.marketing_consent (
  phone        text primary key check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  user_id      uuid references auth.users(id) on delete set null,
  status       text not null check (status in ('opted_in','opted_out')),
  source       text not null default '',
  consented_at timestamptz,
  withdrawn_at timestamptz,
  updated_at   timestamptz not null default now()
);

create index if not exists idx_marketing_consent_status
  on public.marketing_consent(status);

drop trigger if exists trg_marketing_consent_updated_at on public.marketing_consent;
create trigger trg_marketing_consent_updated_at
  before update on public.marketing_consent
  for each row execute function public.marketing_set_updated_at();

create table if not exists public.marketing_consent_events (
  id         uuid primary key default gen_random_uuid(),
  phone      text not null,
  user_id    uuid,
  action     text not null check (action in ('opt_in','opt_out')),
  source     text not null default '',
  actor      uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_marketing_consent_events_phone
  on public.marketing_consent_events(phone, created_at desc);

-- ---- Backfill --------------------------------------------------------------
-- Existing state becomes ledger rows once. Each statement inserts with ON
-- CONFLICT (phone) DO NOTHING and writes its audit events from the rows that
-- INSERT actually returned, so a re-run adds neither consent rows nor events
-- (and a phone the customer has since changed keeps its newer state).
--
-- 3a. Every whatsapp_opt_outs phone is an opt-out: they said STOP, and that has
--     to hold for marketing too. Done FIRST so 3b and this agree on one truth.
--     A number stored without its '+' is normalised; anything that cannot be an
--     E.164 number cannot be a ledger key and is left alone.

with src as (
  select distinct on (norm.phone) norm.phone, norm.opted_out_at
    from (
      select case
               when o.phone ~ '^\+[1-9][0-9]{7,14}$' then o.phone
               when o.phone ~ '^[1-9][0-9]{7,14}$'   then '+' || o.phone
             end as phone,
             o.opted_out_at
        from public.whatsapp_opt_outs o
    ) norm
   where norm.phone is not null
   order by norm.phone, norm.opted_out_at
), ins as (
  insert into public.marketing_consent (phone, user_id, status, source, withdrawn_at)
  select s.phone,
         (select p.id from public.profiles p where p.phone = s.phone and p.phone_verified limit 1),
         'opted_out', 'backfill_opt_out', s.opted_out_at
    from src s
  on conflict (phone) do nothing
  returning phone, user_id, withdrawn_at
)
insert into public.marketing_consent_events (phone, user_id, action, source, created_at)
select phone, user_id, 'opt_out', 'backfill_opt_out', withdrawn_at
  from ins;

-- 3b. A verified profile that ticked "marketing" on an Indian mobile is an
--     opt-in — unless that phone is in whatsapp_opt_outs (their STOP is newer
--     than a checkbox nobody has looked at since).

with ins as (
  insert into public.marketing_consent (phone, user_id, status, source, consented_at)
  select p.phone, p.id, 'opted_in', 'backfill_profile', now()
    from public.profiles p
   where p.marketing_consent
     and p.phone_verified
     and p.phone ~ '^\+91[6-9][0-9]{9}$'
     and not exists (select 1 from public.whatsapp_opt_outs o where o.phone = p.phone)
  on conflict (phone) do nothing
  returning phone, user_id, consented_at
)
insert into public.marketing_consent_events (phone, user_id, action, source, created_at)
select phone, user_id, 'opt_in', 'backfill_profile', consented_at
  from ins;

-- ---------------------------------------------------------------------------
-- SECTION 4 — marketing_playbooks: the five automated campaigns, seeded OFF
-- ---------------------------------------------------------------------------
-- Priority 1 is highest: a contact gets at most one agent message a day, from
-- the highest-priority playbook it qualifies for. params/offer/template are the
-- defaults of spec §1.4 / §5 — the same values as DEFAULT_PLAYBOOKS in
-- lib/marketing/types.ts (a test pins the two together). observed_* is the
-- learning state: what this cafe has actually achieved with the playbook.

create table if not exists public.marketing_playbooks (
  key                  text primary key check (key in ('points_expiring','points_balance','winback_1','winback_2','winback_3')),
  mode                 text not null default 'off' check (mode in ('off','review','auto')),
  priority             int  not null,
  params               jsonb not null default '{}'::jsonb,
  offer                jsonb not null default '{"type":"none"}'::jsonb,
  template             jsonb not null default '{}'::jsonb,
  prior_conversion_pct numeric(5,2) not null default 10 check (prior_conversion_pct between 0 and 100),
  observed_treated     int not null default 0,
  observed_conversions int not null default 0,
  last_planned_at      timestamptz,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users(id) on delete set null
);

drop trigger if exists trg_marketing_playbooks_updated_at on public.marketing_playbooks;
create trigger trg_marketing_playbooks_updated_at
  before update on public.marketing_playbooks
  for each row execute function public.marketing_set_updated_at();

-- ON CONFLICT DO NOTHING: re-running never overwrites what the owner tuned.
insert into public.marketing_playbooks (key, mode, priority, params, offer, template, prior_conversion_pct) values
  ('points_expiring', 'off', 1,
    '{"min_points":20,"days_ahead":5,"recent_order_days":2,"cooldown_days":14}'::jsonb,
    '{"type":"none"}'::jsonb,
    '{"name":"hioc_points_expiring_1","lang":"en","vars":["first_name","expiring_points","expiring_value_inr","expiry_date"],"url_button":true,"body_preview":"Hi {{1}}, {{2}} of your HIOC reward points (worth ₹{{3}}) expire on {{4}}. Use them on your next coffee or waffle: just share your number at the counter, or log in when you order online. See you soon!"}'::jsonb,
    15),
  ('winback_3', 'off', 2,
    '{"offset_days":60,"max_days":180}'::jsonb,
    '{"type":"percent","percent":20,"cap_inr":120,"min_order_inr":200,"validity_days":7}'::jsonb,
    '{"name":"hioc_winback_1","lang":"en","vars":["first_name","offer_text","code","valid_till"],"url_button":true,"body_preview":"Hi {{1}}, we''ve missed you at HIOC! Here''s {{2}} on your next visit. Use code {{3}} at the counter or online, valid till {{4}}. Your favourites are waiting!"}'::jsonb,
    5),
  ('winback_2', 'off', 3,
    '{"offset_days":30}'::jsonb,
    '{"type":"free_item","item_id":null,"variant_id":null,"max_item_price":250,"min_order_inr":200,"validity_days":10}'::jsonb,
    '{"name":"hioc_winback_1","lang":"en","vars":["first_name","offer_text","code","valid_till"],"url_button":true,"body_preview":"Hi {{1}}, we''ve missed you at HIOC! Here''s {{2}} on your next visit. Use code {{3}} at the counter or online, valid till {{4}}. Your favourites are waiting!"}'::jsonb,
    8),
  ('winback_1', 'off', 4,
    '{"gap_multiplier":2.5,"min_days":14,"max_days":45,"default_days":30}'::jsonb,
    '{"type":"percent","percent":10,"cap_inr":60,"min_order_inr":150,"validity_days":10}'::jsonb,
    '{"name":"hioc_winback_1","lang":"en","vars":["first_name","offer_text","code","valid_till"],"url_button":true,"body_preview":"Hi {{1}}, we''ve missed you at HIOC! Here''s {{2}} on your next visit. Use code {{3}} at the counter or online, valid till {{4}}. Your favourites are waiting!"}'::jsonb,
    12),
  ('points_balance', 'off', 5,
    '{"min_points":50,"min_days_since_order":10,"cooldown_days":21}'::jsonb,
    '{"type":"none"}'::jsonb,
    '{"name":"hioc_points_balance_1","lang":"en","vars":["first_name","points","points_value_inr"],"url_button":true,"body_preview":"Hi {{1}}, you have {{2}} HIOC reward points worth ₹{{3}} waiting for you. Redeem them on your next visit: just share your number at the counter, or log in when you order online. See you soon!"}'::jsonb,
    8)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- SECTION 5 — marketing_campaigns
-- ---------------------------------------------------------------------------
-- offer / template / projection / guardrail_flags are FROZEN when the campaign
-- is planned, so what the owner approved is exactly what sends even if the
-- playbook or the menu is edited in between.

create table if not exists public.marketing_campaigns (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('playbook','manual')),
  playbook_key    text references public.marketing_playbooks(key),
  name            text not null,
  status          text not null default 'draft' check (status in
                    ('draft','pending_approval','approved','sending','completed','cancelled','expired')),
  planned_for     date not null default ((now() at time zone 'Asia/Kolkata')::date),
  send_after      timestamptz,
  audience        jsonb not null default '{}'::jsonb,
  offer           jsonb not null default '{"type":"none"}'::jsonb,
  template        jsonb not null default '{}'::jsonb,
  projection      jsonb not null default '{}'::jsonb,
  guardrail_flags text[] not null default '{}',
  priority        int  not null default 10,
  treated_count   int  not null default 0,
  holdout_count   int  not null default 0,
  started_at      timestamptz,
  completed_at    timestamptz,
  approved_by     uuid references auth.users(id) on delete set null,
  approved_at     timestamptz,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One campaign per playbook per IST day: a re-run of the daily planner (a retry,
-- a manual re-trigger) hits this and is a no-op instead of a duplicate campaign.
create unique index if not exists uq_marketing_campaigns_playbook_day
  on public.marketing_campaigns(playbook_key, planned_for) where kind = 'playbook';

create index if not exists idx_marketing_campaigns_status
  on public.marketing_campaigns(status, created_at desc);

drop trigger if exists trg_marketing_campaigns_updated_at on public.marketing_campaigns;
create trigger trg_marketing_campaigns_updated_at
  before update on public.marketing_campaigns
  for each row execute function public.marketing_set_updated_at();

-- ---------------------------------------------------------------------------
-- SECTION 6 — marketing_recipients
-- ---------------------------------------------------------------------------

create table if not exists public.marketing_recipients (
  id                     uuid primary key default gen_random_uuid(),
  campaign_id            uuid not null references public.marketing_campaigns(id) on delete cascade,
  phone                  text not null,
  user_id                uuid references auth.users(id) on delete set null,
  first_name             text not null default '',
  arm                    text not null default 'treatment' check (arm in ('treatment','holdout')),
  status                 text not null default 'pending' check (status in
                           ('pending','queued','sending','sent','delivered','read','failed','skipped','holdout','cancelled')),
  skip_reason            text not null default '',
  vars                   jsonb not null default '{}'::jsonb,   -- token values frozen at plan time
  coupon_id              uuid references public.coupons(id) on delete set null,
  coupon_code            text not null default '',
  click_token            text unique,                          -- base64url, 12 chars, treatment only
  provider_ref           text not null default '',             -- Meta's message id: joins the receipts webhook
  error                  text not null default '',
  error_code             text not null default '',
  cost_inr               numeric(8,3) not null default 0,      -- 0 unless the message was actually sent
  attempts               int not null default 0,
  claimed_at             timestamptz,
  sent_at                timestamptz,
  delivered_at           timestamptz,
  read_at                timestamptz,
  clicked_at             timestamptz,
  reference_at           timestamptz,                          -- attribution clock: sent_at (treated) / campaign start (holdout)
  converted_order_id     uuid references public.orders(id) on delete set null,
  converted_at           timestamptz,
  conversion_revenue_inr int not null default 0,
  attributed_via         text not null default '' check (attributed_via in ('','coupon','order')),
  created_at             timestamptz not null default now(),
  unique (campaign_id, phone)
);

create index if not exists idx_mkt_recipients_queue
  on public.marketing_recipients(status) where status in ('queued','sending');
create index if not exists idx_mkt_recipients_phone_sent
  on public.marketing_recipients(phone, sent_at desc);
create index if not exists idx_mkt_recipients_provider_ref
  on public.marketing_recipients(provider_ref) where provider_ref <> '';
create index if not exists idx_mkt_recipients_reference
  on public.marketing_recipients(reference_at) where converted_at is null;

-- ---------------------------------------------------------------------------
-- SECTION 7 — coupons: which campaign issued the code, and the phone it is locked to
-- ---------------------------------------------------------------------------
-- validateAndComputeCoupon refuses an assigned_phone coupon to anyone whose
-- VERIFIED profile phone differs, so a forwarded WhatsApp message is worthless
-- to a stranger. The coupon list hides campaign_id-not-null rows by default.

alter table public.coupons
  add column if not exists campaign_id uuid references public.marketing_campaigns(id) on delete set null;
alter table public.coupons
  add column if not exists assigned_phone text;

create index if not exists idx_coupons_campaign
  on public.coupons(campaign_id) where campaign_id is not null;

-- ---------------------------------------------------------------------------
-- SECTION 8 — claim_marketing_recipients: the atomic row-claim for the sender
-- ---------------------------------------------------------------------------
-- Two overlapping sender runs (a slow run still going when the next 5-minute
-- tick fires) must never both pick up the same queued recipient: FOR UPDATE
-- SKIP LOCKED makes the second run skip rows the first already holds. Only rows
-- of an approved/sending campaign whose send_after has passed are eligible, in
-- campaign priority order then oldest first.
--
-- DELIBERATELY NO RECLAIM of stale 'sending' rows (the feedback claim reclaims
-- after 10 minutes; this one must not). A run that crashed mid-send may already
-- have handed the message to Meta — re-claiming would message the customer twice
-- and charge for both. Losing one message is the lesser harm, so the sender marks
-- stale 'sending' rows failed with error 'interrupted' instead.
--
-- SECURITY DEFINER + the PUBLIC default grant is the trap
-- 2026-09-security-advisor-fixes.sql exists to close: Postgres grants EXECUTE on
-- every new function to PUBLIC, which for a SECURITY DEFINER function returning
-- customer phone numbers would let anon/authenticated call it through PostgREST's
-- /rpc/claim_marketing_recipients — reading that PII AND stealing queued sends.
-- Revoke the default first, then grant only to service_role (the cron route's
-- admin client).

create or replace function public.claim_marketing_recipients(p_limit int)
returns setof public.marketing_recipients
language sql security definer set search_path = public as $$
  update public.marketing_recipients r
     set status = 'sending', claimed_at = now(), attempts = r.attempts + 1
   where r.id in (
     select r2.id from public.marketing_recipients r2
       join public.marketing_campaigns c on c.id = r2.campaign_id
      where r2.status = 'queued'
        and c.status in ('approved','sending')
        and (c.send_after is null or c.send_after <= now())
      order by c.priority, r2.created_at
      limit greatest(0, least(p_limit, 200))
      for update of r2 skip locked)
  returning r.*;
$$;

revoke all on function public.claim_marketing_recipients(int) from public, anon, authenticated;
grant execute on function public.claim_marketing_recipients(int) to service_role;

-- ---------------------------------------------------------------------------
-- SECTION 9 — RLS: ON, NO POLICIES, and no table privileges for the API roles
-- ---------------------------------------------------------------------------
-- Every table here holds either a margin (menu_item_costs), customer phone
-- numbers and consent, or the marketing spend. None gets a policy someone might
-- later widen: every access goes through an owner-gated or CRON_SECRET-gated
-- route handler using the service-role client. RLS with no policy already
-- returns an EMPTY SET to anon; the REVOKE additionally turns that into a
-- permission error, so a mistake in one layer is caught by the other.

alter table public.menu_item_costs          enable row level security;
alter table public.marketing_settings       enable row level security;
alter table public.marketing_consent        enable row level security;
alter table public.marketing_consent_events enable row level security;
alter table public.marketing_playbooks      enable row level security;
alter table public.marketing_campaigns      enable row level security;
alter table public.marketing_recipients     enable row level security;

revoke all on public.menu_item_costs          from anon, authenticated;
revoke all on public.marketing_settings       from anon, authenticated;
revoke all on public.marketing_consent        from anon, authenticated;
revoke all on public.marketing_consent_events from anon, authenticated;
revoke all on public.marketing_playbooks      from anon, authenticated;
revoke all on public.marketing_campaigns      from anon, authenticated;
revoke all on public.marketing_recipients     from anon, authenticated;

-- ---------------------------------------------------------------------------
-- SECTION 10 — pg_cron + pg_net: the send driver
-- ---------------------------------------------------------------------------
-- Vercel Cron on this plan only runs daily (that is the nightly PLANNER, in
-- vercel.json). Sending has to keep pace with the queue, so — exactly like
-- feedback requests — Postgres drives it: pg_cron ticks every 5 minutes and
-- pg_net fires the HTTP POST the way a Vercel Cron trigger would, carrying the
-- same CRON_SECRET Bearer token the other cron routes check, read out of Vault
-- and never hard-coded here.
--
-- The route accepts POST (app/api/cron/marketing-send/route.ts): net.http_post
-- issues a POST, not a GET, so the route must export both. It does nothing at all
-- unless the owner has switched Sending ON and it is inside the send window, so a
-- tick that finds nothing to do is cheap and harmless.
--
-- Job ownership: `cron.schedule` records whichever role RUNS this migration as
-- the job's owner, and pg_cron executes the job's command AS that owner — there
-- is no separate "run as" role to configure. Applying this file through the
-- Supabase SQL editor or the CLI/migration tooling runs as `postgres`, which
-- already has both privileges this job needs: SELECT on `vault.decrypted_secrets`
-- (Vault's decrypting view — deliberately not readable by `anon`/`authenticated`)
-- and EXECUTE on `net.http_post` (usable by `postgres` once pg_net is created,
-- which the `create extension` below does). If this is ever applied through a
-- different, more restricted role, re-check both grants — the job will otherwise
-- fail silently into `cron.job_run_details.return_message` (see Verify) rather
-- than anywhere more visible.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'marketing-send-poll') then
    perform cron.unschedule('marketing-send-poll');
  end if;
end $$;

select cron.schedule(
  'marketing-send-poll',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://hioc.in/api/cron/marketing-send',
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
--   -- the tables exist with RLS on and no policies:
--   select relname, relrowsecurity
--     from pg_class
--    where relname in ('menu_item_costs', 'marketing_settings', 'marketing_consent',
--                      'marketing_consent_events', 'marketing_playbooks',
--                      'marketing_campaigns', 'marketing_recipients');
--   -- expect relrowsecurity = t for all seven
--
--   select * from pg_policies
--    where tablename in ('menu_item_costs', 'marketing_settings', 'marketing_consent',
--                        'marketing_consent_events', 'marketing_playbooks',
--                        'marketing_campaigns', 'marketing_recipients');
--   -- expect 0 rows
--
--   -- the API roles hold no privileges on them (must return 0 rows):
--   select grantee, table_name, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and grantee in ('anon', 'authenticated')
--      and table_name in ('menu_item_costs', 'marketing_settings', 'marketing_consent',
--                         'marketing_consent_events', 'marketing_playbooks',
--                         'marketing_campaigns', 'marketing_recipients');
--
--   -- RLS posture from the API (must be empty / refused for the ANON key):
--   --   curl "$SUPABASE_URL/rest/v1/menu_item_costs?select=variant_id" -H "apikey: $ANON"
--   --   curl "$SUPABASE_URL/rest/v1/marketing_consent?select=phone"     -H "apikey: $ANON"
--   --   (or just: npm run verify:db)
--
--   -- the settings singleton exists and sending is OFF:
--   select enabled, monthly_budget_inr, message_cost_inr, send_window_start_hour, send_window_end_hour
--     from public.marketing_settings where is_singleton;
--   -- expect: f | 1000 | 1.020 | 11 | 20
--
--   -- the five playbooks are seeded, all off, in priority order:
--   select key, mode, priority, prior_conversion_pct, template->>'name' as template
--     from public.marketing_playbooks order by priority;
--   -- expect: points_expiring, winback_3, winback_2, winback_1, points_balance — all 'off'
--
--   -- the backfill: consent by status and source, and one audit event per row inserted.
--   select status, source, count(*) from public.marketing_consent group by 1, 2 order by 1, 2;
--   select action, source, count(*) from public.marketing_consent_events group by 1, 2 order by 1, 2;
--   -- expect the two to agree (every backfilled row has exactly one matching event);
--   -- opted_in/backfill_profile counts only verified +91 profiles that ticked marketing
--   -- and are NOT in whatsapp_opt_outs; opted_out/backfill_opt_out is every opt-out phone.
--
--   -- a phone that is opted OUT anywhere must never be opted IN here (expect 0 rows):
--   select c.phone from public.marketing_consent c
--     join public.whatsapp_opt_outs o on o.phone = c.phone
--    where c.status = 'opted_in';
--
--   -- the coupon link columns:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'coupons'
--      and column_name in ('campaign_id', 'assigned_phone');
--   -- expect both rows
--
--   -- the vault secret exists (see the one-time step at the top):
--   select name from vault.secrets where name = 'cron_secret';
--
--   -- the cron job is scheduled:
--   select jobname, schedule, active from cron.job where jobname = 'marketing-send-poll';
--
--   -- the job has actually been firing (after a few minutes). A tick before the code is
--   -- deployed gets a 404 from the route — expected until then:
--   select jobid, status, return_message, start_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'marketing-send-poll')
--    order by start_time desc limit 5;
--
--   -- the claim RPC claims nothing when asked for 0 (safe to run against real data):
--   select count(*) from public.claim_marketing_recipients(0);
--   -- expect 0
--
--   -- the claim RPC is NOT callable by anon/authenticated (PII + a working claim would
--   -- otherwise be reachable straight through PostgREST's /rpc/claim_marketing_recipients):
--   select grantee, privilege_type
--     from information_schema.routine_privileges
--    where routine_name = 'claim_marketing_recipients';
--   -- expect service_role | EXECUTE (plus the owning role, postgres) and NO row for
--   -- anon, authenticated or PUBLIC
-- ===========================================================================
