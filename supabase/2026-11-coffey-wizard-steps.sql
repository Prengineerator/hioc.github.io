-- ===========================================================================
-- Coffey wizard step tracking (docs/COFFEY-SPEC.md §10.7)
--
-- Adds:
--   * suggestion_wizard_steps   one row each time a browser reaches a step of
--                               the /suggest wizard BEFORE any picks exist:
--                               'opened' (the wizard loaded), 'feeling_chosen'
--                               (the first feeling tapped in that visit) and
--                               'picks_requested' (each press of "Show my
--                               picks"). Written by POST /api/suggest/steps;
--                               read by Owner → Suggestions.
--
-- Why: suggestion_sessions only gets a row when picks are requested, so a
-- customer who leaves on the feeling step or the preferences step leaves no
-- trace. Over 19 Oct – 17 Nov 2026 Vercel counted 14 visitors on /suggest and
-- suggestion_sessions held 2 first asks; nothing could say which step lost the
-- other 12. These rows can.
--
-- What a row holds: the step, the time, the browser's guest id (anon_id, the
-- same random id suggestion_sessions.anon_id carries, so a visitor's steps line
-- up with their picks) and, for a signed-in customer, their user id, read from
-- the session on the server and never from the request. Nothing the customer
-- chose or typed: no feeling, no preferences, no note. No IP address and no
-- User-Agent. Deleting an account clears user_id and keeps the row, so the
-- counts survive. Rows older than 13 months are deleted by
-- /api/cron/purge-traffic, with the traffic rows, as the privacy policy says.
--
-- Access: RLS ON and NO policies, like pairing_events and traffic_events, and
-- the browser roles hold no privilege on the table at all. Only the service
-- role reads or writes it.
--
-- Every CHECK below is NAMED and dropped-then-added, so this file is safe to
-- re-run and a future change can widen one by name. The step list mirrors
-- WIZARD_STEPS in lib/suggest/types.ts and the guest id's shape mirrors
-- WIZARD_ANON_ID in lib/suggest/wizardSteps.ts;
-- tests/suggestWizardStepsMigration.test.ts pins both. Change both sides
-- together or neither.
--
-- Safe to apply before OR after deploying the code. Until it is applied the
-- wizard works exactly as before: the inserts fail quietly (they are
-- best-effort and always answer 204) and Owner → Suggestions shows a note
-- asking for this file.
--
-- Once applied: run `npm run verify:db`, open /suggest in a private window,
-- tap a feeling, then check Owner → Suggestions → "Where people leave the
-- wizard".
-- ===========================================================================

create table if not exists suggestion_wizard_steps (
  id          uuid primary key default gen_random_uuid(),
  anon_id     text not null,
  user_id     uuid references auth.users(id) on delete set null,
  step        text not null,
  created_at  timestamptz not null default now()
);

-- WIZARD_STEPS of lib/suggest/types.ts.
alter table suggestion_wizard_steps drop constraint if exists suggestion_wizard_steps_step_check;
alter table suggestion_wizard_steps add constraint suggestion_wizard_steps_step_check
  check (step in ('opened', 'feeling_chosen', 'picks_requested'));

-- The guest id is a UUID, or 'anon-<time>-<random>' where the browser has no
-- crypto.randomUUID (components/suggest/api.ts). Letters, digits, '_' and '-'
-- only, so the one text column a browser fills can never carry a sentence.
alter table suggestion_wizard_steps drop constraint if exists suggestion_wizard_steps_anon_id_check;
alter table suggestion_wizard_steps add constraint suggestion_wizard_steps_anon_id_check
  check (anon_id ~ '^[A-Za-z0-9_-]{8,64}$');

-- Owner → Suggestions reads a date range; the purge deletes by age.
create index if not exists idx_suggestion_wizard_steps_created on suggestion_wizard_steps (created_at);

-- For the foreign key: deleting an account has to find that account's rows.
-- Partial, because most rows are guests.
create index if not exists idx_suggestion_wizard_steps_user
  on suggestion_wizard_steps (user_id) where user_id is not null;

alter table suggestion_wizard_steps enable row level security;
revoke all on suggestion_wizard_steps from anon, authenticated;

-- PostgREST caches the schema; ask it to reload so the table is usable straight
-- away (npm run verify:db probes it through PostgREST).
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify:
--   -- the table exists, with RLS on and no policies (rls_on true, policies 0):
--   select c.relname, c.relrowsecurity as rls_on,
--          (select count(*) from pg_policies p where p.tablename = c.relname) as policies
--     from pg_class c
--    where c.relname = 'suggestion_wizard_steps' and c.relkind = 'r';
--
--   -- the browser roles hold no privilege on it (expect no rows):
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'suggestion_wizard_steps' and grantee in ('anon', 'authenticated');
--
--   -- the CHECKs refuse a made-up step and a guest id that is not an id. Both
--   -- statements must fail with "violates check constraint"; nothing is written:
--   insert into suggestion_wizard_steps (anon_id, step) values ('verify-guest-id', 'bogus');
--   insert into suggestion_wizard_steps (anon_id, step) values ('a sentence, not an id', 'opened');
--
--   -- after opening /suggest and tapping a feeling, the latest rows:
--   select created_at, step, anon_id, user_id is not null as signed_in
--     from suggestion_wizard_steps order by created_at desc limit 10;
--
--   -- visitors per step over the last 30 days (what the owner page shows,
--   -- before it narrows each step to the visitors who reached the one before):
--   select step, count(distinct anon_id) as visitors
--     from suggestion_wizard_steps
--    where created_at >= now() - interval '30 days'
--    group by step;
-- ---------------------------------------------------------------------------
