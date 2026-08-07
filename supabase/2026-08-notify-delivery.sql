-- ===========================================================================
-- Phase 6 · WA-4 — delivery receipts: what the customer's PHONE says.
--
-- Everything the notifications table records today stops at our own doorstep.
-- status='sent' means "the Meta Cloud API accepted the request", which is a
-- statement about an HTTP call, not about a phone. That is precisely how the
-- current situation stayed invisible for weeks: the owner says the bill never
-- arrives, the log says 'sent', and both are telling the truth.
--
-- Meta will tell us the rest — sent → delivered → read, or failed — but only
-- via a status webhook, and only keyed by the message id we already store in
-- provider_ref. So the table gains the two facts it cannot currently hold, and
-- the status vocabulary gains the two outcomes only the handset can report.
--
-- ORDERING IS NOT GUARANTEED. Meta does not promise the webhooks themselves
-- arrive in order, so a 'delivered' can land after a 'read' for the same
-- message. The ladder is therefore enforced in the route as a guarded UPDATE
-- (app/api/webhooks/whatsapp/route.ts): a status only ever moves forward.
-- These two columns are set-once facts and are safe to fill in either order.
--
-- Safe to re-run. Apply BEFORE deploying the webhook route — the route writes
-- status='delivered'/'read', which the old CHECK constraint rejects, and the
-- rejection would be silent (the webhook must never answer non-2xx, so a
-- failed write shows up only in the logs). The endpoint now counts those
-- rejections and returns them as `failed` in its response body, so this
-- migration being un-applied is visible rather than reported as success.
--
-- THE MIGRATION IS NOT THE WHOLE DEPLOY. The webhook fails CLOSED, so with
-- either of these unset it 403s every handshake and 401s every status callback,
-- forever, with no row written and no alert — Meta retries, then disables the
-- subscription. Both must be set in the deployed environment:
--
--   WHATSAPP_APP_SECRET            Meta app → Settings → Basic → App Secret
--   WHATSAPP_WEBHOOK_VERIFY_TOKEN  any long random string; paste the SAME value
--                                  into Meta's "Verify token" field
--
-- And point Meta's callback URL at /api/webhooks/whatsapp. The older
-- /api/whatsapp/webhook path still answers — it now runs this same handler
-- rather than the fail-open one it shipped with — but it is retired and should
-- be deleted once the new URL is confirmed receiving receipts.
-- ===========================================================================

-- 1. When the handset acknowledged receipt, and when it was opened. Nullable
--    forever: most rows will never be delivered ones (email, stub sends, and
--    every send made before this migration existed), and a missing receipt is
--    not the same claim as "not delivered".
alter table notifications add column if not exists delivered_at timestamptz;
alter table notifications add column if not exists read_at      timestamptz;

-- 2. 'delivered' and 'read' join the vocabulary. The previous list is the one
--    2026-08-bill-observability.sql left behind ('skipped' was its addition);
--    dropping and re-adding is how that migration widened it too, and is what
--    makes this file re-runnable.
alter table notifications drop constraint if exists notifications_status_check;
alter table notifications add constraint notifications_status_check
  check (status in ('queued', 'sent', 'failed', 'skipped', 'delivered', 'read'));

-- 3. The webhook's only join key. Every status callback arrives with Meta's
--    message id and nothing else we recognise, so this lookup runs several
--    times per message sent — three callbacks for a bill that lands and is
--    read. Partial, because the column is NOT NULL DEFAULT '' and every
--    skipped row carries that empty string: indexing tens of thousands of ''
--    would be pure overhead, and the route never looks up an empty ref.
create index if not exists idx_notifications_provider_ref
  on notifications (provider_ref) where provider_ref <> '';

-- ---------------------------------------------------------------------------
-- Verify:
--   -- the two columns exist:
--   select delivered_at, read_at from notifications limit 1;
--
--   -- the widened CHECK accepts the new statuses (rolls back either way):
--   begin;
--     update notifications set status = 'delivered' where false;
--     update notifications set status = 'read'      where false;
--   rollback;
--
--   -- ...and still REJECTS garbage, i.e. it was widened, not dropped. This
--   -- must raise 23514; if it succeeds, the constraint is gone:
--   -- insert into notifications (order_id, channel, event, status)
--   --   values ('00000000-0000-0000-0000-000000000000', 'whatsapp', 'bill', 'nonsense');
--
--   -- the index is present:
--   select indexname from pg_indexes
--    where tablename = 'notifications' and indexname = 'idx_notifications_provider_ref';
--
--   -- once the webhook is live, the receipts themselves:
--   select event, channel, status, delivered_at, read_at, error
--     from notifications where event = 'bill' order by created_at desc limit 20;
--
-- Then run `npm run verify:db`.
-- ---------------------------------------------------------------------------
