# HIOC Cafe — MVP

Order-ahead web app for HIOC. (Kamla Nagar, Agra): customers browse the menu, build
a cart, and check out as a guest for counter pickup (no online payment). Staff get a
password-protected back office to manage the live order queue and edit the menu.

Built on Next.js 14 (App Router) + Supabase (Postgres, Auth). No payment gateway —
this is "order ahead, pay at the counter" only.

## What was built

**Public site**
- `/` — Home (hero, category teasers, about teaser)
- `/menu` — Menu browser with category tabs, add-to-cart, floating cart bar + drawer
- `/checkout` — Guest checkout (name, phone, pickup time, notes) — no login required,
  no payment. `customer_phone` must be a valid Indian mobile number (10 digits,
  starting 6-9; `+91`/`91`/`0` prefixes and spaces/hyphens are accepted and
  normalized) — format-validated only, no SMS is sent.
- `/login` — Customer login/signup: passwordless 6-digit email code, or email+password.
  Fully independent of checkout — logging in is optional, guest checkout still works
  without it, and there's no order history or saved-details behind it yet.
- `/order-confirmation/[orderId]` — Order confirmation / lookup page
- `/about`, `/contact` — Static brand pages (contact page embeds a no-API-key Google Maps iframe)

**Staff back office** (behind login, gated by `middleware.ts` + a server-side
session+role check in `app/staff/layout.tsx`)
- `/staff/login` — Email/password login
- `/staff` — Live order queue (Received → Preparing → Ready → Completed), polls every 15s
- `/staff/menu` — Menu CRUD: add/edit/delete items, toggle availability

Staff and customers both authenticate through the same Supabase Auth user pool;
what makes an account "staff" is a `role = 'staff'` row in the new `profiles`
table (see "One-time Supabase setup" below) — every staff-only route and the
`/staff/**` middleware gate check this role, not just "is there a session."

**API** — `app/api/**` Route Handlers backing all of the above:
`GET/POST /api/menu`, `PATCH/DELETE /api/menu/[id]`, `POST/GET /api/orders`,
`GET /api/orders/[id]`, `PATCH /api/orders/[id]/status`, `POST /api/auth/login`,
`POST /api/auth/logout`, `GET /api/auth/me`,
`POST /api/auth/customer/otp/request`, `POST /api/auth/customer/otp/verify`,
`POST /api/auth/customer/signup`.

**Data** — `supabase/schema.sql` (tables, RLS policies) and `supabase/seed.sql`
(starting menu — see "What's in the seed menu" below).

## Verification performed

- `npm install`, `npx tsc --noEmit`, and `npm run build` all completed with **zero
  errors** (Node 20.16.0 / npm 10.8.1). The build succeeds without real Supabase
  credentials present, because every route that touches Supabase is a dynamic
  Route Handler or a cookie-reading layout (`export const dynamic = 'force-dynamic'`),
  never statically rendered at build time — Supabase is only contacted at request
  time, once the app is actually running.
- Every frontend `fetch()` call was cross-checked against the actual Route Handler
  it calls (path, method, request body shape, response shape) — no mismatches found.

## Environment variables

Copy `.env.local.example` to `.env.local` and fill in:

| Variable | Where to get it | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase dashboard → **Project Settings → API** → "Project URL" | Safe to expose to the browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page → "Project API keys" → `anon` `public` | Safe to expose to the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → "Project API keys" → `service_role` | **Secret.** Server-only — never commit it, never prefix it `NEXT_PUBLIC_`. Used by order creation and all staff-privileged writes. |

```
cp .env.local.example .env.local
# then paste the three values in
```

## One-time Supabase setup (for a non-technical cafe owner)

1. **Create a free Supabase project**
   - Go to https://supabase.com → Sign up / log in → "New project".
   - Pick any name/region/database password (save the DB password somewhere safe,
     though the app itself never needs it directly).
   - Wait ~2 minutes for the project to finish provisioning.

2. **Create the database tables**
   - In the Supabase dashboard, open the **SQL Editor** (left sidebar).
   - **Brand-new project:** Click "New query", paste the entire contents of
     `supabase/schema.sql` from this repo, and click **Run**. This creates the
     `menu_items`, `orders`, `order_items`, and `profiles` tables plus the
     security rules that protect them. `profiles` is what distinguishes staff
     accounts from customer accounts — see step 5 below.
   - **Project that already has this schema applied** (e.g. you're adding the
     `profiles` table to an existing setup): don't re-paste the whole file —
     it'll fail with `type "order_status" already exists` and stop before
     reaching the new part. Instead, open `supabase/schema.sql`, copy only the
     `profiles` block near the end (from the `create table profiles` comment
     down through the final `insert into public.profiles` backfill), and run
     just that in a new query.

3. **Load the starting menu**
   - New query again, paste the entire contents of `supabase/seed.sql`, and
     **Run**. This adds 21 starting menu items (see below).

4. **Get your API keys**
   - **Project Settings → API** (gear icon, bottom of left sidebar). Copy the
     three values into `.env.local` as described above.

5. **Create one staff login**
   - **Authentication → Users** (left sidebar) → "Add user" → "Create new user".
   - Enter the staff email and a password, and make sure "Auto Confirm User" is
     checked (so no confirmation email is required).
   - **Then, in the SQL Editor, promote that account to staff** — every new
     account (including ones created here in the dashboard) defaults to a
     `'customer'` role, which cannot log into `/staff/login`:
     ```sql
     update public.profiles
     set role = 'staff'
     where id = (select id from auth.users where email = '<staff email>');
     ```
   - This is the email/password staff will use to log in at `/staff/login`.
     Repeat both steps (create user + promote to staff) for every staff
     account you add.

6. **Enable the customer email-code login** (only needed if you want the
   "Email Code" option on `/login` to work — email+password login works
   without this step)
   - **Authentication → Email Templates → Magic Link** (left sidebar).
   - By default this template only contains a clickable link, with no visible
     code — but `/login`'s "Email Code" flow needs an actual 6-digit code to
     show the customer. Replace the template body with something like:
     ```html
     <h2>Your HIOC login code</h2>
     <p>Enter this code to log in: <strong>{{ .Token }}</strong></p>
     <p>This code expires shortly. If you didn't request it, ignore this email.</p>
     ```
   - Note: **Authentication → Providers → Email → "Confirm email"** is ON by
     default. This only affects the password **Create Account** flow on
     `/login` — a new password account can't log in until the customer clicks
     the confirmation email link Supabase sends automatically (no setup
     needed for that one). It doesn't affect the Email Code flow, which logs
     the customer in immediately on a correct code.

That's it — no other setup needed on the Supabase side.

## Running locally

```
npm install
npm run dev
```

Then open http://localhost:3000. Staff back office is at
http://localhost:3000/staff/login.

To build for production: `npm run build` then `npm run start`.

## Deploying

Any host that runs Next.js works (e.g. Vercel is the simplest — connect the repo,
add the three env vars above in the project's settings, deploy). No separate
backend or server to stand up — the API routes ship inside the Next.js app itself.

## What's in the seed menu

`supabase/seed.sql` loads 21 items across 5 categories:

- **Waffles (5 items) — REAL.** Actual HIOC. menu items with real names/prices
  (Almond Honey, Triple Choco, White Garland, Black Forest, Butterscotch).
- **Coffee, Sandwiches, Desserts, Beverages (16 items total) — PLACEHOLDER.**
  Invented for MVP completeness so every category has content to demo/test with.
  Names, descriptions, and prices are made up and **must be reviewed and corrected**
  via `/staff/menu` (edit or delete/re-add) before this goes live for real customers.

## What is explicitly NOT built yet

- **No payment gateway.** Checkout is "reserve now, pay at the counter" only —
  there is no Razorpay/Stripe/UPI integration anywhere in this codebase.
- **No real menu beyond the 5 waffles.** Coffee, sandwiches, desserts, and
  beverages are placeholder items (see above) — verify/replace before launch.
- **No SMS/WhatsApp/email order notifications.** Customers see their order
  status only if they revisit the confirmation link; there's no automated
  "your order is ready" message.
- **No account features beyond login.** Customers can log in (email code or
  password) via `/login`, but there's no order history, saved details, or
  past-orders list behind it yet — every checkout, logged in or not, is still
  a one-off guest order.
- **No inventory/stock-out automation.** "Available"/"unavailable" on a menu
  item is a manual toggle in `/staff/menu` — nothing auto-disables an item.
- **No analytics/reporting dashboard.** `/staff` shows only today's live queue
  (or `?all=true` via the API) — no sales totals, best-sellers, or exports.
- **No multi-location support.** The app assumes a single cafe/pickup location
  (address/hours/phone are hardcoded in `lib/constants.ts`).
- **No image uploads for menu items.** Menu items are text + price only; there
  are no per-item photos.
- **No automated tests.** Verification for this MVP was manual review +
  `tsc`/`next build` type-checking, not a test suite.
- **Security note (not urgent, but worth knowing):** `npm install` reports the
  installed `next@14.2.5` has a known security advisory
  (https://nextjs.org/blog/security-update-2025-12-11). Recommend upgrading to
  a patched Next 14.2.x release before a public launch — this MVP review did
  not upgrade it, to avoid changing behavior outside the scope of this task.

## Project structure reference

- `app/**` — pages and API routes (Next.js App Router)
- `components/**` — shared React components (menu, cart, checkout, staff, site, ui)
- `lib/**` — Supabase clients, shared types, cart state, API helpers, constants,
  Indian mobile number validation (`lib/phone.ts`)
- `middleware.ts` — gates `/staff/**` behind a valid session AND a staff
  `profiles` role (a logged-in customer is not enough)
- `supabase/schema.sql` — database schema + Row Level Security policies
- `supabase/seed.sql` — starting menu data (see above)
