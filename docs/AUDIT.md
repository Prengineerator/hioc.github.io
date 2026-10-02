# Servly restructure: Phase 0 audit

**Date:** 2026-10-02.
**Scope:** the whole `hioc.github.io` repository at `d25140c`, plus read-only metadata from HIOC's Vercel project and Supabase project.

**Method:** five read-only `auditor` sub-agents worked in parallel:
- the customer ordering surface;
- the staff surface, POS, printing and the desktop app;
- the owner surface;
- the coffee features;
- shared code, the API and the backend.

A sixth agent (general-purpose, measure-only) ran a performance baseline in a scratch copy of the repo; the `auditor` definition doesn't allow installs or builds. The lead verified the highest-impact claims directly; those are marked **(verified)**.

Companions: [`HIOC-BASELINE.md`](HIOC-BASELINE.md) (what production looks like today) and [`REPO-PLAN.md`](REPO-PLAN.md) (what we build).

> **This repository is public.** One security finding (a data-exposure issue) was reported to the owner privately and is only summarised in §10. Exploit details stay out of this file until it is fixed.

---

## 1. The ten facts that shape the plan

1. **There is one Next.js app, not three.**
   - "Ordering", "staff" and "owner" are *surfaces* of a single Next.js 14 app.
   - `middleware.ts` and `lib/routing/surface.ts` route by host: `staff.hioc.in` → `/staff/**`, `owner.hioc.in` → `/owner/**`.
   - All three share the same 152 API route files, 247 `lib/` files (~46k lines) and `components/ui`.
2. **The API cannot simply move to its own host.**
   - All ~230 browser `fetch` calls are relative (`/api/...`). Auth is a host-scoped Supabase cookie that the browser client also reads.
   - POS identity uses two cookies:
     - a device cookie set on the parent domain (`Domain=hioc.in`);
     - a host-only operator-PIN cookie.
   - So each app must serve the API routes it uses on its own origin.
3. **The installed Windows POS app is pinned to `https://staff.hioc.in`.**
   - The URL is compiled into `desktop/src/main.ts`, with an origin allowlist in `desktop/src/allowedOrigin.ts`.
   - Auto-update reads GitHub Releases of *this* repo (`desktop/electron-builder.yml`).
   - Changing the staff domain, or the `/staff/**` and `/staff-print/**` paths, strands every counter until someone reinstalls it by hand.
4. **Three external systems call `https://hioc.in` directly.**
   - Razorpay (payment webhook), Meta (WhatsApp webhook) and Supabase Auth (Send-SMS hook) call `https://hioc.in/api/...`.
   - Three pg_cron jobs in the database also POST to hard-coded `https://hioc.in/api/cron/...` URLs **(verified)**.
   - Whatever app answers `hioc.in` after the split must keep serving those routes.
5. **The database cannot be rebuilt from the repo.**
   - `supabase/schema.sql` describes 9 tables; production has 84.
   - Only 27 migrations (from 2026-09-24) are tracked in Supabase; everything earlier was applied by hand.
   - Replaying the 57 SQL files in name order breaks in at least 7 places (§5).
   - Realtime publication, the Vault `cron_secret`, the Auth SMS hook, SMTP and the `menu-images` bucket policy exist only in the dashboard.
6. **Live updates do not actually use Realtime today (verified).**
   - The `supabase_realtime` publication contains **no tables**, so the app's `postgres_changes` subscriptions on `orders` and `menu_items` never fire.
   - Every "live" screen runs on its poll backstop:
     - staff board: 15 s;
     - customer menu: 15 s;
     - order status page: 4 s (Realtime *broadcast*);
     - store settings: 30 s.
   - This is the main source of per-visitor Vercel function invocations.
7. **The "coffee module" is two unrelated features (detail in §4).**
   - **HIOC Ritual** (prepaid cups) is woven into order pricing, the order lifecycle and core-table triggers.
   - **Ask Coffey** (the LLM menu suggester, "Jev") is cleanly separable.
   - Neither is coffee-specific in its data model.
8. **Feature switches are fixed at build time.**
   - All 13 live feature flags are `NEXT_PUBLIC_*`, inlined at build time. A 14th, `GUEST_OTP`, is set on Vercel but unused.
   - Module code ships in every bundle whether it is on or off.
   - Turning a module on or off means a redeploy; there is no runtime module loading.
9. **Every page is server-rendered on every request (verified).**
   - The root layout calls `headers()` (`app/layout.tsx:57`), which makes every route dynamic, including static pages like `/about` and the legal pages.
   - No route uses ISR, `revalidate` or `next/dynamic` lazy loading.
   - `next.config.js` has no `images` config, and menu photos are plain `<img>`.
10. **HIOC-specific values are everywhere.**
    - Brand, address, legal IDs, categories and hours live in `lib/constants.ts` and `lib/legal.ts`.
    - ~40 inline brand strings; ₹ hard-coded on ~90 lines; `Asia/Kolkata` in 16 files.
    - 13 copies of an IST-offset constant; `+91` in ~20 files.
    - ~1,476 `_inr` identifiers, plus DB column names.
    - Template names in SQL seeds; brand-named Tailwind tokens (`tan`, `charcoal`) used ~1,000 times.

---

## 2. What exists today

| Area | Size | Notes |
|---|---|---|
| Customer surface | ~25 routes | All dynamic. 4 pages read the DB with the service-role key: receipt, rewards, `/t/[token]`, `/r/[token]`. |
| Staff surface | ~20 routes; `components/staff` ~60 files, ~13k lines (`PosOrderEntry` 2,315) | POS, live board, cash, attendance, leave, inventory, tables, menu editor, printing. |
| Owner surface | ~19 routes; `components/owner` ~15k lines | Overview, reports (computed in JS, not SQL), staff, payroll, devices, marketing, passes, suggestions. |
| API | 152 `route.ts` | Nearly all use the service-role key; ~88 have route-handler tests. |
| `lib/` | 247 files, ~46k lines | No imports from `app/` or `components/`. One 16-folder module cycle (§3). |
| Desktop POS | Electron 44, `desktop/`, v0.1.3, Windows | Its own release workflow; it imports `../lib/desktop/bridge.ts`. |
| Tests | 283 Vitest files, ~7,400 cases (7,430 passed, 1 skipped when measured; see `PERF.md`) | Node environment only. 419 path-based `vi.mock('@/lib/…')`. **No E2E, no visual tests.** |
| CI | `code-revamp.yml` (lint, `tsc`, test, build on PRs touching app code) | Also runs a weekly Claude "revamp" job. Never checks `supabase/**`. |
| Database | 84 tables, 15 views, 38 functions, 25 triggers, 5 enums, 3 pg_cron jobs | All tables have RLS on; ~50 are service-role-only by design. |
| Legacy | `index.html`, `css/`, `js/`, `sass/`, `fonts/`, `images/`, `CNAME`, `_config.yml` (~2.2 MB) | The old GitHub Pages site. Nothing in the app references it. |

---

## 3. Dependency map (today)

```
                       ┌──────────── middleware.ts (host → surface rewrite, /staff + /owner auth gate)
                       │
   app/(customer)  app/staff/**  app/owner/**  app/staff-print/**   app/api/** (152 routes, shared by all hosts)
        │              │             │              │                    │
        └──────┬───────┴──────┬──────┴──────┬───────┘                    │
               ▼              ▼             ▼                            ▼
      components/{site,menu,cart,checkout,…}  components/staff  components/owner   lib/api/* (http, auth gates,
               │              │             │                            device + operator cookies, rate limit)
               └──────────────┴──────┬──────┘                            │
                                     ▼                                   ▼
                              components/ui (shared, brand tokens)   lib/supabase-server (service role)
                                     │                                   │
                                     ▼                                   ▼
   lib/ pure: types · constants/legal/brand · phone · store/hours · menu · orders/{stateMachine,lines,payments}
              · loyalty rules · passes/rules · print/{ticketModel,escpos} · cash · attendance · payroll · leave
   lib/ server: orders/getOrder · payments/{gateway,reconcile} · notifications/{engine,adapters} · marketing/server
              · suggest/{jev,llm,queries} · reports/*Server · inventory · staff/{emails,pinAuth}
   lib/ client: supabase (browser) · realtime/hooks · cart · hooks · razorpayCheckout · desktop bridge · pos
```

**Most-imported modules:**

| Module | Imports |
|---|---|
| `lib/types` | 185 |
| `lib/supabase-server` | 157 |
| `lib/api/http` | 148 |
| `lib/api/auth` | 112 |
| `lib/flags` | 58 |

**Layering problems to fix before extracting packages:**
- **One module cycle across 16 `lib/` folders.** The main loops:
  - `orders` ⇄ `print`;
  - `staff` ⇄ `desktop`;
  - `cart` → `suggest`;
  - core `types.ts` → `passes/types`.
- **Two file-level cycles:** `suggest/traitVocabulary` ⇄ `suggest/types`, and `api/auth` ⇄ `api/operator` (broken with a deferred import).
- **Four files mix pure and server code without `import 'server-only'`:** `lib/api/auth.ts`, `lib/permissions.ts`, `lib/orders/passPricing.ts`, `lib/reports/ownerDigest.ts`.
- **Core imports module code** (Ritual) in ~15 places: `lib/types.ts:6`, `lib/orders/amend.ts:30`, `lib/print/ticketModel.ts:28`, and others.
- **The same helper is reimplemented in 13 places** (the IST offset). The device-cookie name is duplicated in `middleware.ts` because Edge middleware can't import Node `crypto`.
- **`lib/api/auth.ts`** mixes the customer gate (`getAuthUser`) with the staff, manager and operator gates.

**Cross-surface sharing that must become packages before the apps can separate:**

| Shared item | Used by |
|---|---|
| `components/ui/*` | all three surfaces (Button ×36 in staff/owner alone, Modal ×17, DataTable ×16) |
| `components/menu/{ItemCustomizer,MenuCategoryTabs}` | customer and staff POS |
| `lib/cart/CartContext` | customer and staff POS |
| `lib/realtime/hooks` | customer, staff and owner LiveOps |
| `lib/print/labels`, `lib/print/devanagariFont` | all three (the Devanagari font loads in the root layout) |
| `lib/staff/{accounts,autoPrint,displayName}`, `lib/cash/*`, `lib/attendance/*` | staff and owner |
| `components/staff/ConfirmDialog` | staff and owner |
| `components/{promotions,reviews}/*Manager` / `ReviewModeration` | owner only, though they live outside `components/owner` |

---

## 4. The coffee features (what "the coffee module" can mean)

| | **A. HIOC Ritual** (prepaid cups) | **B. Ask Coffey** (LLM menu suggester) | **C. Loyalty "Beanies", sugar, categories** |
|---|---|---|---|
| Code | `lib/passes` (10 files) + 2 order files, ~4.2k lines; 28 components; 11 API routes; 3 pages | `lib/suggest` (31 files), ~6.6k lines; 14 components; 6 API routes; 4 pages; 1 cron | `lib/loyalty` (5 files); categories in `lib/constants.ts` |
| Files outside its own tree that reference it | **~52**: quote, order create, status, payment, amend, refund, reconcile, print, reports, POS, checkout, nav | **9**: order attribution, cart field, checkout event, home/menu entry points, owner nav | loyalty is part of the order lifecycle (earn, redeem, reverse) |
| Core DB changes | **Yes**: `orders.order_kind` CHECK, `orders.pass_discount_inr`, 4 columns on `order_items`, `menu_items.pass_eligible`; **4 triggers on `orders`/`order_items`** fire on every order even with the flag off | None; own tables, FK-only coupling | Core tables |
| Coffee-specific? | No: generic "prepaid N items" | No: recommends drinks, desserts and food. Only its taste vocabulary and the "Choice of Sugar" helper are café-flavoured | No; "Beanies" is just a brand string |
| External cost | When on, `GET /api/passes/plans` (uncached, 3 DB reads) runs on **every home, menu and checkout view** | TypeSafe "Jev" LLM, budget-capped ($3/day default), only on submit | none |
| Switch-off cleanliness | UI and API clean (404s). DB triggers, CSV columns and the permission rows remain. `/staff/passes` returns 200 "not switched on" | `/coffey` stays public; the owner "Suggestions" tab is always visible; the weekly digest cron runs with no flag check | not switchable |
| Recommended home | `passes` module **after** core gets extension points (order-kind registry, price adjusters, refund and print hooks) | `suggest` module (first and easiest extraction) | core `loyalty`, with "Beanies" as config |

The decision is in `REPO-PLAN.md` §1, question Q4.

---

## 5. Backend (Supabase)

**Reproducibility hazards when applying `supabase/*.sql` from zero:**

| # | Hazard |
|---|---|
| 1 | `2026-09-cash-counts.sql` alters `staff_accounts`, which a later-sorting file creates. |
| 2 | `2026-10-marketing-agent.sql` reads `whatsapp_opt_outs`, created by the later-sorting `2026-10-order-feedback.sql`, so the whole file fails. |
| 3 | In C sort order `-` precedes `.`, so `coffee-pass-per-drink` runs before `coffee-pass`, `cash-expenses-backfill` before `cash-expenses`, and the inventory add-ons before `inventory`. Re-running the base Ritual file after per-drink silently restores an old trigger function. |
| 4 | `2026-09-delete-test-orders.sql` was a one-time production cutover (`delete from public.orders`). It must never be part of a replay. |
| 5 | `phase2-migration.sql` was edited in place for loyalty defaults, so the three `2026-10-loyalty-*` files are redundant on a fresh DB. The rescale file aborts unless the old rate is in place. |
| 6 | `alter type … add value` must commit before use. `phase1-migration.sql` duplicates `phase1-step1/2.sql`, and `apply-phase3.sql` concatenates three other files, giving four redundant files. |
| 7 | Many statements are not idempotent: `schema.sql`, the phase 1–3 policies and triggers, `seed.sql`. |
| 8 | `create or replace view` resets `security_invoker`; `v_valid_orders` is `select *`, so its column list is frozen. |
| 9 | `2026-08-pos-devices.sql` references a file that doesn't exist. |
| 10 | Not in SQL at all: Realtime publication tables, Vault `cron_secret`, Auth Send-SMS hook URL and secret, SMTP, the `menu-images` bucket (created at runtime by `/api/menu/upload`), and the first-owner promotion (`update profiles set role='owner'`). |

**Conclusion:**
- Phase 6's "fresh setup from zero" must start from a **schema-only snapshot of production**, taken with read-only catalog queries or `pg_dump --schema-only`, as `0000_baseline.sql`.
- Later additive migrations go on top of that baseline.
- Each migration has a down-migration, and a CI job replays the chain on a local Supabase stack.
- Data seeds are excluded: the 120-item HIOC menu in `seed.sql`, Ritual plans, marketing playbooks, the review URL and the `legacy_*` history.

**RLS:**
- All 84 tables have RLS enabled. About 50 have no policy, which means service-role only (deny-by-default, intentional).
- Menu, store settings, announcements, loyalty config and active tables are public-read.
- Customer data is own-row; operational tables use `is_staff()`.
- **One access-control finding was reported to the owner privately (§10).** Details are withheld because this repository is public.
- Advisors:
  - WARN: `is_staff()` is a SECURITY DEFINER function callable by `authenticated`.
  - WARN: leaked-password protection is off.
  - WARN: `pg_net` and `btree_gist` are installed in `public`.

**Scheduled work:**
- 8 Vercel crons, all daily or weekly, which is fine for Hobby.
- 3 pg_cron jobs **(verified)**:

  | Job | Schedule (UTC) |
  |---|---|
  | `expire-orders-poll` | `30 6,10,14,18 * * *` |
  | `feedback-requests-poll` | `*/5 * * * *` |
  | `marketing-send-poll` | `*/5 * * * *` |

- The two 5-minute jobs cost ~576 Vercel function invocations a day even while those features are idle.
- `idempotency_keys` and `rate_limits` are never purged.

**Seeds and PII:**
- `seed.sql` is HIOC's real menu: 120 items with fixed UUIDs.
- Production holds a large imported Petpooja history (`legacy_*`) with real customer names and phone numbers.
- **No production data may be copied into test projects.** A test project gets the schema, HIOC's menu and settings (already public on the website), and synthetic customers.

---

## 6. Environment variables (reconciliation)

About 70 env vars are read in code.

| Problem | Variables |
|---|---|
| Read in code but **missing from `.env.local.example`** | `RESEND_FROM_STAFF`, `GOOGLE_REVIEW_URL`, `NEXT_PUBLIC_MONITORING_WEBHOOK_URL`, `INVENTORY_BOOK_DIR`, `WHATSAPP_TPL_FEEDBACK(_LANG)`, `WHATSAPP_TPL_LEAVE_REMINDER`, `NEXT_PUBLIC_FLAG_POS_V2`, `NEXT_PUBLIC_FLAG_SUGGEST`, `NEXT_PUBLIC_FLAG_VERIFIED_ORDERS`, `VERCEL_PROJECT_PRODUCTION_URL` (comment only) |
| In the example and set on Vercel but **read by no code** | `NEXT_PUBLIC_FLAG_GUEST_OTP` (superseded by `VERIFIED_ORDERS`) |
| Set on Vercel but **unused by app code** (tests only) | `GEMINI_API_KEY`, `GEMINI_MODEL`, `ANTHROPIC_API_KEY` |

Other cross-cutting issues:
- **One `NEXT_PUBLIC_SITE_URL` builds links for three audiences:** customer receipts and QR codes, staff password-reset and stock emails, and owner report emails. After the split each app needs its own base URL.
- **Flags enforced on the server must be identical in every project that serves the API:** `coffeePass`, `verifiedOrders`, `suggest`, `tableQr`, `staffPos`, `inventory`.
- **Previews currently share production's Supabase, WhatsApp and Resend credentials.** These variables target both `preview` and `production` with one value each. So a preview deployment of this repo is **not isolated from production data**, and can send real WhatsApp messages. The owner should consider scoping production credentials to the Production environment only. No E2E test may run against these previews (`REPO-PLAN.md` §7).

---

## 7. Everything pinned to an origin or path (must keep working)

| Caller | Target today | Owner after split |
|---|---|---|
| Razorpay webhook | `https://hioc.in/api/payments/webhook` | ordering app (`hioc.in`) |
| Meta WhatsApp webhook | `https://hioc.in/api/webhooks/whatsapp` (+ `/api/whatsapp/webhook`) | ordering app |
| Supabase Send-SMS hook | `https://hioc.in/api/auth/sms-hook` | ordering app |
| pg_cron × 3 | `https://hioc.in/api/cron/{expire-orders,feedback-requests,marketing-send}` | ordering app (or templated per restaurant in `servly-backend`) |
| Vercel crons × 8 | `/api/cron/*` on the production deployment | split by owning app (`REPO-PLAN.md` §6) |
| Installed POS app | `https://staff.hioc.in`, allowlist `staff.hioc.in` + `hioc.in/{staff,staff-print,login}` | staff app **must** keep `staff.hioc.in` and the `/staff/**` and `/staff-print/**` paths |
| PWA manifest | `/pos.webmanifest`, `start_url /staff` | staff app |
| Customer links in WhatsApp, email and QR | `/order/<id>`, `/order/<id>/receipt`, `/t/<token>`, `/r/<token>`, `/feedback/<token>` on `NEXT_PUBLIC_SITE_URL` | ordering app, unchanged paths |
| Staff emails | `/staff/reset-password`, stock links built on the **customer** base URL | staff base URL |
| Owner report emails | `/owner/reports` on the customer base URL | owner base URL |
| Path forms | `hioc.in/staff/**`, `hioc.in/owner/**` | **decision Q7**: redirect to the subdomain or proxy |
| Device cookie | `hioc_device`, `Domain=hioc.in`, read by staff and set from staff/owner | works as long as all apps stay under `hioc.in` |
| Bill-email logo | `${SITE}/images/logo-black.png` | ordering app keeps `/images/*` |
| Desktop auto-update | GitHub Releases of `Prengineerator/hioc.github.io` (`pos-v*`) | **decision Q8** |

---

## 8. Hard-coded HIOC values (summary)

The full `file:line` lists are in the auditors' reports; config-extractor tasks in Phase 4 will carry them. Key names below are the proposed `restaurant-config` keys.

| Group | Main locations | Proposed key(s) |
|---|---|---|
| Brand name, tagline, order prefix `HIOC-`, Devanagari wordmark | `lib/constants.ts:5`, `app/layout.tsx:32-45`, `lib/utils/orderNumber.ts:7`, `lib/print/brandHeader.ts`, `lib/pos/manifest.ts`, `razorpayCheckout.ts:116`, ~40 inline strings | `brand.{name,shortName,tagline,wordmarkNative,orderPrefix,slug}` |
| Contact, address, maps, social, review URL | `lib/constants.ts:7-38`, `order-feedback.sql:69,75` | `contact.*`, `location.*`, `social.*` |
| Legal entity, GSTIN, FSSAI, jurisdiction, policy dates, six policy pages | `lib/legal.ts`, `app/{privacy,terms,refund-cancellation,shipping-delivery}` | `legal.*`, policy templates |
| Programme names: "HIOC Ritual", "Beanies", "Coffey", "Jev" | `lib/passes/brand.ts`, `lib/loyalty/brand.ts`, `app/coffey`, `lib/suggest/*` | `modules.passes.brand`, `loyalty.unitName`, `modules.suggest.assistantName` |
| Menu categories (17), validated by the API | `lib/constants.ts:45-71`, `lib/api/constants.ts:10` | `menu.categories` (or DB) |
| Locale: ₹/INR/`en-IN`/paise ×100, `Asia/Kolkata` (16 files + SQL views), +91 and the Indian mobile regex, GST labels | many | `locale.{currency,timezone,dateLocale,phone}`, `tax.*` |
| Theme: `tan`/`charcoal`/`cream` tokens, ~35 one-off hexes, fonts (DM Sans, Space Mono, Noto Sans Devanagari) | `tailwind.config.ts:26-45`, `globals.css`, `app/layout.tsx` | `theme.colors.*` (semantic names), `theme.fonts` |
| Domains and login domain | `lib/staff/accounts.ts:10` (`@hioc.in` is part of every staff auth email), `desktop/src/*`, 3 pg_cron SQL files | `domains.*`, `auth.staffLoginDomain`, `desktop.*` |
| Cookie and storage prefixes | `hioc_device`, `hioc_operator`, `hioc.cart.v2`, `hioc:*`, `hioc-print` | `brand.slug` (**HIOC keeps its existing names**) |
| WhatsApp template names, marketing copy, report/payslip email copy | `notifications/adapters.ts:51-65`, `marketing/types.ts:446-475`, SQL seeds | `messaging.templates.*`, `copy.*` |
| Aggregators (Swiggy Dineout, Zomato District), cash denominations, expense limit | `lib/orders/payments.ts`, `lib/cash/*` | `payments.methods`, `cash.*` |
| Fallback store settings (10:00–24:00, GST 5%) | `lib/store/hours.ts:208-238`, `phase1-migration.sql:161` | `defaults.storeSettings` |
| Vercel region `icn1` | `vercel.json` | per-deployment `vercel.json` |

**HIOC must keep every existing name.** That covers cookie names, storage keys, order prefix, staff login domain and template names, because renaming them logs people out, empties carts or breaks approved WhatsApp templates. Config makes them *configurable*; HIOC's config reproduces today's values exactly.

---

## 9. Performance baseline

The perf-baseline agent's measurements (build route table, First Load JS, production response headers, Lighthouse) are recorded in [`PERF.md`](PERF.md) as the "before" numbers. What the code audit already shows:
- **Everything is dynamic.** Static, legal and marketing pages could be SSG/ISR.
- **Hot polling paths:**

  | Path | Cadence |
  |---|---|
  | `/api/orders/[id]` | every 4 s while an order page is open |
  | `/api/menu` | 15 s on an open menu tab |
  | `/api/store-settings` | 30 s |
  | staff boards | 15 s |

  `/api/menu` is `force-dynamic` with no `Cache-Control`.
- **The middleware matcher runs on every request**, including `/api/*`.
- **Images:**
  - No `images` config in Next.
  - Menu photos are plain `<img>` from Supabase Storage at their original size. Uploads accept JPG/PNG/WebP/GIF up to 2 MB with no resizing.
  - The hero `img.jpeg` is 217 KB.
- **JavaScript:**
  - No `next/dynamic` anywhere.
  - The owner marketing dashboard imports 7 tabs eagerly.
  - `qrcode` is imported statically.
  - The root layout ships the customer header and footer, Vercel Analytics and three font families to every surface.
- **Order-status updates poll every 4 s, a cost once the Realtime publication is fixed.** Fixing the publication (Phase 6) is one of the biggest reductions in function invocations, alongside static pages.

---

## 10. Pre-existing issues found (not caused by this project)

None of these were changed in Phase 0. Each needs the owner's go-ahead. Most are small, separate fixes to the *current* repo, made before or alongside Stage A.

| # | Severity | Issue | Evidence |
|---|---|---|---|
| S1 | Security | One access-control finding, reported to the owner privately. Details withheld because this repository is public. | withheld |
| B1 | High (ops) | The Realtime publication is empty, so "live" updates never arrive. Staff boards wait up to 15 s for new orders and the customer menu up to 15 s for availability changes **(verified)**. | `pg_publication_tables` |
| B2 | Medium | On `staff.hioc.in`, `/staff-print/<id>/<type>` is rewritten to `/staff/staff-print/...`, which doesn't exist. Browser-fallback and "system+driver" printing 404 on the subdomain; raw ESC/POS is unaffected **(verified by executing the function; not reproduced on a live counter)**. | `lib/routing/surface.ts:54-60` |
| B3 | Medium | Owner Settings "Save" from a normal (non-enrolled) browser fails. The page sends `hidden_categories` and `hidden_variant_labels`, which the API only accepts from an enrolled POS device **(verified by reading the code; not reproduced live)**. | `app/owner/settings/page.tsx:94`, `app/api/store-settings/route.ts:63-78` |
| B4 | Low | The owner login ignores `?error=not_staff`. The owner layout redirects to `/staff/login` while middleware uses `/owner/login`. There is no owner sign-out control. | `app/owner/login/page.tsx:34`, `app/owner/layout.tsx:27` |
| B5 | Low (security) | The staff login form follows `?next=` without `safeNextPath`. | `components/staff/StaffLoginForm.tsx:81-82` |
| B6 | Low | Staff password-reset and stock emails link via the customer base URL. They still work today because one app serves all paths. | `lib/staff/emails.ts:142` |
| B7 | Low | Owner marketing and attendance APIs aren't flag-gated; only their UI is. | `lib/marketing/server/http.ts:20` |
| B8 | Hygiene | Stale env vars on Vercel and missing names in `.env.local.example` (§6). | |
| B9 | Hygiene | Supabase advisors: `is_staff()` exposed as a definer function, leaked-password protection off, extensions in `public`. | Supabase advisors |
| B10 | Hygiene | `idempotency_keys` and `rate_limits` grow forever. | no purge job |

---

## 11. What could break, ranked (risk register)

| # | Risk | Impact if it happens | Mitigation in the plan |
|---|---|---|---|
| R1 | Staff app leaves `staff.hioc.in` or drops `/staff/**`, `/staff-print/**` | Every installed POS counter stops (no printing, no PIN lock, re-enrolment) | Staff app keeps the domain and paths verbatim. Desktop shell is untouched in v1 (Q8). |
| R2 | `hioc.in/api/*` webhooks and cron endpoints move or change | Payments not confirmed, OTP not delivered, orders not expired | Ordering app on `hioc.in` serves every webhook and cron route. An E2E test hits each route's auth check. |
| R3 | Auth or cookie behaviour changes during the split | Everyone logged out, POS unenrolled, customers lose carts | Keep host-only Supabase cookies, cookie names and the `Domain=hioc.in` device cookie. No new cookie domain in v1. |
| R4 | Tests or previews write to production | Real orders, real WhatsApp messages to customers | **Never** E2E against `hioc-in` previews (they use production credentials). Use new preview projects bound to a test Supabase project. |
| R5 | Baseline schema differs from production | New restaurants or test DBs behave differently from HIOC | Baseline from a production schema snapshot; CI diff check (from-zero schema vs snapshot). |
| R6 | Visual or copy drift while moving brand values to config | Owner sees a changed site | Visual snapshots plus HTML diffs at every phase (`config-extractor` acceptance). |
| R7 | Build-time flags differ between the three projects | Server rejects what the UI offers, e.g. Ritual at checkout | One `hioc-config` is the source of flags for all apps; CI asserts parity. |
| R8 | Path-based `vi.mock` goes stale after moves | Tests pass while mocking nothing | `package-extractor` acceptance requires the test count to stay equal; reviewer checks mock paths. |
| R9 | Vercel Hobby limits: 100 deploys/day, 1 build at a time, private-repo commit-author rule | Blocked or queued deploys | Previews only for PRs, ignored-build step, batched upgrades, repo-visibility decision (Q1). |
| R10 | Free-tier exhaustion: GitHub Actions 2,000 min/month on private repos, Packages 500 MB / 1 GB transfer, Supabase 2 active free projects | CI stops or test DBs can't be created | Public repos where possible; lean CI; one test project at a time, pausing between uses (`REPO-PLAN.md` §7, §9). |
| R11 | A module "switched off" still leaves DB triggers and columns (Ritual) | Not fully clean switch-off | Documented exception; Ritual becomes a module only after core extension points exist. |
| R12 | The Claude `code-revamp` weekly job opens PRs against paths that are moving | Merge conflicts, surprise deploys | Pause it during Stage A (owner's call). |
