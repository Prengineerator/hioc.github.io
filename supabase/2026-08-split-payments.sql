-- ===========================================================================
-- Phase 4 · POS4-1 — split payments as first-class parts.
--
-- `orders.payment_method` is a single enum value, so a bill settled half in cash
-- and half by UPI had nowhere truthful to live. Collapsing it to one method
-- silently corrupts the cash drawer: OPS-2's expected-cash math sums whole order
-- totals for payment_method='cash', so a UPI half would be counted as cash and
-- every drawer would read short.
--
-- Each part is now its own row. `orders.payment_method` remains, set to the
-- LARGEST part, so existing reads and UI keep working — but the drawer math
-- reads these rows, and falls back to orders.total_inr only for legacy orders
-- that predate this table.
--
-- Safe to re-run. Apply BEFORE deploying the POS4-1 payment route.
-- ===========================================================================

create table if not exists order_payments (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  method        payment_method not null,
  amount_inr    integer not null check (amount_inr > 0),
  -- Cash only: what the customer handed over. Change given = tendered - amount.
  -- Null for every non-cash method (nothing is "tendered" on a card).
  tendered_inr  integer check (tendered_inr is null or tendered_inr >= amount_inr),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_order_payments_order on order_payments (order_id);
create index if not exists idx_order_payments_created on order_payments (created_at);

alter table order_payments enable row level security;

-- Staff read (the order detail and the cash screen show the parts); every write
-- goes through the service-role payment route, which is the authorization gate.
create policy order_payments_staff_read on order_payments
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Verify:
--   select method, count(*), sum(amount_inr) from order_payments group by method;
--   -- a split order should show two rows summing to its total:
--   select o.order_number, p.method, p.amount_inr, p.tendered_inr
--     from order_payments p join orders o on o.id = p.order_id
--    order by p.created_at desc limit 10;
-- ---------------------------------------------------------------------------
