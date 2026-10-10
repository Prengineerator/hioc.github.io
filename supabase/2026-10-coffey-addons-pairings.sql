-- ===========================================================================
-- Coffey add-ons & pairings — the add-on traits, the owner's overrides and the
-- checkout pairing events (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2.3, §4.3).
--
-- Two tables:
--   * addon_option_traits  the owner's override for ONE add-on option (an
--                          "Edited" row in Owner → Traits → Add-ons). Most
--                          options have no row: their traits are derived from
--                          the group and option names (lib/suggest/addonTraits.ts),
--                          and that derivation is what the engine uses until
--                          the owner says otherwise.
--   * pairing_events       the checkout "Pairs well with your order" funnel:
--                          shown → added → ordered. 'shown' and 'added' come
--                          from POST /api/suggest/pairings/events; 'ordered' is
--                          written by the server from POST /api/orders.
--
-- Why: Coffey can now point at the one add-on that gives an item a flavour it
-- lacks (a cappuccino with hazelnut syrup), and checkout can suggest a second
-- item for the cart. Both need somewhere to keep the owner's corrections and
-- the events that show whether the pairings sell. Nothing here changes the menu
-- or the order tables: pairing_events only references them.
--
-- Access: both tables have RLS ON and NO policies, like menu_item_traits. Only
-- the service role reads or writes them (the owner routes, the pairings API and
-- the events route). The browser never queries either table directly.
--
-- Every CHECK below is NAMED and dropped-then-added, so this file is safe to
-- re-run and a future change can widen one by name. Each vocabulary mirrors
-- lib/suggest/types.ts (ADDON_ROLES, FLAVOUR_FAMILIES, PAIRING_EVENTS,
-- AddonTraits) or lib/suggest/traitVocabulary.ts (TEXTURES). Change both
-- together or neither; tests/suggestTraitsV2Migration.test.ts pins the lists.
--
-- Safe to apply before OR after deploying the code. Until it is applied, the
-- owner's Add-ons view answers 409 ("apply this file") instead of 500, the
-- pairings still work from traits and popularity alone (derived defaults), and
-- the event inserts fail silently: they are best-effort and always answer 204.
--
-- Once applied: run `npm run verify:db`, then skim Owner → Traits → Add-ons and
-- override anything the name-derived roles get wrong.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. addon_option_traits — one row per option the owner has overridden. The
--    key cascades from addon_options, so deleting an option deletes its override
--    with it. "Reset" in the owner view deletes the row, which puts the option
--    back on its derived defaults.
-- ---------------------------------------------------------------------------
create table if not exists addon_option_traits (
  option_id         uuid primary key references addon_options(id) on delete cascade,
  role              text not null,
  flavour_families  text[] not null default '{}',
  sweetness_delta   smallint not null default 0,
  intensity_delta   smallint not null default 0,
  indulgence_delta  smallint not null default 0,
  textures          text[] not null default '{}',
  updated_at        timestamptz not null default now()
);

alter table addon_option_traits enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Their CHECK constraints (named, so the file can be re-run). Each one
--    mirrors AddonTraits in lib/suggest/types.ts.
-- ---------------------------------------------------------------------------
alter table addon_option_traits drop constraint if exists addon_option_traits_role_check;
alter table addon_option_traits add constraint addon_option_traits_role_check
  check (role in ('flavour', 'topping', 'shot', 'sweetener', 'milk', 'ice', 'serve', 'side', 'other'));

-- The seven FLAVOUR_FAMILIES of lib/suggest/types.ts, at most two per option.
alter table addon_option_traits drop constraint if exists addon_option_traits_flavour_families_check;
alter table addon_option_traits add constraint addon_option_traits_flavour_families_check
  check (
    flavour_families <@ array['chocolatey', 'caramel', 'nutty', 'biscuit', 'fruity', 'spiced', 'floral']::text[]
    and cardinality(flavour_families) <= 2
  );

-- 0–5 on the 0–10 item sweetness scale. An add-on can sweeten a drink, never
-- take sweetness out of it.
alter table addon_option_traits drop constraint if exists addon_option_traits_sweetness_delta_check;
alter table addon_option_traits add constraint addon_option_traits_sweetness_delta_check
  check (sweetness_delta between 0 and 5);

-- 0–2: an espresso shot is 1.
alter table addon_option_traits drop constraint if exists addon_option_traits_intensity_delta_check;
alter table addon_option_traits add constraint addon_option_traits_intensity_delta_check
  check (intensity_delta between 0 and 2);

alter table addon_option_traits drop constraint if exists addon_option_traits_indulgence_delta_check;
alter table addon_option_traits add constraint addon_option_traits_indulgence_delta_check
  check (indulgence_delta between 0 and 2);

-- The twelve TEXTURES of lib/suggest/traitVocabulary.ts, at most two per option.
alter table addon_option_traits drop constraint if exists addon_option_traits_textures_check;
alter table addon_option_traits add constraint addon_option_traits_textures_check
  check (
    textures <@ array['silky', 'creamy', 'frothy', 'thick', 'icy', 'fizzy',
                      'crunchy', 'crispy', 'soft', 'gooey', 'flaky', 'chewy']::text[]
    and cardinality(textures) <= 2
  );

-- ---------------------------------------------------------------------------
-- 3. pairing_events — the checkout funnel (COFFEY-ADDONS-PAIRINGS-SPEC §4.3).
--    menu_item_id is the item we suggested; anchor_item_id is the cart item it
--    was suggested beside. user_id is taken from the session, never the body.
--    Deleting an item, an order or an account clears the reference and keeps
--    the row, so the funnel counts survive.
-- ---------------------------------------------------------------------------
create table if not exists pairing_events (
  id              uuid primary key default gen_random_uuid(),
  anon_id         text,
  user_id         uuid references auth.users(id) on delete set null,
  event           text not null,
  menu_item_id    uuid references menu_items(id) on delete set null,
  anchor_item_id  uuid references menu_items(id) on delete set null,
  order_id        uuid references orders(id) on delete set null,
  value_inr       integer,
  created_at      timestamptz not null default now()
);

-- PAIRING_EVENTS of lib/suggest/types.ts. 'ordered' is server-written only.
alter table pairing_events drop constraint if exists pairing_events_event_check;
alter table pairing_events add constraint pairing_events_event_check
  check (event in ('shown', 'added', 'ordered'));

create index if not exists idx_pairing_events_created_event on pairing_events (created_at, event);

alter table pairing_events enable row level security;

-- PostgREST caches the schema; ask it to reload so both tables are selectable
-- straight away (npm run verify:db probes them through PostgREST).
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify:
--   -- both tables exist, with RLS on and no policies (rls_on true, policies 0):
--   select c.relname, c.relrowsecurity as rls_on,
--          (select count(*) from pg_policies p where p.tablename = c.relname) as policies
--     from pg_class c
--    where c.relname in ('addon_option_traits', 'pairing_events') and c.relkind = 'r'
--    order by c.relname;
--
--   -- the named CHECKs are present (six on addon_option_traits, one on pairing_events):
--   select conrelid::regclass as tbl, conname
--     from pg_constraint
--    where conrelid in ('addon_option_traits'::regclass, 'pairing_events'::regclass)
--      and contype = 'c'
--    order by 1, 2;
--
--   -- the index is there:
--   select indexname from pg_indexes where indexname = 'idx_pairing_events_created_event';
--
--   -- a well-formed override is accepted (needs at least one add-on option; the
--   -- seed has them). Rolls back either way:
--   begin;
--     insert into addon_option_traits
--       (option_id, role, flavour_families, sweetness_delta, intensity_delta, indulgence_delta, textures)
--     values ((select id from addon_options limit 1), 'flavour', array['nutty', 'caramel']::text[], 2, 0, 1, array['silky']::text[]);
--   rollback;
--
--   -- ...and the CHECKs still REJECT bad values. Each of these must raise 23514
--   -- (check_violation); if one succeeds, that constraint is gone. The option id
--   -- is a random uuid on purpose: CHECKs run before foreign keys, so the bad
--   -- value is what fails:
--   -- insert into addon_option_traits (option_id, role) values (gen_random_uuid(), 'bogus');
--   -- insert into addon_option_traits (option_id, role, flavour_families) values (gen_random_uuid(), 'flavour', array['bogus']::text[]);
--   -- insert into addon_option_traits (option_id, role, flavour_families) values (gen_random_uuid(), 'flavour', array['nutty', 'caramel', 'fruity']::text[]);
--   -- insert into addon_option_traits (option_id, role, sweetness_delta) values (gen_random_uuid(), 'flavour', 6);
--   -- insert into addon_option_traits (option_id, role, sweetness_delta) values (gen_random_uuid(), 'flavour', -1);
--   -- insert into addon_option_traits (option_id, role, intensity_delta) values (gen_random_uuid(), 'shot', 3);
--   -- insert into addon_option_traits (option_id, role, indulgence_delta) values (gen_random_uuid(), 'flavour', 3);
--   -- insert into addon_option_traits (option_id, role, textures) values (gen_random_uuid(), 'topping', array['crunchy', 'crispy', 'soft']::text[]);
--   -- insert into addon_option_traits (option_id, role, textures) values (gen_random_uuid(), 'topping', array['bogus']::text[]);
--   -- insert into pairing_events (event) values ('bogus');
--
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
