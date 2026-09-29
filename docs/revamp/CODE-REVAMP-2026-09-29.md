# Code revamp — UI/UX pass (2026-09-29)

Run of `.claude/skills/code-revamp` with `surface=all mode=fix`.
Scope: customer ordering site, staff POS / back office (`/staff`), owner dashboard (`/owner`).

**Baseline (before):** lint clean except 1 existing `<img>` warning · `tsc` clean · 188 files / 3,965 tests passing · `next build` OK.
**After:** same results. No API, schema, pricing, auth, state-machine or print changes; no new dependencies.

Each finding has an Impact (H/M/L), an Effort (S/M/L) and a status: `fixed`, `proposed` (needs a decision) or `wontfix`.

---

## Shared

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| SHR-UX-1 | `components/ui/Modal.tsx` | Dialogs never moved focus in, didn't trap Tab and didn't restore focus on close. Keyboard and screen-reader users ended up "behind" the overlay. Affects every modal on all three surfaces. | H | S | New `components/ui/useDialogBehavior.ts` (Escape, scroll lock, focus in / trap / restore; no keyboard pop-up on touch screens; never focuses a destructive button first). Close button is now 44px. | fixed |
| SHR-UX-2 | ~380 class names | Hard-coded `border-[#e5e5e5]` / `bg-[#f6efe9]` everywhere, despite the named `line` / `surface` tokens existing | L | S | Replaced them with the tokens (same hex values, so nothing changes visually) | fixed |
| SHR-UX-3 | `tailwind.config.ts` | `tan` (#ad825e) on white is about 3.4:1, which fails WCAG AA for normal-size text. That covers every primary button label (white on tan), prices and links. `tan-dark` is 4.4:1, just under. | H | S | Follow-up: tan now has three roles. `tan` #ad825e is for decoration only. `tan-dark` is #8a6446 (5.3:1 on white, 4.6:1 on surface) and is used for all tan text and every tan fill under white text. `tan-darker` #73533a is the hover shade. About 245 class swaps, plus the global-error button and the Razorpay theme colour. The charcoal chrome (StaffHeader, SiteFooter, LockScreen) keeps plain `tan` text, which is 4.6:1 there. The green "Complete" button moves to green-700. | fixed |
| SHR-UX-4 | `app/owner/layout.tsx`, `app/staff/layout.tsx` | A second `<main>` nested inside the root layout's `<main>` | L | S | Changed the inner one to a `<div>` | fixed |

## Customer (phone-first)

**Verdict:** everything works, but the phone experience was a long scroll of full-width tiles. There was no search, the category tabs disappeared once you scrolled, the cart drawer's buttons were tiny, and several error states were silent or misleading.

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| CUS-UX-1 | `/menu` | No search (CUS-004, a Must in the requirements) | H | M | Search box. The first keystroke fetches the whole menu once (the same public `GET /api/menu`) and filters it in the browser; live availability updates refresh it too. | fixed |
| CUS-UX-2 | `MenuItemCard` | On phones each item was a full-width 4:3 tile, so only about 1.5 items fit per screen | H | S | Under `sm`: a compact row with a 96px thumbnail on the right (about 4 items per screen). The grid from `sm` up is unchanged. | fixed |
| CUS-UX-3 | `/menu`, `/t/[token]` | Category tabs scrolled out of view, and the active tab could sit off-screen to the right | M | S | Search and tabs stick under the header. The active tab scrolls into view, and switching tabs deep in a list jumps back to the start of the new list. | fixed |
| CUS-UX-4 | `CartDrawer` | Not a real dialog: no Escape, no focus trap, and the page kept scrolling behind it. The −/+ buttons were 20px. | H | S | Shared dialog behaviour, `role=dialog`. Steppers are 36px inside a 44px pill, Remove/close buttons are 44px, and the empty cart has a "Browse the menu" button. | fixed |
| CUS-UX-5 | `FloatingCartBar`, QR review bar | Could cover the last item, ignored the iPhone home indicator, and the label was cramped | M | S | Full-width bar on phones ("2 items · ₹400 — View cart →") with safe-area padding, plus a spacer at the bottom of the page | fixed |
| CUS-UX-6 | `/menu`, `/t/[token]` | When the menu failed to load, customers saw "Nothing here yet" | M | S | A "Couldn't load the menu" message with a Try again button; `res.ok` is now checked | fixed |
| CUS-UX-7 | `MenuItemImage` | A broken photo URL showed a loading shimmer forever | L | S | Falls back to the placeholder on `onError`; `decoding=async` | fixed |
| CUS-UX-8 | `CheckoutForm` | Server errors appeared at the top of a long form, out of view on a phone. Pressing Place Order looked like it did nothing. | H | S | The error banner scrolls into view | fixed |
| CUS-UX-9 | `CheckoutForm` | No `autocomplete`/`inputMode`; field errors weren't linked to their fields or shown in red; the payment toggle had no `aria-pressed`; 36px buttons | M | S | Added `autoComplete` (name / tel-national / email), `inputMode`, `aria-invalid` + `aria-describedby`, `aria-pressed`, and 44px targets | fixed |
| CUS-UX-10 | `CheckoutForm` | The submit button was at the bottom of a long form | M | S | Sticky Place Order bar on phones showing the total (`Place Order · ₹420`), with a loading spinner | fixed |
| CUS-UX-11 | `/order/[id]` | Status was shown only as numbered dots. Nothing said what was happening, and screen readers weren't told when it changed. | M | S | One plain-language headline per status (`aria-live`), ✓ on completed steps, `aria-current="step"`, readable 12px labels | fixed |
| CUS-UX-12 | `/order/[id]` | Guest orders (which have no phone) said "We'll message you on ." | M | S | Guests now see "Keep this page open — it updates live" instead | fixed |
| CUS-UX-13 | `/t/[token]` | Opening checkout from the QR menu kept the menu's scroll position | M | S | Scroll resets when switching view | fixed |
| CUS-UX-14 | `MenuItemImage` | Plain `<img>` (the one lint warning) | L | M | Switching to `next/image` needs `images.remotePatterns` for Supabase storage (a config change) | proposed |
| CUS-UX-15 | `/menu` | No veg / price / bestseller filters (CUS-005/006) | M | M | Needs popularity data from analytics | proposed |

## Staff (counter tablet)

**Verdict:** the most mature surface: well commented, with sticky phone bars and a thought-through counter mode. The main problems were small buttons on the busiest controls, a newest-first queue, and notes that were hard to read.

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| STF-UX-1 | `OrderQueueBoard` | Lanes were sorted newest first, so the longest-waiting order (red timer) sank to the bottom | H | S | Oldest first (a normal first-in, first-out queue). Lane headers stay pinned under the staff header. | fixed |
| STF-UX-2 | `OrderCard` | The order number was body-size text, and prep notes were italic tan at 12px (below AA) | H | S | 20px mono order number and mono total; notes in `tan-dark` semibold | fixed |
| STF-UX-3 | `PosOrderEntry` cart | −/+ were 28px, the most-tapped control on the counter | H | S | 40px, with the item name in the aria-label | fixed |
| STF-UX-4 | `MenuItemTable`, `OrderDetailModal`, `LeavePlanner`, `PrintDock`, refund chips, `PosCustomizeModal` | Buttons of about 24–32px (snooze, Mark available, Void, Approve/Decline, Didn't print) | M | S | 36–40px | fixed |
| STF-UX-5 | `PosOrderEntry` | Phone, name, email, coupon, points and table filter used placeholders as their only label | M | S | `aria-label` on each, `type=tel/email/search`, `autoComplete=off` (shared device) | fixed |
| STF-UX-6 | `OrdersWorkspace` | Search had no label and was 36px; the toast wasn't announced to screen readers | L | S | Labelled 44px search box; `role=status` toast | fixed |
| STF-UX-7 | `StaffHeader` | Nav links were about 36px | L | S | 40px (desktop), 44px (drawer) | fixed |
| STF-UX-8 | `CashCountSheet` | Hand-built dialog without focus management | L | S | Uses the shared hook; Escape is still blocked while saving | fixed |
| STF-UX-9 | `OrderQueueBoard` | At 1024–1279px the four lanes wrap into a 2×2 grid, so Ready sits below the fold | M | M | Follow-up: four lanes from `lg` (1024px) up. At `lg` the card actions drop under the order number at full width so the ~240px lanes aren't squeezed. Below `lg`, a row of lane-count buttons links to each lane, and Ready is highlighted when it has orders. | fixed |

## Owner (phone + desktop)

**Verdict:** the data is rich, but the page read as 15 cards of equal weight. The nav highlighted the wrong tab, and the revenue chart had no numbers.

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| OWN-UX-1 | `OwnerHeader` | **Bug:** "Overview" (`/owner`) matched every `/owner/*` page as a prefix, so it stayed highlighted everywhere | H | S | The root tab now needs an exact match; other tabs match their own section. Added `aria-current`. | fixed |
| OWN-UX-2 | `OwnerHeader` | The nav scrolled away, and phone links were about 36px | M | S | Sticky header, 44px links on phones | fixed |
| OWN-UX-3 | `/owner` | Live ops and revenue trend were buried below the customer split, recent orders and feedback | M | S | Moved directly under the glance cards | fixed |
| OWN-UX-4 | `RevenueBars` | No numbers or axis; values only appeared on hover, which doesn't exist on a phone | M | S | Total and best day shown as text, date range under the chart, accessible summary, best day highlighted | fixed |
| OWN-UX-5 | `GlanceCards` and stats | ₹123456 with no digit grouping; proportional digits; 10px labels; red/green-600 deltas below AA | M | S | `₹1,23,456` grouping, mono tabular numbers, 12px labels, green/red-700 with screen-reader text | fixed |
| OWN-UX-6 | `/owner` | A long single page with no in-page navigation | L | M | Section jump links, or split it into Today / Sales / Operations tabs | proposed |

---

## Verification

```
npm run lint      # 1 existing warning (MenuItemImage <img>), no new ones
npx tsc --noEmit  # clean
npm test          # 188 files, 3965 tests passed
npm run build     # OK
```

I also tested `/menu` in Chromium at 390×844 with the API mocked: search, add-to-cart, the floating bar, and the cart drawer (Escape closes it, and focus stays inside it) all worked.
