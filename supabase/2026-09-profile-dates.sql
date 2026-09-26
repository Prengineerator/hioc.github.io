-- ===========================================================================
-- Profile date columns — pre-fill from Petpooja history on phone verify.
--
-- When a customer verifies their phone, we look up their Petpooja legacy
-- customer record and pre-fill name, date_of_birth, and date_of_anniversary
-- if they are still blank on the profiles row (app/api/auth/customer/phone-otp/
-- verify/route.ts, best-effort catch block). This avoids re-collecting dates
-- the customer already gave Petpooja, while respecting any values they have
-- since entered in the app.
--
-- Idempotent: safe to re-run.
-- ===========================================================================

alter table profiles add column if not exists date_of_birth date;
alter table profiles add column if not exists date_of_anniversary date;
