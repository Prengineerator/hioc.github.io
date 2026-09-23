-- Staff accounts run from the owner portal (docs/PHASE-5-STAFF-ACCOUNTS.md).
--
-- A staffer signs in as <login_id>@hioc.in — a login ID, NOT a mailbox. Their
-- real, reachable address is staff_accounts.personal_email; every reset link,
-- password notice and payslip goes there. Both tables are service-role only
-- (RLS on, no policies): personal emails are PII and only owner APIs read them.
--
-- Idempotent: safe to re-run.

create table if not exists staff_accounts (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  login_id                 text not null unique
                             check (login_id ~ '^[a-z][a-z0-9._-]{1,29}$'),
  personal_email           text,               -- NULL only on backfilled rows
  phone                    text not null default '',
  status                   text not null default 'active'
                             check (status in ('active', 'deactivated')),
  role_before_deactivation text,
  deactivated_at           timestamptz,
  deactivated_by           uuid references auth.users(id) on delete set null,
  created_by               uuid references auth.users(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint staff_accounts_deactivation_consistent
    check ((status = 'deactivated') = (deactivated_at is not null))
);

alter table staff_accounts enable row level security;

drop trigger if exists staff_accounts_updated_at on staff_accounts;
create trigger staff_accounts_updated_at
  before update on staff_accounts
  for each row execute function set_updated_at();

-- Delivery log + idempotency for every email sent to a staffer.
create table if not exists staff_emails (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null
                  check (kind in ('invite', 'password_reset', 'password_changed', 'payslip')),
  ref           text not null default '',     -- payroll_runs.id for 'payslip'
  to_email      text not null,
  status        text not null check (status in ('sent', 'failed', 'skipped')),
  provider_ref  text not null default '',
  error         text not null default '',
  created_at    timestamptz not null default now()
);

alter table staff_emails enable row level security;

-- One successfully sent payslip per staffer per payroll run.
create unique index if not exists staff_emails_payslip_once
  on staff_emails (user_id, ref) where kind = 'payslip' and status = 'sent';

create index if not exists staff_emails_user_created
  on staff_emails (user_id, created_at desc);

-- Backfill: every existing team member gets an account row. login_id is the
-- local part of their auth email, lower-cased; personal_email stays NULL for
-- the owner to fill in. A local part that doesn't satisfy the login_id rule
-- (or collides) is skipped — the owner screen shows those as "no account
-- details" and saving an edit creates the row.
insert into staff_accounts (user_id, login_id)
select p.id, lower(split_part(u.email, '@', 1))
from profiles p
join auth.users u on u.id = p.id
where p.role in ('staff', 'manager', 'owner')
  and u.email is not null
  and lower(split_part(u.email, '@', 1)) ~ '^[a-z][a-z0-9._-]{1,29}$'
on conflict do nothing;
