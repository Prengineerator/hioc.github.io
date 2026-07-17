# HIOC Phase 1 — Deploy / Setup Runbook

Steps to make the Phase-1 "Connected Ordering" code live against your Supabase
project. The application code ships complete; these are the one-time
infrastructure actions the code depends on (kept out of the app per the repo
convention that DDL and infra are owner-run, not auto-applied).

## 1. Apply the database migration

`supabase/phase1-migration.sql` is additive and (mostly) idempotent. **Run it in
two steps** in the Supabase SQL editor — Postgres won't let a brand-new enum
value be *used* in the same transaction it was added in:

1. Run **SECTION 1** (the `alter type order_status add value …` block) on its
   own and let it commit.
2. Run **the rest of the file** (Sections 2–10).

This adds: the extended `order_status` lifecycle, `order_type` / `payment_*`
enums, the new `orders` columns (ETA, pickup code/slot, GST breakup, payment,
`version`), `order_status_events`, `notifications`, `store_settings` (seeded with
one row), `role_change_audit`, the `owner` role, RLS for the new tables, the
`v_*` analytics views, and `order_items.special_instructions`.

`lib/types.ts` already mirrors this migration exactly — no code change needed
after running it.

## 2. Promote an owner account

The owner dashboard (`/owner`) is gated to `profiles.role = 'owner'`. Promote an
existing Supabase Auth user:

```sql
update profiles set role = 'owner'
where id = '<auth-user-uuid>';
```

The `role_change_audit` trigger records the change automatically. Staff accounts
stay `role = 'staff'`; owners also have full access to `/staff` (OWN-002).

## 3. Create the menu-images storage bucket (for item photos, S6/C6)

Staff photo upload writes to a Supabase Storage bucket. Create a **public**
bucket named **`menu-images`** (Storage → New bucket → public). The upload route
uses the service-role key, so no extra Storage RLS policy is required for
writes; public read serves the images on the customer menu.

> The exact bucket name is confirmed against the staff engineer's upload route —
> see `app/api/menu/upload/route.ts`. If it differs, match this doc to the code.

## 4. Configure store settings

Open `/owner/settings` (as the owner) and set real values, or update the seeded
`store_settings` row directly:
- **Opening hours** — JSON `{ "mon": [{"open":"10:00","close":"24:00"}], … }`
  (HIOC is 10:00 AM–12:00 AM daily; `close` may be `"24:00"`).
- **GST** — defaults to 5% exclusive (`gst_percent`, `gst_inclusive`). Confirm
  HIOC's real treatment.
- Pickup-slot length/capacity, default prep time, busy buffer, last-order cutoff,
  packaging charge — all editable here.

## 5. (Optional) Realtime + notifications

- **Realtime** is on by default. For the staff board and menu availability
  (postgres_changes), ensure Realtime is enabled for the `orders` and
  `menu_items` tables in the Supabase dashboard (Database → Replication). The
  customer live-status page uses a per-order broadcast channel and needs no table
  replication.
- **Notifications** currently use a **stub/log adapter** (`lib/notifications/
  adapters.ts`): every accept/ready/reject/cancel is rendered and logged to the
  `notifications` table (and the server console) as `sent`, closing the loop
  end-to-end. To send real WhatsApp/SMS, add one adapter implementing
  `NotificationAdapter` and return it from `getAdapter()` — no engine changes.

## 6. Feature flags (optional, `lib/flags.ts`)

Env-driven, all default ON: `NEXT_PUBLIC_FLAG_OWNER_DASHBOARD`,
`NEXT_PUBLIC_FLAG_REALTIME`, `FLAG_NOTIFICATIONS`. Set to `false` to dark-launch /
disable a capability without a code change.

## 7. Notification provider (going live)

The engine (`lib/notifications/*`) is provider-agnostic and defaults to the log
adapter. To send real messages, set `NOTIFY_PROVIDER` + the provider's creds (see
`.env.local.example`):
- **WhatsApp (Meta Cloud API):** `NOTIFY_PROVIDER=whatsapp`, `WHATSAPP_TOKEN`,
  `WHATSAPP_PHONE_ID`. Note: proactive messages outside the 24h customer-service
  window require a **pre-approved template** — swap the payload `type` to
  `template` in `whatsappAdapter` once templates are approved.
- **SMS (Twilio):** `NOTIFY_PROVIDER=sms`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
- Missing creds → automatic fallback to the log adapter (never breaks the loop).

## 8. Monitoring & performance

- **Error monitoring (F5t):** route-segment + global error boundaries report via
  `lib/monitoring.ts`. Set `MONITORING_WEBHOOK_URL` (or the `NEXT_PUBLIC_` variant
  for the browser) to forward captured errors to Sentry/Slack/Logtail; unset =
  console-only.
- **Performance (F2t):** images are lazy-loaded with fixed aspect boxes (no CLS),
  routes are code-split, and reads are `no-store` (no stale caches). Run a formal
  audit against a deployed URL: `npx lighthouse <preview-url>/menu
  --preset=perf --view` (target: interactive < 2.5s on 4G / mid-range mobile).

## Verify

- `npx tsc --noEmit` → clean, `npm run build` → succeeds, `npm test` → green.
- Place an order → it appears on `/staff` in <2s → Accept with an ETA → the
  customer's `/order/[id]` page advances and a row lands in `notifications` →
  Ready → verify pickup code → Complete. Owner `/owner` reflects the revenue/count.
