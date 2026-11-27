# First-party traffic tracking

Owner → **Traffic** shows where visitors to the ordering pages and the Shop come
from (Instagram, Google, WhatsApp, a tagged flyer…) and which of those visits
ended in an order. The data is ours, in Supabase, so unlike Vercel Web Analytics
on the free plan it keeps more than 31 days, reads campaign tags, and connects a
visit to the order it led to.

## Setup (once)

1. In the Supabase SQL editor, run `supabase/2026-11-traffic-tracking.sql`.
   It is safe to run again, and safe to run before or after the deploy.
2. Run `npm run verify:db`. The line `TRAFFIC · first-party tracking table`
   should pass.
3. Open the site in a private window, go to the menu or the Shop, then open
   Owner → Traffic. The visit shows within a minute (the page reads the
   database on every load).

Nothing else is needed. `NEXT_PUBLIC_FLAG_TRAFFIC_TRACKING` is on by default;
set it to `false` on Vercel and redeploy to stop recording. Rows already
recorded stay visible.

## What is tracked

| Pages | Group |
|---|---|
| `/menu`, `/suggest` (Ask Coffey), `/coffey` (About Coffey), `/t/…` (table QR), `/checkout`, `/order/…`, `/order/…/receipt`, `/order/…/review`, `/order-confirmation/…`, `/account/orders` | Online ordering |
| `/shop`, `/shop/order/…` | Shop |

For each view of those pages, one row in `traffic_events` with:

- the page's **route pattern** (`/order/[id]`), never the order id or a table's
  QR token;
- the **source**, decided on the server (see below), the linking site's
  **hostname** and the five **`utm_*` tags**;
- **phone / tablet / computer**, and the **country and city** Vercel's edge
  reports for the request;
- a random **visit id** and whether this was the visit's **first page**.

When a customer places an order (website or table QR) or starts a Shop
checkout during a tracked visit, the order route adds one more row with the
order id and its total. Owner → Traffic counts a cafe order once it is past
"waiting for payment" and not rejected or cancelled, and a Shop order once it is
paid. Counter (POS) orders are not visits and are never recorded.

### What is not stored

No IP address, no User-Agent, no cookie and no lasting visitor id. The visit
id lives in the browser tab's `sessionStorage`, ends when the tab closes or
after 30 idle minutes, and is never tied to an account. A browser that sends
Global Privacy Control or Do Not Track records nothing, and crawlers are
dropped. Rows older than 13 months are deleted every Sunday by
`/api/cron/purge-traffic`. The Privacy Policy says all of this while the flag
is on.

## How a source is decided

`lib/traffic/classify.ts`, in this order:

1. **A tagged link wins.** If the landing URL has `utm_source`, that decides:
   `instagram`/`ig` → Instagram, `facebook`/`fb` → Facebook, `whatsapp`/`wa` →
   WhatsApp, `google`/`gbp`/`maps` → Google, `email`/`newsletter` → Email,
   `qr`/`flyer`/`poster`/`jar`/`table`… → QR codes & print, any other tag →
   Other tagged links.
2. **Otherwise the linking site:** Google, Instagram, Facebook, WhatsApp Web,
   mail apps, other search engines, other social sites, or any other website.
3. **No linking site is Direct.** WhatsApp messages (bills and chats), QR
   codes, bookmarks and typed addresses pass no linking site, so they all land
   here. That is why tagged links matter.

The source is fixed for the whole visit: a visit that lands on the home page
from Instagram and then opens the menu counts as Instagram.

WhatsApp offers sent from Owner → Marketing go through `/r/<token>`, which now
redirects to `/menu?utm_source=whatsapp&utm_medium=offer`, so their clicks show
as WhatsApp. The two tags are the same for every recipient.

## Tagging your links

Owner → Traffic has a **Make a tagged link** box. Pick the page, where the link
goes and where it is placed, and copy the link. Good places to use one:

| Where | Example link |
|---|---|
| Instagram bio | `https://hioc.in/shop?utm_source=instagram&utm_medium=bio` |
| Instagram story | `https://hioc.in/menu?utm_source=instagram&utm_medium=story&utm_campaign=diwali-offer` |
| Google Business Profile "Order" link | `https://hioc.in/menu?utm_source=google&utm_medium=business-profile` |
| Instagram story pointing at Ask Coffey | `https://hioc.in/suggest?utm_source=instagram&utm_medium=story&utm_campaign=ask-coffey` |
| Table card "Not sure what to order?" | `https://hioc.in/suggest?utm_source=table&utm_medium=qr&utm_campaign=ask-coffey` |
| QR code on the Instant Coffee jar | `https://hioc.in/shop?utm_source=jar&utm_medium=qr` |
| Flyer or table card | `https://hioc.in/menu?utm_source=flyer&utm_medium=qr&utm_campaign=college-week` |

Keep the tags short and lower case; the page shows them exactly as written,
grouped by source, placement and campaign.

## Files

| File | What it does |
|---|---|
| `supabase/2026-11-traffic-tracking.sql` | The `traffic_events` table, its checks, RLS on with no policies |
| `lib/traffic/types.ts` | Vocabularies: events, groups, sources, devices, tracked routes |
| `lib/traffic/classify.ts` | Route patterns, host and tag cleaning, source, device, crawler check |
| `lib/traffic/validate.ts` | What `POST /api/traffic` and the checkouts accept |
| `lib/traffic/client.ts`, `components/traffic/TrafficTracker.tsx` | The browser side: the visit, page views, the `traffic` field of an order |
| `app/api/traffic/route.ts` | Records a page view (best-effort, always 204) |
| `lib/traffic/record.ts` | Builds and inserts rows; records orders from `POST /api/orders` and `POST /api/shop/checkout` |
| `lib/traffic/load.ts`, `lib/traffic/summary.ts` | Reads a date range and adds it up for the owner page |
| `app/owner/traffic/page.tsx`, `components/owner/traffic/CampaignLinkBuilder.tsx` | Owner → Traffic |
| `app/api/cron/purge-traffic/route.ts` | Deletes rows older than 13 months (weekly, `vercel.json`); also purges the Coffey wizard steps (`docs/COFFEY-SPEC.md` §10.7) |

Tests: `tests/traffic*.test.ts`.
