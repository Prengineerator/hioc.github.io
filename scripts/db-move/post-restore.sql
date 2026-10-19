-- Fix-ups applied inside the restore transaction, right after the data
-- (scripts/db-move/move.sh). Each fixes something `supabase db dump` cannot
-- carry from one project to another on its own.
--
-- psql variables: old_url, new_url (https://<ref>.supabase.co), cron_secret.

-- pg_cron and pg_net must exist before move.sh re-creates the scheduled jobs.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Menu photos uploaded by scripts/upload-menu-images.mjs are stored as full
-- public URLs on the OLD project's storage. Point them at the new project,
-- which receives the same files right after this restore. Replica mode keeps
-- it a pure data fix: no triggers fire and no updated_at moves.
set session_replication_role = replica;
update public.menu_items
   set image_url = :'new_url' || substr(image_url, length(:'old_url') + 1)
 where starts_with(image_url, :'old_url' || '/');
set session_replication_role = origin;

-- The dump leaves out triggers on Supabase-managed tables. This one gives
-- every new sign-up its profiles row (supabase/schema.sql); without it a new
-- customer can log in but has no profile.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Vault values are encrypted with a key unique to each project, so a copied
-- row could never be decrypted here. Seal CRON_SECRET afresh under the name
-- the pg_cron jobs read it by.
delete from vault.secrets where name = 'cron_secret';
select vault.create_secret(:'cron_secret', 'cron_secret');
