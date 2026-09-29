---
name: code-revamp
description: Audit and revamp the UI/UX and front-end performance of the HIOC cafe platform — the customer ordering site (menu, cart, checkout, order tracking, account), the staff POS/back office (/staff) and the owner dashboard (/owner). Use when asked to "revamp", "polish", "optimise the UI/UX", "check the ordering site", or when the code-revamp GitHub workflow invokes it. Takes optional arguments `surface=customer|staff|owner|all` (default all) and `mode=audit|fix` (default fix).
---

# code-revamp

A repeatable UI/UX + front-end quality pass over the three HIOC surfaces. The
features already exist and are covered by ~200 unit tests; this skill is about
making them **faster to use, clearer, more consistent and lighter** without
changing what they do.

## Arguments

- `surface` — `customer`, `staff`, `owner` or `all` (default `all`).
- `mode`
  - `audit` — read-only. Produce the report (step 4) and stop. No code edits.
  - `fix` (default) — produce the report, then implement the findings that are
    safe (step 5), verify (step 6) and summarise.

## Surface map

| Surface | Who / device | Routes | Components |
|---|---|---|---|
| **customer** | Guests & members on a **phone** | `app/page.tsx`, `app/menu`, `app/checkout`, `app/order/[id]`, `app/order-confirmation/[orderId]`, `app/t/[token]` (table QR), `app/account/**`, `app/rewards`, `app/suggest`, `app/feedback/[token]`, `app/login` | `components/menu`, `components/cart`, `components/checkout`, `components/qr`, `components/account`, `components/suggest`, `components/site`, `components/reviews` |
| **staff** | Cashier/barista on a **counter tablet** (and the Electron POS shell in `desktop/`) | `app/staff/**`, `app/staff-print/**` | `components/staff/**`, `components/print/**` |
| **owner** | Owner on **phone + desktop** | `app/owner/**` | `components/owner/**`, `components/promotions`, `components/reviews/ReviewModeration.tsx` |

Shared building blocks live in `components/ui/` (Button, Card, Input, Select,
Textarea, Modal, Badge, DataTable, EmptyState, Skeleton, Spinner,
ToggleSwitch). Surface detection/links: `lib/routing/surface.ts`,
`components/SurfaceLink.tsx`. The product intent for every screen is in
`docs/REVAMP-REQUIREMENTS.md` and the `docs/PHASE-*-SPEC.md` files — read the
relevant section before changing a screen.

## Design system (do not drift from it)

- Palette in `tailwind.config.ts` / `app/globals.css`: `charcoal`, `tan`,
  `tan-dark`, `tan-darker`, `cream`, `muted`, `line`, `surface`. **Do not add
  new colours.** Tan roles (contrast): `tan` is decoration only (bars, dots,
  borders, focus rings), never text or a fill behind text; `tan-dark` is for
  tan text and tan fills with white text; `tan-darker` is their hover. On the
  charcoal chrome (StaffHeader, SiteFooter, LockScreen) plain `tan` text is
  the one that passes. Replace ad-hoc hex values (`bg-[#f6efe9]`, `border-[#e5e5e5]`,
  `text-[#828282]`) with the named tokens when you touch a file.
- Fonts: DM Sans (`font-sans`) for text; Space Mono (`font-mono`, usually with
  `tabular-nums`) for prices, bill totals, order numbers and codes.
- Shadows `shadow-card` / `shadow-elevated`; animations `animate-fade-in`,
  `animate-scale-in`. Motion is already neutralised by the global
  `prefers-reduced-motion` rule.
- Prefer the `components/ui/*` primitives over hand-rolled buttons, inputs and
  modals. If a primitive is missing a needed variant, extend the primitive.

## Procedure

### 1. Baseline

```bash
npm ci            # if node_modules is missing
npm run lint
npx tsc --noEmit
npm test
```

Record the baseline (warnings, failures). Anything already red is **not**
yours to hide — note it in the report and do not make it worse.

### 2. Walk every screen in scope

For each route in the surface map, read the page and the components it renders
(follow imports; don't stop at the page file). If a dev server can be started
with working Supabase env vars, use Playwright (Chromium is at
`/opt/pw-browsers`) to screenshot at **390×844** (customer phone),
**1024×768** (staff tablet) and **1440×900** (owner desktop). Without env vars,
rely on code reading — don't burn time faking a backend.

### 3. Score against the checklist

**All surfaces**
- Loading, empty and error states exist for every async view (use `Skeleton`,
  `EmptyState`, an inline retry) — no blank screens, no raw error strings.
- Every action gives feedback: pending state on the button, disabled while
  submitting, success/failure message; destructive actions confirm.
- Tap targets ≥ 44×44 px; inputs ≥ 16px font on mobile (prevents iOS zoom);
  correct `type`/`inputMode`/`autoComplete` (`tel`, `numeric`, `name`, `one-time-code`).
- Accessibility (WCAG 2.1 AA): labelled inputs, `aria-live` for status changes,
  `aria-pressed`/`aria-selected` on toggles/tabs, dialogs trap focus and close
  on Esc, colour is never the only signal, contrast ≥ 4.5:1 (`muted` and
  `tan-dark` on white pass; plain `tan` text or white-on-`tan` does **not**).
- Consistency: same spacing scale, headings, button hierarchy (one primary per
  view), currency formatting (`₹` + `font-mono tabular-nums`), date/time in IST.
- Performance: `next/image` with `sizes` for photos, no layout shift, no
  polling faster than needed, intervals/listeners cleaned up, expensive derived
  lists memoised, no client component where a server component would do, no
  unnecessary re-fetch on every render.

**Customer (phone-first)**
- Menu → cart → checkout in as few taps as possible; sticky cart bar visible
  but never covering content (safe-area insets: `pb-[env(safe-area-inset-bottom)]`).
- Category tabs scroll and indicate the active section; search/veg filter easy
  to reach; unavailable items clearly greyed with reason.
- Customisation modal: price updates live, required choices obvious, primary
  CTA always visible on small screens.
- Checkout: minimal fields, inline validation, clear bill breakup (GST,
  discounts, loyalty), obvious pickup/table context, single clear CTA.
- Order tracking: glanceable progress, ETA, what to do next.

**Staff (counter tablet — glanceable, hard to mis-tap)**
- New orders impossible to miss; lanes/cards readable at arm's length
  (large order number, elapsed time, payment state).
- Frequent actions one tap; destructive/irreversible ones separated and
  confirmed; no two primary buttons adjacent.
- POS entry: fast search/quick-add, keyboard friendly, totals always visible.
- Works in landscape tablet and in the Electron shell; no hover-only affordances.

**Owner (decision dashboard)**
- Top of `/owner` answers "how is today going?" in one glance (sales, orders,
  AOV, vs. yesterday/last week) before any detail.
- Tables sortable/filterable (use `DataTable`), numbers right-aligned mono,
  wide tables scroll horizontally on phones instead of breaking layout.
- Navigation between the owner sections is obvious on phone and desktop.

### 4. Report

Write `docs/revamp/CODE-REVAMP-<YYYY-MM-DD>.md` with, per surface:

- A short verdict (what's good, what hurts most).
- A findings table: `ID | Screen / file:line | Problem | Impact (H/M/L) | Effort (S/M/L) | Fix | Status`.
  IDs are `CUS-UX-n`, `STF-UX-n`, `OWN-UX-n`.
- Ordered by impact ÷ effort. Mark each `fixed`, `proposed` or `wontfix (reason)`.

In `audit` mode, stop here.

### 5. Fix (mode=fix)

Implement the findings in impact ÷ effort order. Rules:

- **Presentation and client behaviour only.** Do not change API routes,
  request/response shapes, DB schema/migrations (`supabase/`), pricing/tax
  maths, auth, the order state machine, printing/ESC-POS output, or anything a
  test in `tests/` pins down. If a UX fix needs one of those, list it as
  `proposed` instead.
- No new npm dependencies.
- Keep existing comments' intent; match the surrounding code style (these files
  carry long explanatory comments — add one where a change is non-obvious).
- Keep diffs focused: one concern per commit, message prefixed with the
  surface, e.g. `customer: sticky checkout CTA on small screens`.
- Don't break either URL scheme (`/staff/...` and `staff.<host>/...`) — use
  `SurfaceLink`/existing helpers for internal links.

### 6. Verify

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build     # needs NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY; placeholders are fine for a compile check
```

Everything that was green at baseline must still be green. Re-read the diff
adversarially (hydration mismatches, missing `'use client'`, keys, effects
without cleanup, mobile overflow) before committing.

### 7. Summarise

Reply (or, in CI, write the PR body / issue) with: the report path, what was
fixed per surface, what is proposed and needs a decision, and the verification
results.
