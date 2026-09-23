-- ===========================================================================
-- SECURITY · rate_limits was the only table in the schema with no RLS.
--
-- `rate_limits` (phase2-hardening.sql §M10) backs the OTP abuse limiter. Every
-- other table enables row level security; this one never did, so the public
-- anon key could read the counters — and reading them is enough to learn which
-- keys exist and how close each is to its cap, i.e. exactly when to retry.
--
-- Nothing legitimate reads this table from a client. The limiter runs through
-- `check_rate_limit`, a SECURITY DEFINER function called server-side
-- (lib/api/rateLimit.ts), and SECURITY DEFINER functions are unaffected by RLS
-- on the tables they touch. So enabling RLS with NO policy — deny everyone —
-- leaves the limiter working and shuts the read.
--
-- Note the limiter deliberately FAILS OPEN if the RPC is missing
-- (lib/api/rateLimit.ts) so a partial deploy can't lock customers out of
-- checkout. That trade-off is unchanged here.
--
-- Safe to re-run.
-- ===========================================================================

alter table rate_limits enable row level security;

-- No policy is created on purpose: RLS with zero policies denies every
-- anon/authenticated request, while the service role and SECURITY DEFINER
-- functions still pass. If a policy is ever added here, re-read the comment
-- above first — there is no client that needs to read this table.

-- ---------------------------------------------------------------------------
-- Verify:
--   select relname, relrowsecurity from pg_class
--    where relname = 'rate_limits';   -- expect relrowsecurity = t
--
--   -- and that nothing was granted back:
--   select policyname from pg_policies where tablename = 'rate_limits';  -- expect 0 rows
--
-- Then confirm OTP still works end-to-end — the limiter must keep functioning.
-- ---------------------------------------------------------------------------
