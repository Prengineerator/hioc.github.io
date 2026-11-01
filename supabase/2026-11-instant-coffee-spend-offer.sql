-- ===========================================================================
-- "Spend ₹1099, get one Instant Coffee jar at ₹49" (any flavour, one per bill).
--
-- Needs supabase/2026-11-spend-offers.sql and the app update that reads it.
-- RUN THIS AFTER THAT UPDATE IS LIVE (the app before it ignores spend offers).
-- The same as creating it in Promotions → Offers → Spend & get, where it can be
-- edited, switched off or deleted from then on. Inserts only; safe to re-run.
-- ===========================================================================

insert into spend_offers (id, name, menu_item_id, min_spend_inr, price_inr, active)
select 'c4e2a9d1-7b3f-4c6e-8a52-9f1d0b6e3a74', 'Instant Coffee at ₹49',
       'f3299544-0c5e-4478-9ad3-029741e35279', 1099, 49, true
where exists (select 1 from menu_items where id = 'f3299544-0c5e-4478-9ad3-029741e35279')
  and not exists (
    select 1 from spend_offers
    where menu_item_id = 'f3299544-0c5e-4478-9ad3-029741e35279' and active
  )
on conflict (id) do nothing;

-- Verify:
--   select name, min_spend_inr, price_inr, active from spend_offers;
