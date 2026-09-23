-- ===========================================================================
-- Phase 6 · DEV-2/DEV-3 — the counter machines get an identity.
--
-- Everything the app knows today is about a PERSON: a session, a role, a name
-- on an order. Nothing knows about the machine. That is fine while there is one
-- counter and one login, and it stops being fine the moment the cafe has a
-- till, a back-office laptop and an event stand: the till should default to
-- takeaway and print KOTs, the event stand should print nothing, and a laptop
-- that walks out of the building should be revocable without changing anyone's
-- password.
--
-- So: a device row, a secret in an httpOnly cookie on that machine, and a
-- revoke button. Three things this is deliberately NOT:
--
--   * NOT authentication. A device cookie on its own grants nothing — no order
--     can be placed, no page opens. All authority still comes from a staff
--     session (or, from PIN-3 onward, an operator who unlocked this device).
--     The cookie only says "this is the till", and the till's settings and, in
--     6C, its lock screen hang off that.
--   * NOT a person. Attribution stays with the operator (PIN-4). A device never
--     appears as the actor on an order.
--   * NOT deletable. Revoking sets a timestamp; the row survives so "which
--     machine was that, and when did we retire it" still has an answer.
--
-- Apply BEFORE deploying: /owner/devices and /api/device/context both read this
-- table, and a missing table makes enrollment fail with a PostgREST 404 that
-- reads like a bug in the page.
-- Safe to re-run.
-- ===========================================================================

create table if not exists pos_devices (
  id            uuid primary key default gen_random_uuid(),

  -- What the owner calls it: "Counter 1", "Back office", "Event stand".
  -- Shown in the revoke list, and (later) on the lock screen.
  name          text not null,

  -- sha-256 (hex) of a 32-byte random secret. The PLAINTEXT IS NEVER STORED —
  -- it exists for exactly one HTTP response, the Set-Cookie on enrollment, and
  -- after that only the browser has it. Same reasoning as tables.qr_token being
  -- unreadable through PostgREST: a secret that can be read back is a secret
  -- that leaks through some future select *.
  --
  -- UNIQUE both because a collision would hand one machine another's identity
  -- and because the lookup on every device-aware request is by this column —
  -- the constraint's index is that lookup's index.
  token_hash    text not null unique,

  enrolled_by   uuid not null references profiles(id),
  enrolled_at   timestamptz not null default now(),

  -- Touched by /api/device/context at POS boot, not on every request: this is
  -- for the owner's "is that machine still in use?" question, not telemetry.
  last_seen_at  timestamptz,

  -- The kill switch. Non-null = the cookie on that machine stops resolving and
  -- it drops back to being an anonymous browser. One-way: re-enrolling issues a
  -- fresh secret rather than reviving this row, so a stolen cookie stays dead.
  revoked_at    timestamptz,

  -- --- DEV-3: per-device defaults -----------------------------------------
  -- NULL everywhere means "no opinion — use the store-level setting". That is
  -- the whole three-state design: a device can default to takeaway, or default
  -- to dine-in, or defer. Booleans are nullable for exactly that reason, and
  -- readers must use `?? store` rather than `|| store` (false is an answer).
  default_order_type text check (default_order_type in ('takeaway', 'dine_in')),
  auto_print_kot     boolean,
  auto_print_bill    boolean

  -- active_event_id (EVT-3) is deliberately absent: `events` does not exist
  -- yet, and a FK to a missing table fails the whole migration. It is added by
  -- 2026-08-events.sql, which creates the table first.
);

-- Two active devices called "Counter 1" make the revoke list a coin flip, and
-- the owner is choosing which machine to kill from that list. Partial, so a
-- retired "Counter 1" does not block naming its replacement the same thing —
-- which is exactly what re-enrolling a repaired till looks like.
create unique index if not exists idx_pos_devices_active_name
  on pos_devices (lower(name)) where revoked_at is null;

-- RLS ON, NO POLICIES → nothing reaches this table except the service role.
-- The qr_token lesson (spec §11): a table holding a secret does not get a
-- "staff can read" policy that someone later widens. Every access goes through
-- a route handler that has already decided who is asking.
alter table pos_devices enable row level security;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- the table and its shape:
--   select id, name, enrolled_at, last_seen_at, revoked_at,
--          default_order_type, auto_print_kot, auto_print_bill
--     from pos_devices order by enrolled_at desc;
--
--   -- RLS posture — this must return 0 rows for the ANON key even when rows
--   -- exist (run it from the API, not the SQL editor, which is service-role):
--   --   curl "$SUPABASE_URL/rest/v1/pos_devices?select=id" -H "apikey: $ANON"
--
--   -- the CHECK is real (must raise 23514):
--   -- insert into pos_devices (name, token_hash, enrolled_by, default_order_type)
--   --   values ('probe', 'x', '<a profiles.id>', 'delivery');
--
--   -- the active-name index is real (second insert must raise 23505):
--   -- insert into pos_devices (name, token_hash, enrolled_by) values ('Counter 1', 'a', '<id>');
--   -- insert into pos_devices (name, token_hash, enrolled_by) values ('counter 1', 'b', '<id>');
--
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
