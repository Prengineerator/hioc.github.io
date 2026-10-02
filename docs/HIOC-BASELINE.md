# HIOC production baseline (before the Servly restructure)

Recorded 2026-10-02, Phase 0 of the Servly restructure, using read-only API calls only. Nothing was changed.

**This repository is public.** The page lists names only:
- no secret values;
- no project or team IDs;
- no database row counts.

The live values stay in the Vercel and Supabase dashboards.

This is the state that the restructure must keep working: the same URLs, flows, data and look. Phase 10 compares new preview deployments against it, and the rollback plan in `SWITCH-OVER.md` returns to it.

---

## 1. Source code

| Item | Value |
|---|---|
| Repo | `Prengineerator/hioc.github.io` (personal account, **public**) |
| Production branch | `main` |
| Production commit at baseline | `d25140c` (merge of #69, "Inventory: separate switch for taking stock off on sale") |
| App | One Next.js **14.2.35** App Router app (React 18, TypeScript, Tailwind 3); package manager **npm** (`package-lock.json`) |
| Tests | Vitest unit and route-handler tests under `tests/`. No E2E or visual tests yet. |
| CI | `.github/workflows/code-revamp.yml` runs `checks` (lint, `tsc`, `vitest`, `next build`) on PRs touching the app. `pos-desktop-release.yml` builds the Electron POS. |
| Commit authors (last 30 commits) | 21 by `Claude <noreply@anthropic.com>` (agent branches), 9 by the owner (`Prengineerator`, merges via GitHub) |
| Legacy files | `index.html`, `css/`, `js/`, `sass/`, `fonts/`, `images/`, `CNAME` (`hioc.in`), `_config.yml`, `README.txt`. These are the old GitHub Pages "under construction" site. `hioc.in` is now served by Vercel (see §2). |

**One app, three surfaces.** There are no separate "ordering", "staff" and "owner" apps today. `middleware.ts` and `lib/routing/surface.ts` route by host:

| Host | Serves | Same as path |
|---|---|---|
| `hioc.in`, `www.hioc.in` | customer ordering site | `/`, `/menu`, `/checkout`, … |
| `staff.hioc.in` | staff POS / back office | `hioc.in/staff/**` |
| `owner.hioc.in` | owner dashboard | `hioc.in/owner/**` |

Other routing facts:
- `/api/**` is shared by all three hosts and is never rewritten.
- `middleware.ts` gates `/staff/**` (staff, manager or owner role, or an enrolled POS device with a PIN operator) and `/owner/**` (owner only), using Supabase Auth plus `profiles.role`.
- Both URL forms (path and subdomain) must keep working. Links already sent to customers and staff use both.

## 2. Vercel

| Item | Value |
|---|---|
| Account | Vercel **Hobby** plan, one Hobby team (slug `hioc`), one owner |
| Concurrent builds | 1 |
| Projects | **1**: `hioc-in` |
| Framework preset | Next.js |
| Node.js version | 24.x |
| Function region | `icn1` (Seoul), set in `vercel.json`. It sits next to the Supabase region `ap-northeast-2`. |
| Git connection | `Prengineerator/hioc.github.io`. Production = `main`. **Every pushed branch builds a preview** (no ignored-build step). |
| Recent deploy volume | 40 deployments in about 19 hours (production merges plus a preview for every agent-branch push) |
| Deployment protection | Vercel Authentication on all deployments except custom domains. Previews need a Vercel login or a protection-bypass token. |
| Build / install / output commands | Framework defaults (`next build`), no overrides in the repo |

### Domains (all on project `hioc-in`, all verified, none redirecting)

| Domain | Role |
|---|---|
| `hioc.in` | customer site (canonical) |
| `www.hioc.in` | customer site |
| `staff.hioc.in` | staff surface (rewritten to `/staff/**`) |
| `owner.hioc.in` | owner surface (rewritten to `/owner/**`) |
| `hioc-in-two.vercel.app`, `hioc-in-hioc.vercel.app`, `hioc-in-git-main-hioc.vercel.app` | Vercel-generated aliases |

### Vercel cron jobs (`vercel.json`, all daily, UTC)

| Path | Schedule (UTC) | ≈ IST |
|---|---|---|
| `/api/cron/expire-orders` | `0 3 * * *` | 08:30 (backstop; the main run is pg_cron, see §3) |
| `/api/cron/close-attendance` | `30 21 * * *` | 03:00 |
| `/api/cron/leave-reminders` | `30 4 * * *` | 10:00 |
| `/api/cron/purge-location` | `0 2 * * 0` | Sun 07:30 |
| `/api/cron/suggest-digest` | `30 22 * * 0` | Mon 04:00 |
| `/api/cron/expire-points` | `0 20 * * *` | 01:30 |
| `/api/cron/owner-reports` | `30 2 * * *` | 08:00 |
| `/api/cron/marketing-plan` | `15 4 * * *` | 09:45 |

Hobby runs each cron **at most once a day**, and Vercel only promises the hour, not the exact minute.

### Environment variable NAMES on `hioc-in` (values never read)

The targets are what Vercel reports. "branch" means a preview variable scoped to one Git branch.

| Name | Production | Preview | Notes |
|---|:-:|:-:|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✓ | ✓ | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | ✓ | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | ✓ | |
| `NEXT_PUBLIC_SITE_URL` | ✓ | ✓ | |
| `CRON_SECRET` | ✓ | ✓ | Must match the Supabase Vault secret `cron_secret`, which pg_cron uses to call `/api/cron/*` |
| `OPERATOR_JWT_SECRET` | ✓ | ✓ | Signs the POS PIN operator cookie |
| `SUPABASE_SEND_SMS_HOOK_SECRET` | ✓ | ✓ | Supabase Auth Send-SMS hook → WhatsApp OTP |
| `NOTIFY_PROVIDER` | ✓ | ✓ | |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_OTP_TEMPLATE` | ✓ | ✓ | |
| `WHATSAPP_TPL_BILL`, `WHATSAPP_TPL_BILL_LANG`, `WHATSAPP_TPL_BILL_HEADER_IMAGE` | ✓ | ✓ | |
| `RAZORPAY_KEY_ID`, `NEXT_PUBLIC_RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | ✓ | — | Live payments are production-only |
| `RESEND_API_KEY` | ✓ | branch | Preview copies scoped to 4 old branches |
| `RESEND_FROM` | ✓ | ✓ | |
| `TYPESAFE_API_KEY` | ✓ | ✓ | |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | ✓ | ✓ | **Not in `.env.local.example`** |
| `ANTHROPIC_API_KEY` | ✓ | — | **Not in `.env.local.example`** |
| `NEXT_PUBLIC_FLAG_ATTENDANCE` | ✓ | ✓ | |
| `NEXT_PUBLIC_FLAG_GUEST_OTP` | ✓ | ✓ | |
| `NEXT_PUBLIC_FLAG_PIN_SWITCH` | ✓ | — | |
| `NEXT_PUBLIC_FLAG_SUGGEST` | ✓ | ✓ | **Not in `.env.local.example`** |
| `NEXT_PUBLIC_FLAG_COFFEE_PASS` | ✓ | ✓ | HIOC Ritual |
| `NEXT_PUBLIC_FLAG_MARKETING` | ✓ | ✓ | |
| `NEXT_PUBLIC_FLAG_INVENTORY` | ✓ | branch | |

Other notes:
- Names in `.env.local.example` that are **not** set on Vercel use their code defaults. Examples: `RESEND_FROM_REPORTS`, `TWILIO_*`, `JEV_MODEL`, `SUGGEST_*`, the remaining `WHATSAPP_TPL_*`, and `NEXT_PUBLIC_FLAG_{REALTIME,STAFF_POS,TABLE_QR,OWNER_DASHBOARD,INVENTORY_SALES}`. The full reconciliation of code against `.env.example` against Vercel is in `AUDIT.md`.
- **Usage policy:** Vercel Hobby is for non-commercial use. HIOC takes real payments, so it should move to Pro (or another commercial plan) once it is commercially live. See `DEPLOY.md`.

## 3. Supabase

| Item | Value |
|---|---|
| Projects | **1** ("Hioc Coffee"), free plan |
| Region | `ap-northeast-2` (Seoul) |
| Postgres | 17 |
| Edge Functions | none |
| Branches | none. Branching is a paid feature, so migration tests need a separate free project or a local stack. |
| Tracked migrations | 27, from 2026-09-24 onward. **Everything earlier** (`supabase/schema.sql`, `phase*-*.sql`, `2026-07…`/`2026-08…`/most `2026-09…` files) **was applied by hand** in the SQL editor and is not in the migration history. |
| Extensions in use | `pg_cron`, `pg_net` (in `public`), `pgcrypto`, `uuid-ossp`, `btree_gist` (in `public`), `pg_stat_statements`, `supabase_vault` |
| Tables (`public`) | **84**, all with RLS enabled. 50 have no policies, so only the service role (the app's API routes) can reach them. That is deny-by-default, and looks intentional. |
| Data | Live orders, customers (`profiles`), loyalty, payments, cash, attendance, payroll, inventory, marketing consent. It also holds a large imported Petpooja history (`legacy_orders`, `legacy_order_items`, `legacy_customers`) with **real customer names and phone numbers**. |
| Scheduled jobs | Three pg_cron jobs `POST` to the app over `pg_net`, using the `cron_secret` Vault secret, at **hard-coded** URLs: `https://hioc.in/api/cron/expire-orders` (4 runs a day), `https://hioc.in/api/cron/feedback-requests`, and `https://hioc.in/api/cron/marketing-send` (from `supabase/2026-10-expire-orders-cron.sql`, `2026-10-order-feedback.sql`, `2026-10-marketing-agent.sql`). Whichever app serves `hioc.in/api/cron/*` after the split must keep answering them. |
| Security advisors | INFO: 50 × "RLS enabled, no policy" (by design). WARN: `btree_gist` and `pg_net` in `public`. WARN: `public.is_staff()` is a SECURITY DEFINER function callable by `authenticated`. WARN: leaked-password protection disabled. |

## 4. Other systems the app depends on

| System | What uses it | Must keep working |
|---|---|---|
| Razorpay (live) | Online payment, webhook `/api/payments/webhook` | Webhook URL is registered at Razorpay with the `hioc.in` domain |
| WhatsApp Cloud API (Meta) | OTP (via the Supabase Send-SMS hook), bills, order status, feedback, marketing. Webhooks `/api/whatsapp/webhook`, `/api/webhooks/whatsapp` | Webhook URLs and message templates are registered with Meta |
| Supabase Auth Send-SMS hook | Calls `/api/auth/sms-hook` on the app | Hook URL is configured in Supabase Auth |
| Resend | Staff password emails, owner reports, payslips | Sender domain |
| Electron POS desktop app (`desktop/`) | Wraps the staff site and drives receipt printers | Installed builds have the app URL baked in. See `AUDIT.md`. |
| LLM providers (Gemini, Anthropic, Typesafe) | Ask Coffey suggestions, marketing planner | Keys are production env vars |

Changing the app's host or domain affects every row in this table. Each one is part of the switch-over checklist.

## 5. Flows that must keep working (input to the Phase 1 E2E suite)

1. **Customer:**
   - browse `/menu`, customise an item (sizes, add-ons, sugar);
   - cart, `/checkout` with WhatsApp OTP or guest checkout;
   - pay online (Razorpay) or at the counter;
   - order status `/order/[id]`, receipt, review;
   - account (orders, favourites, profile), rewards (Beanies), `/ritual` (HIOC Ritual), `/coffey` (Ask Coffey);
   - table QR `/t/[token]`, referral `/r/[token]`, feedback `/feedback/[token]`.
2. **Staff:**
   - login (password and device PIN switching);
   - live orders board (accept, ready, complete), KOT/bill printing (`/staff-print`, desktop app);
   - POS new order, settle, cash day, cash movements and expenses;
   - tables, menu availability switches, inventory, attendance punch, leave, Ritual sell/redeem.
3. **Owner:**
   - login, reports and CSV, menu/settings, staff accounts and permissions, payroll, attendance;
   - devices, promotions/coupons, reviews and feedback, Ritual plans, suggestions (Coffey), marketing, notifications.
4. **Background:**
   - crons (§2);
   - pg_cron callbacks (§3);
   - payment and WhatsApp webhooks;
   - the SMS hook.

---
*Re-record before the switch-over (Phase 12): the production commit, env names, domains and cron list may change while the restructure is in progress.*
