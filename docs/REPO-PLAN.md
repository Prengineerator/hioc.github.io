# Servly repo plan (Phase 0 proposal, awaiting the owner's approval)

This plan turns HIOC's single app into **Servly**, a white-label product made of independent repos, while HIOC keeps running unchanged.

It builds on [`AUDIT.md`](AUDIT.md) (facts and risks) and [`HIOC-BASELINE.md`](HIOC-BASELINE.md) (production today). It adjusts the original brief where the audit showed the brief would break HIOC; every adjustment says why.

---

## 1. Decisions needed from the owner

Each has a recommended default. Reply "approve defaults", or override by number.

| # | Decision | Recommended default | Why |
|---|---|---|---|
| **Q1** | Repo visibility | **Product repos public, `hioc-config` private.** | Vercel Hobby only deploys a **private** repo's commits when the commit author is the Vercel account owner's linked GitHub login. Agent-authored commits (21 of the last 30 are by "Claude") and Renovate PRs would then never preview. Public repos also get unlimited free GitHub Actions minutes; private repos share 2,000/month. The code is already public today. If you want everything private, see §9. |
| **Q2** | GitHub account and npm scope | Account `Prengineerator`, so the scope is **`@prengineerator`**, and package name = repo name (e.g. `@prengineerator/servly-core`, `@prengineerator/hioc-config`). | GitHub Packages requires the scope to equal the owning account, lowercased. Please **confirm the username**. If any repo will be private, also tell me **which GitHub login is connected to the Vercel account** (Vercel user `businesshighoncaff-6498`). |
| **Q3** | Where the API lives after the split | **Add one package, `servly-server`.** It holds all route-handler logic, and each app re-exports the routes it needs, so the API stays same-origin. | Sessions are host-only cookies. The POS uses a parent-domain device cookie plus a host-only PIN cookie, and all ~230 browser calls are relative `/api/...`. A separate API host would need CORS plus a new cookie scheme, which changes behaviour. Copying 152 handlers into three apps is unmaintainable. |
| **Q4** | What "the coffee module" is | **Two modules: `servly-suggest` (Ask Coffey) and `servly-passes` (HIOC Ritual).** HIOC's config enables both, under a "coffee" preset. | The two features share no code, and neither is coffee-only. Suggest is cleanly separable (9 touch points, no core DB changes). Passes touches ~52 files and puts triggers on `orders`, so it is extracted after core gets extension points. The alternative is one `servly-coffee` repo containing both, as in the brief. |
| **Q5** | Where Stage A (the temporary monorepo) happens | **A new temporary repo, `servly-monorepo`, under your account, with full history imported, branch `restructure/monorepo`, not connected to HIOC's Vercel project.** | `hioc-in` builds a preview for **every** branch push, and those previews run with **production** Supabase, WhatsApp and Resend credentials. Doing Stage A in `hioc.github.io` would create dozens of builds wired to production, while the original repo must stay untouched. |
| **Q6** | HIOC feature work during the restructure | **Keep shipping on `hioc.github.io`. Merge `main` into the monorepo weekly. Short freeze (~2–3 days) only during the big file moves in Phase 3.** | HIOC merges several PRs a day; every one after the snapshot has to be ported. Conflicts get expensive once files move. |
| **Q7** | `hioc.in/staff/**` and `hioc.in/owner/**` after the split | **308-redirect them to `staff.hioc.in/staff/**` and `owner.hioc.in/owner/**`**, keeping the full path, from the ordering app. | The subdomains keep working exactly as now. Anyone who uses the path form signs in once more, because sessions are per host. The alternative, proxying from `hioc.in`, keeps the URL bar identical but doubles function invocations. |
| **Q8** | The Windows POS app (`desktop/`) | **Leave it in `hioc.github.io` for v1, unchanged.** Later, ship one release with a configurable origin and update feed, then move it to `servly-pos-desktop`. | Installed shells look for updates in *this* repo's Releases and only trust `staff.hioc.in`. The staff app keeps both, so nothing breaks. |
| **Q9** | Test data | **Test Supabase project = production schema snapshot + HIOC's menu and settings (already public) + synthetic customers and staff. Never copy real customers, orders or `legacy_*`.** Razorpay **test** keys if you can provide them; otherwise E2E covers pay-at-counter and mocks Razorpay. | "Copy HIOC's database" would copy real names and phone numbers (~10k legacy customers) into a second project. |
| **Q10** | Pre-existing issues (`AUDIT.md` §10) | **Fix S1 (security) now**, as a small separate PR plus an additive, reversible migration on the current repo. **Then B1–B5** as separate small PRs. Each is your call, and each is tested on the test project first. | S1 exposes business data to signed-in customers. B1 means "live" screens aren't live. These are independent of the restructure. |
| **Q11** | Weekly `code-revamp` Claude job | **Pause it during Stage A.** | It opens PRs against paths that are moving. |
| **Q12** | Vercel plan | Acknowledge: **Hobby is for non-commercial use, and HIOC already takes payments.** Move HIOC to Pro when you're ready. The plan stays within Hobby limits either way. | Vercel fair-use terms. |

Other choices this plan makes that you may want to change:
- **Built-in features stay in core for v1**, toggled per restaurant by config: loyalty, marketing, inventory, attendance/payroll/leave, cash, table QR, feedback, reports. They become separate modules later, only if a restaurant needs one removed. This keeps the repo count down. Each repo costs CI, releases and upgrade PRs.
- **The owner menu editor stays staff/POS-only**, as today.

---

## 2. Final repo list

All repos live under your personal GitHub account. Only the three app repos are ever connected to Vercel.

| Repo | Kind | Visibility (Q1) | Publishes | Vercel | Contents (from today's code) |
|---|---|---|---|---|---|
| `servly-config` | package | public | `@prengineerator/servly-config` | no | ESLint config, including a **module-boundaries rule** that enforces the dependency direction; `tsconfig` bases; Tailwind **preset with semantic tokens** (`primary`, `ink`, `surface`…; colours come from restaurant config); PostCSS; `browserslist`; Vitest base. |
| `servly-core` | package | public | `@prengineerator/servly-core` | no | The pure part of `lib/`, as listed below. |
| `servly-restaurant-config` | package | public | `@prengineerator/servly-restaurant-config` | no | Zod schema for restaurant config (§5); `defineRestaurant()`; loader and build-time validator; neutral defaults; a codegen step that generates module routes for enabled modules only. |
| `servly-api-client` | package | public | `@prengineerator/servly-api-client` | no | Typed browser client for every `/api/*` call, replacing ~230 raw `fetch` calls. Same-origin by default. Types and zod from core. |
| `servly-server` *(new, Q3)* | package (server-only) | public | `@prengineerator/servly-server` | no | Supabase server and admin clients, auth gates, device and operator cookies, rate limits, idempotency, the `PaymentProvider` interface (Razorpay; pay-at-counter needs no keys), the notifications engine and adapters (WhatsApp, Twilio, Resend), error logging to a Supabase table, and **all route handlers** grouped by domain (`routes/orders`, `routes/owner/staff`…). |
| `servly-ui` | package | public | `@prengineerator/servly-ui` | no | `components/ui/*` (themeable through CSS variables), shared menu, cart and checkout pieces (`ItemCustomizer`, `MenuCategoryTabs`, `CartContext`), realtime hooks, `ConfirmDialog`, `StarRating`, `SurfaceLink` replacement. |
| `servly-suggest` *(Q4)* | module | public | `@prengineerator/servly-suggest` | no | Ask Coffey: `lib/suggest/*`, `components/{suggest,coffey}`, owner Suggestions UI, its 6 routes and digest cron, its 2 SQL files as module migrations, its config (assistant name, vocabulary, LLM budget). |
| `servly-passes` *(Q4)* | module | public | `@prengineerator/servly-passes` | no | HIOC Ritual: `lib/passes/*`, `passPricing`, `pos/ritual`, the 28 components, its 11 routes, its 2 SQL files. **Extracted last**, after core has the hooks in §4. |
| `servly-backend` | backend | public | `@prengineerator/servly-backend` (migration files plus generated DB types) | no | `supabase/migrations` (a `0000_baseline` from a production schema snapshot, then additive migrations, each with a **down** file), RLS tests (pgTAP), generic demo seed, menu import (CSV/JSON) CLI, pg_cron templates with the app URL as a parameter, and a setup runbook (Realtime publication, Vault secret, Auth SMS hook, SMTP, storage bucket, first owner). |
| `servly-ordering` | app | public | none | **yes** | Customer site. Production domain `hioc.in`, `www.hioc.in`. Serves every webhook and every cron route that external systems call on `hioc.in`. |
| `servly-staff` | app | public | none | **yes** | Staff POS and back office on `staff.hioc.in`. **Keeps `/staff/**`, `/staff-print/**`, `/pos.webmanifest` exactly**, for installed counters. |
| `servly-owner` | app | public | none | **yes** | Owner dashboard on `owner.hioc.in`. Keeps `/owner/**`. |
| `hioc-config` | restaurant config | **private** | `@prengineerator/hioc-config` | no | HIOC's values: brand, assets, policy texts, locale, modules on, cookie and storage names, template names. Also HIOC-only tooling: Petpooja import, the recipe-book scripts (recipe data stays gitignored and in the DB). **No secrets.** |
| `servly-restaurant-template` | template | public | none | no | Blank config, setup guide, Deploy-to-Vercel buttons listing the required env vars. |
| `servly-workspace` | dev meta-repo | public | none | no | `scripts/bootstrap` (clones all repos side by side and links them with pnpm workspaces), cross-repo Playwright E2E for the full HIOC flow, and all docs (this file, `AUDIT`, `ARCHITECTURE`, `RELEASE`, `PERF`, `DEPLOY`, `NEW-RESTAURANT`, `MODULES`, `LOCAL-DEV`, `SWITCH-OVER`). |
| `servly-monorepo` *(Q5, temporary)* | Stage A only | public | none | preview-only project, test credentials | History imported from `hioc.github.io`. Archived after Stage C. |
| `hioc.github.io` *(existing)* | original | public | n/a | `hioc-in` (production today) | **Untouched**, except for the separate, owner-approved fixes (Q10). It stays the fallback until you confirm the switch. Keeps `desktop/` for v1 (Q8). |

`servly-core` contents, from the pure part of `lib/`:
- `types` (split, with zod schemas);
- order state machine, order lines, payments maths, refunds, amend;
- **bill composition with extension points**;
- store hours and slots; menu customisation; loyalty rules;
- one **time/locale/money module** (time zone, currency and phone pattern as parameters), replacing 13 IST copies and the `₹`/`+91` literals;
- permission keys;
- print model (`ticketModel`, `escpos`, `kotRouting`);
- cash, attendance, leave and payroll maths;
- the module-contract types.

`servly-pizza` (custom builder) is a future module repo following the same contract.

---

## 3. Dependency graph

```
                         servly-config
                              │
                         servly-core ◄──────────── servly-backend (generated DB types; contract tests)
                       ┌──────┼────────────────┐
                       ▼      ▼                ▼
          servly-restaurant-config   servly-api-client   servly-server (server-only)
                       │      │                │
                       └──────┼────────────────┘
                              ▼
                          servly-ui
                              │
                ┌─────────────┼──────────────┐
                ▼                            ▼
         servly-suggest               servly-passes          (future: servly-pizza)
                │                            │
     ┌──────────┴───────────┬────────────────┴───┐
     ▼                      ▼                    ▼
servly-ordering        servly-staff         servly-owner      ◄── restaurant config package chosen by env
 (hioc.in)          (staff.hioc.in)      (owner.hioc.in)          (HIOC: @prengineerator/hioc-config)
```

Rules:
- Arrows point from dependency to dependant.
- No cycles. Packages never import apps.
- `servly-server` is imported only by app route files and module route entries, never by client code. It uses the `server-only` guard plus a separate `/server` export.
- Modules declare `servly-core`, `servly-ui` and `servly-server` as **peer** dependencies with compatible ranges.

---

## 4. Module contract (Suggest, Passes, future Pizza)

```ts
// in @prengineerator/servly-core (types only)
export interface ServlyModule<C = unknown> {
  id: string;                                  // 'suggest' | 'passes' | 'pizza' …
  version: string;
  peer: { core: string; ui: string; server: string };   // semver ranges, checked at build
  configSchema: ZodType<C>;                    // the module's section of the restaurant config
  migrations: string;                          // path to its SQL (applied by the servly-backend CLI)
  routes: ModuleRoute[];                       // { app: 'ordering'|'staff'|'owner', path, page?, api? }
  nav?: NavItem[];                             // per app, with required permission
  crons?: CronDef[];                           // merged into the app's vercel.json at build
  hooks?: {
    orderKinds?: OrderKindDef[];               // e.g. 'coffee_pass': kitchen? earns loyalty? refundable? printables
    quoteAdjusters?: QuoteAdjuster[];          // bill composition (Passes)
    afterOrderCreated?: OrderHook[];           // attribution (Suggest)
    onRefund?: RefundHook[];
    printRows?: PrintRowHook[];
    reportColumns?: ReportColumnHook[];
    cartLineMeta?: CartMetaDef[];
  };
  register(ctx: RegisterContext<C>): void;     // validates config, wires hooks
}
```

**How apps load modules.** Next.js can't add routes at runtime, so `servly-restaurant-config` has a **build-time codegen step**. It reads the selected restaurant config and writes thin route files, plus a `modules.generated.ts` registry, **for enabled modules only**. A disabled module therefore has no routes, no nav items, no crons and no bundle weight.

**Adding a module to a restaurant:**
1. Install the package.
2. Enable it in config.
3. Run its migration with `servly-backend migrate --module passes`.

**Exception (documented): Passes.** Its existing DB triggers and columns on `orders` and `order_items` stay in HIOC's database and are inert when it is off. The `order_kind` CHECK becomes a lookup table so Pizza can add kinds. This is an additive, reversible change in Phase 6.

---

## 5. Restaurant configuration

Validated with zod at **build time**: a bad config fails `next build`, never production.

| Section | Keys (examples) | Source today |
|---|---|---|
| `brand` | `name`, `shortName`, `tagline`, `slug` (cookie and storage prefix: HIOC keeps `hioc`), `orderPrefix` (`HIOC-`), `wordmarkNative`, `assets.{logoDark,logoLight,icon,hero,billHeader}`, `poweredByServly` (HIOC: false) | `lib/constants.ts`, `app/layout.tsx`, `lib/print/brandHeader.ts` |
| `theme` | `colors.{primary,primaryDark,ink,surface,muted,line,…}`, `fonts.{body,mono,native}` (self-hosted files), `chrome` | `tailwind.config.ts`, `globals.css` |
| `contact` / `location` / `social` | phone, email, address, geo, maps URLs, Instagram, review URL | `lib/constants.ts` |
| `legal` | entity name, GSTIN, FSSAI, jurisdiction, policy documents (templated, per-module sections), last-updated dates | `lib/legal.ts`, `app/{privacy,terms,…}` |
| `locale` | `currency` (INR), `minorUnit` (100), `timezone` (Asia/Kolkata), `dateLocale` (en-IN), `phone.{callingCode,pattern,example}` | 16+ files |
| `tax` | `label` (GST), `idLabel`; **the rate stays in the DB** (`store_settings.gst_percent`) | `lib/store/hours.ts` |
| `ordering` | order types, table QR on/off, scheduled orders, default type | flags and constants |
| `payments` | providers enabled (`razorpay`), method list (cash, UPI, card, Swiggy Dineout, Zomato District…), merchant display name; keys are **env vars** | `lib/orders/payments.ts`, `razorpayCheckout.ts` |
| `messaging` | provider, template names and languages (HIOC's current names) | `notifications/adapters.ts`, env |
| `domains` | `ordering`, `staff`, `owner` base URLs (replacing the single `NEXT_PUBLIC_SITE_URL` for links) | `lib/url.ts` |
| `auth` | `staffLoginDomain` (HIOC: `hioc.in`, part of every staff login email), OTP channel | `lib/staff/accounts.ts` |
| `modules` | `suggest`, `passes`, `pizza`: `{ enabled, …module config }` | `NEXT_PUBLIC_FLAG_*` |
| `features` | `loyalty`, `marketing`, `inventory`, `workforce`, `cash`, `tableQr`, `feedback`, `reports`, `realtime`, `pinSwitch`, `posV2`… | the other 12 flags |
| `menu` | `categories` (until moved to the DB), veg badge | `lib/constants.ts` |
| `defaults` | fallback store settings | `lib/store/hours.ts` |

**Stays in the DB:**
- opening hours, holidays, slots, GST rate and packaging (`store_settings`);
- menu, prices, add-ons and photos;
- loyalty rates (`loyalty_config`), coupons, announcements;
- tables, staff, permissions;
- marketing settings, Ritual plans.

**How a deployment picks its restaurant.**
- Env vars `RESTAURANT_CONFIG=hioc` and `RESTAURANT_CONFIG_VERSION=<exact>`. The install step fetches exactly `@prengineerator/hioc-config@<version>` into a fixed alias, using the same `NPM_RC` token.
- That keeps app repos restaurant-neutral.
- The rest of the env is the restaurant's own Supabase keys and secrets. The exact install hook is prototyped in Phase 4.

---

## 6. Which app serves which routes (same-origin, from `servly-server`)

| App | Pages | API routes mounted (handler code is shared, never duplicated) | Vercel crons |
|---|---|---|---|
| **ordering** `hioc.in` | all customer pages; `/order/*`, `/t/*`, `/r/*`, `/feedback/*`; legal pages; module customer pages; **308s for `/staff/**`, `/staff-print/**`, `/owner/**`** (Q7) | public reads (`menu` GET, `store-settings` GET, `announcements` GET); `orders` POST and quote; `orders/[id]` GET and cancel; `payments/*` incl. **webhook**; `auth/customer/*`, `auth/me`, `auth/logout`, **`auth/sms-hook`**; `account/*`; loyalty reads; `coupons/validate`; `reviews`; `feedback/[token]`; module customer APIs; **`webhooks/whatsapp`** and `whatsapp/webhook`; **all `cron/*` routes that pg_cron calls** (`expire-orders`, `feedback-requests`, `marketing-send`) | `expire-orders` (backstop), `expire-points` |
| **staff** `staff.hioc.in` | `/staff/**`, `/staff-print/**`, `/pos.webmanifest`; root `/` rewrites to `/staff` | everything the POS and back office call (~50): orders board and actions, menu CRUD and upload, store-settings PATCH, tables, customers, cash-*, attendance, leave, inventory, kot-routing, print ticket, `device/*`, `auth/login`, `auth/staff/*`, `owner/devices` (counter enrolment), module staff APIs | `close-attendance`, `leave-reminders`, `purge-location` |
| **owner** `owner.hioc.in` | `/owner/**`; root `/` rewrites to `/owner` | `owner/*` (51), plus the shared routes the owner UI calls: `auth/login`, `store-settings`, `orders` GET, `resend-bill`, `cash-days/log`, `cash-drawer/opens`, `cash-expenses/approve`, coupons, announcements, `reviews/[id]`, `passes/plans`, `loyalty/config` | `owner-reports`, `marketing-plan`, `suggest-digest` |

**Rules that preserve today's behaviour:**
- Host-only Supabase cookies, unchanged.
- The `hioc_device` cookie keeps `Domain=hioc.in`, which works because all three apps stay under `hioc.in`.
- Cookie names and localStorage keys come from `brand.slug`, so HIOC's stay identical.
- Server-enforced flags come from the same `hioc-config`, so they can't drift between apps.
- Each app's middleware is the existing gate, narrowed to its own surface.
- Region `icn1` in every app's `vercel.json`.
- All three apps get the same env var **names** as today. Each project gets only the variables its routes need (least privilege).

---

## 7. Environments during the restructure

| Environment | Purpose | Backend | Who can deploy |
|---|---|---|---|
| `hioc-in` (existing Vercel project) | HIOC production, unchanged | production Supabase | merges to `hioc.github.io` `main` (as today) |
| `servly-stage-a` (new Vercel project, Q5) | Phase 2–7 previews of the monorepo | **test** Supabase | ignored-build step: builds only when the lead asks (commit message `[preview]`), never on every push |
| `servly-{ordering,staff,owner}` (new projects, Phase 10) | HIOC from the new repos, preview only | test Supabase, then production at switch-over | PR previews only; production branch `production-hioc`, promoted by you |
| `sample-cafe-*`, `sample-pizza-*` (Phase 11) | plug-and-play proof | their own test Supabase project | once each |
| Local and CI | migrations, RLS, contract tests | local Supabase stack (Docker) in GitHub Actions | every backend PR |

**Never run E2E against `hioc-in` previews.** They carry production database, WhatsApp and Resend credentials.

**Supabase free tier allows 2 active projects, and HIOC uses one.** So one test project is active at a time. Paused projects don't count and can be restored within 90 days. The sequence:
1. `servly-test` for Stages A–C.
2. Pause it, then create `sample-cafe` (Phase 11).
3. Pause that, then create `sample-pizza`.

Migration and RLS tests use the local Docker stack in CI, so they don't need a hosted project.

**Production schema snapshot (input to Phase 1a and 6).**
- Taken with read-only catalog queries through the Supabase connection already available here. This needs no DB password.
- An alternative is a `supabase db dump --schema-only` you run yourself.
- No data is copied.

---

## 8. Registry, versions and tokens

- **Registry.** GitHub Packages npm, `https://npm.pkg.github.com`, scope `@prengineerator`. Installing *any* package from it, public or private, needs a token.
- **Package repos.**
  - `.npmrc` (committed, no token): `@prengineerator:registry=https://npm.pkg.github.com`
  - CI publishes with `GITHUB_TOKEN` (`packages: write`) on merge of the Changesets release PR.
- **Vercel.**
  - The `NPM_RC` env var holds the whole `.npmrc`:

    ```
    @prengineerator:registry=https://npm.pkg.github.com
    //npm.pkg.github.com/:_authToken=<classic PAT with read:packages only>
    ```

  - Add it with `vc env add NPM_RC production` and again for `preview`, pasting the content so line breaks survive.
  - Never commit it. A separate read-only token per restaurant deployment.
- **Versions.**
  - Semver, managed with Changesets.
  - A breaking change means a major version plus a migration note in the CHANGELOG.
  - Apps pin **exact** versions. Renovate groups `@prengineerator/*` into one weekly PR per app repo.
  - The PR must pass app CI and cross-repo E2E, then build a Vercel preview, before merging.
- **Contract tests.**
  - `servly-backend` publishes generated DB types.
  - `servly-core` and `servly-api-client` CI checks their zod schemas against them.
  - A backend change that breaks the contract fails CI before release.
- **HIOC production.** Deploys only from each app repo's protected `production-hioc` branch, promoted manually by you after previews pass.

---

## 9. Free-tier budget

| Resource | Limit | Plan |
|---|---|---|
| Vercel deployments | 100/day per account (HIOC itself used ~40 in 19 h recently) | Restructure work ≤ 20/day. PR-only previews. Ignored-build step skips docs-only, bot and Renovate branches until CI passes. Never more than one app build triggered at a time. |
| Vercel concurrent builds | 1 | A restructure preview can delay a HIOC production deploy by a few minutes. Avoid previews while you're shipping a fix. |
| Vercel crons | 1/day each, hour precision | The current split already fits; nothing new. |
| Vercel runtime logs | 1 hour | Errors also written to a Supabase `app_errors` table (additive migration, Phase 6). |
| Vercel image optimisation | Hobby quota | Pre-optimised static assets; menu photos resized on upload (Phase 7). |
| GitHub Actions | Public repos: free. Private: 2,000 min/month shared | Q1 = public. If private: E2E only on release PRs and nightly; skip-unchanged jobs. |
| GitHub Packages | Public packages: free. Private: 500 MB storage, 1 GB transfer/month | Only `hioc-config` is private and tiny. |
| Supabase | 2 active free projects, 500 MB DB each, pause after 7 idle days | §7 sequence. |

**If you choose all-private repos (Q1):**
- Every commit that should deploy must be authored by the GitHub login linked to the Vercel account. Agents would commit with that identity plus a co-author line.
- Renovate PRs won't preview until a person pushes to them.
- CI must fit 2,000 minutes a month across ~15 repos.

---

## 10. Phase plan: changes to the brief

| Phase | Change | Reason |
|---|---|---|
| 0.5 *(new, optional)* | Owner-approved small fixes on `hioc.github.io` (Q10): S1 first. | Independent of the restructure, and two of them (S1, B1) matter now. |
| 1 → **1a + 1b** | **1a:** production schema snapshot → `servly-test` project → synthetic seed → Auth test numbers with fixed OTPs. **1b:** Playwright E2E and visual snapshots of every HIOC flow, run against **local `next start` of today's code** pointed at `servly-test`. | E2E needs a backend. The only existing previews point at production. |
| 2 | Monorepo skeleton in `servly-monorepo` (Q5). The current app moves into `apps/hioc-legacy` as-is. Previews go to `servly-stage-a` with test credentials. | Keeps HIOC's Vercel project and repo untouched. |
| 3 | Extraction order: config → core (first break the `lib` cycles: orders⇄print, staff⇄desktop, `types`→passes, as move-only splits) → restaurant-config → server → api-client → ui → suggest → (core hooks) → passes. | Adds `servly-server` (Q3); Passes needs hooks first. |
| 4 | Config extraction into `restaurants/hioc`. Prototype the env-selected config install (§5). | |
| 5 | Split into the three apps per §6. Path-form 308s (Q7). Per-app base URLs replace `NEXT_PUBLIC_SITE_URL` for links. Root `headers()` read disappears, which yields the measured static-page win. | |
| 6 | Backend: `0000_baseline` from the snapshot, additive migrations with down files, RLS tests, Realtime publication in SQL, pg_cron templated by app URL, `app_errors` table, purge jobs, `order_kind` lookup table. | |
| 7 | Performance per `PERF.md` (§ "Opportunity list"). Production baseline measured first. | |
| 8–9 | As in the brief, with the repo list in §2. | |
| 10 | New Vercel projects per app, bound to `servly-test`. Full E2E plus visual snapshots vs the baseline. | |
| 11 | Sample cafe and pizza, sequential Supabase projects (§7). | |
| 12 | Switch-over checklist. Includes moving the domains `hioc.in`, `www`, `staff`, `owner` from `hioc-in` to the three projects. Rollback = move them back, because `hioc-in` keeps deploying from `hioc.github.io` `main`. Also covers Razorpay, Meta and Supabase hook URLs, which are **unchanged** because `hioc.in` keeps serving them. | |

**Gate after every phase:**
- The `reviewer` agent checks the diff against the hard constraints.
- Typecheck, lint, unit tests, build, E2E and visual snapshots are all green.
- HIOC's preview matches the baseline.

**Sub-agents** (`.claude/agents/*.md`, all Sonnet, narrow scope): `auditor`, `test-writer`, `package-extractor`, `config-extractor`, `repo-splitter`, `perf-engineer`, `backend-api`, `servly-reviewer` (the name `reviewer` is reserved in this environment).
- At most one agent per file or branch at a time.
- Each task states the files it may and may not touch, its acceptance commands, and "report back, don't merge".
