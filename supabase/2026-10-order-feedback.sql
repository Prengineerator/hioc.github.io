-- ===========================================================================
-- Post-order WhatsApp feedback + owner feedback inbox.
--
-- 30 minutes after an order is marked completed (skip cancelled/rejected/no
-- phone/opted-out/already-asked orders), the customer gets a WhatsApp
-- template with three quick-reply buttons ("Loved it"/"It was okay"/"Not
-- happy") and a URL button to a short web feedback page. Replies — button
-- taps AND typed text — land in an owner inbox (/owner/feedback) so the owner
-- can read them, chat back, and work the thread to resolution.
--
-- Pieces:
--   feedback_requests   — one row per order asked. Carries the token (hashed,
--                          never stored in the clear — the qr_token /
--                          pos_devices.token_hash lesson), the rating, and the
--                          thread's working state (status/notes/assignee).
--   feedback_messages   — the conversation: every inbound and outbound
--                          message, chat-bubble ordered.
--   whatsapp_opt_outs   — phones that replied STOP/UNSUBSCRIBE. Checked before
--                          every send, cron and reactive alike.
--   store_settings       — two new columns: the on/off toggle and the delay
--                          (minutes), owner-editable, default 30.
--   claim_feedback_requests(p_limit) — atomic row-claim RPC so two overlapping
--                          cron runs can't double-send the same request
--                          (FOR UPDATE SKIP LOCKED + a staleness window that
--                          reclaims a request whose claim never finished).
--   pg_cron + pg_net     — polls POST /api/cron/feedback-requests every 5
--                          minutes. Vercel's own cron is daily-only on this
--                          plan, so the 30-minute delay has to be driven from
--                          Postgres instead.
--
-- ---------------------------------------------------------------------------
-- ONE-TIME OPERATOR STEP — do this BEFORE (or right after) applying this file,
-- in the Supabase SQL editor, with the REAL secret (never commit it):
--
--   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
--
-- This must be the SAME value as the CRON_SECRET env var the Vercel deployment
-- uses (app/api/cron/feedback-requests/route.ts checks it Bearer-style,
-- exactly like the other cron routes). If the value ever needs rotating:
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'cron_secret'),
--     '<NEW_CRON_SECRET>'
--   );
--
-- and update the Vercel env var to match. The pg_cron job below reads the
-- secret fresh out of vault.decrypted_secrets on every run, so a rotation
-- takes effect on the next 5-minute tick with no redeploy.
-- ---------------------------------------------------------------------------
--
-- Safe to re-run: every statement is idempotent (create-if-not-exists /
-- create-or-replace / unschedule-then-reschedule).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- SECTION 1 — store_settings: the feedback toggle + delay
-- ---------------------------------------------------------------------------

alter table store_settings
  add column if not exists feedback_enabled boolean not null default true;

alter table store_settings
  add column if not exists feedback_delay_min integer not null default 30;

-- Defaults to the cafe's real Google review link (public, not a secret) so a
-- fresh install starts usable; the owner can still change it from Settings.
alter table store_settings
  add column if not exists google_review_url text not null
  default 'https://g.page/r/CVAlGTvqRc1fEBM/review';

-- A row created before this migration already has '' from an earlier apply of
-- this same file in dev — backfill it forward so existing installs don't have
-- to touch Settings just to get the same default a fresh install gets.
update store_settings
  set google_review_url = 'https://g.page/r/CVAlGTvqRc1fEBM/review'
  where is_singleton and google_review_url = '';

-- Sane bound: a delay that's zero-or-negative would fire immediately (not a
-- "30 minutes after" nudge any more) and a silly-large one is almost
-- certainly a fat-fingered setting, not an intentional choice.
alter table store_settings
  drop constraint if exists store_settings_feedback_delay_min_check;
alter table store_settings
  add constraint store_settings_feedback_delay_min_check
  check (feedback_delay_min between 1 and 1440);

-- ---------------------------------------------------------------------------
-- SECTION 2 — feedback_requests: one row per completed order asked
-- ---------------------------------------------------------------------------

create table if not exists feedback_requests (
  id               uuid primary key default gen_random_uuid(),

  -- One request per order — this IS the "already asked" idempotency guard
  -- alongside the notifications table's own (order_id, event, channel)
  -- uniqueness; either alone would already stop a double-ask.
  order_id         uuid not null unique references orders(id) on delete cascade,

  phone            text not null,
  customer_name    text not null default '',

  scheduled_for    timestamptz not null,

  -- Row-claim race guard for the cron (see claim_feedback_requests below).
  -- Non-null while a run is (or was, and maybe crashed) sending this row;
  -- the claim query reclaims a stale one rather than leaving it stuck
  -- 'pending' forever.
  claimed_at       timestamptz,

  sent_at          timestamptz,
  status           text not null default 'pending'
                     check (status in ('pending', 'sent', 'skipped', 'failed')),
  skip_reason      text not null default '',

  -- The Cloud API message id of the template send (correlates with the
  -- delivery-status webhook exactly like notifications.provider_ref).
  provider_ref     text not null default '',

  -- sha-256 (hex) of a 32-byte random token. The PLAINTEXT IS NEVER STORED —
  -- same reasoning as pos_devices.token_hash / tables.qr_token: a column that
  -- can be read back is a secret that leaks through some future `select *`.
  --
  -- NULL until the template actually sends. A raw token is only ever minted
  -- at the MOMENT it is handed to Meta as the URL button's dynamic suffix —
  -- not at enqueue time, 30 minutes earlier — because unlike a device cookie
  -- (handed to the browser once, in the one response that creates it) this
  -- token has to exist again in a LATER process (the cron, and again on an
  -- owner "resend"). Hashing at enqueue time would make that later moment
  -- unrecoverable: there would be a hash with no plaintext anyone could ever
  -- produce again. So the request row queues with no token at all, and each
  -- (re)send mints a fresh one — which also means an old feedback-page link
  -- goes dead the moment a newer one is sent, exactly the property a
  -- password-reset link has. Plain UNIQUE, not a partial index: Postgres
  -- already treats every NULL as distinct from every other NULL, so several
  -- not-yet-sent rows coexist with this column NULL with no extra syntax.
  token_hash       text unique,

  -- The rating, from whichever channel answered first — a WhatsApp quick-
  -- reply button or the web form. Nullable until either responds.
  rating           integer check (rating between 1 and 5),
  rating_source    text check (rating_source in ('whatsapp_button', 'web_form')),
  responded_at     timestamptz,

  -- --- the owner's working thread -----------------------------------------
  thread_status    text not null default 'open'
                     check (thread_status in ('open', 'in_progress', 'resolved')),
  owner_notes      text not null default '',
  assignee_id      uuid references profiles(id),
  -- Set on a new inbound message, cleared when the owner opens/marks the
  -- thread read (OWN feedback inbox unread badge).
  unread           boolean not null default false,
  -- Denormalized cache of the customer's most recent inbound message time —
  -- the 24h customer-service-window check (owner reply box, follow-up sends)
  -- reads this instead of MAX(feedback_messages.created_at) on every check.
  last_inbound_at  timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_feedback_requests_scheduled
  on feedback_requests (scheduled_for) where status = 'pending';
create index if not exists idx_feedback_requests_phone
  on feedback_requests (phone);
create index if not exists idx_feedback_requests_thread_status
  on feedback_requests (thread_status);

drop trigger if exists trg_feedback_requests_updated_at on feedback_requests;
create trigger trg_feedback_requests_updated_at
  before update on feedback_requests
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- SECTION 3 — feedback_messages: the conversation thread
-- ---------------------------------------------------------------------------

create table if not exists feedback_messages (
  id           uuid primary key default gen_random_uuid(),

  -- Nullable: an inbound text can arrive from a phone with NO feedback
  -- request at all (never ordered, or texting long after their last one) —
  -- it still has to land somewhere so the owner can see it, per a
  -- phone-only thread.
  request_id   uuid references feedback_requests(id) on delete set null,
  order_id     uuid references orders(id) on delete set null,

  phone        text not null,
  direction    text not null check (direction in ('in', 'out')),
  body         text not null default '',

  -- The quick-reply payload string ('fb:<request_id>:<rating>') when this
  -- inbound row came from a template button tap; '' otherwise.
  button_payload text not null default '',

  -- Outbound only. Meta's message id, for dedup on the way in.
  wa_message_id  text,

  status       text not null default '' check (status in ('', 'queued', 'sent', 'failed')),
  error        text not null default '',

  -- Owner profile id when a staffer sent this from the inbox reply box; null
  -- for system-generated follow-ups and for every inbound row.
  sent_by      uuid references profiles(id),

  created_at   timestamptz not null default now()
);

-- Dedup key for inbound webhook delivery (Meta retries on anything but a
-- clean 2xx, so the same wamid can arrive twice). Partial: outbound rows may
-- legitimately have no id yet (send failed before Meta returned one) or share
-- '' across several failed attempts, so the constraint only bites where it
-- means something.
create unique index if not exists idx_feedback_messages_wamid
  on feedback_messages (wa_message_id) where wa_message_id is not null;

create index if not exists idx_feedback_messages_request
  on feedback_messages (request_id, created_at);
create index if not exists idx_feedback_messages_phone
  on feedback_messages (phone, created_at);

-- ---------------------------------------------------------------------------
-- SECTION 4 — whatsapp_opt_outs
-- ---------------------------------------------------------------------------

create table if not exists whatsapp_opt_outs (
  phone         text primary key,
  opted_out_at  timestamptz not null default now(),
  source        text not null default ''
);

-- ---------------------------------------------------------------------------
-- SECTION 5 — RLS: ON, NO POLICIES. Service role only (the qr_token /
-- pos_devices lesson — a table holding customer PII/contact tokens does not
-- get a policy that someone later widens; every access goes through a route
-- handler that has already decided who is asking).
-- ---------------------------------------------------------------------------

alter table feedback_requests   enable row level security;
alter table feedback_messages   enable row level security;
alter table whatsapp_opt_outs   enable row level security;

-- ---------------------------------------------------------------------------
-- SECTION 6 — claim_feedback_requests: the atomic row-claim for the cron
-- ---------------------------------------------------------------------------
-- Two overlapping cron runs (a slow run still in flight when the next 5-minute
-- tick fires) must never both pick up the same due request. `FOR UPDATE SKIP
-- LOCKED` makes a concurrent second run skip rows the first run already has
-- locked, rather than block on or double-claim them. `claimed_at` records the
-- claim; a request whose claim is older than the staleness window (the run
-- that claimed it presumably crashed before finishing) is eligible again, so
-- a crash doesn't strand it in limbo forever.
--
-- SECURITY DEFINER + PUBLIC default grant is exactly the trap
-- 2026-09-security-advisor-fixes.sql exists to close: Postgres grants EXECUTE
-- on every new function to PUBLIC unless told otherwise, which for a
-- SECURITY DEFINER function returning `setof feedback_requests` (customer
-- phone numbers, names) means anon/authenticated could call it straight
-- through PostgREST's `/rpc/claim_feedback_requests` — reading that PII AND
-- claiming rows (delaying real sends) with no code of ours involved at all.
-- Same fix as that migration's §2a: revoke the PUBLIC default first, then
-- grant only to service_role (the one caller — the cron route's admin
-- client — that should ever run this).

create or replace function claim_feedback_requests(p_limit integer default 20)
returns setof feedback_requests
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update feedback_requests
  set claimed_at = now()
  where id in (
    select id from feedback_requests
    where status = 'pending'
      and scheduled_for <= now()
      and (claimed_at is null or claimed_at < now() - interval '10 minutes')
    order by scheduled_for
    limit p_limit
    for update skip locked
  )
  returning *;
end;
$$;

revoke execute on function claim_feedback_requests(integer) from public, anon, authenticated;
grant execute on function claim_feedback_requests(integer) to service_role;

-- ---------------------------------------------------------------------------
-- SECTION 7 — pg_cron + pg_net: the 30-minute-delay driver
-- ---------------------------------------------------------------------------
-- Vercel Cron on this plan only runs daily, which cannot express "30 minutes
-- after an arbitrary completion time". Postgres can: pg_cron ticks every 5
-- minutes (fine-grained enough that no due request waits more than ~5 minutes
-- past its scheduled_for) and pg_net fires the HTTP POST the same way a
-- Vercel Cron trigger would, carrying the same CRON_SECRET Bearer token the
-- other cron routes already check — read out of Vault, never hard-coded here.
--
-- The route accepts POST (see app/api/cron/feedback-requests/route.ts) —
-- net.http_post issues a POST, not a GET, so the route must export both.
--
-- Job ownership: `cron.schedule` records whichever role RUNS this migration
-- as the job's owner, and pg_cron executes the job's command AS that owner —
-- there is no separate "run as" role to configure. Applying this file through
-- the Supabase SQL editor or the CLI/migration tooling runs as `postgres`,
-- Supabase's default superuser-ish role, which already has both privileges
-- this job needs: SELECT on `vault.decrypted_secrets` (Vault's decrypting
-- view — deliberately not readable by `anon`/`authenticated`, only by
-- `postgres`/`service_role`) and EXECUTE on `net.http_post` (the `pg_net`
-- extension's functions are usable by `postgres` once the extension is
-- created, which the `create extension` above does). If this is ever applied
-- through a different, more restricted role, re-check both grants — the job
-- will otherwise fail silently into `cron.job_run_details.return_message`
-- (see the Verify section) rather than anywhere more visible.

create extension if not exists pg_cron;
create extension if not exists pg_net;

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
  );
  $$
);

-- ===========================================================================
-- Verify
-- ===========================================================================
--   -- the new store_settings columns and their defaults:
--   select feedback_enabled, feedback_delay_min, google_review_url
--     from store_settings where is_singleton;
--   -- expect: t | 30 | 'https://g.page/r/CVAlGTvqRc1fEBM/review'
--
--   -- the tables exist with RLS on and no policies:
--   select relname, relrowsecurity
--     from pg_class
--    where relname in ('feedback_requests', 'feedback_messages', 'whatsapp_opt_outs');
--   -- expect relrowsecurity = t for all three
--
--   select * from pg_policies
--    where tablename in ('feedback_requests', 'feedback_messages', 'whatsapp_opt_outs');
--   -- expect 0 rows
--
--   -- RLS posture from the API (must be empty for the ANON key even with rows):
--   --   curl "$SUPABASE_URL/rest/v1/feedback_requests?select=id" -H "apikey: $ANON"
--
--   -- the vault secret exists (run the one-time step above first):
--   select name from vault.secrets where name = 'cron_secret';
--
--   -- the cron job is scheduled:
--   select jobname, schedule, active from cron.job where jobname = 'feedback-requests-poll';
--
--   -- the job has actually been firing (after a few minutes):
--   select jobid, status, return_message, start_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'feedback-requests-poll')
--    order by start_time desc limit 5;
--
--   -- the claim RPC is atomic and idempotent-safe (two concurrent calls never
--   -- return the same row — run in two separate sessions against a seeded
--   -- pending request due now):
--   --   select id, status from claim_feedback_requests(5);
--
--   -- the claim RPC is NOT callable by anon/authenticated (must return 0 rows
--   -- for both — PII + a working claim would otherwise be reachable straight
--   -- through PostgREST's /rpc/claim_feedback_requests):
--   select grantee, privilege_type
--     from information_schema.routine_privileges
--    where routine_name = 'claim_feedback_requests';
--   -- expect exactly one row: service_role | EXECUTE
-- ===========================================================================
