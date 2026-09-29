-- ===========================================================================
-- Owner report emails — a daily, weekly and monthly summary of how the cafe
-- did, emailed to the owner (lib/reports/ownerDigest.ts, cron
-- /api/cron/owner-reports, configured on Owner → Reports).
--
-- Two tables:
--   * owner_report_settings  the singleton configuration the owner edits
--   * owner_report_sends     one row per email attempt (sent/failed/skipped)
--
-- The numbers themselves come from the same reconciliation report as Owner →
-- Reports (lib/reports/reconcile.ts); nothing here stores them.
--
-- Access: RLS ON, no policies — service-role only, read and written by
-- owner-gated routes and the CRON_SECRET-gated cron.
--
-- Safe to re-run.
-- ===========================================================================

create table if not exists owner_report_settings (
  is_singleton        boolean primary key default true check (is_singleton),
  daily_enabled       boolean not null default true,
  -- Skip the daily email for a day with no orders and no money (a holiday).
  daily_skip_empty    boolean not null default true,
  weekly_enabled      boolean not null default true,
  -- ISO weekday the weekly email goes out (1 = Monday … 7 = Sunday). It covers
  -- the 7 days ending the day before, so 1 means a Monday–Sunday week.
  weekly_send_dow     smallint not null default 1 check (weekly_send_dow between 1 and 7),
  monthly_enabled     boolean not null default true,
  -- Day of the month the monthly email goes out. It covers the month ending
  -- the day before, so 1 means a calendar month; 5 means the 5th–4th.
  monthly_send_day    smallint not null default 1 check (monthly_send_day between 1 and 28),
  -- Also send to every owner account's login email.
  send_to_owner_login boolean not null default true,
  -- Extra addresses (an accountant, a partner).
  recipients          text[] not null default '{}' check (cardinality(recipients) <= 10),
  updated_by          uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);

alter table owner_report_settings enable row level security;

insert into owner_report_settings (is_singleton) values (true)
on conflict (is_singleton) do nothing;

create table if not exists owner_report_sends (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('daily', 'weekly', 'monthly')),
  period_start  date not null,
  period_end    date not null,
  -- 'cron' = the scheduled send; 'manual' = the owner's "Send now".
  trigger       text not null default 'cron' check (trigger in ('cron', 'manual')),
  to_email      text not null default '',
  status        text not null check (status in ('sent', 'failed', 'skipped')),
  provider_ref  text not null default '',
  error         text not null default '',
  created_at    timestamptz not null default now()
);

alter table owner_report_sends enable row level security;

-- A scheduled report goes to each address once per period, however many times
-- the cron runs (a retry, a manual re-trigger from the Vercel dashboard).
create unique index if not exists owner_report_sends_cron_once
  on owner_report_sends (kind, period_start, to_email)
  where status = 'sent' and trigger = 'cron';

create index if not exists owner_report_sends_created_at
  on owner_report_sends (created_at desc);
