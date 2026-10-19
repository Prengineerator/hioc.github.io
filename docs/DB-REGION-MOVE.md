# Moving the database from Seoul to Mumbai

**Status:** ready to run, 2026-10-19. The target project **Hioc India**
(`mulbrnmdzpagzlzgwzuy`, Mumbai) exists and is empty. Tooling:
`.github/workflows/supabase-region-move.yml` → `scripts/db-move/`. Nothing
changes for customers until cutover step 4.

## Why it's in Seoul, and why it has to be copied

The Supabase project **"Hioc Coffee"** (`jdhavrnivafuenncegqb`) was created on
15 July 2026 with the region **Seoul (`ap-northeast-2`)** picked at creation.
The code followed it later: `vercel.json` pins the app to `icn1` (Seoul) so it
sits next to the database. For a café in India, every page then pays a
round trip to Korea.

A Supabase project is tied to its region and **can't be switched**. Supabase's
own answer is to create a new project in the target region and copy everything
across. That's what this runbook does.

## What moves (measured 2026-10-19)

| | Seoul today | How it moves |
|---|---|---|
| Database | 125 MB, 102 tables (most of it the old Petpooja import) | dumped and restored in one transaction |
| Logins | 510 (500 phone, 10 email) | copied with their password hashes |
| Stored files | 45 menu photos (6.8 MB), bucket `menu-images` (public) | copied file by file |
| Menu photo links | 51 `menu_items.image_url` values point at Seoul's storage | rewritten to Mumbai during the restore |
| Sign-up trigger | `on_auth_user_created` on `auth.users` | re-created (the dump tool skips it) |
| Scheduled jobs | `expire-orders-poll`, `feedback-requests-poll`, `marketing-send-poll` | re-created, switched **off** until cutover |
| Vault secret | `cron_secret` | re-sealed from `CRON_SECRET` (Vault encryption is per project) |
| Auth settings, SMS hook, email templates | dashboard settings | **copied by hand** (checklist below) |
| API keys | per project | **new keys**, swapped in Vercel at cutover |

The copy tooling only ever reads Seoul. The one change there is pausing its
background jobs during the copy (cutover step 1). The database restore into
Mumbai is all-or-nothing: if it fails, Mumbai stays empty and the café keeps
running on Seoul.

The scripts were rehearsed against Supabase's own Postgres 17 image, with these results:
- The photo links are rewritten. Local paths, empty values and lookalike domains are left alone, and no triggers fire.
- The cron secret reads back exactly, including `$` and spaces.
- The jobs land switched off.
- The sign-up trigger creates profiles.
- A second run changes nothing.
- A failure rolls back completely.

The storage copier was tested against a mock Storage API, covering both key styles and paths with spaces and `#`.

## Before the night (daytime, no customer impact)

### 1. Project slot — done 2026-10-19

The free plan allows 2 active projects. The empty **studio-vastyukt** project
(no tables, logins, files or functions) was **paused** to free the slot.
Paused projects don't count toward the limit. Delete it for good whenever you
like: its dashboard → Project Settings → General → Delete project.

### 2. The Mumbai project — created 2026-10-19

| | |
|---|---|
| Name | **Hioc India** |
| Ref | `mulbrnmdzpagzlzgwzuy` |
| Region | South Asia (Mumbai), `ap-south-1` |
| URL | `https://mulbrnmdzpagzlzgwzuy.supabase.co` |
| Postgres | 17.11, empty |
| Plan | Free (organization "Hioc") |

It was created through the Supabase API, so nobody knows its database
password yet. Set one: Project Settings → Database → **Reset database
password**. Use a long random one and save it in your password manager. Then
collect:

| What | Where |
|---|---|
| Publishable key (`sb_publishable_…`) | Project Settings → API Keys |
| Secret key (`sb_secret_…`) | Project Settings → API Keys |
| Session pooler connection string | Connect → **Session pooler** (not "Direct") |

### 3. Copy the auth settings, Seoul → Mumbai

Open both dashboards side by side and make Mumbai match:

| Page | What to copy |
|---|---|
| Authentication → Sign In / Providers | Phone on, Email on, "Allow new users to sign up", "Confirm email" and the other toggles, same as Seoul |
| Authentication → URL Configuration | Site URL `https://hioc.in` and **every** Redirect URL (hioc.in, staff.hioc.in, owner.hioc.in …) |
| Authentication → Emails | every customised template (at least *Reset password*, used for staff password emails) and the SMTP settings if custom SMTP is on |
| Authentication → Hooks | **Send SMS hook** → HTTPS → `https://hioc.in/api/auth/sms-hook`, then *Generate secret*. Save that secret; it becomes `SUPABASE_SEND_SMS_HOOK_SECRET` at cutover. |
| Authentication → Rate limits, Sessions, Attack protection | same values as Seoul |
| Project Settings → Data API | same exposed schemas (normally `public`, `graphql_public`) |

### 4. Add the GitHub secrets

GitHub → repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `OLD_DB_URL` | Seoul → Connect → **Session pooler** string, with the real password (URL-encode `@ : / ? #` in it) |
| `NEW_DB_URL` | the same for Mumbai (its host contains `ap-south-1`) |
| `OLD_SUPABASE_URL` | `https://jdhavrnivafuenncegqb.supabase.co` |
| `NEW_SUPABASE_URL` | `https://mulbrnmdzpagzlzgwzuy.supabase.co` |
| `OLD_SERVICE_KEY` | Seoul's secret key (or its legacy `service_role` key) |
| `NEW_SERVICE_KEY` | Mumbai's secret key |
| `CRON_SECRET` | the same value as `CRON_SECRET` in Vercel |

### 5. Dry runs

GitHub only offers "Run workflow" for workflows that exist on the default
branch, so `.github/workflows/supabase-region-move.yml` has to be merged into
`main` first. Merging it changes nothing on the live site.

Actions → **Move Supabase to Mumbai** → Run workflow:

1. `check`: both projects reachable, Mumbai empty, Seoul's jobs listed. About 1 minute.
2. `rehearse`: the full real dump of Seoul, restored into a throwaway Supabase
   on GitHub's runner, with row counts compared. About 10 minutes. Neither real
   project is touched. During opening hours a few busy tables may show small
   differences; that's live traffic, not a problem.

Both must pass before the night.

## Cutover night (~45 minutes)

Start after closing and finish **before 03:00 IST**: the nightly attendance
and cash-day jobs run at 03:00 and 03:05 IST.

1. **Stop Seoul's background jobs.** In Seoul's SQL editor:
   `select cron.alter_job(jobid, active := false) from cron.job;`
   Feedback requests and marketing sends then stop writing while the copy runs.
2. Check that the store shows **closed** and no orders are open on the staff board.
3. **Copy.** Actions → Move Supabase to Mumbai → mode `migrate`, confirm `MIGRATE`.
   Takes about 5–10 minutes. It must end with `storage: 45/45 files copied`
   and `row counts match`. If it fails:
   - **During the dump or restore:** the restore is one transaction, so Mumbai
     is still empty. Turn Seoul's jobs back on (step 1 with `true`) and stop
     here. Nothing has changed for customers.
   - **After the restore, at the file copy or the count check:** run the
     workflow again with mode `storage`. It redoes only those two steps and is
     safe to repeat.
4. **Point the app at Mumbai.** Vercel → Project → Settings → Environment
   Variables, for Production and Preview:

   | Variable | New value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://mulbrnmdzpagzlzgwzuy.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Mumbai's publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Mumbai's secret key |
   | `SUPABASE_SEND_SMS_HOOK_SECRET` | the secret from Mumbai's SMS hook (step 3) |

   In the same go, change `vercel.json` `"regions": ["icn1"]` → `["bom1"]`
   (Mumbai) and push to `main`. That deploy rebuilds with the new values;
   the `NEXT_PUBLIC_*` ones are baked in at build time, so a plain restart is
   not enough. If the app already runs on the self-hosted server, change
   `/opt/hioc/app.env` and the `NEXT_PUBLIC_ENV` GitHub secret instead, then
   re-run *Deploy to server*.
5. **Start Mumbai's background jobs.** In Mumbai's SQL editor:
   `select cron.alter_job(jobid, active := true) from cron.job;`
6. **Smoke test** on a phone, on mobile data:
   - The menu loads and the photos show. Right-click a photo: its address is `mulbrnmdzpagzlzgwzuy.supabase.co`.
   - A customer can log in with the WhatsApp OTP. This proves the SMS hook works.
   - Staff can log in at `staff.hioc.in` with their usual password. The POS desktop app loads and prints.
   - A pay-at-counter order appears on the staff board.
   - The owner dashboard shows today's and older numbers.
   - If online payments are on, a ₹1 Razorpay payment and refund work.
7. The next morning, watch the first orders. Check that the scheduled jobs run:
   `select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;`

## Rollback

Available until Seoul is deleted:
1. Put the four Vercel variables and `"icn1"` back, then redeploy.
2. Switch Mumbai's jobs off and Seoul's back on (step 1 with `false` / `true`).

Orders taken on Mumbai after the switch don't exist in Seoul. Decide on
rollback within the first morning, and re-enter anything taken in between by
hand.

## After two calm weeks

- Take a last backup of Seoul (Database → Backups, or
  `supabase db dump --db-url <seoul> -f final.sql`), then pause or delete the
  Seoul project.
- Update local `.env.local` files (`npm run verify:db` and the other scripts
  read them) and the region note in `README-MVP.md`.

## What people notice

- **Everyone signs in once more.** Customers use the WhatsApp OTP, staff their
  usual password. Sessions can't move between projects, but passwords and
  accounts do.
- **Enrolled POS devices and staff PINs keep working.** Both live in database
  tables that are copied.
- **Pages get faster for customers and staff in India.** Every database round
  trip stops going to Korea and back.
