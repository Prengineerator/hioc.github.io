# Hosting migration plan — Vercel → a small server in Seoul

**Status:** proposed, 2026-10-19. The deploy kit (`Dockerfile`, `deploy/`,
`.github/workflows/deploy-server.yml`) is in the repo and was tested end to end
in a sandbox. Nothing is switched over until step 6 below; until then Vercel
keeps serving hioc.in exactly as it does today.

## TL;DR

- **Why Vercel is full:** the team is on the free **Hobby** plan. Hobby has
  hard monthly caps (1M function calls, 4 CPU-hours) and no way to buy more.
  HIOC's staff and owner screens poll the API every 15–60 seconds all day. One
  screen left open costs roughly 250k requests a month, so three or four
  screens reach the cap. Hobby is also for personal, non-commercial use only.
  A café's ordering and POS system is commercial, so the "legal" Vercel option
  is Pro at **$20/month** anyway.
- **Recommendation:** run the app on one small cloud server in **Seoul**, next
  to the Supabase database (`ap-northeast-2`). Use **AWS Lightsail, 2 GB plan,
  about $12/month** (₹1,050). The $7 1 GB plan also works if money is tight.
  You pay a fixed price whatever the traffic, so polling no longer costs
  anything. Caddy provides free automatic HTTPS. GitHub Actions deploys every
  push to `main`. Cron jobs run on the server at exact times.
- **Cost:** ~$144/year vs $240/year for Vercel Pro, with no overage bills.
- **Effort:** about half a day of setup, plus a 30-minute cutover after closing
  time. Rolling back is a DNS change.
- **Not recommended now:** Cloudflare Workers ($5/month). Its Next.js adapter
  needs Next 15.5+, and HIOC is on Next 14.2 (see "Risks outside this plan").

## 1. What we have today (checked 2026-10-19)

| Item | Finding |
|---|---|
| Vercel plan | Team "Hioc" on **Hobby**. The billing API has no charges, and observability queries return "available on Pro and Enterprise plans". |
| Project | `hioc-in`, Next.js **14.2.35**, Node 24, functions pinned to `icn1` (Seoul) in `vercel.json` |
| Database | Supabase in `ap-northeast-2` (Seoul), which runs on AWS's Seoul region |
| Domains | `hioc.in`, `www.hioc.in`, `staff.hioc.in`, `owner.hioc.in`. www is served directly, not redirected. |
| DNS | At **GoDaddy** (`ns17/18.domaincontrol.com`). Each name is an A record pointing at Vercel (`216.198.79.1`). |
| Cron | 9 Vercel crons in `vercel.json` (daily/weekly, UTC), plus 3 Supabase `pg_cron` jobs that POST to `https://hioc.in/api/cron/*` |
| Builds | Last 100 deployments (30 Sep–19 Oct): **80 preview builds** of `claude/*` branches, 20 production |
| App size | 166 API routes, 68 pages. Middleware runs on every non-static request (subdomain routing and the staff/owner gate). |
| Vercel-specific code | `waitUntil` from `@vercel/functions` (`lib/api/background.ts`): a harmless no-op off Vercel, and the work still finishes on a long-running server. `<Analytics />` from `@vercel/analytics`. `VERCEL_PROJECT_PRODUCTION_URL` fallback in `lib/url.ts` and `lib/notifications/templates.ts`. |

### Where the requests come from

The realtime hooks keep a polling "backstop" running **even when the Supabase
socket is healthy** (`lib/realtime/hooks.ts`). Other screens poll on their own
timers:

| Poller | Interval |
|---|---|
| Staff header open-state (`components/staff/StaffHeader.tsx`) | 15 s |
| Orders board / tables / owner LiveOps (`useStaffOrdersRealtime`) | 15 s |
| POS and menu availability (`useMenuAvailabilityRealtime`) | 15 s |
| Pending menu requests | 60 s |
| Store settings on customer pages (`lib/cart/useStoreSettings.ts`) | 30 s |
| Order tracking page (`useOrderRealtime`) | 4 s |

A counter screen polls about 10 times a minute. Over a 14-hour day that is
≈ 8,400 requests, or **≈ 250k a month**, and each one also runs the
middleware. That is an estimate from the code; Vercel's Usage tab shows which
meter actually hit 100%. Either way, a fixed-price server is indifferent to
this load. (Reducing it is a separate improvement; see the end of this doc.)

## 2. Options compared

Prices are monthly list prices from public sources in October 2026. Confirm
on the provider's page when you sign up.

| Option | Cost / month | Fits HIOC? | Notes |
|---|---|---|---|
| **AWS Lightsail, Seoul, 2 GB** (recommended) | **~$12** (1 GB: ~$7) | ✅ | Same AWS region as Supabase. Includes a static IP and 3 TB of transfer. AWS bills Indian accounts in INR. |
| Vultr, Seoul, 1–2 GB | ~$6–12 | ✅ | Equivalent alternative. Same kit, same steps; only the signup differs. |
| Vercel Pro | $20 + usage over the $20 credit | ✅ | No migration needed. 1 TB transfer and 10M edge requests included. Usage-billed past the credit, so the polling keeps costing money. |
| Cloudflare Workers Paid (OpenNext) | $5 | ❌ for now | `@opennextjs/cloudflare` 1.20 requires `next >=15.5.28`. HIOC is on 14.2. Workers also run near the visitor, not near the DB, unless placement is configured. Revisit after the Next upgrade. |
| Oracle Cloud Always Free, Seoul | $0 | ⚠️ | ARM VM, free. But capacity is a lottery, idle VMs get reclaimed unless the account is upgraded to pay-as-you-go, and there is no support. Too fragile for a POS. |
| Railway / Render / DigitalOcean App Platform | $5–7+ | ❌ | **No Seoul region** (nearest is Singapore). Every database query would cross the sea, which is exactly why Vercel was pinned to `icn1`. |
| Netlify | free / paid tiers | ❌ | Functions run far from Seoul by default; same latency problem. |

### Why a server, and why Seoul

- **Price is fixed.** HIOC's traffic is steady and comes from one café,
  mostly polling. That is the worst shape for per-request billing and the best
  shape for a small always-on server.
- **Next to the database.** Every API route makes several Supabase queries.
  In the same AWS region they take ~1 ms each, against ~70–100 ms from
  Singapore or Mumbai. Visitors' round trip from India to Seoul is the same as
  today, because Vercel already runs the functions in Seoul.
- **No code changes.** The app already runs as a normal Node server. The only
  change is one opt-in line in `next.config.js`.

### Sizing — measured, not guessed

From the sandbox test of the production image:

| Measurement | Result |
|---|---|
| `next build` | 111 s, **1.8 GB peak memory**, so builds run in GitHub Actions, not on the server |
| Docker image | 96 MB (91 MB compressed) |
| App memory | **56 MB** idle; ~265 MB after 5,000 requests |
| Startup | ready in 72 ms; healthy in under 20 s |
| Throughput | ~150 req/s on `/menu` with 30 concurrent clients (4 cores) |
| Café's real load | about 1 req/s, so the server has a lot of headroom |

1 GB of RAM is enough to run the app. 2 GB leaves room for growth (inventory,
marketing jobs, report generation) and sustained CPU at rush hour. That is
why 2 GB is the recommended plan.

## 3. What the kit contains

| File | What it does |
|---|---|
| `next.config.js` | `output: 'standalone'` **only** when `BUILD_STANDALONE=1`. The Vercel build is unchanged. |
| `Dockerfile` | Multi-stage build to a self-contained `node server.js` image. Adds `sharp` for `next/image`, runs as a non-root user, has a health check. `NEXT_PUBLIC_*` values come in as a build secret; server secrets never enter the image. |
| `.dockerignore` | Keeps `.env*`, key files, `desktop/`, docs and so on out of the build. |
| `deploy/docker-compose.yml` | Two containers: `app` (bound to loopback only) and `caddy` (ports 80/443). |
| `deploy/caddy/Caddyfile` | Automatic Let's Encrypt HTTPS for all four hostnames, HSTS (same value Vercel sends), gzip/zstd, HTTP/3. Holds requests during a deploy instead of returning 502. |
| `deploy/deploy.sh` | Runs on the server. Loads the new image, swaps it in, waits for healthy, and **rolls back automatically** if it isn't. Also has `rollback` and `heal` modes. |
| `deploy/hioc-cron` + `deploy/run-cron.sh` | The 9 Vercel crons, same UTC times, same `Bearer CRON_SECRET` request. Plus a once-a-minute `heal` that restarts a hung app. Logs to `/var/log/hioc-cron.log`. |
| `deploy/setup-server.sh` | One-time Ubuntu 24.04 setup: Docker, UTC clock, 2 GB swap, firewall, automatic security updates (with any required reboot at 05:00 IST), `/opt/hioc`. |
| `.github/workflows/deploy-server.yml` | On each push to `main`: build, ship over SSH, switch. **Does nothing until `SERVER_DEPLOY_ENABLED=true`.** |

**Tested in the sandbox:** the image builds and runs. All four hostnames serve
over HTTPS through Caddy, and `staff.hioc.in/orders` is rewritten and gated
like on Vercel. Static assets get 1-year immutable caching. A redeploy under
traffic served **300/300 requests with zero errors**. A broken build **rolled
itself back** and failed the deploy. A frozen app was detected and restarted
by `heal` within about 60 s. Cron calls pass the `CRON_SECRET` check and wrong
secrets get 401. Spoofed `X-Forwarded-For` headers are dropped, so the rate
limiter can't be bypassed.

## 4. Migration runbook

Allow half a day for steps 1–5 (no customer impact) and 30 minutes for step 6,
**after closing time**.

### Step 1 — the day before: shorten DNS caching

At GoDaddy → hioc.in → DNS, set the TTL of the A records for `@`, `www`,
`staff` and `owner` to **600 seconds** (10 minutes). Leave every other record
alone (MX, the Resend/email TXT records, and so on).

### Step 2 — create the server

1. AWS Console → **Lightsail** → Create instance → Region **Seoul
   (ap-northeast-2)** → Linux → **Ubuntu 24.04 LTS** → plan **2 GB** → name
   `hioc-web`.
2. Networking → **Create static IP** and attach it to `hioc-web`. Write the IP
   down.
3. Networking → IPv4 firewall: keep SSH (22) and add **HTTP (80)**, **HTTPS
   (443 TCP)** and, optionally, **443 UDP** for HTTP/3.
4. Download the SSH key (or add your own), then
   `ssh ubuntu@<static-ip>` once to confirm it works.

### Step 3 — set the server up

```bash
# from a checkout of this repo
scp -r deploy ubuntu@<static-ip>:~/
ssh ubuntu@<static-ip> 'sudo bash ~/deploy/setup-server.sh'
```

Then fill in `/opt/hioc/app.env` with the production environment variables:

1. Get them from Vercel. Either run `vercel env pull app.env --environment=production`
   with the Vercel CLI, or copy them from Project → Settings → Environment
   Variables. Values marked *Sensitive* can't be pulled; copy those from where
   they came from (Supabase, Razorpay, Meta, Resend dashboards).
2. Delete any `VERCEL_*` lines.
3. **Add `NEXT_PUBLIC_SITE_URL=https://hioc.in`.** Off Vercel there is no
   `VERCEL_PROJECT_PRODUCTION_URL` fallback. Without this line, the links in
   WhatsApp and email messages (order tracking, bills) would be missing their
   domain.
4. Make sure `CRON_SECRET` is the **same value** as on Vercel and in Supabase
   Vault (`cron_secret`), because the pg_cron jobs send it.
5. Wrap any value that contains `$` in single quotes.
6. Copy it up and lock it down:
   `scp app.env ubuntu@<static-ip>:/opt/hioc/app.env && ssh ubuntu@<static-ip> chmod 600 /opt/hioc/app.env`.
   Delete the local copy afterwards and keep the master copy in your password
   manager. This file is the only thing on the server that can't be rebuilt
   from the repo.

### Step 4 — connect GitHub Actions

Create a deploy key pair on your laptop (`ssh-keygen -t ed25519 -f hioc-deploy -N ''`).
Append `hioc-deploy.pub` to `/home/ubuntu/.ssh/authorized_keys` on the server.
Then in GitHub → repo → Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Variable | `SERVER_HOST` | the static IP |
| Variable | `SERVER_USER` | `ubuntu` |
| Secret | `SERVER_SSH_KEY` | contents of `hioc-deploy` (the private key) |
| Secret | `SERVER_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <static-ip>` |
| Secret | `NEXT_PUBLIC_ENV` | every `NEXT_PUBLIC_…=…` line from `app.env`, one per line, **including** `NEXT_PUBLIC_SITE_URL` |
| Variable | `SERVER_DEPLOY_ENABLED` | `true` (set this last) |

Then Actions → **Deploy to server** → Run workflow. The first run takes
~5 minutes. It ends with `deployed hioc-web:<sha>`. On the server,
`cd /opt/hioc && docker compose ps` should show `app` as `healthy`.

The `NEXT_PUBLIC_*` values are compiled into the site at build time. **If you
change a flag, update the secret and re-run the workflow.** Editing `app.env`
alone is not enough for those values. Server-only values in `app.env` take
effect after `docker compose up -d --force-recreate app`.

### Step 5 — test before switching

Vercel is still live, so test on a spare name:

1. GoDaddy: add an A record `test` → the static IP (TTL 600).
2. On the server, add `test.hioc.in` to the first line of
   `/opt/hioc/caddy/Caddyfile` (`hioc.in, www.hioc.in, staff.hioc.in, owner.hioc.in, test.hioc.in {`)
   and run `cd /opt/hioc && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
   The next deploy from GitHub puts the repo's Caddyfile back, which drops
   the test name again.
3. Check in a browser: `https://test.hioc.in/menu` and `/about`, then
   `https://test.hioc.in/staff/login` and log in.

> **It is the real database.** Browsing and logging in are safe. Do **not**
> place real orders or payments on the test name. Razorpay and WhatsApp
> webhooks still go to Vercel until step 6.

### Step 6 — cutover (after closing, ~30 minutes)

1. **DNS:** at GoDaddy, change the A records for `@`, `www`, `staff` and `owner`
   from `216.198.79.1` to the static IP. If `www` is a CNAME to Vercel, replace
   it with an A record to the static IP.
2. **Certificates:** right away, on the server:
   `cd /opt/hioc && docker compose restart caddy && docker compose logs -f caddy`.
   Wait for `certificate obtained successfully` for all four names (usually
   under 2 minutes). The restart makes Caddy try immediately instead of waiting
   out the retry backoff it built up while DNS still pointed at Vercel.
   Visitors whose DNS still shows the old IP keep using Vercel meanwhile, so
   nobody sees an outage.
3. **Cron, in this order:** first Vercel → Project → Settings → **Cron Jobs →
   Disable**. Then on the server:
   `sudo install -m 644 -o root -g root /opt/hioc/hioc-cron /etc/cron.d/hioc`.
   Never have both on at once, or owner report emails and leave reminders go
   out twice. The 3 pg_cron jobs need nothing; they call `https://hioc.in` and
   follow DNS.
4. **Smoke test** (on mobile data, so you're not on a cached DNS answer):
   - `https://hioc.in/menu` loads; check the padlock shows a Let's Encrypt
     certificate.
   - Place a small pay-at-counter order and see it arrive on the staff orders
     board in real time.
   - `staff.hioc.in` and `owner.hioc.in` log in. The POS desktop app (which
     uses `https://staff.hioc.in`) loads and prints.
   - If online payments are on, do one small Razorpay payment and refund it.
   - Run one cron by hand. `expire-orders` is safe because it is idempotent
     and pg_cron already runs it 4×/day:
     `sudo /opt/hioc/run-cron.sh expire-orders && tail -1 /var/log/hioc-cron.log`
     should show `HTTP 200`.
5. **Monitoring:** create two free monitors (UptimeRobot or Better Stack) on
   `https://hioc.in/privacy` and `https://staff.hioc.in/login`, alerting the
   owner's email or phone.

### Step 7 — rollback (if anything is wrong in the first two weeks)

- **A bad deploy:** `ssh ubuntu@<ip> /opt/hioc/deploy.sh rollback`. A deploy
  that fails its health check already rolls itself back.
- **Back to Vercel entirely:** point the four A records back to
  `216.198.79.1`. Then `sudo rm /etc/cron.d/hioc` on the server and re-enable
  Vercel's Cron Jobs. Vercel kept building `main` the whole time, so it is
  current.

### Step 8 — retire Vercel (after two calm weeks)

- Vercel → Project → Settings → Git → disconnect the repo, so pushes stop
  building there (this also ends the preview builds). Then delete the project.
- Remove `<Analytics />` / `@vercel/analytics` from `app/layout.tsx`. Off
  Vercel it only 404s on `/_vercel/insights/script.js`. If you want traffic
  numbers, Cloudflare Web Analytics is free and needs no DNS change.
- Optionally take a Lightsail snapshot of the configured server (a few cents a
  month) for a faster rebuild.

## 5. What changes for the team

| | Vercel | New server |
|---|---|---|
| Deploy | automatic on push to `main` | automatic on push to `main` (GitHub Actions, ~5 min) |
| Preview URL per branch | yes | **no**. Use `npm run dev` locally; a staging copy on `test.hioc.in` can be added later on the same server for $0. |
| Logs | Vercel dashboard | `ssh` → `cd /opt/hioc && docker compose logs -f app` (crons: `/var/log/hioc-cron.log`). `MONITORING_WEBHOOK_URL` alerts work as before. |
| Static files (JS, CSS, images) | Vercel's CDN, near the visitor | served from Seoul. The first visit is a little slower; after that the browser caches them for a year. Cloudflare's free proxy can be added later (fix `trusted_proxies` first; see the Caddyfile). |
| Cron timing | ±59 min on Hobby | exact |
| Function time limits (`maxDuration`) | enforced | none (requests run to completion) |
| Scaling | automatic | one server, ~50× headroom over today's load. Move to a bigger Lightsail plan via snapshot if ever needed. |
| Failover | multi-zone | single server. Automatic restart on crash or hang, automatic rollback of bad deploys, uptime alerts. Data lives in Supabase, so a dead server is rebuilt from this repo in ~30 minutes. |
| OS upkeep | none | security updates install automatically; any reboot they need happens at 05:00 IST |

## 6. Risks outside this plan

1. **Next.js 14 is end-of-life** (support ended 26 Oct 2025). It no longer
   gets security patches; at least one 2026 CVE has no fix for 14. This is
   unrelated to hosting and needs its own upgrade project (Next 15.5+ or 16,
   React 19). This kit keeps working after that upgrade (drop the `sharp`
   line from the Dockerfile; Next 15+ bundles it). The upgrade also makes
   Cloudflare Workers a $5/month option again.
2. **Polling volume.** Running the poll backstop only while the realtime
   socket is down (or much slower while it is up) would cut API traffic by
   roughly 4×. That matters on any per-request host, not on this one.
3. **Database in Seoul, café in India.** Every request crosses India→Seoul
   (~100 ms each way), on Vercel today and on this server. Moving Supabase and
   the server to Mumbai (`ap-south-1`) would make the app noticeably snappier,
   but it is a database migration and a separate project.

## Sources

- Vercel limits and Hobby terms: <https://vercel.com/docs/limits>, <https://vercel.com/docs/plans/pro-plan>, <https://vercel.com/docs/cron-jobs/usage-and-pricing>, <https://vercel.com/docs/encryption> (HSTS defaults)
- Cloudflare Workers pricing: <https://developers.cloudflare.com/workers/platform/pricing/>. OpenNext's Next.js requirement comes from the `@opennextjs/cloudflare` package's `peerDependencies` on npm.
- Lightsail and Vultr prices: <https://onedollarvps.com/pricing/aws-lightsail-pricing>, <https://onedollarvps.com/pricing/vultr-pricing>, <https://www.vultr.com/products/regular-performance-compute/>
- Oracle Always Free reclamation: <https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm>
- Next.js 14 end of life: <https://www.herodevs.com/blog-posts/nextjs-eol-dates-version-support-timeline>, <https://community.vercel.com/t/is-there-a-fix-available-for-cve-2026-23864-in-nextjs-v14/32932>
