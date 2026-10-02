# Servly / HIOC performance log

Each phase records its numbers here with the same method. **HIOC's numbers must never get worse.** A change that regresses a metric is reverted.

## Method

| Measure | How |
|---|---|
| Bundle | `next build` route table: First Load JS (gzip) per route, plus static (○) vs dynamic (ƒ) counts and middleware size |
| Lighthouse | v12, mobile (default throttling) and `--preset=desktop`, **median of 3 runs**, same URLs every time |
| Headers | `curl -sSI -H 'Accept-Encoding: br, gzip'`, then gzip only, then no encoding: `content-encoding`, `cache-control`, `x-vercel-cache`, `age` |
| Quality gates | `tsc --noEmit`, `npm run lint`, `npm test` pass and fail counts |

## Baseline: 2026-10-02, commit `d25140c` (before any restructure)

Measured on a copy of the repo with Node 22.22, Next 14.2.35, and CI's placeholder Supabase env.

**Production (`hioc.in`) could not be measured.** The cloud sandbox's network policy denies the host, so the Lighthouse numbers below come from a **local production build with no database and no CDN**. Use them for before/after comparison only, not as real-world scores. A production baseline (PageSpeed Insights on `hioc.in`, plus headers) must be added before Phase 7, either from the owner's machine or after `hioc.in` is allowed in the environment's network settings.

### Build

| Metric | Value |
|---|---|
| `npm ci` / cold `next build` | 17.6 s / 110.2 s |
| Routes (API / pages) | 223 (152 / 71) |
| Static / dynamic / SSG | **2 ○** (`/icon.png`, `/pos.webmanifest`) / **221 ƒ** / 0 ● |
| Shared First Load JS | 87.5 kB gzip |
| Middleware | 83.6 kB (matches every request except `_next/static`, `_next/image`, `favicon.ico`, `images/`, `fonts/`) |
| Client JS on disk | 106 chunks, 2.41 MB raw. CSS: one 65.8 KB file (12.7 kB gzip) plus 2.5 KB Devanagari font CSS |
| Routes over 100 kB / over 150 kB First Load | 33 / 12 |

**Build reliability.** One of two cold builds failed inside `next/font/google`, because builds download fonts from Google at build time. This is a reason to self-host fonts (Phase 7).

### First Load JS (gzip) for key routes

| Route | kB | Route | kB |
|---|---|---|---|
| `/` | 111 | `/staff`, `/staff/orders`, `/staff/orders/new` | 209 |
| `/menu` | 185 | `/staff/settle` | 184 |
| `/checkout` | 182 | `/staff/menu` | 177 |
| `/t/[token]` | 180 | `/owner` | 179 |
| `/order/[id]` | 175 | `/ritual` | 112 |
| `/account/profile` | 156 | `/suggest` | 118 |

**The Supabase browser client accounts for about 63 kB gzip.** It loads on 13 routes, including `/menu`, `/checkout` and `/order/[id]`. On `/menu` it is only needed for the Realtime subscription, and the Realtime publication is empty in production today (see `AUDIT.md` B1).

### Lighthouse: local production build (median of 3)

No DB, no CDN, no brotli, so these are lab numbers only.

| URL | Form | Perf | A11y | BP | SEO | FCP | LCP | TBT | CLS | SI | Transfer | Requests |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/` | mobile | 96 | 96 | 96 | 100 | 0.92 s | 2.81 s | 28 ms | 0 | 0.92 s | 311 KB | 26 |
| `/` | desktop | 100 | 100 | 96 | 100 | 0.27 s | 0.68 s | 0 ms | 0 | 0.30 s | 288 KB | 44 |
| `/menu` | mobile | 93 | 94 | 96 | 100 | 0.91 s | 2.95 s | 49 ms | 0 | 3.63 s | 327 KB | 32 |
| `/menu` | desktop | 91 | 98 | 96 | 100 | 0.26 s | 0.63 s | 0 ms | 0.045 | 3.66 s | 329 KB | 39 |

### Headers (local `next start`, not production)

| Response | `Cache-Control` |
|---|---|
| HTML | `private, no-cache, no-store, max-age=0, must-revalidate` (every page is dynamic) |
| `/_next/static/*`, fonts, `/icon.png` | `public, max-age=31536000, immutable` |
| `/_next/image` | `public, max-age=60, must-revalidate` (default `minimumCacheTTL`) |
| `/api/menu` | none set (`force-dynamic`) |

### Assets

| Asset | Size | Notes |
|---|---|---|
| Images | 13 files, 1.13 MB | No WebP or AVIF. Hero `img.jpeg` is 212 KB (1000×994), duplicated in legacy `images/`. Footer logo is 800×800 / 63 KB, shown at 40×40. |
| Menu photos | n/a | Plain `<img>` from Supabase Storage. Uploads accept up to 2 MB with no resize or conversion. Probably the largest real-world byte cost; not measurable without production access. |
| Fonts | ~56 kB preloaded on every page | `next/font/google`. Noto Sans Devanagari isn't preloaded, but its CSS is render-blocking on every page. |

### Quality gates

| Check | Result |
|---|---|
| `tsc` | pass (37.5 s) |
| lint | pass, 1 warning (`no-img-element`, `MenuItemImage.tsx:30`) |
| vitest | 282 files, 7,430 passed, 1 skipped, 0 failed (50.7 s) |

### Measured experiment (not applied)

Removing the root layout's `headers()` read in a throwaway copy turned **12 routes static**: `/`, `/menu`, `/checkout`, `/about`, `/contact`, `/coffey`, the four legal pages, `/suggest`, and `/_not-found`. Per-app layouts after the split remove the need for that read, so Phase 5 gets this win almost for free.

### Opportunity list (input to Phase 7, in priority order)

1. **Static/ISR customer pages.** Drop the root `headers()` read so HTML is served by the CDN, not a function in Seoul.
2. **Cache public GETs.** `s-maxage` plus `stale-while-revalidate` on `/api/menu`, `/api/store-settings`, `/api/announcements` and `/api/passes/plans`, with on-demand revalidation on menu edits.
3. **Fix the empty Realtime publication.** Then poll intervals can be lengthened, which cuts per-visitor function calls.
4. **Menu photo pipeline.** Resize and convert on upload, then `next/image` with `remotePatterns`, `sizes`, AVIF to WebP to JPEG fallback, and a long `minimumCacheTTL`. Watch Hobby's image quota.
5. **Lazy-load the Supabase realtime client** on `/menu`: about −63 kB.
6. **Cut per-page fetches.** Skip `/api/auth/me` when there is no session cookie, and cache announcements.
7. **Images.** `sizes` on the hero and logos; shrink the logos and favicon.
8. **Fonts and CSS.** Move the Devanagari font to the staff app only, and self-host fonts with `next/font/local`.
9. **Modern `browserslist`** (about 11 KiB of legacy JS), with polyfills only where the target browsers need them.
10. **Slim the POS bundle** (209 kB), and lazy-load the owner marketing tabs and `qrcode`.
