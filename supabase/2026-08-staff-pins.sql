-- ===========================================================================
-- Phase 6 · PIN-1/PIN-5 — staff PINs for fast operator switching on an
-- enrolled counter (docs/PHASE-6-SPEC.md §6, D6-2, D6-7).
--
-- Depends on supabase/2026-08-pos-devices.sql (an operator is only ever
-- meaningful alongside an enrolled device — apply that migration first).
--
-- Two tables:
--
--   * staff_pins  — ONE row per staffer who has a PIN, bcrypt-hashed, with the
--     lockout counters the server enforces on every verify attempt
--     (lib/staff/pinPolicy.ts). This is a CREDENTIAL, same posture as
--     pos_devices.token_hash: service-role only, never selected with `*`, the
--     hash never leaves the server.
--   * pin_audit   — one row per owner set/reset/unlock action (PIN-5), the
--     role_change_audit shape. This is NOT an attempt log — failed unlock
--     tries are cheap and counted on staff_pins itself; what's audited here is
--     the registrar's own actions, which is what an owner or an incident
--     review would ever need to answer "who could unlock this counter, and
--     who gave them that PIN".
--
-- Safe to re-run.
-- ===========================================================================

create table if not exists staff_pins (
  -- One staffer, one PIN. `on delete cascade` — if the profile is ever hard-
  -- deleted (SA-D2, only legal with no history), the credential goes with it.
  user_id         uuid primary key references profiles(id) on delete cascade,

  -- bcrypt hash. A 4-digit PIN is a tiny keyspace, but the attacker's real
  -- constraint is the lockout below, not the hash's work factor — bcrypt here
  -- is table stakes, not the actual defence (unlike pos_devices.token_hash,
  -- which is 256 bits of randomness with no defence needed beyond the hash).
  pin_hash        text not null,

  -- Consecutive-failure counter, reset to 0 on a correct verify. Paired with
  -- locked_until, this is what lib/staff/pinPolicy.ts's lockout arithmetic
  -- reads and writes: 5 fails -> 60s lock, doubling per further fail, capped
  -- at 15 minutes (D6-7). Enforced server-side from THIS ROW — the rate_limits
  -- table (below) is belt-and-braces on top, not the primary control.
  failed_attempts int  not null default 0,

  -- Non-null while locked out; the verify route refuses even a correct PIN
  -- until this passes. Cleared back to null by a lockout-expiry-then-correct
  -- verify (see resetPinAttempts in lib/staff/pinAuth.ts).
  locked_until    timestamptz,

  -- Who last set/reset this PIN (PIN-5: owner-set/reset only, no self-service
  -- in this phase — spec §13 parking lot).
  set_by          uuid not null references profiles(id),
  updated_at      timestamptz not null default now()
);

-- One row per owner PIN action: set (first PIN), reset (replaced), unlock
-- (cleared a lockout early). Never a PIN or its hash — this is "who did what,
-- when", not a credential log.
create table if not exists pin_audit (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  action       text not null check (action in ('set', 'reset', 'unlock')),
  performed_by uuid not null references profiles(id),
  performed_at timestamptz not null default now()
);

create index if not exists idx_pin_audit_user on pin_audit (user_id, performed_at desc);

-- RLS ON, NO POLICIES → nothing reaches either table except the service role.
-- The qr_token / pos_devices.token_hash lesson applied again: a table holding
-- (or gating access to) a credential never gets a client-readable policy.
alter table staff_pins enable row level security;
alter table pin_audit enable row level security;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- the tables and their shape:
--   select user_id, failed_attempts, locked_until, set_by, updated_at
--     from staff_pins;
--   select id, user_id, action, performed_by, performed_at from pin_audit order by performed_at desc;
--
--   -- RLS posture — this must return 0 rows for the ANON key even when rows
--   -- exist (run it from the API, not the SQL editor, which is service-role):
--   --   curl "$SUPABASE_URL/rest/v1/staff_pins?select=user_id" -H "apikey: $ANON"
--   --   curl "$SUPABASE_URL/rest/v1/pin_audit?select=id" -H "apikey: $ANON"
--
--   -- the action CHECK is real (must raise 23514):
--   -- insert into pin_audit (user_id, action, performed_by) values ('<a profiles.id>', 'delete', '<a profiles.id>');
--
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
