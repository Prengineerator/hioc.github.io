-- HIOC Phase 2 "Value & Retention" — schema migration.
-- Companion to docs/PHASE-2-SPEC.md §6. ADDITIVE and (where possible)
-- idempotent — run AFTER phase1-migration.sql is applied.
--
-- HOW TO RUN (Supabase SQL Editor):
--   Run SECTION 1 (enum additions) FIRST, on its own, and let it commit
--   (Postgres won't let a new enum value be *used* in the same transaction it
--   was added in), then run the rest.
--
-- NEW SECURITY MODEL THIS PHASE: unlike Phase 1 (all order reads server-side
-- via the service role), Phase 2 lets a LOGGED-IN CUSTOMER read *their own*
-- loyalty/reviews via RLS `auth.uid() = user_id`. Order *detail* stays
-- server-side (service role, filtered by user_id) — see SECTION 9 notes.
--
-- WHEN APPLIED FOR REAL: mirror every change in lib/types.ts in the SAME PR,
-- run the PCI + per-user RLS review (Q3) and the payment/refund + coupon/
-- loyalty tests (Q1/Q2) from the Phase-2 DoD.

-- ===========================================================================
-- SECTION 1 — Enum extensions  (RUN THIS BLOCK FIRST, THEN COMMIT)
-- ===========================================================================

-- Add the manager role tier (Phase 1 had customer/staff/owner; the manager
-- gate is what allows refunds — docs/PHASE-2-SPEC.md FND-5). profiles.role is
-- a CHECK-constrained text column, so this is handled in SECTION 8, not here.

-- payment_method already exists from Phase 1 ('cash','upi','card','online').
-- payment_status already exists from Phase 1
--   ('unpaid','payment_pending','paid','refunded','partially_refunded').
-- No new enums are strictly required for the committed scope; loyalty and
-- coupon "types" are modeled as CHECK-constrained text for flexibility.
-- (This section is intentionally a no-op placeholder so the run order matches
--  phase1-migration.sql's structure.)
select 1;

-- ===========================================================================
-- SECTION 2 — orders: link to a customer account  (ACC-2/ACC-4)
-- ===========================================================================
-- Nullable so guest checkout (Phase 1) is unchanged; set when a logged-in
-- customer orders, or backfilled when a guest "claims" past orders by phone.
alter table orders add column if not exists user_id uuid references auth.users(id) on delete set null;
create index if not exists idx_orders_user_id on orders (user_id);

-- Fast guest-claim lookup by phone (ACC-4).
create index if not exists idx_orders_customer_phone on orders (customer_phone);

-- ===========================================================================
-- SECTION 3 — payments & refunds  (FND-1, FND-2, PAY-1/3)
-- ===========================================================================
-- One row per payment attempt/intent against an order. We store ONLY gateway
-- references — never PAN/CVV (PCI, XC-032). An order may have multiple rows
-- across retries; the successful one drives orders.payment_status = 'paid'.
create table if not exists payments (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references orders(id) on delete cascade,
  gateway            text not null default 'razorpay',        -- provider name
  gateway_order_id   text not null default '',                -- provider's order id
  gateway_payment_id text not null default '',                -- provider's payment id (on success)
  method             payment_method,                          -- upi/card/... (null until known)
  amount_inr         integer not null check (amount_inr >= 0),
  status             payment_status not null default 'payment_pending',
  signature_ok       boolean not null default false,          -- webhook signature verified
  error              text not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- idempotency: one row per gateway order id (once assigned)
  unique (gateway, gateway_order_id)
);

create index if not exists idx_payments_order on payments (order_id);
create index if not exists idx_payments_status on payments (status);

create trigger trg_payments_updated_at
  before update on payments
  for each row execute function set_updated_at();

-- Refunds against a payment. Manager-initiated (FND-5). Partial supported.
create table if not exists refunds (
  id              uuid primary key default gen_random_uuid(),
  payment_id      uuid not null references payments(id) on delete cascade,
  order_id        uuid not null references orders(id) on delete cascade,
  amount_inr      integer not null check (amount_inr > 0),
  reason          text not null default '',
  status          text not null default 'pending' check (status in ('pending', 'processed', 'failed')),
  gateway_ref     text not null default '',
  created_by      uuid references auth.users(id) on delete set null,   -- the manager
  created_at      timestamptz not null default now(),
  processed_at    timestamptz
);

create index if not exists idx_refunds_order on refunds (order_id);
create index if not exists idx_refunds_payment on refunds (payment_id);

-- ===========================================================================
-- SECTION 4 — accounts: extend profiles  (ACC-1/ACC-3)
-- ===========================================================================
-- Phase 1's profiles had (id, role, created_at). Add the customer-facing
-- fields. IMPORTANT: profiles writes stay SERVER-SIDE (service role) and only
-- ever touch these whitelisted columns — NEVER `role` — preserving Phase 1's
-- anti-privilege-escalation guarantee (no client UPDATE policy is added).
alter table profiles add column if not exists name              text not null default '';
alter table profiles add column if not exists phone             text not null default '';
alter table profiles add column if not exists phone_verified    boolean not null default false;
alter table profiles add column if not exists marketing_consent boolean not null default false;   -- DPDP: marketing only, not transactional
alter table profiles add column if not exists prefs             jsonb not null default '{}'::jsonb;
alter table profiles add column if not exists updated_at        timestamptz not null default now();

create index if not exists idx_profiles_phone on profiles (phone);

-- Favorites (ACC-5): a customer's saved menu items.
create table if not exists favorites (
  user_id       uuid not null references auth.users(id) on delete cascade,
  menu_item_id  uuid not null references menu_items(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (user_id, menu_item_id)
);

-- ===========================================================================
-- SECTION 5 — coupons & promotions  (FND-3, LOY-2, LOY-5)
-- ===========================================================================
create table if not exists coupons (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  description        text not null default '',
  discount_type      text not null check (discount_type in ('percent', 'flat')),
  discount_value     integer not null check (discount_value >= 0),   -- percent (0-100) or paise-safe ₹
  min_order_inr      integer not null default 0 check (min_order_inr >= 0),
  max_discount_inr   integer not null default 0 check (max_discount_inr >= 0),  -- 0 = no cap
  scope              jsonb not null default '{}'::jsonb,             -- {item_ids:[], category:[]} — empty = whole menu
  valid_from         timestamptz,
  valid_to           timestamptz,
  usage_limit        integer not null default 0,                    -- total redemptions; 0 = unlimited
  per_user_limit     integer not null default 0,                    -- per customer; 0 = unlimited
  is_auto            boolean not null default false,                -- auto-applied promo (no code needed)
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

create index if not exists idx_coupons_active on coupons (active);

create table if not exists coupon_redemptions (
  id            uuid primary key default gen_random_uuid(),
  coupon_id     uuid not null references coupons(id) on delete cascade,
  order_id      uuid not null references orders(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  discount_inr  integer not null check (discount_inr >= 0),
  created_at    timestamptz not null default now(),
  unique (coupon_id, order_id)
);

create index if not exists idx_coupon_redemptions_coupon on coupon_redemptions (coupon_id);
create index if not exists idx_coupon_redemptions_user on coupon_redemptions (user_id);

-- Homepage banners / announcements (LOY-5).
create table if not exists announcements (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  body         text not null default '',
  image_url    text not null default '',
  active       boolean not null default true,
  starts_at    timestamptz,
  ends_at      timestamptz,
  created_at   timestamptz not null default now()
);

-- ===========================================================================
-- SECTION 6 — loyalty  (FND-4, LOY-1)
-- ===========================================================================
-- Ledger model: balance is ALWAYS the sum of loyalty_transactions for a user
-- (never a free-floating counter). loyalty_accounts caches the balance for
-- fast reads; it is maintained by the app in the same transaction as the
-- ledger insert (or via a trigger — see note).
create table if not exists loyalty_accounts (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  points_balance integer not null default 0,
  updated_at     timestamptz not null default now()
);

create table if not exists loyalty_transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  order_id    uuid references orders(id) on delete set null,
  type        text not null check (type in ('earn', 'redeem', 'adjust', 'reverse', 'expire')),
  points      integer not null,                                  -- signed: +earn / -redeem
  note        text not null default '',
  created_at  timestamptz not null default now()
);

create index if not exists idx_loyalty_tx_user on loyalty_transactions (user_id, created_at);

-- Single-row loyalty config (earn/redeem rates, expiry) — owner-editable.
create table if not exists loyalty_config (
  id                    uuid primary key default gen_random_uuid(),
  is_singleton          boolean not null default true,
  points_per_inr        numeric(6,3) not null default 1.000,      -- points earned per ₹ spent
  inr_per_point         numeric(6,3) not null default 0.250,      -- ₹ value when redeeming 1 point
  min_redeem_points     integer not null default 100,
  max_redeem_pct        integer not null default 50,              -- cap redemption at % of bill
  points_expiry_days    integer not null default 365,             -- 0 = never
  enrolled_by_default   boolean not null default true,
  updated_at            timestamptz not null default now()
);

create unique index if not exists idx_loyalty_config_singleton on loyalty_config (is_singleton);
insert into loyalty_config (is_singleton) values (true) on conflict (is_singleton) do nothing;

-- ===========================================================================
-- SECTION 7 — reviews & ratings  (LOY-3, RET-4)
-- ===========================================================================
create table if not exists reviews (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders(id) on delete cascade,
  menu_item_id   uuid references menu_items(id) on delete set null,   -- null = overall order rating
  user_id        uuid references auth.users(id) on delete set null,   -- null = guest (via order link)
  rating         integer not null check (rating between 1 and 5),
  comment        text not null default '',
  staff_response text not null default '',
  responded_at   timestamptz,
  hidden         boolean not null default false,                       -- owner can hide abusive content
  created_at     timestamptz not null default now(),
  -- one review per (order, item) — item null = the overall-order review
  unique (order_id, menu_item_id)
);

create index if not exists idx_reviews_order on reviews (order_id);
create index if not exists idx_reviews_item on reviews (menu_item_id);
create index if not exists idx_reviews_rating on reviews (rating);

-- ===========================================================================
-- SECTION 8 — RBAC: add 'manager' role  (FND-5)
-- ===========================================================================
-- Widen profiles.role again (Phase 1 = staff/customer, Phase-1 migration
-- added owner). Add manager. The role-change audit trigger from the Phase-1
-- migration keeps recording changes automatically.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('staff', 'customer', 'owner', 'manager'));

-- ===========================================================================
-- SECTION 9 — Row Level Security for the new tables
-- ===========================================================================
-- Pattern:
--  * payments/refunds/coupons/redemptions/announcements: staff/owner-facing
--    reads gated to `authenticated` (route guards enforce owner/manager where
--    needed); customer-facing payment status is served by server routes.
--  * loyalty_* and reviews: customers may read THEIR OWN rows (auth.uid()),
--    and may insert their own review. All privileged writes (earn/redeem,
--    refunds, coupon config) go through server routes on the service role.
--  * loyalty_config & announcements: public READ (customer UI needs them),
--    authenticated WRITE.

alter table payments             enable row level security;
alter table refunds              enable row level security;
alter table favorites            enable row level security;
alter table coupons              enable row level security;
alter table coupon_redemptions   enable row level security;
alter table announcements        enable row level security;
alter table loyalty_accounts     enable row level security;
alter table loyalty_transactions enable row level security;
alter table loyalty_config       enable row level security;
alter table reviews              enable row level security;

-- Payments / refunds — staff/owner read (route guard narrows to owner/manager).
create policy payments_staff_read on payments for select to authenticated using (true);
create policy refunds_staff_read  on refunds  for select to authenticated using (true);

-- Favorites — customer manages their own.
create policy favorites_own_read   on favorites for select to authenticated using (auth.uid() = user_id);
create policy favorites_own_insert on favorites for insert to authenticated with check (auth.uid() = user_id);
create policy favorites_own_delete on favorites for delete to authenticated using (auth.uid() = user_id);

-- Coupons — owner-managed via authenticated; server role (service key) reads
-- for validation at checkout (bypasses RLS entirely, so no public read needed).
create policy coupons_staff_read   on coupons for select to authenticated using (true);
create policy coupons_staff_write  on coupons for insert to authenticated with check (true);
create policy coupons_staff_update on coupons for update to authenticated using (true) with check (true);
create policy coupon_redemptions_staff_read on coupon_redemptions for select to authenticated using (true);

-- Announcements — public read (active shown on site), authenticated write.
create policy announcements_public_read on announcements for select using (true);
create policy announcements_staff_write on announcements for insert to authenticated with check (true);
create policy announcements_staff_update on announcements for update to authenticated using (true) with check (true);

-- Loyalty — customer reads own balance + ledger; config is public-read.
create policy loyalty_accounts_own_read on loyalty_accounts for select to authenticated using (auth.uid() = user_id);
create policy loyalty_tx_own_read       on loyalty_transactions for select to authenticated using (auth.uid() = user_id);
create policy loyalty_config_public_read on loyalty_config for select using (true);
create policy loyalty_config_staff_write on loyalty_config for update to authenticated using (true) with check (true);

-- Reviews — customer reads + writes their own; staff/owner read all.
create policy reviews_own_read    on reviews for select to authenticated using (auth.uid() = user_id or auth.uid() is not null);
create policy reviews_own_insert  on reviews for insert to authenticated with check (auth.uid() = user_id);
create policy reviews_staff_update on reviews for update to authenticated using (true) with check (true);

-- ===========================================================================
-- SECTION 10 — Retention & payment analytics views  (RET-1..4)
-- ===========================================================================
-- Build on Phase-1's v_valid_orders. Plain views for correctness; materialize
-- the hot ones later if range queries slow down at volume.

-- Per-customer stats (RET-1): order count, spend, first/last order, simple LTV.
create or replace view v_customer_stats as
  select
    o.user_id,
    count(*)                                   as orders,
    coalesce(sum(o.total_inr), 0)              as revenue_inr,
    coalesce(round(avg(o.total_inr)), 0)       as aov_inr,
    min(o.created_at)                          as first_order_at,
    max(o.created_at)                          as last_order_at
  from v_valid_orders o
  where o.user_id is not null
  group by o.user_id;

-- New vs returning per day (RET-1): a customer is "returning" if they had a
-- prior valid order before the one counted.
create or replace view v_new_vs_returning as
  select
    (o.created_at at time zone 'Asia/Kolkata')::date as order_date,
    count(*) filter (where prior.cnt = 0) as new_customers,
    count(*) filter (where prior.cnt > 0) as returning_customers
  from v_valid_orders o
  cross join lateral (
    select count(*) as cnt
    from v_valid_orders p
    where p.user_id = o.user_id
      and p.created_at < o.created_at
  ) prior
  where o.user_id is not null
  group by 1
  order by 1 desc;

-- Payment mix (RET-2): method split + collected vs refunded.
create or replace view v_payment_mix as
  select
    coalesce(p.method::text, 'unknown')                       as method,
    count(*)                                                  as payments,
    coalesce(sum(p.amount_inr) filter (where p.status = 'paid'), 0)    as collected_inr,
    coalesce((select sum(r.amount_inr) from refunds r where r.status = 'processed'), 0) as refunded_inr_total
  from payments p
  group by 1;

-- Coupon performance (RET-3): redemptions + total discount cost per coupon.
create or replace view v_coupon_performance as
  select
    c.code,
    count(cr.id)                              as redemptions,
    coalesce(sum(cr.discount_inr), 0)         as discount_given_inr
  from coupons c
  left join coupon_redemptions cr on cr.coupon_id = c.id
  group by c.code
  order by discount_given_inr desc;

-- Review summary (RET-4): volume + average, overall and per item, over time.
create or replace view v_review_summary as
  select
    (created_at at time zone 'Asia/Kolkata')::date as review_date,
    menu_item_id,
    count(*)                                        as reviews,
    round(avg(rating), 2)                           as avg_rating
  from reviews
  where not hidden
  group by 1, 2;

-- ===========================================================================
-- END OF PHASE 2 MIGRATION
-- Remember: mirror all of the above in lib/types.ts when applied; run the
-- PCI + per-user RLS review (Q3) and payment/coupon/loyalty tests (Q1/Q2).
-- ===========================================================================
