-- ===========================================================================
-- Loyalty: 1 point = ₹1 at redemption, and existing points rescaled ×0.1.
--
-- Follows 2026-10-loyalty-earn-10pct.sql (earning dropped to 0.1 point per
-- ₹1). Points earned before that were at 1 point per ₹1 and redeemed at
-- ₹0.25; they are restated as if they had always been earned at 10%, i.e.
-- every old ledger row ×0.1 (rounded). A customer who had 242 points now has
-- ~24, worth ₹24.
--
-- The ledger rows themselves are rescaled — not offset by one "conversion"
-- row per customer — because reverseForOrder() takes back exactly the
-- points recorded against an order: refunding an old ₹250 order must take 25
-- points, not 250. Earn rows written after the earn-rate change are already
-- at the new scale and are left alone; every redeem row predates this file
-- (redemptions were still quoted at ₹0.25), so all of them are rescaled.
--
-- Original values are kept in loyalty_tx_backup_2026_10_rescale. That table
-- doubles as the run-once guard: re-running this file is a no-op.
-- ===========================================================================

do $$
declare
  earn_cutoff timestamptz;
begin
  if to_regclass('public.loyalty_tx_backup_2026_10_rescale') is not null then
    raise notice 'loyalty rescale already applied — skipping';
    return;
  end if;

  -- When earning switched to 10% (that migration stamped updated_at). Read
  -- before this file stamps it again below.
  select updated_at into earn_cutoff
    from loyalty_config
   where is_singleton and points_per_inr = 0.100;
  if earn_cutoff is null then
    raise exception 'Apply 2026-10-loyalty-earn-10pct.sql first';
  end if;

  create table public.loyalty_tx_backup_2026_10_rescale as
    select id, user_id, type, points, note, created_at
      from loyalty_transactions
     where type = 'redeem'
        or (type = 'earn' and created_at < earn_cutoff);
  -- Audit copy only: no client role may read it.
  alter table public.loyalty_tx_backup_2026_10_rescale enable row level security;
  revoke all on public.loyalty_tx_backup_2026_10_rescale from anon, authenticated;

  update loyalty_transactions t
     set points = sign(b.points) * round(abs(b.points) * 0.1),
         note   = t.note || ' (×0.1 loyalty rescale)'
    from public.loyalty_tx_backup_2026_10_rescale b
   where t.id = b.id;

  -- Rounding can leave a customer who spent (nearly) everything at -1; bring
  -- them back to zero rather than carry a debt.
  insert into loyalty_transactions (user_id, type, points, note)
  select user_id, 'adjust', -sum(points), 'Rounding after loyalty rescale'
    from loyalty_transactions
   group by user_id
  having sum(points) < 0;

  -- Balance cache (the ledger stays the source of truth).
  update loyalty_accounts a
     set points_balance = coalesce(s.bal, 0),
         updated_at     = now()
    from (select user_id, sum(points)::int as bal from loyalty_transactions group by user_id) s
   where s.user_id = a.user_id;

  alter table loyalty_config alter column inr_per_point set default 1.000;
  update loyalty_config
     set inr_per_point = 1.000,
         updated_at    = now()
   where is_singleton;
end $$;
