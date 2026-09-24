-- ===========================================================================
-- Phase 7 · SUG-1 — the "Help me choose" suggestion engine
-- (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md).
--
-- Five tables:
--   * menu_item_traits        what each item tastes like (Opus-tagged, owner-confirmed)
--   * customer_taste_profiles the per-account preference cache (derived, disposable)
--   * suggestion_sessions     one row per engine answer (inputs, picks, model, cost)
--   * suggestion_events       the funnel: shown → added → checkout → ordered
--   * suggestion_digests      the weekly Sonnet-written owner summary
--
-- Access: every table has RLS ON. Only customer_taste_profiles has a policy
-- (a signed-in customer may read THEIR OWN row); everything else is
-- service-role only, read by owner-gated routes. The engine never needs a
-- browser to read these tables directly.
--
-- Nothing here touches orders: attribution lives in suggestion_events, so a
-- missing or broken engine can never block checkout.
--
-- Safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- menu_item_traits — one row per menu item. An item WITHOUT a row is never
-- suggested (safer than guessing what it tastes like).
-- ---------------------------------------------------------------------------
create table if not exists menu_item_traits (
  menu_item_id  uuid primary key references menu_items(id) on delete cascade,
  temperature   text not null check (temperature in ('hot', 'iced', 'either', 'ambient')),
  caffeine      text not null check (caffeine in ('none', 'low', 'medium', 'high')),
  is_coffee     boolean not null default false,
  sweetness     smallint not null check (sweetness between 0 and 3),
  body          text not null check (body in ('light', 'medium', 'rich')),
  kind          text not null check (kind in ('drink', 'food', 'dessert')),
  moods         text[] not null default '{}'
                check (moods <@ array['boost', 'cosy', 'celebrate', 'comfort', 'cool', 'surprise']::text[]),
  dayparts      text[] not null default '{}'
                check (dayparts <@ array['morning', 'afternoon', 'evening', 'late']::text[]),
  flavor_notes  text[] not null default '{}' check (cardinality(flavor_notes) <= 5),
  source        text not null default 'opus' check (source in ('opus', 'owner')),
  confirmed     boolean not null default false,
  updated_at    timestamptz not null default now()
);

alter table menu_item_traits enable row level security;

-- ---------------------------------------------------------------------------
-- customer_taste_profiles — the preference cache. Derived entirely from orders
-- + favorites, so deleting a row loses nothing (it is recomputed on next read).
-- opted_out survives a reset only if the customer set it; "Reset" deletes the
-- row, "Don't personalise" sets opted_out.
-- ---------------------------------------------------------------------------
create table if not exists customer_taste_profiles (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  profile          jsonb not null default '{}'::jsonb,
  order_count      integer not null default 0,
  computed_at      timestamptz not null default now(),
  source_order_at  timestamptz,
  opted_out        boolean not null default false
);

alter table customer_taste_profiles enable row level security;

drop policy if exists taste_profiles_own_read on customer_taste_profiles;
create policy taste_profiles_own_read on customer_taste_profiles
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- suggestion_sessions — one row per engine answer (a refine is a new row
-- pointing at its parent through refine_of).
-- ---------------------------------------------------------------------------
create table if not exists suggestion_sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references auth.users(id) on delete set null,
  anon_id            text,
  inputs             jsonb not null default '{}'::jsonb,
  profile_used       boolean not null default false,
  ordering_mood      text check (ordering_mood in ('treating', 'saving', 'explorer', 'routine')),
  candidate_ids      uuid[] not null default '{}',
  pick_ids           uuid[] not null default '{}',
  usual_item_id      uuid,
  source             text not null check (source in ('llm', 'fallback')),
  fallback_reason    text,
  model              text,
  latency_ms         integer not null default 0,
  input_tokens       integer not null default 0,
  cache_read_tokens  integer not null default 0,
  output_tokens      integer not null default 0,
  cost_usd_micros    bigint not null default 0,
  refine_of          uuid references suggestion_sessions(id) on delete set null,
  created_at         timestamptz not null default now()
);

create index if not exists idx_suggestion_sessions_created on suggestion_sessions (created_at);
create index if not exists idx_suggestion_sessions_user on suggestion_sessions (user_id);

alter table suggestion_sessions enable row level security;

-- ---------------------------------------------------------------------------
-- suggestion_events — the funnel. 'ordered' is written ONLY by the server
-- from POST /api/orders (playbook S-4); the client events route whitelists
-- the rest.
-- ---------------------------------------------------------------------------
create table if not exists suggestion_events (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references suggestion_sessions(id) on delete cascade,
  event         text not null check (event in (
                  'shown', 'added_to_cart', 'feedback_up', 'feedback_down',
                  'refined', 'dismissed', 'browse_menu', 'checkout_started', 'ordered')),
  menu_item_id  uuid,
  order_id      uuid references orders(id) on delete set null,
  value_inr     integer,
  created_at    timestamptz not null default now()
);

create index if not exists idx_suggestion_events_session on suggestion_events (session_id);
create index if not exists idx_suggestion_events_created_event on suggestion_events (created_at, event);

alter table suggestion_events enable row level security;

-- ---------------------------------------------------------------------------
-- suggestion_digests — the weekly owner summary (SUG-12).
-- ---------------------------------------------------------------------------
create table if not exists suggestion_digests (
  id            uuid primary key default gen_random_uuid(),
  week_start    date not null,
  summary       text not null,
  stats         jsonb not null default '{}'::jsonb,
  source        text not null check (source in ('llm', 'template')),
  model         text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_suggestion_digests_created on suggestion_digests (created_at desc);

alter table suggestion_digests enable row level security;
