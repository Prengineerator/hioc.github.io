-- ===========================================================================
-- DRW-2 — every cash-drawer opening, logged.
--
-- The drawer now opens the moment a staffer taps Cash (DRW-1) and on demand
-- from the POS's "Open drawer" button. An opening with no sale behind it is
-- exactly what a till audit needs to see, so each one is recorded here: when,
-- who, on which counter, why (a cash payment or a manual open), and the order
-- when there is one. The owner's Cash page shows today's count and the recent
-- list (GET /api/cash-drawer/opens).
--
-- Written only by the server (POST /api/cash-drawer/opens, service role):
-- RLS on with NO client policies, the same posture as cash_movements.
--
-- Safe to re-run. Until it is applied the drawer still opens; the log write
-- fails quietly and the owner's card says the migration is missing.
-- ===========================================================================

create table if not exists cash_drawer_opens (
  id         uuid primary key default gen_random_uuid(),
  opened_at  timestamptz not null default now(),
  reason     text not null check (reason in ('cash_payment', 'manual')),
  order_id   uuid references orders(id) on delete set null,
  opened_by  uuid references auth.users(id) on delete set null,
  device_id  uuid references pos_devices(id) on delete set null
);

comment on table cash_drawer_opens is
  'DRW-2: one row per cash-drawer opening (cash payment tap or manual). Server-written only.';

create index if not exists idx_cash_drawer_opens_opened_at on cash_drawer_opens (opened_at desc);

alter table cash_drawer_opens enable row level security;
-- No policies: anon/authenticated can neither read nor write. The service role
-- bypasses RLS.

-- ---------------------------------------------------------------------------
-- Verify:
--   -- 1. RLS is on and there are no policies:
--   select relrowsecurity from pg_class where relname = 'cash_drawer_opens';
--   select * from pg_policies where tablename = 'cash_drawer_opens';  -- 0 rows
--
--   -- 2. today's openings by reason (IST):
--   select reason, count(*)
--     from cash_drawer_opens
--    where opened_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
--    group by reason;
-- ---------------------------------------------------------------------------
