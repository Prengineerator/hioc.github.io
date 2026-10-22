# Splitting hioc.in into three Vercel projects (customer / staff / owner)

Research and implementation plan, 2026-10-22. Written so that a cheaper
implementation agent (Sonnet/Haiku class) can do every code task without
re-doing the research, and so the owner can see which steps are theirs.

- **§1–§4** are for the owner: what we found, whether a split spreads the load,
  and the decision to make before any work starts.
- **§5** is the target setup.
- **§6** lists the agent tasks (T1–T5). Each one is a single PR with pure
  functions and unit tests. None of them needs Vercel, DNS or secret access.
- **§7** is the owner's runbook (H1–H9): Vercel dashboard and domain steps.
  An agent must not do these.
- **§8** lists the gotchas. **§9** lists the sources.

---

## 1. Short answer

| Question | Answer |
|---|---|
| How many projects does the free (Hobby) plan allow? | **200 per account.** The Hioc team uses 3 today (`hioc-in`, `studio-vastyukt`, `studio-vastyukt-admin`). A split adds 2, for 5 in total. Hobby also allows up to 10 projects per Git repository and 50 domains per project. The project count is not a constraint. |
| Does splitting into 3 projects divide the load? | **No, not in any way that helps.** On Hobby the free allowance (1M edge requests, 100 GB transfer, 1M function calls, 4 CPU-hours a month) is **one pool for the whole account**. Three projects draw from the same pool, so a split does not triple the free tier. Performance does not depend on the split either. Vercel functions scale per request, and a customer rush does not queue the POS behind it. The one thing all three surfaces really share is **Supabase**, and a Vercel split leaves that untouched. |
| Then what *does* a split buy? | Separate deploys and rollbacks: you could roll back the customer site without touching the POS mid-service. You also get per-surface logs and usage graphs, and later the option to give each project fewer secrets. These are reliability and isolation wins, not capacity wins. |
| What does it cost on Hobby? | Hobby has **1 build slot**, so every merge to `main` builds 3 times, one after another. All three projects share the **100 deployments/day** cap, and a build that Vercel skips still counts towards it. Every environment variable has to be kept on 3 projects. Crons must be pinned to one project, or each would run 3 times. |
| Bigger issue found | **Hobby is licensed for non-commercial, personal use only.** A café site that takes orders and payments is commercial use under Vercel's fair-use rules. On Hobby, an account that goes over its allowance gets its features **paused for up to 30 days**. That would take the customer site, the POS and the owner dashboard down together. |

**Recommendation.** Do not split *for load*. If load or limits are the worry,
first open Vercel → Usage and see how close the account is to the Hobby caps.
Then move the team to **Pro** ($20/month for one seat, which includes $20 of
usage credit). Pro covers commercial use and includes 10× the edge requests
and 10× the transfer. It never pauses: usage beyond the credit is billed, and
an optional spend cap can limit that. Pro also has 12 build slots and allows
6,000 deployments a day. If you also want the isolation benefits above, do
the split **on Pro**, following this plan. Task T1 fixes three routing bugs
that exist today. It is worth doing even if you never split.

---

## 2. What was measured on the live account (2026-10-22)

These facts came from the Vercel API through the connected Vercel MCP:

- Team **Hioc** is on **Hobby**. Billing data answered "costs not found",
  and the observability query answered "available on Pro and Enterprise
  plans". The repo agrees: `docs/MARKETING-AGENT-SPEC.md` F9 says "Vercel
  crons are daily-only on this plan".
- Project `hioc-in` (Next.js 14, Node 24.x, functions in `icn1`) serves
  `hioc.in`, `www.hioc.in`, `staff.hioc.in` and `owner.hioc.in`. The two
  subdomains are already attached and verified.
- Traffic over the last 30 days: **9,093 page views from 639 visitors** across
  all three surfaces (Web Analytics). Edge-request and CPU totals need
  Observability Plus, which Pro provides. On Hobby, open Vercel → **Usage**
  in the dashboard to see them.
- Deployments: **67 in the last 14 days**, with a peak of **29 on a single
  day** (2026-10-19) and at most 4 of those to production. If each push
  touched three projects, that peak day would have used about 87 of the
  100/day Hobby cap.
- Vercel is not the only scheduler. Besides the 10 Vercel crons in
  `vercel.json`, Supabase `pg_cron` calls `https://hioc.in/api/cron/...`:
  `expire-orders` 4×/day and `marketing-send` every 5 minutes. Meta calls
  `https://hioc.in/api/webhooks/whatsapp`, and Supabase Auth calls
  `https://hioc.in/api/auth/sms-hook`.

## 3. Vercel limits that matter here

| | Hobby (free) | Pro |
|---|---|---|
| Commercial use | **Not allowed** | Allowed |
| Price | Free | $20 per seat per month, includes $20 usage credit |
| Projects | 200 per account | More than enough |
| Projects per Git repo | 10 | More than enough |
| Deployments created per day | **100**, shared by all projects; skipped builds count | 6,000 |
| Concurrent builds | **1**; skipped builds still hold the slot briefly | 12 |
| Domains per project | 50 | No hard limit |
| Cron jobs | 100 per project, **once a day**, ±59 min | 100 per project, down to every minute |
| Edge requests included per month | 1,000,000 | 10,000,000 |
| Fast data transfer included per month | 100 GB | 1 TB |
| Function invocations included per month | 1,000,000 | Billed from the credit |
| Active CPU included per month | 4 CPU-hours | Billed from the credit |
| Going over | **Feature paused until the 30-day window resets** | Billed; a spend cap is optional |
| Allowance shared across projects? | **Yes, one pool per account** | Yes, one pool per team |

Third-party guides disagree on some of these figures. The Vercel docs pages
in §9 are the authority, and prices change, so check vercel.com/pricing
before deciding.

## 4. Decision gate (owner)

Pick one of these before handing any task to an agent:

1. **Don't split. Do T1 only.** It fixes today's subdomain link and print
   bugs; see T1. Upgrade to Pro if the commercial-use rule or the pause
   risk concerns you. *(Recommended if the goal was "more capacity".)*
2. **Split on Pro.** Do T1–T4, then the runbook in §7, using the Pro steps.
   *(Recommended if the goal is isolation: separate deploys, rollbacks and
   logs per surface.)*
3. **Split on Hobby.** Do T1–T5 (T5 keeps the 1 build slot and the 100/day
   cap under control), then §7, using the Hobby steps. This works
   technically, but it leaves the commercial-use and pause risks in place.

---

## 5. Target setup

There is **one repo and one Next.js app, built three times.** Nothing moves
between folders. The only difference between the three builds is the
environment variable `HIOC_SURFACE`.

| Vercel project | Domains | `HIOC_SURFACE` (Production only) | Serves | Sends elsewhere |
|---|---|---|---|---|
| `hioc-in` (existing) | `hioc.in`, `www.hioc.in` | `main` | Customer pages; all `/api/**`, including the main-only routes below | `/staff/**` and `/staff-print/**` → 307 to staff.hioc.in; `/owner/**` → 307 to owner.hioc.in |
| `hioc-staff` (new) | `staff.hioc.in` | `staff` | `/staff/**`, `/staff-print/**`, shared `/api/**` | Customer pages → hioc.in; owner pages → owner.hioc.in; main-only API → 404 |
| `hioc-owner` (new) | `owner.hioc.in` | `owner` | `/owner/**`, shared `/api/**` | Customer pages → hioc.in; staff pages → staff.hioc.in; main-only API → 404 |

The **main-only API** routes are served only by `hioc-in`, because outside
callers already use those exact URLs and cron routes must never run three
times:

- `/api/cron/**`
- `/api/webhooks/**`
- `/api/payments/webhook`
- `/api/auth/sms-hook`

**When `HIOC_SURFACE` is unset, behaviour is exactly as today.** We call this
"all" mode. It covers local dev, every preview deployment, and the state
before the owner flips the switch, so merging the code changes nothing on
its own.

Why build the same app three times instead of a real monorepo split
(`apps/customer`, `apps/staff`, `apps/owner`, `packages/shared`)? The monorepo
route is weeks of moving almost every import, and it is not safe for a cheap
agent. The env-var route takes four small PRs, keeps every route and test
working, and is undone by unsetting one variable and moving two domains back.

---

## 6. Agent tasks

### Rules for every task (paste these into the agent's prompt)

- Work on a new branch. Don't push to `main`.
- Run all four checks before pushing and paste the results into the PR:
  `npm ci --no-audit --no-fund && npm run lint && npx tsc --noEmit && npm test && npm run build`.
  These are the same commands `.github/workflows/code-revamp.yml` runs.
- `middleware.ts` runs on the **Edge runtime**. Nothing it imports, directly
  or through `lib/routing/*`, may import a Node built-in (`crypto`, `fs`,
  …). See the comment at the top of `middleware.ts`.
- Next.js inlines a `NEXT_PUBLIC_*` variable only where code reads it
  **literally**, as in `process.env.NEXT_PUBLIC_STAFF_ORIGIN`. Never build
  the name dynamically.
- Match the existing comment style: explain *why*, in full sentences.
- Don't touch Vercel settings, DNS, Supabase or secrets. Those steps belong
  to the owner (§7).

Prompt template:

> Read `docs/VERCEL-SPLIT-PLAN.md` §5 and §6 (the rules), then implement task
> **T<n>** exactly as written. Change only the files that task lists. Add the
> listed tests. Run the four checks and paste their output into the PR
> description. If anything in the task doesn't match the code, stop and say
> what didn't match. Don't improvise.

---

### T1. Make cross-surface links and `/staff-print` work on the subdomains

> **Done** on branch `claude/relaxed-volta-irgkra` (commit 104c2ad, "Subdomains: send
> cross-surface links to the right host, serve /staff-print"). Skip to T2; the
> `surfaceOfPath` and `surfaceOrigin` helpers T2 needs exist.

**This fixes bugs that are live today, whatever the split decision.** We
confirmed each one by running `lib/routing/surface.ts` against these inputs:

| On | Link / URL | Today it becomes | Result |
|---|---|---|---|
| owner.hioc.in | "Staff board" nav item (`/staff`, `components/owner/OwnerHeader.tsx:60`) | `/owner/staff` | Opens the owner **Team** page, not the staff board |
| owner.hioc.in | "the staff portal" (`/staff/login`, `app/owner/login/page.tsx:125`) | `/owner/staff/login` | 404 |
| staff.hioc.in (desktop POS) | driver print `https://staff.hioc.in/staff-print/<id>/<type>?silent=1` (`lib/desktop/printExecutor.ts:124-125`) | `/staff/staff-print/...` | 404, so printers set to system + driver mode print a 404 page |

**Files:** `lib/routing/surface.ts`, `app/owner/login/page.tsx`,
`app/owner/layout.tsx`, `tests/surfaceRouting.test.ts`.

**1. `lib/routing/surface.ts`: add these two exports.**

```ts
function isUnder(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/** Which surface a canonical path belongs to; null for host-agnostic paths (API, assets). */
export function surfaceOfPath(pathname: string): Surface | null {
  if (isHostAgnostic(pathname)) return null;
  // /staff-print lives outside app/staff/** (see its page) but is the POS's.
  if (isUnder(pathname, '/staff') || isUnder(pathname, '/staff-print')) return 'staff';
  if (isUnder(pathname, '/owner')) return 'owner';
  return 'main';
}

/** Public origin of a surface, no trailing slash. Each env read is literal so Next inlines it. */
export function surfaceOrigin(surface: Surface): string {
  const raw =
    surface === 'staff'
      ? process.env.NEXT_PUBLIC_STAFF_ORIGIN
      : surface === 'owner'
        ? process.env.NEXT_PUBLIC_OWNER_ORIGIN
        : process.env.NEXT_PUBLIC_MAIN_ORIGIN;
  const fallback =
    surface === 'staff' ? 'https://staff.hioc.in'
    : surface === 'owner' ? 'https://owner.hioc.in'
    : 'https://hioc.in';
  return (raw || fallback).replace(/\/+$/, '');
}
```

**2. `rewriteForSurface`.** Insert the new check directly after the existing
"Already prefixed" `return null`:

```ts
if (surface === 'staff' && isUnder(pathname, '/staff-print')) return null;
```

The middleware auth gate already treats `/staff-print` as a staff route,
because `'/staff-print'.startsWith('/staff')` is true. No gate change is
needed.

**3. `hrefForSurface`.** Keep its signature and its `main` behaviour. Replace
the body with:

```ts
export function hrefForSurface(surface: Surface, href: string): string {
  if (surface === 'main') return href;
  // Only app-absolute paths are ours to rewrite: leave '#x', '?a=b', 'https://…', '//host' alone.
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const path = href.split(/[?#]/, 1)[0];
  const target = surfaceOfPath(path);
  if (target === null) return href; // /api, assets
  if (target === surface) return stripPrefix(surface, href);
  // Cross-surface. A relative link would be prefixed with THIS surface and 404
  // (owner.hioc.in/staff/login → /owner/staff/login), so send it to the other site.
  const local = target === 'main' ? href : stripPrefix(target, href);
  return `${surfaceOrigin(target)}${local}`;
}

function stripPrefix(surface: Exclude<Surface, 'main'>, href: string): string {
  const prefix = SURFACE_PREFIX[surface];
  if (href === prefix) return '/';
  if (href.startsWith(`${prefix}/`)) return href.slice(prefix.length) || '/';
  return href;
}
```

`stripPrefix` must behave exactly as the old body did, so every existing
same-surface test keeps passing unchanged.

Rewrite the file's header comment and the `hrefForSurface` doc comment. The
paragraph "A cross-surface link (staff → owner) keeps its full path and is
served by the main domain's routing" is wrong: a relative link resolves on
the *current* host. Replace it with the new rule.

**4. `app/owner/login/page.tsx`.** Change `import Link from 'next/link'` to
`import { SurfaceLink as Link } from '@/components/SurfaceLink'`, so the
"staff portal" link becomes `https://staff.hioc.in/login` on owner.hioc.in.
First check that no other `Link` in that file depends on plain `next/link`
behaviour. If one does, import `SurfaceLink` under its own name and use it
only for that link.

**5. `app/owner/layout.tsx:27`.** Change `redirect('/staff/login')` to
`redirect('/owner/login')`. That matches the middleware: "an expired owner
session lands back on the owner login". `/owner/login` works on both hosts.

**6. Check the call sites.** Run `grep -rn "useSurfaceHref" components app`.
For every `router.push(toHref(x))` or `router.replace(toHref(x))` where `x`
can point at a *different* surface, use `window.location.assign(...)` for an
absolute result, because the App Router's `push` is meant for same-origin
paths. If every `x` is same-surface, change nothing and say so in the PR.

**7. `tests/surfaceRouting.test.ts`.**

The existing cases "leaves CROSS-surface links whole" and "leaves customer
paths whole" encode the bug. Replace them with:

```ts
it('sends CROSS-surface links to the other site — relative ones 404 here', () => {
  expect(hrefForSurface('owner', '/staff')).toBe('https://staff.hioc.in/');
  expect(hrefForSurface('owner', '/staff/login')).toBe('https://staff.hioc.in/login');
  expect(hrefForSurface('owner', '/staff/login?next=/staff')).toBe('https://staff.hioc.in/login?next=/staff');
  expect(hrefForSurface('staff', '/owner/attendance')).toBe('https://owner.hioc.in/attendance');
});
it('sends customer paths from a subdomain to the main site', () => {
  expect(hrefForSurface('staff', '/menu')).toBe('https://hioc.in/menu');
  expect(hrefForSurface('staff', '/privacy')).toBe('https://hioc.in/privacy');
});
```

Add these:

- `hrefForSurface('staff', '/staff-print/abc/kot?silent=1')` →
  unchanged (same surface, no prefix to strip).
- These stay unchanged on `staff`: `'/api/orders'`, `'#top'`, `'?tab=x'`,
  `'https://example.com/x'` and `'//evil.com/x'`.
- `rewriteForSurface('staff', '/staff-print/abc/kot')` → `null`.
- `rewriteForSurface('owner', '/staff-print/abc/kot')` →
  `'/owner/staff-print/abc/kot'`. This is the existing behaviour; only the
  staff surface owns it.
- `surfaceOfPath`, as a table:
  - `'/staff'` and `'/staff/orders'` → staff
  - `'/staff-print/1/kot'` → staff
  - `'/staffing'` → main
  - `'/owner'` and `'/owner/payroll'` → owner
  - `'/'`, `'/menu'` and `'/login'` → main
  - `'/api/orders'`, `'/_next/static/x.js'` and `'/pos.webmanifest'` → null
- `surfaceOrigin` with `NEXT_PUBLIC_STAFF_ORIGIN='https://staff.example.com/'`
  → `'https://staff.example.com'`. Set and restore it with `vi.stubEnv` and
  `vi.unstubAllEnvs`.
- `hrefForSurface('main', '/staff/orders')` → unchanged. This test already
  exists; keep it.

**Done when** the checks are green, the cases above pass, and no other test
changed. If another test fails, report it rather than editing it.

---

### T2. The surface lock in middleware (dormant until `HIOC_SURFACE` is set)

**Files:** new `lib/routing/deployment.ts`, `middleware.ts`, new
`tests/deploymentLock.test.ts`, new `tests/middlewareDeploymentLock.test.ts`.
This task depends on T1, because it uses `surfaceOfPath` and
`surfaceOrigin`.

**`lib/routing/deployment.ts`.** Keep it pure and Edge-safe. It may import
only `./surface`.

```ts
import { hrefForSurface, surfaceOfPath, surfaceOrigin, type Surface } from './surface';

/** Which surface THIS Vercel project serves. 'all' = unset = today's single-project behaviour. */
export type Deployment = Surface | 'all';

/** Read on every call (not a module-level const) so tests can change it. */
export function deploymentFromEnv(raw: string | undefined = process.env.HIOC_SURFACE): Deployment {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'main' || v === 'staff' || v === 'owner' ? v : 'all';
}

/**
 * Served only by the main project. Outside callers already use these exact
 * hioc.in URLs: Vercel Cron, Supabase pg_cron, Meta, the payment provider and
 * Supabase Auth. A cron served by all three projects would run three times.
 */
export const MAIN_ONLY_API_ROOTS = [
  '/api/cron',
  '/api/webhooks',
  '/api/payments/webhook',
  '/api/auth/sms-hook',
] as const;

export type LockDecision =
  | { kind: 'serve' }
  | { kind: 'redirect'; location: string }
  | { kind: 'not_found' };

export function lockRequest(deployment: Deployment, canonicalPath: string, search: string): LockDecision {
  if (deployment === 'all') return { kind: 'serve' };
  const mainOnly = MAIN_ONLY_API_ROOTS.some(
    (r) => canonicalPath === r || canonicalPath.startsWith(`${r}/`),
  );
  if (mainOnly) return deployment === 'main' ? { kind: 'serve' } : { kind: 'not_found' };
  const owner = surfaceOfPath(canonicalPath);
  if (owner === null || owner === deployment) return { kind: 'serve' };
  const local = owner === 'main' ? canonicalPath : hrefForSurface(owner, canonicalPath);
  return { kind: 'redirect', location: `${surfaceOrigin(owner)}${local}${search}` };
}
```

**`middleware.ts`.** Add the lock directly after
`const pathname = rewritten ?? request.nextUrl.pathname;` and before
`requestHeaders` is built. It must run before the auth gate, so a request for
another surface never touches Supabase.

```ts
const lock = lockRequest(deploymentFromEnv(), pathname, request.nextUrl.search);
if (lock.kind === 'redirect') return NextResponse.redirect(lock.location, 307);
if (lock.kind === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
```

Use **307, not 308.** Browsers cache a 308 permanently, which would make a
rollback (§7, H9) sticky. Add a comment that says so.

**`tests/deploymentLock.test.ts`.** Test the pure function:

- `deploymentFromEnv`:
  - `'staff'` → staff; `' Owner '` → owner; `'main'` → main
  - `undefined`, `''` and `'bogus'` → all
- `'all'` serves `/`, `/staff/orders`, `/owner` and `/api/cron/expire-orders`.
- `main`:
  - serves `/`, `/menu`, `/login`, `/api/orders` and `/api/cron/expire-orders`
  - `/staff/orders` with `?x=1` → `https://staff.hioc.in/orders?x=1`
  - `/staff` → `https://staff.hioc.in/`
  - `/staff-print/1/kot` with `?silent=1` →
    `https://staff.hioc.in/staff-print/1/kot?silent=1`
  - `/staff/reset-password` with `?token_hash=abc&type=recovery` →
    `https://staff.hioc.in/reset-password?token_hash=abc&type=recovery`
  - `/owner/payroll` → `https://owner.hioc.in/payroll`
- `staff`:
  - serves `/staff/orders`, `/staff-print/1/kot`, `/api/orders`,
    `/api/payments/verify` and `/pos.webmanifest`
  - returns not_found for `/api/cron/expire-orders`,
    `/api/webhooks/whatsapp`, `/api/payments/webhook` and
    `/api/auth/sms-hook`
  - `/owner/devices` → `https://owner.hioc.in/devices`
  - `/` → `https://hioc.in/`
  - `/menu` → `https://hioc.in/menu`
- `owner` mirrors `staff`. Also check that `/api/cronx` is *served*, because
  matching is root-based, not prefix-based.

**`tests/middlewareDeploymentLock.test.ts`.** Copy the mocking pattern from
`tests/middlewarePinSwitch.test.ts` (mock `@supabase/ssr` and `@/lib/flags`,
then `await import('@/middleware')`). Use `vi.stubEnv('HIOC_SURFACE', …)` per
test and `vi.unstubAllEnvs()` in `afterEach`.

- Unset: `https://hioc.in/menu` gets no `location` header.
- `main`: `https://hioc.in/staff/orders` → status 307, location
  `https://staff.hioc.in/orders`.
- `staff`: `https://staff.hioc.in/api/cron/expire-orders` → 404.
- `staff`: `https://staff.hioc.in/orders`, signed out → still redirects to
  the staff login. The lock serves it, and the existing gate takes over.

**Done when** the checks are green and every existing middleware test passes
unchanged. That proves "all" mode is a no-op.

---

### T3. Customer links in messages must never point at a staff or owner host

`lib/url.ts` `absoluteUrl()` and `statusLink()` in
`lib/notifications/templates.ts` fall back to
`VERCEL_PROJECT_PRODUCTION_URL` when `NEXT_PUBLIC_SITE_URL` is unset. In the
`hioc-staff` project that variable is `staff.hioc.in`, so a WhatsApp bill
sent from the POS would link to `staff.hioc.in/order/<id>` and 404 for the
customer. The runbook also sets the variable (H3), but a missed variable
must not quietly break customer bills.

**Files:** `lib/url.ts`, `lib/notifications/templates.ts`, `tests/url.test.ts`.

- In `absoluteUrl`, the base becomes:
  1. `NEXT_PUBLIC_SITE_URL`, if set;
  2. otherwise, if `deploymentFromEnv()` is `'staff'` or `'owner'`,
     `surfaceOrigin('main')`;
  3. otherwise, the existing `VERCEL_PROJECT_PRODUCTION_URL` fallback;
  4. otherwise, `''`.
- Change `statusLink(order)` to `return absoluteUrl(`/order/${order.id}`);`.
  The precedence is identical today, and this keeps the two from drifting.
  Update the comment that says they "match".
- Add tests to `tests/url.test.ts`:
  - `HIOC_SURFACE=staff`, `NEXT_PUBLIC_SITE_URL` unset,
    `VERCEL_PROJECT_PRODUCTION_URL=staff.hioc.in` →
    `absoluteUrl('/order/1')` is `https://hioc.in/order/1`.
  - With `NEXT_PUBLIC_SITE_URL` set → it wins.
  - Unset `HIOC_SURFACE` → today's behaviour.

  Use `vi.stubEnv` and `vi.unstubAllEnvs`.

**Done when** the checks are green.

---

### T4. Documentation and environment example

**Files:** `.env.local.example`, `README-MVP.md`.

- In `.env.local.example`, add a commented block next to the
  `NEXT_PUBLIC_SITE_URL` block:
  - `HIOC_SURFACE=` — leave it unset locally. Each Vercel project sets it
    (Production only) to `main`, `staff` or `owner`. Explain "all" mode in
    one line.
  - The three optional origin overrides, for anyone running the subdomains
    locally:
    - `NEXT_PUBLIC_MAIN_ORIGIN=https://hioc.in`
    - `NEXT_PUBLIC_STAFF_ORIGIN=https://staff.hioc.in`
    - `NEXT_PUBLIC_OWNER_ORIGIN=https://owner.hioc.in`
- In `README-MVP.md`, add a short "Three Vercel projects" paragraph to the
  deploy section. Link to this doc and state the rule that matters most:
  **an environment variable that other docs say to "set in Vercel" must be
  set on every project that serves the route using it.** Crons, webhooks
  and the SMS hook live on `hioc-in`.

**Done when** the checks are green. The build check matters here, since
docs-only PRs still run it.

---

### T5. GitHub Actions deploy for `hioc-staff` and `hioc-owner` (Hobby only; skip it on Pro)

On Hobby, the staff and owner projects should **not** be Git-connected. If
they were, every push to any branch would create 2 extra deployments (skipped
or not, they count towards 100/day) and would queue on the single build slot.
This workflow builds them on GitHub's runners instead, only on `main`, and
uploads the finished output. `--prebuilt` deployments don't use Vercel's
build slot.

**File:** new `.github/workflows/deploy-surfaces.yml`.

```yaml
name: Deploy staff + owner surfaces
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: deploy-surfaces-${{ github.ref }}
  cancel-in-progress: false   # never abandon a half-finished production deploy
jobs:
  deploy:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false        # one surface failing must not cancel the other
      matrix:
        include:
          - surface: staff
            project_secret: VERCEL_PROJECT_ID_STAFF
          - surface: owner
            project_secret: VERCEL_PROJECT_ID_OWNER
    env:
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets[matrix.project_secret] }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm i -g vercel@latest
      - run: vercel pull --yes --environment=production --token=${{ secrets.VERCEL_TOKEN }}
      - run: vercel build --prod --token=${{ secrets.VERCEL_TOKEN }}
      - run: vercel deploy --prebuilt --prod --token=${{ secrets.VERCEL_TOKEN }}
```

- Pin the GitHub actions and the `vercel` version the way
  `.github/workflows/pos-desktop-release.yml` pins its tools. Read that file
  first and follow its style.
- Give it a header comment like the other workflows have. Say what the
  workflow does, why it exists (the Hobby build slot and deployment cap), and
  the one-time setup: repository secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
  `VERCEL_PROJECT_ID_STAFF` and `VERCEL_PROJECT_ID_OWNER`.
- `vercel pull` writes `.vercel/`, which is already in `.gitignore`. Don't
  commit anything it creates.
- If the repo is private, each merge to `main` costs about 2 × the build time
  in Actions minutes. Note that in the header comment.

**Done when** the YAML lints (`npx --yes yaml-lint .github/workflows/deploy-surfaces.yml`
or an equivalent check) and the PR says which secrets the owner must add.
The agent cannot test it end-to-end, so the PR must say so.

---

## 7. Owner runbook (do not hand these to an agent)

Each step is reversible. Run them in this order. Steps that move a domain
cause up to a minute of 404s on that subdomain, so do them before the café
opens or after it closes.

**H1. Ship T1–T4.** Merge them. `hioc-in` deploys with `HIOC_SURFACE` unset,
so it runs in "all" mode. Check that hioc.in, staff.hioc.in and
owner.hioc.in behave as before. The owner header's "Staff board" should now
open staff.hioc.in.

**H2. (Pro path) Upgrade.** Go to Vercel → Hioc team → Settings → Billing and
choose Pro. Do this before creating projects, so the build slots and
deployment cap are already in place.

**H3. Create `hioc-staff` and `hioc-owner`.**

- Pro: Add New → Project → import the same GitHub repo. Keep the framework
  as Next.js and the root directory as the repo root. Set Node.js to 24.x to
  match `hioc-in`. Then go to Settings → Git → **Ignored Build Step**, choose
  "Only build production" or use the custom command
  `[ "$VERCEL_ENV" != "production" ]`. That way feature-branch pushes still
  build only `hioc-in`, whose previews run in "all" mode.
- Hobby: create the two projects **without** a Git connection, for example
  `vercel project add hioc-staff --scope hioc`, and set Node.js to 24.x.
  Then add the four GitHub secrets that T5 needs. Get the project IDs from
  each project's Settings → General.
- Environment variables, for both projects: copy every variable from
  `hioc-in` (Production and Preview). There are three exceptions:
  - **Don't copy `CRON_SECRET`.** Crons stay on `hioc-in`, and the cron
    routes fail closed without it, which is a second guard behind T2.
  - Set `NEXT_PUBLIC_SITE_URL=https://hioc.in` in every environment.
  - Set `HIOC_SURFACE` to `staff` or `owner` in **Production only**.

  If the team settings offer shared environment variables, link them to all
  three projects instead of copying.
- Settings → **Cron Jobs → Disable** on both new projects. `vercel.json` is
  shared, so they would otherwise schedule the same 10 crons. T2 already
  answers those with 404s, but disabling them keeps the logs clean.

**H4. First deploy, and a check before any domain moves.** Deploy each new
project to production: Pro does this from its first `main` build; Hobby
runs T5's workflow from the Actions tab. Open each project's
`*.vercel.app` production URL while signed in to Vercel and check:

- `/staff/login` (or `/owner/login`) renders;
- `/menu` redirects to `https://hioc.in/menu`;
- `/api/cron/expire-orders` returns 404.

**H5. Move `owner.hioc.in` first.** It is used less, so it is the safer one
to start with. Go to `hioc-in` → Settings → Domains, remove
`owner.hioc.in`, then add it at `hioc-owner` → Settings → Domains. DNS
doesn't change, because both projects are in the same team. Wait for "Valid
Configuration", then sign in at owner.hioc.in and open three tabs.

**H6. Move `staff.hioc.in`.** Do the same between `hioc-in` and
`hioc-staff`, with the café closed. Then check:

- staff sign-in;
- PIN switch on an enrolled counter. The device cookie is scoped to
  `hioc.in`, so enrolment survives the move;
- a test order;
- one print in raw mode and one in driver mode;
- a WhatsApp bill: its link must open `hioc.in/order/...`.

**H7. Turn on the main lock.** Set `HIOC_SURFACE=main` on `hioc-in`
(Production) and redeploy. After that, `hioc.in/staff/...` and
`hioc.in/owner/...` redirect to the subdomains, keeping the path and query.

**H8. Check the outside integrations. They should need no change.**

- Meta's webhook, the payment webhook, the Supabase SMS hook and both
  `pg_cron` jobs all point at `https://hioc.in/api/...`, which is still
  served by `hioc-in`.
- In Supabase → Auth → URL Configuration, the redirect URLs must include
  `https://staff.hioc.in/**` and `https://owner.hioc.in/**`. They probably
  already do, because the subdomains work today.
- The desktop POS already loads `https://staff.hioc.in`.
- Any POS web app installed from `hioc.in/staff` should be reinstalled from
  `staff.hioc.in`.
- The next morning, check `hioc-in` → Logs: the daily crons should have run
  there, once.

**H9. Rollback (any step).**

1. Unset `HIOC_SURFACE` on `hioc-in` and redeploy.
2. Move `staff.hioc.in` and `owner.hioc.in` back to `hioc-in`.

`hioc-in` in "all" mode serves all three surfaces exactly as before H1. The
lock uses 307 redirects, so browsers have nothing cached to undo.

---

## 8. Gotchas

1. **The free allowance is shared.** A split doesn't add capacity. Watch
   Vercel → Usage. The 5-minute `marketing-send` job is a steady consumer.
   The staff screens' polling used to be the biggest one; it now slows to a
   safety net while realtime is live (`lib/realtime/hooks.ts`).
2. **Each surface serves its own copy of `/api`.** Every merge to `main`
   must reach **all three** projects. If one build fails, the surfaces run
   different code against the same database. After every merge, check all
   three deployments are green, especially for PRs with a
   `supabase/*.sql` migration.
3. **Environment variables drift.** Many docs say "set X in Vercel and
   redeploy", for example `docs/WHATSAPP-BILL-TEMPLATE.md` and
   `docs/MARKETING-AGENT-SETUP.md`. After the split, that means every project
   that serves the route reading X. If unsure, set it on all three.
4. **Crons run per project.** T2 and H3 (disable crons) handle this. Never
   set `CRON_SECRET` on the staff or owner projects.
5. **On Hobby, a skipped build still costs a deployment and the build
   slot.** That is why T5 exists.
6. **Rollback on Hobby is limited.** Instant Rollback there goes back to the
   previous production deployment only; Pro can roll back to any.
7. **Cold starts.** The quieter owner project may see slightly more cold
   starts than when it shared warm functions with the customer site. This
   shouldn't be noticeable at the café's traffic.
8. **Speed Insights on Hobby covers 1 project.** Web Analytics must be
   enabled on each new project, or it stops counting staff and owner views.

---

## 9. Sources

- Vercel limits (projects, deployments/day, concurrent builds, domains): https://vercel.com/docs/limits
- Vercel Hobby plan (included usage; pause after going over): https://vercel.com/docs/plans/hobby
- Fair use guidelines (Hobby is non-commercial only): https://vercel.com/docs/limits/fair-use-guidelines
- Cron jobs, usage and pricing (Hobby: 100 per project, once a day): https://vercel.com/docs/cron-jobs/usage-and-pricing
- Pro plan ($20 credit, 1 TB transfer, 10M edge requests): https://vercel.com/docs/plans/pro
- Builds (concurrency, the Ignored Build Step uses a slot): https://vercel.com/docs/builds
- Monorepos (skip unaffected projects needs npm/pnpm/yarn workspaces): https://vercel.com/docs/monorepos
- Skipped builds count as deployments (community answer): https://community.vercel.com/t/do-cancelled-builds-count-towards-the-deployment-limits-count/3747
- Programmatic config, if per-project crons are ever needed: https://vercel.com/docs/project-configuration/vercel-ts
