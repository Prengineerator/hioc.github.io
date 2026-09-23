-- ===========================================================================
-- Phase 4 · POS4-2 — replay-safe order creation.
--
-- On cafe wifi a POST /api/orders can succeed server-side while the response
-- never reaches the tablet. The staffer, seeing an error, taps again — and the
-- customer is charged twice for a second identical order. The in-flight ref in
-- the POS guards a double TAP, not a double SUBMIT across a network failure.
--
-- The client now sends an Idempotency-Key; the first request claims it, and any
-- replay returns the order the original created instead of making a new one.
--
-- Safe to re-run. Apply BEFORE deploying the POS4-2 create route.
-- ===========================================================================

create table if not exists idempotency_keys (
  key         text primary key,
  -- Null between claiming the key and the order existing — that window is what
  -- makes a concurrent duplicate detectable rather than a race.
  order_id    uuid references orders(id) on delete cascade,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_idempotency_created on idempotency_keys (created_at);

alter table idempotency_keys enable row level security;
-- No policy: this table is written and read ONLY by the service-role create
-- route. RLS on with no policy denies every anon/authenticated access, which is
-- exactly what we want — a leaked key must not be probeable from the client.

-- ---------------------------------------------------------------------------
-- Housekeeping: keys older than 24h are dead weight (the replay window is
-- seconds). Run occasionally, or wire to a cron:
--   delete from idempotency_keys where created_at < now() - interval '24 hours';
--
-- Verify:
--   select count(*), count(order_id) from idempotency_keys;
-- ---------------------------------------------------------------------------
