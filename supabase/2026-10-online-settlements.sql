-- ===========================================================================
-- Online platform settlements — the weekly payout reports Zomato (and Swiggy)
-- email to the café, read automatically and shown on Owner → Online orders.
--
-- Every morning /api/cron/online-reports logs into the café's mailbox over
-- IMAP, looks for recent emails from the platforms' domains, and reads each
-- spreadsheet attachment (lib/online-settlements/). The owner can also press
-- "Check email now" or upload a report by hand — same pipeline either way.
--
-- online_settlement_reports     one row per report FILE, deduped by its
--                               SHA-256: the same attachment in two emails (or
--                               emailed and uploaded) is read once. The raw
--                               file is kept in the private Storage bucket
--                               'online-settlements' so a report can be read
--                               again when a parser improves — that is how
--                               Swiggy reports saved today get read later.
-- online_settlement_orders      one row per platform order (platform + order
--                               id). An order that is 'pending' in one week's
--                               report settles in a later one, so a NEWER
--                               report replaces the row; an OLDER report never
--                               overwrites a newer one (report_period_end
--                               decides, enforced in lib/online-settlements/
--                               ingest.ts, so re-reading an old file is safe).
-- online_settlement_deductions  non-order lines from a report: ads, Hyperpure,
--                               adjustments from previous weeks, additions.
--                               Same newer-report-wins rule.
-- online_settlement_sync_runs   one row per mailbox check (cron or the owner's
--                               button): what was found and what was read, so
--                               the owner page can say "last checked …".
-- online_settlement_seen_messages
--                               one row per email already downloaded and
--                               handled, whatever came of it (read, duplicate,
--                               unsupported, failed, no usable attachment), so
--                               the next check skips it without downloading it
--                               again. An email cut short by the time limit is
--                               not recorded, so it is retried.
--
-- All five: RLS on, NO policies, explicit REVOKE — service-role only, the same
-- double lock as the Petpooja archive (2026-09-petpooja-history.sql). The owner
-- page and routes read them through the admin client after getOwnerUser().
--
-- No PAN, GSTIN, address or owner name is stored from the report: only the
-- platform's restaurant id, and per order the platform's opaque customer hash
-- (for repeat-customer counts).
--
-- Idempotent: safe to re-run.
-- ===========================================================================

-- ── online_settlement_reports ───────────────────────────────────────────────
create table if not exists online_settlement_reports (
  id                 uuid primary key default gen_random_uuid(),
  platform           text not null check (platform in ('zomato', 'swiggy')),
  source             text not null check (source in ('email', 'upload')),
  file_name          text not null,
  file_sha256        text not null unique,
  file_bytes         integer not null,
  storage_path       text,                        -- null if the Storage upload failed
  email_message_id   text,
  email_from         text,
  email_subject      text,
  email_received_at  timestamptz,
  restaurant_ref     text,                        -- the platform's restaurant id (Zomato "Res ID")
  period_start       date,
  period_end         date,
  -- read:        parsed, orders/deductions written
  -- unsupported: saved, but there is no parser for this platform/format yet
  -- failed:      a parser ran and could not read it (error says why). Also
  --              what a report is while its rows are being written, with the
  --              error 'Reading stopped before every order was saved…': only
  --              the last step makes it 'read', and the mail check reads such
  --              a report again if the run was cut short.
  status             text not null check (status in ('read', 'unsupported', 'failed')),
  error              text,
  orders_count       integer not null default 0,
  deductions_count   integer not null default 0,
  warnings           jsonb not null default '[]',
  read_at            timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists online_settlement_reports_period
  on online_settlement_reports (platform, period_end desc);
create index if not exists online_settlement_reports_created
  on online_settlement_reports (created_at desc);

-- ── online_settlement_orders ────────────────────────────────────────────────
create table if not exists online_settlement_orders (
  platform                    text not null check (platform in ('zomato', 'swiggy')),
  order_id                    text not null,
  report_id                   uuid not null references online_settlement_reports(id) on delete cascade,
  report_period_end           date,                -- of the report this row came from (newer wins)
  restaurant_ref              text,
  ordered_at                  timestamptz not null,
  status                      text not null,       -- delivered | cancelled | rejected | timed_out | <raw, lower-cased>
  order_type                  text not null default '',
  offer                       text not null default '',
  payment_mode                text not null default '',
  cancel_reason               text not null default '',
  cancel_stage                text not null default '',
  refund_policy               text not null default '',
  menu_sales_inr              numeric(12, 2) not null default 0,  -- item total before discount
  packaging_inr               numeric(12, 2) not null default 0,
  discount_inr                numeric(12, 2) not null default 0,  -- every restaurant-funded discount
  gst_from_customer_inr       numeric(12, 2) not null default 0,
  net_order_value_inr         numeric(12, 2) not null default 0,
  commission_pct              numeric(6, 2),
  commission_inr              numeric(12, 2) not null default 0,
  payment_fee_inr             numeric(12, 2) not null default 0,
  gst_on_fees_inr             numeric(12, 2) not null default 0,
  tcs_inr                     numeric(12, 2) not null default 0,
  tds_inr                     numeric(12, 2) not null default 0,
  gst_paid_by_platform_inr    numeric(12, 2) not null default 0,  -- section 9(5)
  gst_due_by_restaurant_inr   numeric(12, 2) not null default 0,
  other_deductions_inr        numeric(12, 2) not null default 0,
  additions_inr               numeric(12, 2) not null default 0,
  payout_inr                  numeric(12, 2) not null default 0,  -- the platform's order-level payout
  settlement_status           text not null default '',
  settlement_date             date,
  utr                         text not null default '',
  unsettled_inr               numeric(12, 2) not null default 0,
  customer_ref                text,
  updated_at                  timestamptz not null default now(),
  primary key (platform, order_id)
);

create index if not exists online_settlement_orders_ordered_at
  on online_settlement_orders (ordered_at desc);
create index if not exists online_settlement_orders_settlement
  on online_settlement_orders (platform, settlement_date desc);
create index if not exists online_settlement_orders_report
  on online_settlement_orders (report_id);

-- ── online_settlement_deductions ────────────────────────────────────────────
create table if not exists online_settlement_deductions (
  id                 uuid primary key default gen_random_uuid(),
  platform           text not null check (platform in ('zomato', 'swiggy')),
  report_id          uuid not null references online_settlement_reports(id) on delete cascade,
  report_period_end  date,
  kind               text not null check (kind in ('ads', 'hyperpure', 'other', 'adjustment', 'addition')),
  label              text not null default '',    -- the report's own "Type" text, e.g. 'ADS'
  ref                text not null default '',    -- campaign id / invoice no / order id
  period_text        text not null default '',    -- as written, e.g. '01 April 26 - 05 April 26'
  period_start       date,
  period_end         date,
  settlement_status  text not null default '',
  amount_inr         numeric(12, 2) not null default 0,
  settled_inr        numeric(12, 2) not null default 0,
  outstanding_inr    numeric(12, 2) not null default 0,
  updated_at         timestamptz not null default now(),
  unique (platform, kind, label, ref, period_text)
);

create index if not exists online_settlement_deductions_period
  on online_settlement_deductions (platform, period_start);

-- ── online_settlement_sync_runs ─────────────────────────────────────────────
create table if not exists online_settlement_sync_runs (
  id              uuid primary key default gen_random_uuid(),
  trigger         text not null check (trigger in ('cron', 'owner')),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  lookback_days   integer not null default 0,
  messages_found  integer not null default 0,
  files_found     integer not null default 0,
  files_read      integer not null default 0,
  files_skipped   integer not null default 0,   -- already read before (same file hash)
  files_failed    integer not null default 0,
  error           text,
  details         jsonb not null default '[]'   -- per file: name, platform, outcome, period
);

create index if not exists online_settlement_sync_runs_started
  on online_settlement_sync_runs (started_at desc);

-- ── online_settlement_seen_messages ─────────────────────────────────────────
create table if not exists online_settlement_seen_messages (
  message_id  text primary key,                 -- the email's Message-ID header
  platform    text not null check (platform in ('zomato', 'swiggy')),
  outcome     text not null,                    -- read | duplicate | unsupported | failed | skipped
  seen_at     timestamptz not null default now()
);

-- ── Lockdown: service role only ─────────────────────────────────────────────
alter table online_settlement_reports         enable row level security;
alter table online_settlement_orders          enable row level security;
alter table online_settlement_deductions      enable row level security;
alter table online_settlement_sync_runs       enable row level security;
alter table online_settlement_seen_messages   enable row level security;

revoke all on online_settlement_reports       from anon, authenticated;
revoke all on online_settlement_orders        from anon, authenticated;
revoke all on online_settlement_deductions    from anon, authenticated;
revoke all on online_settlement_sync_runs     from anon, authenticated;
revoke all on online_settlement_seen_messages from anon, authenticated;

-- ── Private bucket for the raw report files ─────────────────────────────────
-- The code also creates it on first upload (lib/online-settlements/store.ts),
-- but creating it here keeps it private from the start.
insert into storage.buckets (id, name, public)
values ('online-settlements', 'online-settlements', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Verify (or run `npm run verify:db`):
--   select platform, status, count(*), min(period_start), max(period_end)
--     from online_settlement_reports group by 1, 2;
--
--   -- weekly payout by platform, as the owner page shows it:
--   select platform, date_trunc('week', ordered_at at time zone 'Asia/Kolkata') as week,
--          count(*) filter (where status = 'delivered') as orders,
--          sum(menu_sales_inr) filter (where status = 'delivered') as menu_sales,
--          sum(payout_inr) as payout
--     from online_settlement_orders group by 1, 2 order by 2 desc limit 12;
--
--   -- last mailbox checks:
--   select trigger, started_at, files_found, files_read, files_skipped, files_failed, error
--     from online_settlement_sync_runs order by started_at desc limit 5;
-- ---------------------------------------------------------------------------
