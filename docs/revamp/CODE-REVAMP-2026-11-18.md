# Code revamp — customer flow pass (2026-11-18)

Run of `.claude/skills/code-revamp` with `surface=customer mode=fix`, working from the Hallmark
audit of the customer site (2026-11-06, finding IDs such as CHK-02 and MENU-01 below). Five agents
fixed one area each (home and chrome, menu, cart and checkout, order status, login and account);
every diff was then reviewed again and merged by hand.

**Baseline (before):** lint clean except 1 existing `<img>` warning · `tsc` clean · 396 files /
10,288 tests passing · `next build` OK.
**After:** lint, same single warning · `tsc` clean · 396 files / 10,293 tests passing (5 new, for the
opening-time label) · `next build` OK. No API, schema, pricing maths, auth, order-state or print
changes; no new dependencies; no new colours.

**Rules kept on purpose (owner decisions):** guests pay online only (it stops fake orders); a
signed-in customer whose number isn't WhatsApp-verified still gets the code step before ordering;
when the cafe is closed the menu behaves as before (it now only says when it opens); the Instant
Coffee popup keeps its once-per-visit rule.

Each finding has an Impact (H/M/L), an Effort (S/M/L) and a status: `fixed`, `proposed` (needs a
decision or a change outside this pass) or `wontfix`.

---

## Customer (phone-first)

**Verdict:** the order path worked but wasn't honest or easy to reach. The bill showed two totals
after a discount and grew by the packaging charge at the last step; guests learned the pay-online
rule only at checkout; 9 of 17 menu categories couldn't be reached on desktop and two were empty;
the closed menu never said when it opens; account pages scrolled sideways; there was no skip link,
no branded 404, and most pages were titled just "HIOC.". All of that is fixed below. What still
hurts most is material, not code: 75 of 126 items have no photo.

### Money path

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| CUS-UX-1 (CHK-02) | `components/cart/CartSummary.tsx`, `CheckoutForm.tsx` | "Your Order" and "Bill summary" showed different totals after a coupon, points or Ritual cups (CartSummary always passed discount 0); the total was printed three times | H | S | CartSummary lists the lines only; the checkout bill (with discounts) is the one total, and the sticky bar repeats only the final amount | fixed |
| CUS-UX-2 (CHK-09) | `FloatingCartBar.tsx`, `CartDrawer.tsx` | The cart said one total, then checkout added packaging | H | S | The bar and drawer show the takeaway total checkout will show (`computeBill`, packaging included), labelled "incl. GST and packaging"; the drawer lists GST and packaging; no figure until the settings arrive | fixed |
| CUS-UX-3 (CHK-01, CHK-22) | `/menu` header, cart drawer, checkout | "Pay online, or at the counter" was shown to guests, who can only pay online; with online payment off a guest met a dead button; a pressed "Pay at counter" button did nothing; consent copy said "this number" to guests | H | M | "Guests pay online. Sign in to pay at the counter." on the menu, in the drawer and on checkout, with Sign in returning to where they were; a plain sentence and a Sign in link when online payment is off; plain text instead of the fake button; consent copy per case | fixed |
| CUS-UX-4 (CHK-03, CHK-04) | `CheckoutForm.tsx` | The sticky Place Order was disabled on arrival with the reason far below; an empty name returned the raw API text "customer_name is required…" | H | S | Never disabled at rest: a tap moves focus to the first problem and the bar says what's missing; inline validation on blur and submit; known API messages mapped to sentences; still disabled while submitting | fixed |
| CUS-UX-5 (MENU-20) | `MenuItemCard.tsx` | "₹135–₹150" ranges, then a different figure on the dialog, then another incl. GST on the bar | M | S | "From ₹135, 2 sizes", and one note under the menu heading saying whether prices include GST (from the store setting) | fixed |
| CUS-UX-6 (CHK-05, SYS-15, SYS-14) | `components/ui/Input`, `Select`, `Textarea` | Field edges at 1.26:1 against white (WCAG 1.4.11 asks 3:1); 14 px fields made iOS zoom in | M | S | `border-muted/80` (about 3.7:1), `text-base`, error border red-700; checkout, login and profile fields use the shared primitives with visible labels. A caller's own `aria-describedby` is now kept alongside the error link. Staff and owner forms that use these primitives get the same 16 px text and stronger edge | fixed |
| CUS-UX-7 (CHK-18, CHK-21, CHK-13) | `/checkout` | Blank until the saved cart was read; on desktop the summary and action scrolled away; filled panels nested inside cards | M | S | A skeleton while loading; a sticky sidebar with the summary, bill and Place Order from `lg`; one level of containment | fixed |

### Menu

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| CUS-UX-8 (MENU-01, MENU-18) | `MenuCategoryTabs.tsx` | At 1280 px and wider only 8 of 17 pills showed, with no scrollbar or hint; every food category was unreachable by mouse | H | S | Customer menus (`wrapOnWide`) wrap the pills from `md` up; phones keep the scrolling row with edge fades and the active pill scrolled into view; `aria-pressed`, arrow, Home and End keys; 44 px pills. The POS keeps its single row | fixed |
| CUS-UX-9 (MENU-04, HOME-03) | `/menu`, home tiles | Waffle Crepes and Coffee Beans opened empty pages from the menu and from home | H | S | The menu now loads the whole menu once and drops pills for empty categories; the home page reads which categories have items on the server (same in-store and owner-switch rules as the menu) and falls back to the full list on any error | fixed |
| CUS-UX-10 (MENU-03) | `lib/store/hours.ts`, `StoreStatusBanner`, `CartDrawer` | `nextOpenLabel` was null in every branch, so a closed menu never said when it opens, and the drawer pointed at a notice it covered | H | M | "Opens at 10:00 AM", "Opens tomorrow at …" or "Opens Friday at …" (skipping holidays), null when it can't be known (a pause, a forced close); shown in the banner and the drawer; 5 new tests. Ordering behaviour while closed is unchanged | fixed |
| CUS-UX-11 (MENU-07) | `MenuItemCard`, `/menu` | After an add the card looked the same and screen readers heard nothing | M | S | "N in cart" on the row (every line of that item) and one polite live region: "Added Latte to your cart" | fixed |
| CUS-UX-12 (MENU-06, MENU-05) | `MenuItemCard`, customise dialog | Cards lifted on hover but weren't clickable; descriptions were cut to two lines even in the dialog | M | S | The name is a button stretched over the card (no nested controls; out of the tab order when the card's own action opens the same dialog); simple items open the dialog too; the dialog shows the full description; `Card` animates transform, shadow and border only | fixed |
| CUS-UX-13 (MENU-02) | `MenuItemImage.tsx` | 75 items showed a ☕ on beige instead of a photo | M | S | Menu rows with no photo have no image slot (a clean text row). The checkout's "Pairs well with" rows keep their placeholder tile (`missing="placeholder"`, pinned by a test) | fixed |
| CUS-UX-14 (MENU-14) | `/menu` search | A second native ×; the active pill stayed lit over all results; results didn't name their category; "capuccino" found nothing | M | S | One ×; neutral pills while searching; category captions; matching ignores case and accents and collapses doubled letters | fixed |
| CUS-UX-15 (MENU-09 part, SYS-14, MENU-10) | `ItemCustomizer`, customise dialog, card steppers | 36 px chips, 24–40 px quantity buttons, 14 px note fields, "REQUIRED" beside a "Required" pill | M | S | 44 px chips and steppers, 16 px labelled note and grams fields, "Required" once | fixed |
| CUS-UX-16 (MENU-19, SYS-16, SYS-17) | `MenuItemCard`, `/menu` | The veg mark was skipped by screen readers (axe: 17 serious per page); item titles were h4 under h1; "Back at…" text was about 2.5:1 | M | S | `role="img"` on the mark; h2 category headings with h3 items; only the photo is greyed on unavailable items | fixed |
| CUS-UX-17 (SYS-19, MENU-15 part) | `/menu`, `MenuItemImage` | Smooth scrolling ignored reduced motion; photos stayed invisible until JavaScript reported them loaded | L | S | Reduced-motion-aware scrolling; photos visible by default; the first two load eagerly | fixed |
| CUS-UX-18 | `/menu` data loading | A refresh for a tab the customer had just left could land in the new tab; a failed background refresh wiped the search index | L | S | Responses are dropped unless they match the tab on screen; a failed refresh keeps the previous index | fixed |

### Home and global chrome

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| CUS-UX-19 (SYS-17, MENU-18) | `app/layout.tsx` | No skip link; about 9 Tab stops before the menu search | M | S | "Skip to content" as the first focusable element, to `<main id="main-content">` | fixed |
| CUS-UX-20 (HOME-18, ACCT-22, CHK-20) | `app/not-found.tsx`, `error.tsx`, `/order/[id]` | Next's unbranded 404 with no way back; the error page offered only "Try again"; a server error on the status page said "Order not found" | M | S | Branded not-found page (Menu, Home, Call); error page adds Menu and Home; the status and review pages show "We couldn't load your order." with Try again, separate from a real 404 | fixed |
| CUS-UX-21 (SYS-10, HOME-14, HOME-21, SYS-11) | `SiteFooter`, `AnnouncementBanner`, `PolicyLayout`, `globals.css` | 16 px footer links (axe target-size on every page); a padless banner ×; 14 px legal text at about 100 characters a line; the cart bar covered the footer's last lines | M | S | 44 px footer and policy-nav rows; a 44 px × ; 16 px legal text at 65 characters; `body:has([data-floating-cart-bar])` reserves the bar's height, and the bar has a light ring over the charcoal footer | fixed |
| CUS-UX-22 (HOME-08, HOME-09) | `SiteHeader`, `AccountNav` | The mobile menu ignored Esc and outside taps and pushed the page down; "Your Order" went to /menu; one-tap Log out in the menu; the header cart showed no count | M | S | Overlay menu that closes on Esc (focus back to the toggle) and outside taps; honest labels; Log out lives in the account header only; a count badge ("Cart, 3 items") that goes to checkout, updated through a `hioc:cart-changed` event from the cart instead of polling | fixed |
| CUS-UX-23 (HOME-02, HOME-04, HOME-11) | home hero, visit strip | Nothing said you can order ahead; "Order Now" fell below the fold on small phones; Get Directions went to /contact | M | S | The hero sentence says order ahead and pick up at the counter; the illustration is capped at 40% of the screen height on phones; Get Directions opens the maps link | fixed |
| CUS-UX-24 (SYS-13, HOME-13, SYS-19) | `InstantCoffeePopup`, `globals.css` | The page behind the popup stayed reachable; `100vw` sizing; no `overflow-x: clip` | L | S | Everything outside the popup is `inert` while it's open; width in `%`; `overflow-x: clip` on html and body | fixed |
| CUS-UX-25 (SYS-02, HOME-19, ACCT-24) | page metadata | The home page was titled "Home"; menu, checkout, login, rewards and order pages were all "HIOC."; no Open Graph text | M | S | Specific titles on every customer page; Open Graph title, description, site name and locale (no share image yet) | fixed |
| CUS-UX-26 (HOME-06, HOME-12, and the tells in every area) | customer copy | Emoji used as icons, labels in tracked capitals, arrows glued to links, em dashes and middle-dot meta strings | L | S | Removed across the customer files touched; `EmptyState` can now render no icon | fixed |

### Order status and after the order

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| CUS-UX-27 (CHK-07) | `/order/[id]` | "Cancel order" cancelled in one tap | H | S | An inline confirm, "Cancel this order?", with "Keep my order" as the primary button | fixed |
| CUS-UX-28 (CHK-10) | `/order/[id]` | Pickup time and place sat at the bottom; no directions | M | S | A Pickup block at the top: the slot, or "As soon as possible", the address, Directions and Call | fixed |
| CUS-UX-29 (CHK-06) | `/order/[id]` | Nothing signalled "ready" outside the page | M | S | When the order turns ready while open: the tab title becomes "Ready: order N", one vibration, the existing live announcement | fixed |
| CUS-UX-30 (ACCT-06, CHK-19) | `StarRating`, review page | Empty stars at 1.26:1; the comment box labelled only by its placeholder | M | S | Muted empty stars, 44 px stars as a radio group with arrow keys; a visible comment label. Owner screens that show ratings read-only are unaffected | fixed |
| CUS-UX-31 (ACCT-17, ACCT-18, SYS-09) | feedback link, table QR | An expired feedback link showed "HIOC." and an unlinked WhatsApp mention; the QR-off screen blamed a "refreshed" code; 20 px QR steppers | M | S | A real heading with Call and Menu links; "Table ordering isn't available yet"; 44 px named steppers | fixed |
| CUS-UX-32 (ACCT-19) | `/coffey` | Indexable while the feature is off | L | S | `robots: noindex` while the suggest flag is off (content untouched) | fixed |

### Login and account

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| CUS-UX-33 (ACCT-02) | `AccountHeader`, `app/account/layout.tsx` | Every account page scrolled sideways (`-mx-4` tab row); a nested `<main>` | H | S | Tabs inside the content width, centred on the active one; a `div` instead of the second `<main>` | fixed |
| CUS-UX-34 (ACCT-08, ACCT-09, ACCT-20) | `app/login/LoginForm.tsx` | No Resend, no one-time-code autofill, no +91, no autofocus, raw server errors; 32 px tabs; "Back to menu" went home and ignored `next` | H | M | One code field with `one-time-code`, autofocus and paste; a visible +91; Resend with a 30-second countdown (same request as the first send); plain-sentence errors; a 44 px tablist; Back returns to a safe `next`, else /menu. Request URLs and bodies unchanged | fixed |
| CUS-UX-35 (ACCT-03) | `/login` | Never said what signing in unlocks | M | S | Three lines (pay at the counter, earn Beanies, reorder) and one on how the number or email is used, linking to the privacy page | fixed |
| CUS-UX-36 (ACCT-04) | `lib/account/orderDisplay.ts` | Status pills were tan on tan (2.93:1); Ready looked like Preparing; a pickup order was "on its way" | M | S | 4.5:1 pills, a solid Ready pill, "Ready to collect" | fixed |
| CUS-UX-37 (ACCT-05, ACCT-13) | `/account/orders` | A reorder with every item unavailable opened an empty checkout; old bills repeated on every page under "No past orders yet."; a quick tab switch could show Active orders under Past | M | S | Stay and say so; old bills on page 1 only, no empty message beside them; only the newest request may update the list | fixed |
| CUS-UX-38 (ACCT-07, ACCT-14, ACCT-21) | profile, rewards, empty states | Unlabelled profile fields; "+points" at 3.30:1; bare empty states | M | S | Visible labels; green-700 points; `EmptyState` with one action on each list | fixed |

### Proposed (needs a decision or a change outside this pass)

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| CUS-UX-39 (ACCT-01) | `CheckoutForm.tsx` | A customer signed in by email can't place any order, not even a paid one, until a WhatsApp code verifies their number | H | S | Let them pay online like a guest; ask for the code only to pay at the counter | proposed (owner decision) |
| CUS-UX-40 (MENU-03) | `/menu` while closed | Cards still say "Customize & Add" and the cart fills while closed | M | M | Browse-only or pre-order for opening time | proposed (owner decision) |
| CUS-UX-41 (HOME-01, HOME-20) | `InstantCoffeePopup` | The launch poster covers the first screen once per visit and needs a deploy to end | M | M | An inline "New at the counter" band scheduled through announcements with an end date | proposed (owner decision) |
| CUS-UX-42 (MENU-02) | menu photos | In a desktop row that mixes photo and text-only cards, the text-only card has empty space | M | — | Photos for the 75 items without one, on the same peach set | proposed (owner material) |
| CUS-UX-43 (CHK-17) | `CheckoutForm.tsx` | The availability check downloads the whole menu to check 2–3 items | L | S | Have the quote return unavailable lines (API change) | proposed |
| CUS-UX-44 (CHK-08) | `/checkout` | Size and add-ons can't be edited from checkout | M | M | Steppers on checkout lines and a "Change" link that reopens the customiser | proposed |
| CUS-UX-45 (MENU-16, MENU-17, SYS-03, SYS-01) | `/menu` | Client-only menu; one request per tab; 1400 px JPEGs as 96 px thumbnails | M | L | Server-rendered continuous menu; resized images with `srcset` | proposed (next phase) |
| CUS-UX-46 (ACCT-10, ACCT-11, ACCT-12, ACCT-15, ACCT-16, ACCT-23) | account | Beanies rules hidden from signed-out visitors; profile preferences nobody reads; no "Verify this number"; no heart on the menu; two account headers | M | M | As in the audit backlog (items 28 and 29) | proposed |
| CUS-UX-47 | `CheckoutForm.tsx` `handleSubmit` | No in-flight guard; a double tap is stopped only by the disabled state (unchanged from before) | L | S | A ref guard at the top of the handler | proposed |
| CUS-UX-48 | `lib/constants.ts` | No WhatsApp link to offer on the feedback page | L | S | Add `CAFE_WHATSAPP_URL` | proposed |

## Verification

```
npm run lint      # clean except the existing <img> warning in MenuItemImage.tsx
npx tsc --noEmit  # clean
npm test          # 396 files, 10,293 passed, 1 skipped
npm run build     # compiled successfully
```

Accessibility before and after: axe-core with the WCAG 2.2 AA and best-practice rules, at 390 and
1280 px, against a local build reading the live menu (before: dev build of main; after: production
build of this branch). No form was submitted and no order placed. Sideways overflow was 0 on every
page both times; every page has one `<main>` and one h1.

| Route | axe violations, before | after | Skip link | Title, before → after |
|---|---|---|---|---|
| `/` | target-size (footer links) | none | no → yes | "HIOC." → the cafe and order-ahead pickup |
| `/menu` | aria-prohibited-attr ×17 (veg mark), heading-order, target-size | none | no → yes | "HIOC." → "Menu" |
| `/login` | heading-order, target-size | none | no → yes | "HIOC." → "Log in" |
| `/rewards` | heading-order, target-size | none | no → yes | "HIOC." → "Rewards" |
| `/about` | target-size | none | no → yes | unchanged |
| `/privacy` | link-in-text-block ×3, target-size | link-in-text-block ×3 | no → yes | unchanged |
| `/order/<unknown id>` | heading-order, target-size | none | no → yes | "HIOC." → "Order status" |
| `/feedback/<bad token>` | heading-order, target-size | none | no → yes | "HIOC." → "Feedback" |
| `/t/<bad token>` | heading-order, target-size | none | no → yes | unchanged |
| unknown URL | target-size | none | no → yes | Next's "404" → "Page not found" |

Phone flow at 375 px (customise dialog, add to cart, checkout with a filled cart): the dialog had
5 controls under 44 px and now has 1; checkout fields went from 41–42 px to 44 px tall; checkout's
axe result went from target-size ×2 to none. The menu's item-name buttons measure 22 px tall
themselves, but each one's hit area is the whole card (a stretched overlay); the inline "Sign in"
link sits in a sentence, which WCAG 2.5.8 exempts. Still open: three links on `/privacy` are
told apart from the text by colour alone (link-in-text-block).
