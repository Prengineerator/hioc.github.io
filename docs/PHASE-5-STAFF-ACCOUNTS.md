# Phase 5 add-on — Staff accounts run from the owner portal

Status: **PLAN** (2026-09-23). Branch `phase-5-attendance-payroll`.

## The problem

Staff sign in as `name@hioc.in`. That address is a **login ID, not a mailbox** —
nothing sent to it arrives. Today:

- The owner can only add a member by email + role, or demote them to customer
  (`app/api/owner/staff/route.ts`). No names, no passwords, no edit.
- A forgotten staff password has no recovery path: Supabase's own reset email
  would go to `name@hioc.in`, i.e. nowhere.
- Payroll lives only on the owner screen; staff never receive their payslip.

## Decisions (owner, 2026-09-23)

| # | Decision |
|---|----------|
| SA-D1 | Every staffer has a **login ID** (`<id>@hioc.in`, the Supabase auth email) **and a personal email** the owner records. All mail to a staffer goes to the personal email — never to the login ID. |
| SA-D2 | **Delete = deactivate.** Login blocked immediately, hidden from the active team, history (attendance, leave, payroll, orders entered) kept; can be reactivated. A true delete is allowed **only** for an account with no history (e.g. created by mistake). Reason: `attendance_sessions`, `staff_employment`, payroll lines etc. are `on delete cascade` from `auth.users` — hard-deleting a real staffer would erase their pay history. |
| SA-D3 | **First password: owner chooses per staffer** — send a one-time "set your password" link to the personal email, or type an initial password. Same two options for later resets. |
| SA-D4 | Passwords are **never emailed**. When the owner sets one, the staffer gets a "your password was changed" notice instead. |
| SA-D5 | Payslips are emailed to the personal email when the owner **finalizes** a payroll month. |

## Data — `supabase/2026-09-staff-accounts.sql`

```sql
create table staff_accounts (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  login_id        text not null unique,          -- 'ayush' (auth email = login_id || '@hioc.in')
  personal_email  text,                          -- nullable only for backfilled rows
  phone           text not null default '',
  status          text not null default 'active' check (status in ('active','deactivated')),
  role_before_deactivation text,                 -- restored on reactivate
  deactivated_at  timestamptz,
  deactivated_by  uuid references auth.users(id) on delete set null,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table staff_accounts enable row level security;   -- NO policies: service role only (PII)

create table staff_emails (                        -- delivery log + idempotency
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null check (kind in ('invite','password_reset','password_changed','payslip')),
  ref           text not null default '',          -- e.g. payroll run id for 'payslip'
  to_email      text not null,
  status        text not null check (status in ('sent','failed','skipped')),
  provider_ref  text not null default '',
  error         text not null default '',
  created_at    timestamptz not null default now()
);
create unique index staff_emails_payslip_once on staff_emails (user_id, ref) where kind = 'payslip' and status = 'sent';
alter table staff_emails enable row level security;
```

Backfill: one `staff_accounts` row per existing staff/manager/owner profile,
`login_id` = local part of their auth email, `personal_email` NULL. The team
screen flags those rows "Add a personal email — password reset and payslips
can't reach them until you do."

## Owner portal (owner-only; managers get nothing new)

Team screen (`components/owner/TeamManager.tsx`) becomes:

- **Active / Deactivated** lists: name, login ID, personal email (or a warning),
  role, last sign-in.
- **Add staff**: name, login ID (live preview `ayush@hioc.in`, uniqueness
  checked), personal email (required), role, and *First password*:
  ◉ Email a set-password link  ○ Set it now (min 8 chars, shown once to the owner).
- **Edit**: name, personal email, role, login ID (rename updates the auth email).
- **Password**: "Email reset link" or "Set new password".
- **Deactivate / Reactivate**; **Delete** is only offered when the account has no history.
- Owner cannot deactivate, demote or delete themselves or another owner.

## APIs (all `getOwnerUser()`-gated, admin client)

| Method | Route | Does |
|---|---|---|
| GET | `/api/owner/staff` | list with account fields (extends today's shape; existing fields unchanged) |
| POST | `/api/owner/staff` | create: `createUser({email: login, email_confirm: true, password?})` → profiles role+name → `staff_accounts` → invite link or nothing. Keeps accepting the old `{email, role}` body. |
| PATCH | `/api/owner/staff/[id]` | name / personal email / role / login ID |
| POST | `/api/owner/staff/[id]/password` | `{mode:'link'}` → recovery link to personal email; `{mode:'set', password}` → `updateUserById` + "password changed" notice |
| POST | `/api/owner/staff/[id]/deactivate` | `ban_duration` far future + `profiles.role='customer'` (server-side gates read role, so access stops on the next request, not in an hour) + status row |
| POST | `/api/owner/staff/[id]/reactivate` | unban + restore `role_before_deactivation` |
| DELETE | `/api/owner/staff/[id]` | 409 unless no attendance / leave / payroll / employment / orders.created_by / cash rows |

## Password emails

- Links come from `admin.auth.admin.generateLink({ type: 'recovery', email: loginEmail, options: { redirectTo: <staff>/staff/reset-password } })`
  — this **returns** the link without Supabase sending anything; we send it via
  Resend (`emailAdapter`) to the personal email. Same mechanism for invites.
- **Staff "Forgot password?"** on `/staff/login`: enter login ID →
  `POST /api/auth/staff/forgot` → always the same generic reply (no account
  enumeration); rate-limited per IP and per login ID; sends only for an
  *active* account *with* a personal email.
- **`/staff/reset-password`** page: exchanges the recovery token, asks for the
  new password twice, `updateUser({ password })`, signs in to the staff app.
- Every send is logged in `staff_emails`.

## Payslip emails

- On PAY-4 finalize, one email per staff line with a personal email: month,
  paid days, hours, OT, deductions, adjustments (with reason), net pay — from
  the run's **frozen snapshot**, never recomputed.
- Idempotent per (staffer, run) via `staff_emails_payslip_once`; the payroll
  screen shows per-person sent / failed / no email, with **Resend payslip**.
- Finalizing never fails because an email did.
- Reverse-and-refinalize sends the corrected payslip (new run id).

## Config

- Resend: done (domain verified, `RESEND_API_KEY` + `RESEND_FROM` set). Optional
  `RESEND_FROM_STAFF` (e.g. `HIOC Team <team@hioc.in>`), falls back to `RESEND_FROM`.
- **Supabase → Authentication → URL Configuration → Redirect URLs**: add
  `https://staff.hioc.in/staff/reset-password` (and the preview domain) —
  otherwise the reset link lands on the site root. Owner does this in the dashboard.

## Security invariants (add to SECURITY-PLAYBOOK as A-10…)

- Owner-only for every account operation; a manager session gets 403.
- No password ever in an email, log line, or API response (except the owner's own form echo).
- Forgot-password responses are identical whether or not the account exists.
- `staff_accounts` / `staff_emails` have RLS on and no client policies.
- Deactivation revokes server access via role immediately, and the ban blocks new sign-ins/refreshes.

## Build plan (parallel, by file ownership)

| Ticket | Owner | Files |
|---|---|---|
| SA-1 migration + `lib/staff/accounts.ts` (login-ID rules, validation, types, API contract) | lead (first, shared) | `supabase/2026-09-staff-accounts.sql`, `lib/staff/accounts.ts` |
| SA-2 owner account APIs | agent A | `app/api/owner/staff/**` |
| SA-3 team screen | agent B | `components/owner/TeamManager.tsx`, `app/owner/staff/page.tsx` |
| SA-4 password emails: templates + sender, forgot API, reset page, login link | agent C | `lib/staff/emails.ts`, `app/api/auth/staff/**`, `app/staff/login`, `app/staff/reset-password` |
| SA-5 payslip emails + resend | agent D | `app/api/owner/payroll/**`, `components/owner/PayrollScreen.tsx`, `lib/payroll/payslipEmail.ts` |
| SA-6 `verify:db` section, playbook, integration + review | lead | `scripts/verify-db*`, `docs/SECURITY-PLAYBOOK.md` |

## Deploy order

1. Apply `supabase/2026-09-staff-accounts.sql`; `npm run verify:db` green.
2. Add the reset-password redirect URL in Supabase.
3. Deploy.
4. Owner fills in personal emails for existing staff.
5. Test: add a throwaway staffer with a link → set password → log in → forgot
   password → deactivate (login refused) → reactivate → delete (allowed: no history).
6. Finalize a payroll month → check payslip email + log.
