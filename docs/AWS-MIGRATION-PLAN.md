# Moving hioc.in from Vercel to AWS: analysis and plan

**Status, 2026-11-19:** Vercel Pro was taken on 2026-11-18. The AWS move is not planned.

Written 2026-11-19, when the owner asked whether to move to AWS instead of paying for
Vercel Pro, and whether it could be done the same day.

- **§1** is for the owner: the short answer and the decision.
- **§2–§4** are the evidence: what the site uses today, the cost on each side, and
  what AWS's free tier really gives.
- **§5** is the migration plan, if the owner decides to go ahead later.
- **§6** lists the owner's steps. An agent must not do these.

---

## 1. Short answer

| Question | Answer |
|---|---|
| Can we move to AWS today? | **Not safely.** A careful move is 4–6 working days plus a quiet-hours cutover. Done in one day, it would most likely break things customers and staff rely on (the list is in §2), during service. |
| Does it save money? | **A little.** Vercel Pro costs **$20 a month (about ₹1,750)**. The usage credit included in that covers our traffic many times over, so in practice the bill stays at $20. AWS would cost **about $2–8 a month** after the free credits run out. The saving is roughly **₹1,000–1,500 a month**. |
| What about AWS's free tier? | A new AWS account gets **$100 in credits (up to $200)**. On the "free plan" the account **closes itself after 6 months** unless it is upgraded to paid, and the site would go down with it. On the paid plan the credits cover the site for well over a year. So the free tier delays the bill; it does not remove it. See §4. |
| Is the move worth it? | **Not now.** It saves about ₹15,000 a year but costs a week of engineering and a risky cutover. We would also lose things we get from Vercel today: automatic rollback by the manager, per-pull-request previews, web analytics and the built-in firewall. |
| Recommendation | **Upgrade the Vercel team "Hioc" to Pro today.** It takes 5 minutes, needs no code change and causes no downtime. It also fixes the real problem: the free Hobby plan does not allow commercial use (see `docs/VERCEL-SPLIT-PLAN.md` §1). Look at AWS again if the Vercel bill goes above about $50 a month for two months in a row. That would take roughly 10 times today's traffic. |

### Decision gate (owner)

1. **Vercel Pro now, no AWS move.** *(Recommended.)* Your steps: §6 A.
2. **Vercel Pro now, then move to AWS in a planned week.** Pro keeps the site legal and
   up while §5 is built and tested. Cut over on a quiet night, then cancel Pro.
3. **Move to AWS today, skipping Pro.** Not recommended. Every item in §2 would have to
   be changed, tested and released in one day, and the payment flow is among them.

---

## 2. What the site relies on today that AWS does not give for free

Found in the code on 2026-11-19. Each row needs work before the site can run on AWS
Amplify Hosting, the closest AWS equivalent to Vercel.

| # | What we use on Vercel | Where | On AWS Amplify | Work needed | Risk if missed |
|---|---|---|---|---|---|
| 1 | **Work that continues after the reply** (`waitUntil`) | `lib/api/background.ts`, used by 9 API routes and 3 shared modules, including placing an order (`app/api/orders/route.ts`), order status, settling a payment (`lib/orders/settlePayment.ts`) and shop checkout | Not supported: "executing code after a response" is on Amplify's unsupported list | Await the work before replying, or move it onto a queue. Owned by `orders-payments-engineer`, security review required | WhatsApp bills and order follow-ups silently not sent |
| 2 | **11 scheduled jobs** in `vercel.json` (expire orders, close attendance, end cash day, owner reports, marketing plan, points expiry and others) | `vercel.json`, `app/api/cron/*` | Amplify has no cron feature | Move them to Supabase `pg_cron` + `net.http_post` on **Hioc India**, the pattern `expire-orders` and `feedback-requests` already use. Or use EventBridge Scheduler. Each one sends `Authorization: Bearer CRON_SECRET`, read from Supabase Vault as `expire-orders` does, never written into a SQL file | Cash day not closed, attendance not closed, orders not expired, owner reports not sent |
| 3 | **Build ID for the POS menu cache** | `lib/pos/menuCache.ts`, `lib/pos/localSnapshot.ts` read `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` | That variable does not exist; Amplify's equivalent is `AWS_COMMIT_ID` | Read a host-neutral variable set at build time | Every build is called `dev`, so a POS keeps an old cached menu after a release |
| 4 | **Production URL** for links in WhatsApp and email | `lib/url.ts`, `lib/notifications/templates.ts`, `lib/notifications/health.ts` | `VERCEL_PROJECT_PRODUCTION_URL` does not exist | Set `NEXT_PUBLIC_SITE_URL=https://hioc.in` on AWS | Links in customer messages become bare paths |
| 5 | **Routes allowed to run up to 60 s** (`maxDuration = 60`) | 15 routes: owner reports, GST workbook, online-report sync, marketing, suggestion traits | Amplify sets the server time limit itself; `maxDuration` is ignored. The limit could not be confirmed in AWS's docs on 2026-11-19 | Test each long route on Amplify; split work into batches if it times out | Owner reports and online-settlement sync fail part-way |
| 6 | **Web Analytics** | `app/layout.tsx` (`@vercel/analytics`) | Not available | Remove it, or replace it (the app also has its own traffic tracking, `docs/TRAFFIC-TRACKING.md`) | Visitor numbers in Vercel stop |
| 7 | **Streaming / loading screens** | 1 `loading.tsx`, `<Suspense>` in 8 files | Next.js streaming not supported | None required. Pages still work but show nothing until fully rendered | Slightly slower-feeling pages |
| 8 | **Middleware** (subdomain routing, staff/owner login gate) | `middleware.ts` | Supported, but Amplify does not run it on static files and images | Test staff.hioc.in and owner.hioc.in login, and the desktop POS print URLs | Staff or owner locked out, or pages exposed. Highest-impact item to test |
| 9 | **79 environment variables** (Supabase, Razorpay, WhatsApp, email, AI keys, `CRON_SECRET` and others) | Vercel project `hioc-in` | Must be re-entered in Amplify | Owner copies them across (§6 B). No agent may handle the values | Any one missing breaks its feature |
| 10 | **The agent team's tooling** | `.claude/skills/incident-manager`, `.claude/skills/weekly-optimisation`, `.claude/agents/web-engineer.md`, `docs/AGENT-TEAM.md`, `.github/workflows/uptime-watch.yml` | The manager reads Vercel logs and rolls back through the Vercel connector. There is no AWS equivalent in its rules | **Owner's decision** (see M6): whether the team gets any AWS access, and whether the manager may roll back on Amplify by itself. Both are new agent powers | No automatic rollback during an outage until this is done |
| 11 | **Region** | `vercel.json` pins Mumbai (`bom1`) | Amplify is available in Mumbai (`ap-south-1`) | Create the Amplify app in Mumbai, next to Supabase | Slower pages if created elsewhere |

What does **not** change: the Supabase database (Hioc India), Razorpay, WhatsApp/Meta,
the domain name and every URL outside callers use (`https://hioc.in/api/...`), and the
desktop POS app. As long as hioc.in points at the new host, the webhooks keep working.

## 3. Cost comparison

Traffic measured from Vercel Web Analytics: **about 600 visitors and 6,000–9,000 page
views a month** across hioc.in, staff and owner (Oct 2026: 600 visitors, 9,010 views;
Nov 1–18: 588 visitors, 5,877 views).

| | Vercel Pro | AWS Amplify (after credits) |
|---|---|---|
| Base fee | $20 / month per seat (includes $20 usage credit) | None |
| Our usage | Well inside the included credit | Server requests: well under the 500,000/month free allowance in year one, then about $0.30 per million. Data transfer: a few GB at $0.15/GB. Builds: about 5 min each at $0.01/min |
| Firewall | Included | $15 / month if wanted (AWS WAF on Amplify) |
| DNS | Included | Free if DNS stays where it is; $0.50 / month on Route 53 |
| **Expected monthly bill** | **$20 (≈ ₹1,750)** | **≈ $2–8 (≈ ₹170–700)**, or ≈ $17–23 with the firewall |
| Engineering to get there | None | 4–6 working days (§5) |

Prices are from vercel.com/pricing and aws.amazon.com/amplify/pricing; check both
before deciding, because prices change. Foreign-currency and GST charges on the card
apply to both.

## 4. AWS free tier, in plain words

Taken from AWS's own pages on 2026-11-19
(docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html).

- **Accounts created on or after 15 July 2025** get **$100 in credits** at sign-up and
  can earn up to $100 more. At sign-up you choose one of two plans:
  - **Free plan.** No charges ever, but it **ends after 6 months or when the credits run
    out**. The account then **closes automatically**, the site goes down, and data is
    deleted after 90 days unless the account is upgraded. **Not suitable for a live
    café site.**
  - **Paid plan.** The same credits are applied to the bill (usable for up to 12 months
    from sign-up). Usage beyond them is billed. At our size, $100–200 covers Amplify for
    well over a year.
- **Older accounts** keep the earlier "12 months free" offer. For Amplify that is 1,000
  build minutes, 15 GB transfer, 5 GB storage, 500,000 server requests and 100 GB-hours
  a month, for 12 months from account creation.
- Some services stay free forever within monthly limits, for example Lambda (1 million
  requests). Amplify's server allowance is not in that list.

Whether the café already has an AWS account, and when it was opened, could not be
checked on 2026-11-19 (the AWS connector needed signing in again).

## 5. Migration plan (only if the owner picks option 2)

Each step is one pull request. Each is built, reviewed by `security-reviewer`, and kept
working on Vercel too, so nothing changes in production until cutover day.

| Step | What | Who | Size |
|---|---|---|---|
| M1 | Replace `waitUntil` in `lib/api/background.ts`: await best-effort work with a short time limit, so it works on any host | `orders-payments-engineer` | 1 day |
| M2 | Make build ID and site URL host-neutral (§2 rows 3–4) | `web-engineer` | ½ day |
| M3 | Move the 11 Vercel crons to `pg_cron` on Hioc India. SQL files in `supabase/`, run by the owner. Remove `crons` from `vercel.json` only after each one has fired correctly | `database-engineer` | 1 day |
| M4 | Add `amplify.yml` (build settings) and drop or replace `@vercel/analytics` | `web-engineer` | ½ day |
| M5 | Owner creates the Amplify app on a test address (§6 B) and tests it, using a checklist `web-engineer` writes: pages load on each surface, staff and owner login, POS print, each long report route. Anything that touches live data, live payments, credentials or a cron (a ₹1 test order, end cash day, owner reports, marketing) is done **by the owner only**, or on a test app given Razorpay test keys and no cron or marketing triggers. Agents only help with read-only checks | Owner (checklist by `web-engineer`) | 1 day |
| M6 | **Owner's decision first:** does the team get read access to AWS, and may the manager roll back on Amplify by itself? Both are new agent powers and need the owner's explicit yes. Without them, the manager can only report, and the owner rolls back by hand (point DNS back at Vercel). Only after that yes: rewrite the manager's and the weekly pass's Vercel steps and update `docs/AGENT-TEAM.md` | Owner decides, then product owner | ½ day |
| M7 | **Cutover**, 11 pm–1 am IST after closing: point hioc.in, www, staff and owner at Amplify; watch for an hour; keep Vercel ready to switch back for 7 days | Owner | 2 hours |
| M8 | After 7 clean days, cancel Vercel Pro | Owner | 5 min |

**Rollback during cutover:** point the DNS records back at Vercel. Vercel keeps
serving throughout, so the switch back takes as long as DNS takes to update (minutes,
if the record TTL is lowered to 300 s a day before).

## 6. The owner's steps

### A. Upgrade to Vercel Pro (today, 5 minutes)

1. Open vercel.com, sign in, choose the team **Hioc**.
2. **Settings → Billing → Upgrade to Pro**. Add the card.
3. Optional: under **Settings → Billing → Spend Management**, set a spend limit
   (for example $40) so the bill can never surprise you.
4. Nothing else changes. The site keeps running on the same addresses.

### B. Only if moving to AWS (option 2)

1. Create or sign in to the AWS account. Choose the **Paid plan**, not the Free plan,
   so the account does not close after 6 months.
2. **Billing → Budgets:** create a $10/month budget with an email alert.
3. **Amplify → Create app → GitHub**, repository `hioc.github.io`, branch `main`,
   region **Asia Pacific (Mumbai)**. Do not add the domain yet.
4. Copy every environment variable from Vercel (project `hioc-in` → Settings →
   Environment Variables) into Amplify (App settings → Environment variables). Check
   that `NEXT_PUBLIC_SUPABASE_URL` is the **Hioc India** Project URL (Supabase →
   Project Settings → API).
5. Run the SQL files from M3 in Supabase on **Hioc India**.
6. On cutover night (M7): Amplify → **Custom domains → Add domain** `hioc.in` with
   `www`, `staff` and `owner`. Update the DNS records it shows.
