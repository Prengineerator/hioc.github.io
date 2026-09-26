-- ===========================================================================
-- POS-ACC — a counter order opens the customer's HIOC account.
--
-- When staff place an order with the customer's phone and no account holds that
-- number yet, POST /api/orders now creates one (lib/loyalty/customerLink.ts
-- createCounterCustomer): an Auth user keyed on the phone, a customer profile
-- with that phone marked verified, and the order linked through
-- customer_user_id so it earns points on completion like any linked order.
-- The customer later signs in with a WhatsApp code to the same number and lands
-- on that account, points and history included.
--
-- The one case the Auth admin API cannot answer on its own: the number is
-- ALREADY an Auth user whose profile was never verified — typically someone who
-- requested a login code and never entered it (signInWithOtp creates the user
-- at request time). createUser then fails with phone_exists, and there is no
-- admin endpoint to look a user up by phone. This function is that lookup.
--
-- Service role only: it reads auth.users, so anon/authenticated must never be
-- able to call it (it would turn any phone number into an account id).
--
-- Safe to re-run. Until it is applied, the create path still works for new
-- numbers; only the "abandoned login code" case stays unlinked (and logs why).
-- ===========================================================================

create or replace function public.auth_user_id_for_phone(p_phone text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- GoTrue stores phones as bare digits ("919876543210"); accept either form.
  select u.id
    from auth.users u
   where u.phone in (p_phone, ltrim(p_phone, '+'))
   limit 1
$$;

revoke execute on function public.auth_user_id_for_phone(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_for_phone(text) to service_role;

-- ---------------------------------------------------------------------------
-- Verify:
--   -- 1. only service_role (and the owner) can execute it:
--   select proname, proacl from pg_proc where proname = 'auth_user_id_for_phone';
--
--   -- 2. accounts opened at the counter (app_metadata set by createUser):
--   select u.id, u.phone, u.created_at, p.name, p.phone_verified
--     from auth.users u
--     join public.profiles p on p.id = u.id
--    where u.raw_app_meta_data->>'created_via' = 'staff_pos'
--    order by u.created_at desc
--    limit 20;
-- ---------------------------------------------------------------------------
