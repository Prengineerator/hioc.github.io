-- ===========================================================================
-- Change a dine-in order after it is paid — the difference is settled later.
--
-- Owner request (2026-11): a table pays up front, then wants one more coffee,
-- or to take the brownie off. Until now every correction refused a paid bill
-- ("This order is already paid — start a new order"), so the counter had to
-- cancel the order and punch a new one.
--
-- Now a PAID dine-in order can take Add items / Void / Edit exactly like an
-- unpaid one. The bill is recomputed as always, and the change in its total
-- goes into a BALANCE on the order, settled later from the Settle screen:
--
--   balance_due_inr > 0   the customer owes the café that much more
--                         (collected as extra tenders — cash, UPI, card, split)
--   balance_due_inr < 0   the café owes the customer that much back
--                         (given back as a counter refund on a chosen tender)
--   balance_due_inr = 0   nothing outstanding (every order before this file)
--
-- The order stays payment_status = 'paid' throughout. That is deliberate: the
-- HIOC Ritual and paid_at triggers act on the move INTO 'paid', so flipping a
-- paid bill back to 'unpaid' and settling it again would redeem cups twice and
-- move nothing it should. Money keeps its own records, as before:
--   * what was taken     → order_payments rows (each at its own created_at)
--   * what went back     → refunds rows (processed_at)
-- so the cash drawer and the reconciliation report stay exact.
--
-- paid_amended_at marks the first time a paid bill was changed. From then on
-- "Change payment" (re-recording how the bill was paid) is refused: it would
-- replace the tenders taken at different times with one set summing to the new
-- total, and the drawer would lose track of the original payment.
--
-- order_amendments gets one more kind, 'settle_balance', for the audit row a
-- balance settlement writes (collect / give back / write off). Every kind
-- already allowed is kept.
--
-- Safe to re-run. Apply BEFORE deploying — the app refuses to change a paid
-- bill (with a message naming this file) until these columns exist.
-- ===========================================================================

alter table orders add column if not exists balance_due_inr integer not null default 0;
alter table orders add column if not exists paid_amended_at timestamptz;

-- The Settle screen lists every bill with a balance, from any day.
create index if not exists idx_orders_balance_due on orders (created_at)
  where balance_due_inr <> 0;

alter table order_amendments drop constraint if exists order_amendments_kind_check;
alter table order_amendments add constraint order_amendments_kind_check
  check (kind in ('void_item', 'add_item', 'change_table', 'comp', 'change_qty', 'settle_balance'));

-- ---------------------------------------------------------------------------
-- Verify:
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns
--    where table_name = 'orders' and column_name in ('balance_due_inr', 'paid_amended_at');
--   -- expect: balance_due_inr integer 0 NOT NULL; paid_amended_at timestamptz NULL
--
--   -- Bills with something still to settle:
--   select order_number, total_inr, balance_due_inr, paid_amended_at
--     from orders where balance_due_inr <> 0 order by created_at;
-- ---------------------------------------------------------------------------
