# Code revamp — Ask Coffey (2026-11-17)

Run of `.claude/skills/code-revamp` with `surface=customer mode=fix`, **scoped to the Coffey screens only** at the owner's request: `/suggest` (`components/suggest/**`, `components/coffey/**`) and the Coffey path into the customise screen (`components/menu/MenuItemCustomizeModal.tsx`, `lib/menu/customization.ts`). The rest of the customer surface was not walked in this run.

**Baseline (before):** lint clean except 1 existing `<img>` warning · `tsc` clean · 382 files / 10,025 tests passing · `next build` OK.
**After:** lint and `tsc` the same · 385 files / 10,136 tests passing · `next build` OK (`/suggest` 18 kB, 129 kB first load; was 11 kB / 121 kB). No new dependencies, no new colours, no schema, pricing, auth or order-state changes.

**One departure from the skill's "presentation only" rule, made at the owner's explicit request:** the suggestion engine and its response gained optional fields (`addonPresets`, and earlier `unmet` / `misses`) so that a drink plus the add-on that makes it match can be suggested. Those changes are specified in `docs/COFFEY-SPEC.md` §10 and §11, not here. The request shape, the API routes' behaviour for existing clients, and every table are unchanged.

Screens were checked in Chromium at 390×844 and 360×740 against the live menu (read-only), with every write answered locally so nothing reached the database.

Each finding has an Impact (H/M/L), an Effort (S/M/L) and a status: `fixed`, `proposed` (needs a decision) or `wontfix`.

---

## Customer — Ask Coffey

**Verdict:** the wizard asked the right questions but read as a form: nothing on screen responded to a choice, the three most-used questions were small pills, and a flavour the kitchen can only add (a syrup, a sauce) was a muted tip with no price. It now behaves like building a drink, and what Coffey preselects is visible, priced and one tap to change.

| ID | Screen / file | Problem | Impact | Effort | Fix | Status |
|---|---|---|---|---|---|---|
| CUS-UX-1 | `/suggest` step 2, `WizardSteps.tsx` | Nothing reacted to a selection; the mascot was a static picture beside a fixed sentence | H | M | The cup is live (`CoffeyMascot` `look`, `LiveCup`): ice and a straw for Iced, steam for Hot, darker or milkier coffee, sugar cubes, flavour and bite badges; it winks and its bubble answers the last choice | fixed |
| CUS-UX-2 | step 2, kinds / hot or iced / coffee | The three most-used questions were pills that wrapped to two rows, with long labels ("Something sweet to eat") | M | S | Large tiles in one row each (`ChoiceTile`), shorter labels ("A sweet bite"), and the coffee tiles show the cup as each option makes it | fixed |
| CUS-UX-3 | step 2, "How sweet?" | Three unrelated pills gave no sense of a level | M | M | A glass that fills (`SweetnessGlass`): drag or tap to set it. The three chips stay beside it as the keyboard and screen-reader control, so dragging always has an alternative. `touch-action: none` on the glass only, so the page still scrolls everywhere else | fixed |
| CUS-UX-4 | step 2, sticky bar | Once the customer scrolled, nothing showed what they had chosen | M | S | The bar carries a small live cup and a one-line summary ("Iced · Strong coffee · Not sweet") above **Show my picks**; the cart-bar offset is unchanged | fixed |
| CUS-UX-5 | step 2 header | The heading repeated the bubble's question and cost a line of a phone screen | L | S | The `h1` is kept for assistive tech and focus but visually hidden; top padding reduced | fixed |
| CUS-UX-6 | results, `SuggestionCard.tsx` | An add-on that gives a pick its flavour was a muted "Coffey tip" with no price, and was never chosen for the customer | H | M | "Made your way": the name carries the add-on ("Cappucino + Hazelnut syrup"), and each preselected option is a tickable chip with its price and a line saying why it is there. Un-ticking takes it out and the card stays truthful: the tag it earned goes, the reason and the sugar option switch to the plain ones, and a line says "Without Hazelnut syrup: not nutty". Never on "Your usual"; never a sweetener for "Not sweet". Needs the engine's `addonPresets` (spec §11) | fixed |
| CUS-UX-7 | customise screen via Coffey | A preselected option must never reach the cart unseen | H | S | A pick with a ticked add-on never takes the one-tap add. The customise screen opens with it chosen through the vetted path (exists, switched on, within the group's limit), marked "Coffey's pick", with a one-sentence note naming it and its price; the total includes it from the first paint | fixed |
| CUS-UX-8 | step 2, greyed chips | With add-ons counting, greying one option at a time would enable combinations nothing can keep (a syrup adds sweetness, an add-on adds to the price) | H | M | The wizard evaluates the choices together with the engine's own functions on a compact per-item record (spec §11.3) | fixed |
| CUS-UX-9 | picks for a hot request | "Tiramisu Latte Iced" was offered to customers who asked for a hot drink: its traits row says `hot` | H | S | A drink whose name says "Iced" is treated as iced (`traitsGuard.ts`). The row itself still needs correcting | fixed in code · data fix proposed |
| CUS-UX-10 | customise screen via Coffey | Coffey's preselected options sat inside long option groups; the note named them, but the customer scrolled to find and change them | M | M | A "Coffey set this up for you" panel at the top of the screen: one chip per preselected option, bound to the form's own toggle, so removing or restoring one is a single tap and the total moves with it (spec §11.8) | fixed |
| CUS-UX-11 | `/suggest` | Abandonment before the picks is invisible (14 visitors, 2 reached picks in 30 days); no step is logged | M | M | A wizard step event and a funnel on the owner page; needs a table, so it is the owner's decision (queued as a suggested task) | proposed |
| CUS-UX-12 | add-on names on cards | Some option names read badly as a suggestion ("Sparkling Water(green Apple)") | L | S | Rename the options on the menu; the card uses the menu's own names | proposed |

## What to decide

1. **Nothing to apply:** `supabase/2026-11-coffey-preset-events.sql` was applied to the live database on 2026-11-17, so the "Add-ons Coffey preselects" card starts counting as soon as this code is deployed (spec §11.7).
2. **CUS-UX-11:** whether to add step tracking (a small new table).
3. **Data:** "Tiramisu Latte Iced" had its temperature corrected on 2026-11-17; regenerate the rest of its row, and generate traits for the eight items that have none (listed in `docs/COFFEY-SPEC.md` §10.6 and §11.9).
4. **Preselecting a paid add-on** is a default the owner asked for. It is always priced and one tap to remove; the new card shows how often customers remove it, and `docs/COFFEY-SPEC.md` §11.9 says what to do if most do.
