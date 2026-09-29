-- ===========================================================================
-- Coffey v2 — traits v2: the 14-dimension taste profile
-- (docs/COFFEY-SPEC.md §3.1 and §7).
--
-- "Help me choose" became Coffey, and Coffey needs to know more about each
-- item than v1's nine trait fields could say: 60% of the menu sat at
-- sweetness 3 and 114 of 117 items were tagged "afternoon", so the scorer's
-- terms were close to constant (COFFEY-SPEC §0). Jev now re-tags every item on
-- 14 dimensions (TRAIT_DIMENSIONS in lib/suggest/traitVocabulary.ts). This
-- migration adds the columns; the owner's "Regenerate with Jev" button on the
-- Traits tab (POST /api/owner/suggest/traits/generate) fills them.
--
--   sweetness_level  smallint 0–10   INHERENT sweetness, as the kitchen makes
--                                    it — not counting optional table sugar
--   intensity        smallint 0–3    flavour strength, gentle → bold
--   refreshment      smallint 0–3    how refreshing / thirst-quenching
--   indulgence       smallint 0–3    everyday → a real treat
--   novelty          smallint 0–3    familiar classic → adventurous
--   textures         text[]   ≤ 3    subset of the twelve TEXTURES
--   mood_fit         jsonb object    graded 0–3 fit per feeling (one decimal),
--                                    keys are the MOODS
--   traits_version   smallint        1 = tagged before Coffey,
--                                    2 = CURRENT_TRAITS_VERSION
--
-- The five 0–N columns are nullable ON PURPOSE: NULL means "not tagged at v2
-- yet", and every reader (lib/suggest/sweetness.ts, the scorer, the filter)
-- treats it as neutral. So nothing breaks between applying this file and the
-- first Regenerate. traits_version is what tells the two apart: it defaults to
-- 1, so every existing row is a Regenerate target until Jev has tagged it.
--
-- The legacy 0–3 `sweetness` column stays. It is DERIVED from sweetness_level
-- on every v2 write (legacySweetnessFromLevel in lib/suggest/sweetness.ts:
-- ≤1 → 0, ≤4 → 1, ≤7 → 2, else 3), so the taste profile's meanSweetness and
-- older code paths keep working.
--
-- Also here, because Coffey adds two feelings — 'focus' ("Focused — working or
-- studying") and 'unwind' ("Stressed — need to unwind"): the `moods` CHECK is
-- widened to allow both, i.e. all eight MOODS of lib/suggest/types.ts.
--
-- Every CHECK below is NAMED, and dropped-then-added, so this file is safe to
-- re-run and a future change can widen one by name. Each mirrors a validator
-- in lib/suggest/traitsValidate.ts — change both together or neither.
--
-- Safe to re-run. Safe to apply before OR after deploying the code: until it
-- is applied the Traits tab shows an "apply this file" banner, Regenerate
-- answers 409 (never 500), the owner PATCH refuses v2 fields — and the two new
-- moods — with a 409 of its own, and the engine treats every v2 column as
-- neutral.
--
-- Once applied: run `npm run verify:db`, then Owner → Suggestions → Traits →
-- "Regenerate with Jev" until it reports 0 remaining. Owner-edited rows keep
-- every edit they have; model-tagged rows come back unconfirmed for a quick
-- review.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The new columns.
-- ---------------------------------------------------------------------------
alter table menu_item_traits
  add column if not exists sweetness_level smallint,
  add column if not exists intensity       smallint,
  add column if not exists refreshment     smallint,
  add column if not exists indulgence      smallint,
  add column if not exists novelty         smallint,
  add column if not exists textures        text[] not null default '{}',
  add column if not exists mood_fit        jsonb  not null default '{}'::jsonb,
  add column if not exists traits_version  smallint not null default 1;

-- ---------------------------------------------------------------------------
-- 2. Their CHECK constraints (named, so the file can be re-run).
-- ---------------------------------------------------------------------------
alter table menu_item_traits drop constraint if exists menu_item_traits_sweetness_level_check;
alter table menu_item_traits add constraint menu_item_traits_sweetness_level_check
  check (sweetness_level is null or sweetness_level between 0 and 10);

alter table menu_item_traits drop constraint if exists menu_item_traits_intensity_check;
alter table menu_item_traits add constraint menu_item_traits_intensity_check
  check (intensity is null or intensity between 0 and 3);

alter table menu_item_traits drop constraint if exists menu_item_traits_refreshment_check;
alter table menu_item_traits add constraint menu_item_traits_refreshment_check
  check (refreshment is null or refreshment between 0 and 3);

alter table menu_item_traits drop constraint if exists menu_item_traits_indulgence_check;
alter table menu_item_traits add constraint menu_item_traits_indulgence_check
  check (indulgence is null or indulgence between 0 and 3);

alter table menu_item_traits drop constraint if exists menu_item_traits_novelty_check;
alter table menu_item_traits add constraint menu_item_traits_novelty_check
  check (novelty is null or novelty between 0 and 3);

-- The twelve TEXTURES of lib/suggest/traitVocabulary.ts, at most three per item.
alter table menu_item_traits drop constraint if exists menu_item_traits_textures_check;
alter table menu_item_traits add constraint menu_item_traits_textures_check
  check (
    textures <@ array['silky', 'creamy', 'frothy', 'thick', 'icy', 'fizzy',
                      'crunchy', 'crispy', 'soft', 'gooey', 'flaky', 'chewy']::text[]
    and cardinality(textures) <= 3
  );

-- Only the shape is enforced here (a JSON object); the keys (MOODS) and the
-- 0–3 values are validated by the app before anything is written.
alter table menu_item_traits drop constraint if exists menu_item_traits_mood_fit_check;
alter table menu_item_traits add constraint menu_item_traits_mood_fit_check
  check (jsonb_typeof(mood_fit) = 'object');

alter table menu_item_traits drop constraint if exists menu_item_traits_traits_version_check;
alter table menu_item_traits add constraint menu_item_traits_traits_version_check
  check (traits_version >= 1);

-- ---------------------------------------------------------------------------
-- 3. Widen the `moods` CHECK to allow 'focus' and 'unwind'.
--
-- 2026-09-suggestion-engine.sql declared the check INLINE, so Postgres named
-- it (most likely menu_item_traits_moods_check) — but the name is not relied
-- on. Drop every CHECK on the table whose definition mentions `moods`, then
-- add the one named constraint that is re-runnable from here on. (`mood_fit`
-- does not match: its definition never contains the word `moods`.)
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'menu_item_traits'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%moods%'
  loop
    execute format('alter table menu_item_traits drop constraint %I', c.conname);
  end loop;
end
$$;

alter table menu_item_traits drop constraint if exists menu_item_traits_moods_check;
alter table menu_item_traits add constraint menu_item_traits_moods_check
  check (moods <@ array['boost', 'focus', 'unwind', 'cosy', 'comfort', 'celebrate', 'cool', 'surprise']::text[]);

-- ---------------------------------------------------------------------------
-- 4. Backfill sweetness_level from the legacy 0–3 column, so the 0–10 scale
--    works before the first Regenerate. The mapping is SWEETNESS_SCALE.
--    legacyToLevel in lib/suggest/types.ts: 0 → 0, 1 → 3, 2 → 6, 3 → 9.
--    Only rows that don't have a level yet — a re-run never overwrites a
--    level Jev or the owner has set. traits_version stays 1, so these rows are
--    still Regenerate targets.
-- ---------------------------------------------------------------------------
update menu_item_traits
   set sweetness_level = case sweetness when 0 then 0 when 1 then 3 when 2 then 6 else 9 end
 where sweetness_level is null;

-- PostgREST caches the schema; ask it to reload so the new columns are
-- selectable straight away (the generate route's probe reads traits_version).
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify:
--   -- the columns exist and every row has a version:
--   select menu_item_id, sweetness_level, intensity, refreshment, indulgence,
--          novelty, textures, mood_fit, traits_version
--     from menu_item_traits limit 5;
--   select count(*) as rows_without_a_level from menu_item_traits where sweetness_level is null;   -- 0
--   select traits_version, count(*) from menu_item_traits group by 1 order by 1;
--
--   -- 'focus' and 'unwind' are now legal moods (rolls back either way):
--   begin;
--     update menu_item_traits set moods = array['focus', 'unwind']::text[] where false;
--   rollback;
--
--   -- ...and the CHECKs still REJECT garbage, i.e. they were widened, not
--   -- dropped. Each of these must raise 23514; if one succeeds, that
--   -- constraint is gone:
--   -- update menu_item_traits set moods = array['angry']::text[]            where menu_item_id = (select menu_item_id from menu_item_traits limit 1);
--   -- update menu_item_traits set sweetness_level = 11                      where menu_item_id = (select menu_item_id from menu_item_traits limit 1);
--   -- update menu_item_traits set textures = array['a','b','c','d']::text[] where menu_item_id = (select menu_item_id from menu_item_traits limit 1);
--
--   -- the constraints are present and named:
--   select conname from pg_constraint
--    where conrelid = 'menu_item_traits'::regclass and contype = 'c' and conname like 'menu_item_traits_%'
--    order by conname;
--
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
