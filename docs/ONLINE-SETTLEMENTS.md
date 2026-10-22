# Online orders: Zomato and Swiggy settlement reports

Owner → **Online orders** (`/owner/online`) shows what the delivery apps paid the café: orders, menu sales,
discounts, platform fees, ads, payout and what reached the bank, week by week. It reads the settlement report
each platform emails every week, so nobody has to download and open spreadsheets.

## How it works

1. Every morning at about 09:15 IST, `/api/cron/online-reports` logs into the mailbox that receives the
   reports (IMAP, **read-only**: nothing is marked read, moved or deleted).
2. It looks at the last 14 days of mail from the platforms' domains (`zomato.com`; `swiggy.in`, `swiggy.com`),
   first by envelope and attachment names only, and downloads just the emails that carry a report and were
   not read before. Mail whose sender failed DMARC is skipped, so a forged "Zomato" email can't put numbers
   on the dashboard.
3. Each report attachment is hashed. A file already read is skipped, so the same report emailed twice, or
   emailed and also uploaded, is counted once.
4. The raw file goes to the private Storage bucket `online-settlements` and is parsed:
   - **Zomato** `.xlsx` settlement reports are read in full: every order (bill, discount, commission, gateway
     fee, GST, TCS/TDS, payout, settlement date, bank UTR) and the ads/Hyperpure deductions. Zomato `.csv`
     reports are read the same way when their columns match, and saved as **Could not read** otherwise.
   - **Swiggy** files are saved but **not read yet**. We need one real Swiggy weekly report to write its parser.
     Once that ships, press **Re-read saved reports** to read the saved Swiggy files.
5. An order that is "pending" in one week's report settles in a later one. The newer report replaces the
   row; re-reading an older file never changes a newer one back.

The owner can also press **Check email now** (optionally looking back up to 13 months) or **Upload a
report** on the page. Both run the same pipeline.

**Re-read saved reports** (shown while any report is *Saved, not read yet* or *Could not read*) runs those
saved files through the pipeline again, without the email: use it after a parser is added or fixed. It
re-reads the raw file kept in Storage and updates the same report row. Reports already read are never
touched, and files that still can't be read stay as they were. A press handles up to 100 files and says how
many are left; press again for the rest.

Code: `lib/online-settlements/` (parser `zomato.ts`, mailbox `mailbox.ts`, pipeline `ingest.ts`, money math
`summary.ts`), routes in `app/api/cron/online-reports` and `app/api/owner/online-reports/`.

## Setup (once, about 10 minutes)

### 1. Database

Apply `supabase/2026-10-online-settlements.sql` in the Supabase SQL editor, then run `npm run verify:db`
and check the "ONL-1" lines pass.

### 2. A mailbox the reports reach

Use a mailbox that only receives the reports, not the owner's main inbox: the app password below can
read every email in the mailbox it belongs to.

1. Create a Gmail account for this, e.g. `hioc.reports@gmail.com`, and turn on 2-Step Verification.
2. In the mailbox Zomato and Swiggy write to (the one registered on the partner apps), add a filter that
   forwards their emails to the new account:
   Gmail → Settings → Forwarding and POP/IMAP → *Add a forwarding address* (confirm the code sent to the new
   account), then Settings → Filters → *Create a new filter* with
   `From: (zomato.com OR swiggy.in OR swiggy.com) has:attachment` → *Forward it to* the new address.
   Forwarding keeps the original sender, so the domain and DMARC checks still work.
   *(Or skip forwarding and use the existing mailbox directly. It works the same way, but the password
   gives access to all of that mailbox's mail.)*
3. In the reports account: Google Account → Security → 2-Step Verification → **App passwords** → create one
   named "HIOC website". Copy the 16 characters.

Any IMAP mailbox works (Zoho: `imap.zoho.in`; Google Workspace if the admin allows app passwords).
Outlook.com and Microsoft 365 no longer accept passwords over IMAP, so they need a forward to Gmail as
above.

### 3. Vercel environment variables (Production)

| Variable | Value |
| --- | --- |
| `ONLINE_REPORTS_IMAP_USER` | the reports mailbox address |
| `ONLINE_REPORTS_IMAP_PASSWORD` | the app password (spaces optional) |
| `ONLINE_REPORTS_IMAP_MAILBOX` | optional, default `INBOX`. Use `[Gmail]/All Mail` if a filter archives the mail |
| `ONLINE_REPORTS_IMAP_HOST` / `_PORT` | optional, default `imap.gmail.com` / `993` |
| `ONLINE_REPORTS_LOOKBACK_DAYS` | optional, default `14` |
| `ONLINE_REPORTS_ZOMATO_DOMAINS` / `ONLINE_REPORTS_SWIGGY_DOMAINS` | optional, only if a platform starts mailing from a new domain |

`CRON_SECRET` is already set for the other crons; the new one in `vercel.json` uses it too. Redeploy after
adding the variables.

### 4. Load the history

Open Owner → Online orders, choose **last 13 months** next to *Check email now* and press it. A run
downloads up to 60 report emails and says how many are left; press again until none are. Emails already
read are skipped without downloading, and the platforms' promotional emails (no report attached) are never
downloaded. Reports that never came by email (or came
before the forward was set up) can be uploaded with **Upload a report**.

## Checking it works

- The page's *Reports & email* box shows the last check: emails found, reports read, anything that failed.
- `select * from online_settlement_sync_runs order by started_at desc limit 5;` shows the same from SQL.
- A report marked **Could not read** gives the reason under it (most often the email held a different
  spreadsheet, such as a tax invoice summary).
