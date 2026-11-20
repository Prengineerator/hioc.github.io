-- ===========================================================================
-- Shop orders: ship with Amazon Shipping (docs/AMAZON-SHIPPING-SPEC.md).
--
-- On /owner/shop a paid order can go to Shiprocket (as before) or be booked on
-- the café's own Amazon Shipping account: the page shows Amazon's prices, the
-- owner picks one, and the label is bought. These columns record which carrier
-- took the parcel and what Amazon said. Nothing about the Shiprocket columns
-- changes.
--
--   shop_orders.carrier             'shiprocket' or 'amazon'. Null: not booked
--                                   with either yet (and old orders, until the
--                                   backfill in the report is run; the app
--                                   treats null + shiprocket_order_id as
--                                   Shiprocket).
--   shop_orders.amazon_shipment_id  Amazon's id for the booked shipment. Unique
--                                   when set, so one Amazon shipment can never
--                                   sit on two orders.
--   shop_orders.amazon_service_name The Amazon service the owner picked.
--   shop_orders.amazon_charge_inr   What the café paid Amazon for the label, in
--                                   rupees (paise allowed, like
--                                   shiprocket_total_inr). Never negative.
--   shop_orders.amazon_status       Amazon's own status text for the shipment.
--   shop_orders.amazon_booking_at   A short claim taken just before booking, so a
--                                   double click can't buy two labels (like
--                                   shiprocket_sending_at).
--
-- No new order status. Booking with Amazon moves paid -> shipped; cancelling the
-- label moves it back to paid. shop_orders has no status-transition trigger
-- (its only trigger, shop_orders_legacy_discount, runs before insert and
-- touches discounts), and shop_orders_status_check lists the allowed values,
-- not the allowed moves, so shipped -> paid is already permitted.
--
-- Written by the server only (service role); shop_orders keeps its lockdown
-- (RLS on, nothing granted to anon or authenticated). Until this file is
-- applied the Amazon button is simply unavailable and everything else works as
-- before; the previous build ignores these columns.
--
-- Additive and safe to re-run.
-- ===========================================================================

alter table shop_orders
  add column if not exists carrier             text,
  add column if not exists amazon_shipment_id  text,
  add column if not exists amazon_service_name text,
  add column if not exists amazon_charge_inr   numeric(10, 2),
  add column if not exists amazon_status       text,
  add column if not exists amazon_booking_at   timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'shop_orders_carrier_check'
                    and conrelid = 'public.shop_orders'::regclass) then
    alter table shop_orders
      add constraint shop_orders_carrier_check
      check (carrier is null or carrier in ('shiprocket', 'amazon'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'shop_orders_amazon_charge_nonneg'
                    and conrelid = 'public.shop_orders'::regclass) then
    alter table shop_orders
      add constraint shop_orders_amazon_charge_nonneg
      check (amazon_charge_inr is null or amazon_charge_inr >= 0);
  end if;
end $$;

create unique index if not exists shop_orders_amazon_shipment_id_key
  on shop_orders (amazon_shipment_id) where amazon_shipment_id is not null;

comment on column shop_orders.carrier is
  'Which carrier took the parcel: shiprocket or amazon. Null until booked (and on older Shiprocket orders until backfilled).';
comment on column shop_orders.amazon_shipment_id is
  'Amazon Shipping''s shipment id once booked; unique when set. Cleared when the label is cancelled.';
comment on column shop_orders.amazon_service_name is
  'The Amazon Shipping service the owner picked for this parcel.';
comment on column shop_orders.amazon_charge_inr is
  'What the cafe paid Amazon for the label, in rupees (>= 0). Not what the customer paid.';
comment on column shop_orders.amazon_status is
  'Amazon Shipping''s own status text for the shipment, as last read.';
comment on column shop_orders.amazon_booking_at is
  'Short claim taken just before booking with Amazon so a double click cannot buy two labels.';

-- ---------------------------------------------------------------------------
-- Verify (read-only; run after applying, in Hioc India):
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'shop_orders'
--      and column_name in ('carrier','amazon_shipment_id','amazon_service_name',
--                          'amazon_charge_inr','amazon_status','amazon_booking_at')
--    order by column_name;
--   -- expect 6 rows (text x4, numeric, timestamp with time zone)
--   select conname from pg_constraint
--    where conrelid = 'public.shop_orders'::regclass
--      and conname in ('shop_orders_carrier_check','shop_orders_amazon_charge_nonneg');
--   -- expect 2 rows
--   select indexname from pg_indexes where indexname = 'shop_orders_amazon_shipment_id_key';
--   -- expect 1 row
--   select relrowsecurity from pg_class where oid = 'public.shop_orders'::regclass;
--   -- expect true (unchanged)
--   select count(*) from information_schema.role_table_grants
--    where table_name = 'shop_orders' and grantee in ('anon','authenticated');
--   -- expect 0 (unchanged)
-- ---------------------------------------------------------------------------
