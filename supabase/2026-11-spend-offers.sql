-- ===========================================================================
-- Spend offers: "spend ₹1099, get one Instant Coffee jar at ₹49".
--
-- The second kind of offer in Promotions → Offers (the first is the multi-buy
-- offer, menu_offers, 2026-10-item-offers.sql). The item keeps its regular
-- price on the menu and on the line (₹399), and the offer comes off the bill
-- as its own discount row:
--
--   … café items …             ₹1099
--   Instant Coffee (Classic)    ₹399
--   Instant Coffee at ₹49      −₹350
--
--   spend_offers               One offer on one menu item: its name (printed
--                              on the bill), the minimum everything ELSE on
--                              the bill must reach (min_spend_inr, before GST
--                              and packaging, not counting what Ritual cups
--                              pay for), and what one unit then costs
--                              (price_inr). On/off and an optional start/end.
--                              One unit per bill. At most one switched-on
--                              spend offer per item.
--   orders.spend_offers        The live spend offers on the bill's items when
--                              it was priced (a snapshot), so a void, a Settle
--                              edit or an add re-checks the minimum against the
--                              offer as it was sold.
--   orders.offer_name          The offer row's label when it is a spend offer
--                              (a multi-buy label is read off the lines).
--
-- It can't be combined: with a coupon or Beanies on the bill it stays off (the
-- counter screen says why), and against the multi-buy offers the bill takes
-- whichever saves more, never both. The rule is lib/orders/offers.ts
-- billOffers, run by the server and the POS alike. The discount sits inside
-- orders.discount_inr / offer_discount_inr like the multi-buy one, so totals,
-- GST and reports read the bill as before.
--
-- Additive only and safe to re-run. Safe to apply before or after the app
-- update that reads it: no spend offer exists until one is created, and the
-- order columns are only written on orders that have one.
-- ===========================================================================

create table if not exists spend_offers (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(btrim(name)) between 1 and 60),
  menu_item_id   uuid not null references menu_items(id) on delete cascade,
  min_spend_inr  integer not null check (min_spend_inr > 0),
  price_inr      integer not null check (price_inr >= 0),
  active         boolean not null default true,
  valid_from     timestamptz,
  valid_to       timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (valid_from is null or valid_to is null or valid_to > valid_from)
);

-- One switched-on spend offer per item.
create unique index if not exists spend_offers_one_active_per_item
  on spend_offers (menu_item_id) where active;

-- Read and written only by the server (service role): the order routes, the
-- POS menu read and app/api/spend-offers (manager / owner).
alter table spend_offers enable row level security;
revoke all on spend_offers from anon, authenticated;

alter table orders
  add column if not exists spend_offers jsonb,
  add column if not exists offer_name text;

-- ---------------------------------------------------------------------------
-- Verify:
--   select s.name, m.name as item, s.min_spend_inr, s.price_inr, s.active
--     from spend_offers s join menu_items m on m.id = s.menu_item_id;
--   select order_number, offer_name, offer_discount_inr, discount_inr, total_inr
--     from orders where offer_name is not null order by created_at desc limit 20;
-- ---------------------------------------------------------------------------
