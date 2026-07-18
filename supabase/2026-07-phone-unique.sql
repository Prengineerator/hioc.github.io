-- HIOC — Security review S4 (2026-07): one verified phone per account.
-- Run once in the Supabase SQL editor. Idempotent.
--
-- Without this, two distinct Auth accounts could each set phone_verified=true on
-- the SAME number, making guest-order claim (lib/account/claim.ts, matches on
-- orders.customer_phone) ambiguous. A partial unique index enforces uniqueness
-- only across VERIFIED, non-empty phones — unverified rows and the '' default are
-- unaffected.
create unique index if not exists idx_profiles_phone_verified_unique
  on profiles (phone)
  where phone_verified = true and phone <> '';

-- After running: the phone-OTP verify route's profile UPDATE may now hit a 23505
-- when a number is already linked elsewhere. That is the correct outcome —
-- surface it to the user as "This number is already linked to another account."
