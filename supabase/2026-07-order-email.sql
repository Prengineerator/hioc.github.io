-- Optional customer email on orders, so a link-based e-bill can be delivered by
-- email (in addition to WhatsApp). Nullable: email stays optional at checkout —
-- guests can still order with just name + phone.
alter table orders add column if not exists customer_email text;

-- Widen the notifications delivery-log event CHECK to include the 'bill' event
-- (RCT-1/2), so the engine can log the e-bill send (email + whatsapp channels)
-- for idempotency + audit alongside the order-status notifications.
alter table notifications drop constraint if exists notifications_event_check;
alter table notifications add constraint notifications_event_check
  check (event in ('accepted', 'ready', 'rejected', 'cancelled', 'bill'));
