# Coffey: add-on flavours and checkout pairings (spec and work plan)

**Companion to:** `docs/COFFEY-SPEC.md` (v2, still the reference for everything this file doesn't change), `docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md` (v1 and the tone guide), `docs/SECURITY-PLAYBOOK.md`
**Date:** 2026-10-10
**Scope:** three changes.
1. **Add-on traits.** Every add-on option gets a small taste profile: what it does (its role), which flavour families it brings, and how much sweetness, strength and indulgence it adds. The profile is derived from the menu's own names, and the owner can override any option.
2. **Flavour through add-ons.** Coffey can now reach a requested flavour through an add-on. A customer who asks for nutty can be offered a Cappucino, with Coffey pointing to the Hazelnut syrup.
3. **"Pairs well with" at checkout.** The checkout lists up to three things that go with what's already in the cart, each with a one-tap add.

Where this file and `COFFEY-SPEC.md` disagree, this file wins.

---

## 0. Why: what the live menu shows (snapshot 2026-10)

| Finding | Evidence | Consequence |
|---|---|---|
| **Flavour is often an add-on.** | "Add a Syrup" (Salted Caramel / Vanilla / Hazelnut / Caramel, ₹35) is on 50 of 117 items. "Add Condiments" (Chocolate Sauce, Caramel Sauce, Espresso Shot, Whipped Cream) is on 51. "Add Toppings" (Nutella, chocochips, ice cream) is on 28 waffles. | The flavour sub-fit (`score.ts preferenceFits`) is 1 or 0 on the item's own name and notes. A Cappucino scores **0** for "nutty", even though the kitchen will make it nutty for ₹35. |
| **Add-ons have no traits.** | `menu_item_traits` covers items only. Add-on options are just a name and a price. | The engine can't reason about an option. The only add-on it understands is sugar, because `sugar.ts` matches it by name. |
| **No cross-sell.** | The checkout's left column (`components/cart/CartSummary.tsx`) lists the cart, with nothing to add. | A coffee-only cart never sees the brownie that regulars order with it. |

---

## 1. Customer flow

### 1.1 Coffey picks (`/suggest`, behind `flags.suggest`)
- Suppose the customer picked flavours and a pick doesn't carry one natively, but one of its add-on options does. That pick then carries a **flavour add-on** (§2.4), and the card shows one quiet line under the match tags: **"Coffey tip: try it with Hazelnut syrup"**. The card shows no price, in line with the tone guide (Coffey never talks about spending).
- Tapping **Add** on such a pick always opens the customise modal. The suggested option:
  - is **not preselected**. The rule from §4.7 stands: *a preset must never quietly add to the bill*.
  - carries a small **"Coffey's pick"** pill on its row.
  - is named in a hint at the top of the modal: "For the nutty notes you asked for, Coffey suggests Hazelnut syrup — tap it to add." When there is also a sugar preset, the two hints stack, sugar first.
- The pick's reason and match tag say the flavour comes from an add-on (§3.3).

### 1.2 Checkout (`/checkout`, behind `flags.checkoutPairings`)
- A **"Pairs well with your order"** card sits in the left column, directly under "Your Order" (the `CartSummary` card). It has a 20 px Coffey mascot and up to 3 rows. Each row has a thumbnail (or the existing placeholder), the name, a one-line reason, "₹min", and an **Add** button.
- **One-tap add** works when the item has exactly one variant and every *required* add-on group's default (`defaultOptionIds`) is free. The line is then added with the variant and the default required selections, with optional groups left empty. Anything else opens the existing `MenuItemCustomizeModal`.
- After an add, the row disappears and the rail recomputes from the new cart (debounced 400 ms). The bill in `CartSummary` and the quote in `CheckoutForm` update the way they do for any other cart change.
- If there are no picks, or the request fails, the card does not render at all: no skeleton is left behind and nothing shifts. The checkout must never wait on, or fail because of, this card.

---

## 2. Add-on traits

### 2.1 Shape (`lib/suggest/types.ts`)
```ts
type AddonRole = 'flavour' | 'topping' | 'shot' | 'sweetener' | 'milk' | 'ice' | 'serve' | 'side' | 'other';
interface AddonTraits {
  role: AddonRole;
  flavour_families: FlavourFamily[]; // ≤ 2
  sweetness_delta: number;           // 0–5, on the 0–10 item sweetness scale
  intensity_delta: number;           // 0–2 (an espresso shot is 1)
  indulgence_delta: number;          // 0–2
  textures: Texture[];               // ≤ 2, from TEXTURES
}
```

### 2.2 Derived defaults (`lib/suggest/addonTraits.ts`, pure)
`deriveAddonTraits(group: Pick<AddonGroup,'name'|'display_name'>, option: Pick<AddonOption,'name'>): AddonTraits`. The rules are checked in order and the first matching **role** rule wins. Names are matched case-insensitively against `group.name + ' ' + group.display_name` (G) and `option.name` (O).

| # | when | role | sweetness | intensity | indulgence | textures |
|---|---|---|---|---|---|---|
| 1 | G ~ `sugar` | sweetener | 0 | 0 | 0 | — |
| 2 | G ~ `milk` | milk | 0 | 0 | 0 | — |
| 3 | G ~ `\bice\b` and not `ice ?cream` | ice | 0 | 0 | 0 | — |
| 4 | O ~ `espresso shot\|extra shot` | shot | 0 | 1 | 0 | — |
| 5 | O ~ `whipped cream` and not `^no ` | topping | 1 | 0 | 1 | creamy |
| 6 | O ~ `ice ?cream` | topping | 2 | 0 | 2 | creamy |
| 7 | G ~ `syrup` | flavour | 2 | 0 | 0 | — |
| 8 | O ~ `sauce` | flavour | 2 | 0 | 1 | — |
| 9 | G ~ `topping\|extras\|treat yourself\|base- ?add on` | topping | 1 | 0 | 1 | — (`marshmallow` → soft; `chip` → crunchy; `nuts?:` / `almond` / `hazelnut` → crunchy) |
| 10 | G ~ `side\|slider\|croissant` | side | 0 | 0 | 0 | — |
| 11 | G ~ `brew\|specialized` | serve | 0 | 0 | 0 | — (`sparkling\|tonic\|ginger ale\|coke` → fizzy) |
| 12 | G ~ `dip` | topping | 0 | 0 | 0 | — |
| 13 | otherwise (packaging, "No Whipped Cream", "Default") | other | 0 | 0 | 0 | — |

- `flavour_families` = `FLAVOUR_FAMILIES.filter(f => FLAVOUR_FAMILY_INFO[f].pattern.test(option.name))`, capped at 2, in `FLAVOUR_FAMILIES` order, **for every role except** sweetener, milk, ice and other, which always get `[]`. This reuses the item patterns, so "Hazelnut" → nutty, "Nutella" → chocolatey + nutty, "Sparkling Water(peach)" → fruity. "Vanilla" gets no family, because vanilla is not a wizard family.
- A test pins the derived traits for **every** option in `data/inventory/menu-snapshot.json`. When an option is added to the menu, the test fails until someone looks at it.

### 2.3 Owner overrides (`addon_option_traits`)
- Table `addon_option_traits (option_id uuid pk → addon_options(id) on delete cascade, role, flavour_families text[], sweetness_delta, intensity_delta, indulgence_delta, textures text[], updated_at)`. It has named CHECKs mirroring §2.1, RLS on, and no policies (service role only, like `menu_item_traits`). The migration is `supabase/2026-10-coffey-addons-pairings.sql`, re-runnable.
- `resolveAddonTraits(group, option, overrides?: Map<optionId, AddonTraits>)` returns the override when there is one, otherwise the derived defaults.
- Owner → Suggestions → Traits → **Add-ons** sub-section. It lists every option, grouped by add-on group, showing the derived or overridden traits; an "Edited" pill marks overrides. Rows edit inline. **Reset** deletes the override.
  - `GET /api/owner/suggest/addon-traits` lists the options with resolved traits and an `overridden` flag.
  - `PATCH` upserts one override. It is validated by `validateAddonTraitsPatch` in `lib/suggest/addonTraitsValidate.ts`.
  - `DELETE ?optionId=` resets one option.
  - All three are owner-only, use the same auth guard as `/api/owner/suggest/traits`, and answer **409** "Apply supabase/2026-10-coffey-addons-pairings.sql…" while the table is missing (never 500).

### 2.4 Flavour reach (`lib/suggest/addonTraits.ts`)
- **Reachable options** of an item are the options that meet all of these:
  - they belong to any of its add-on groups (optional or required);
  - they are `is_available !== false`;
  - `price_inr ≤ ADDON_SUGGEST_LIMITS.maxPriceInr` (60);
  - their resolved role is in `FLAVOUR_REACH_ROLES` (flavour, topping, serve);
  - they have at least one flavour family.
- `reachableAddonFamilies(item, inputs, baseLevel, overrides?) → FlavourFamily[]`. These are the requested families (`inputs.flavours`) that the item does **not** match natively (`flavourFamiliesOf`) but that a reachable option provides. There is a **sweetness guard**: when `sweetnessTarget(inputs.sweetness)` is not null, an option only counts when `baseLevel + sweetness_delta ≤ target + SWEETNESS_SCALE.tolerance`. "Not sweet + caramel" never routes through a caramel syrup that blows the ceiling. With no requested flavours, the result is `[]`.
- `flavourAddonFor(item, inputs, baseLevel, overrides?) → FlavourAddonSuggestion | null` returns null unless `reachableAddonFamilies` is non-empty. Otherwise it is the single best option, ordered by:
  1. the requested family's index in `inputs.flavours`;
  2. role (flavour < topping < serve);
  3. `sweetness_delta` ascending;
  4. `price_inr` ascending;
  5. group `sort_order`;
  6. option `sort_order`;
  7. option id.

  The `label` is the option name with `(new)` and `(newly launched)` stripped (case-insensitive) and whitespace collapsed. When the group matches /syrup/i and the name lacks "syrup", " syrup" is appended, so "Salted Caramel (newly Launched)" becomes "Salted Caramel syrup".

---

## 3. Engine changes (Coffey picks)

### 3.1 Candidate and scoring (`score.ts`)
- `ScoreCandidatesArgs.addonTraitsById?: Map<string, AddonTraits>` (owner overrides). `Candidate.addonFlavourFamilies?: FlavourFamily[]`, and the same optional field on `ScoredSubject` / `MatchTagSubject`. Absent means `[]`, so every existing fixture keeps working.
- `scoreCandidates` sets `addonFlavourFamilies = reachableAddonFamilies(c.item, inputs, sweetnessLevel(c.traits), addonTraitsById)`.
- `preferenceFits` flavours: native match → 1; else any requested family in `subject.addonFlavourFamilies` → `ADDON_SUGGEST_LIMITS.flavourFit` (0.75); else 0. Nothing else in the scorer changes.

### 3.2 Engine (`engine.ts`)
- `RunSuggestArgs.addonTraitsById?` is passed through to `scoreCandidates`.
- `decorate()` sets `flavourAddon = flavourAddonFor(item, inputs, sweetnessLevel(traits), addonTraitsById)` on every pick and on the usual, read from the menu row. It never comes from decider output.
- `app/api/suggest/route.ts` loads `addon_option_traits` alongside traits in the same 60 s cache. On error (the table is missing before the migration), it logs once and uses an empty map.

### 3.3 Reasons, tags, decider (`templates.ts`, `brief.ts`)
- **Match tag** (priority slot 2, in place of the native family tag): when the family matched only through an add-on, the tag is `` `${FLAVOUR_FAMILY_INFO[f].tag} add-on` `` ("Nutty add-on", "Caramel add-on").
- **Reason**: when the flavour phrase comes from an add-on, it becomes `"<family phrase> from <label>"`, e.g. "Mellow and silky, with toasty nutty notes from Hazelnut syrup — easy to sip while you focus." If the result is over 120 characters, drop `" from <label>"`. If it is still over, the existing truncation rules apply. The result must pass `lintReason`. To keep the template pure, `templateReason` gets an optional trailing `addon?: FlavourAddonSuggestion | null` argument.
- **Jev**: `describeCandidate(c)` adds `addOnFlavours: string[]`, the labels of `c.addonFlavourFamilies` (e.g. `["Nutty"]`), only when non-empty. The rubric question is unchanged.

### 3.4 Response contract
`SuggestionPick.flavourAddon?: FlavourAddonSuggestion | null`. It is optional, so old clients ignore it.

---

## 4. Checkout pairings

### 4.1 Pure ranker (`lib/suggest/pairings.ts`)
```ts
pairingsFor({ cartItemIds, menu, traitsById, coOrders, popularity, now, limit = PAIRING_LIMITS.picks }): PairingPick[]
buildCoOrderStats(orders: { itemIds: string[] }[]): CoOrderStats   // distinct ids per order
```
- **Pool:** menu items not in the cart, `isMenuItemAvailable`, with a traits row, and `minPrice ≤ max(PAIRING_LIMITS.minPriceCapInr, max over cart items of their minPrice)`. The caller has already removed in-store-only, hidden-category and switched-off items, as `loadMenuAndTraits` does. Cart ids with no menu row or no traits are ignored; if none remain, the result is `[]`.
- **Score:** each candidate `c` is scored against each cart anchor `a`, and keeps its **best anchor**:
  `score = 0.40·complement + 0.25·coOrder + 0.20·harmony + 0.10·popularity + 0.05·daypartFit`. The weights are exported as `PAIRING_WEIGHTS`.
  - **complement** (cart composition; `K` = the set of cart kinds):
    - c drink: 1 if `drink ∉ K`, else 0.2.
    - c dessert: 0.15 if `dessert ∈ K`; else 1 if `drink ∈ K`; else 0.6.
    - c food: 0.15 if `food ∈ K`; else 0.8 if `drink ∈ K`; else 0.6.
  - **coOrder(a, c):** 0 when `pairs(a,c) < PAIRING_LIMITS.minCoOrders`. Otherwise it is `clamp01(0.5·min(1, conf/0.25) + 0.5·clamp01((lift − 1)/3))`, where `conf = pairs(a,c)/itemOrders(a)` and `lift = pairs(a,c)·orders / (itemOrders(a)·itemOrders(c))`.
  - **harmony(a, c):** `min(1, 0.6·[shares a flavour family] + 0.4·[contrast])`. Flavour families come from `flavourFamiliesOf`. The contrast is "a is a coffee drink at sweetnessLevel ≤ 4 and c is a dessert at ≥ 6" (a sweet partner for a bold coffee), or the reverse.
  - **popularity:** the same normaliser as `score.ts` (the 30-day units ÷ the max).
  - **daypartFit:** for a drink with medium or high caffeine, `{morning 1, afternoon 1, evening 0.5, late 0}[daypartFor(now)]`; otherwise 1.
- **Select:** drop scores below `PAIRING_LIMITS.minScore` (0.35). Go down the list in descending score order (ties broken by menuItemId ascending) and take candidates whose **category** isn't already taken, with at most one drink, until `limit` is reached.
- **Reason** (≤ `PAIRING_LIMITS.reasonMaxChars` = 90, must pass `lintReason`). `<A>` is the anchor name, shortened with "…" so the reason fits.
  1. coOrder ≥ 0.6 → "Often ordered with your <A>."
  2. a shared flavour family `f` (the first shared one, in `FLAVOUR_FAMILIES` order) → "Pairs well with your <A> — <FLAVOUR_FAMILY_INFO[f].phrase>."
  3. dessert → "Pairs well with your <A> — a sweet finish."
  4. food → "Pairs well with your <A> — a savoury bite on the side."
  5. drink → "Pairs well with your <A> — something to sip alongside."

### 4.2 API (`POST /api/suggest/pairings`)
- Body `PairingRequest` `{ itemIds: string[] }`: distinct UUIDs, at most `cartItemsMax` (20). Malformed → 400. Rate-limited per IP with `rateLimitOk` (`ipRequestsPer10Min` = 60) → 429.
- Returns 404 when `flags.checkoutPairings` is off.
- Response `PairingResponse` `{ picks, items }`. The `items` are the picked rows, shaped like `/api/menu` items, so one-tap add and the customise modal need no second fetch.
- **Data:**
  - `loadMenuAndTraits` and `loadPopularity30d` move from `app/api/suggest/route.ts` into a shared `lib/suggest/serverData.ts` ('server-only'). Both routes import them and share the 60 s cache.
  - A new `loadCoOrderStats`: order lines from the last `historyDays` (90), from non-rejected, non-cancelled orders, with voided lines skipped, at most `historyMaxOrders` (5000) orders. It is grouped per order into `buildCoOrderStats` and cached 10 min.
- **No LLM:** this is deterministic and fast. The checkout never waits on Jev.

### 4.3 Events and attribution
- Table `pairing_events (id uuid pk default gen_random_uuid(), anon_id text, user_id uuid → auth.users on delete set null, event text check in ('shown','added','ordered'), menu_item_id uuid → menu_items on delete set null, anchor_item_id uuid → menu_items on delete set null, order_id uuid → orders on delete set null, value_inr integer, created_at timestamptz default now())`. It has indexes on `(created_at, event)`, RLS on, and no policies. It is created by the same migration.
- `POST /api/suggest/pairings/events` takes `{ anonId?, events: [{ event: 'shown'|'added', menuItemId, anchorItemId }] }`, at most `eventsPerRequest` (3) events.
  - Only events in the whitelist are accepted. Rate-limited.
  - The `user_id` comes from the session, never from the body.
  - The insert is best-effort and always answers 204.
- The client sends 'shown' once per item per page view, and 'added' on every successful add.
- **Cart lines** gain `pairingAnchorId?: string`. One-tap add sets it directly. For a modal add it rides on a one-shot pending hint, mirroring `setPendingSuggestionSessionId` (`setPendingPairingAnchorId`).
- **'ordered'** is written by `POST /api/orders` from `pairing_lines: [{ menu_item_id, anchor_item_id }]` (≤ 5, parsed leniently, never a 400), after the order is created. It is best-effort and sits beside the existing `writeOrderAttribution`, with the line total as `value_inr`. A failure is logged, never thrown.

### 4.4 Owner view
Owner → Suggestions → Overview gains a **"Checkout pairings"** card for the page's selected window (Today / 7 days / 30 days, like every other card there). The server page reads it directly, through `getPairingStats`; there is no API route. It shows the shown, added and ordered counts, the add rate (added ÷ distinct shown), the attributed revenue (the sum of `value_inr` on ordered), and the top 5 anchor → item pairs by adds. While the table is missing, the widget shows "Apply supabase/2026-10-coffey-addons-pairings.sql to start measuring" instead.

---

## 5. Flags and rollout
- `flags.checkoutPairings = boolEnv(process.env.NEXT_PUBLIC_FLAG_CHECKOUT_PAIRINGS, false)`. It is **dark-launched**, following the repo convention for new customer-facing surfaces.
- The add-on flavour reach rides on the existing `flags.suggest`.

**Rollout steps:**
1. Merge. Nothing breaks before the migration: with no overrides, the add-on traits are derived from names, the pairings work from traits and popularity alone (coOrder is still read from `order_items`, which exists), and the event inserts fail silently.
2. Run `supabase/2026-10-coffey-addons-pairings.sql` (re-runnable), then `npm run verify:db`.
3. Owner → Traits → Add-ons: skim the derived roles and families, and override anything that's wrong.
4. Set `NEXT_PUBLIC_FLAG_CHECKOUT_PAIRINGS=true` on Vercel and redeploy. Watch the "Checkout pairings" widget.

## 6. Acceptance
- Cappucino with `flavours: ['nutty']` and `sweetness: 'any'`:
  - scores flavours 0.75 (it was 0);
  - carries `flavourAddon.label === 'Hazelnut syrup'`;
  - has the tag "Nutty add-on";
  - the modal shows the pill, and nothing extra is preselected.
- The same request with `sweetness: 'none'`: Hazelnut syrup still counts only when `baseLevel + 2 ≤ 3`.
- A pick that is natively nutty has no `flavourAddon`.
- Existing behaviour is unchanged:
  - no flavours requested → no `flavourAddon` anywhere;
  - every existing `tests/suggest*.test.ts` passes unchanged;
  - `npm run eval:suggest` does not get worse.
- Pairings:
  - a cart of one Americano gets ≤ 3 picks, at most one of them a drink, all from distinct categories;
  - an empty or unknown cart gets `[]`;
  - output is deterministic for fixed inputs;
  - every reason is ≤ 90 characters and passes `lintReason`.
- The checkout works the same with the flag off, with the API failing, and before the migration.
- `npx tsc --noEmit`, `npx vitest run`, `npm run lint` and `npm run build` are all clean.

---

## 7. Work plan (who builds what)

Opus wrote this spec and the shared contract in `lib/suggest/types.ts` (commit "Coffey add-ons & pairings: spec and shared types"). The packages below are built against that contract by cheaper models. Each package runs in its own git worktree and touches only the files it owns. Opus merges the packages, runs the full gate (tsc, vitest, lint, build, eval) and reviews the diff before it is pushed.

| Wave | Pkg | Model | Builds | Owns (files) |
|---|---|---|---|---|
| 1 | **A** | Sonnet | §2.2, §2.4, §3 add-on traits and flavour reach in the engine | `lib/suggest/addonTraits.ts` (new), `score.ts`, `engine.ts`, `templates.ts`, `brief.ts`, `app/api/suggest/route.ts` (overrides load only), `tests/suggestAddonTraits.test.ts`, `tests/suggestAddonReach.test.ts` |
| 1 | **B** | Sonnet | §4.1 pure pairings ranker | `lib/suggest/pairings.ts` (new), `tests/suggestPairings.test.ts` |
| 1 | **C** | Sonnet | §1.1 UI: card tip, modal pill and hint | `components/suggest/SuggestionCard.tsx`, `SuggestWizard.tsx`, `components/menu/MenuItemCustomizeModal.tsx`, `tests/suggestAddonUi.test.ts` |
| 1 | **D** | Haiku | §2.3 and §4.3 migration, the flag, verify-db | `supabase/2026-10-coffey-addons-pairings.sql` (new), `lib/flags.ts`, `scripts/verify-db.mjs` |
| 2 | **E** | Sonnet | §1.2, §4.2, §4.3 pairings API, checkout rail, events, attribution | `lib/suggest/serverData.ts` (new), `app/api/suggest/route.ts`, `app/api/suggest/pairings/**` (new), `components/checkout/PairsWellWith.tsx` (new), `app/checkout/page.tsx`, `lib/cart/CartContext.tsx`, `components/checkout/CheckoutForm.tsx` (payload only), `app/api/orders/route.ts` + `lib/suggest/attribution.ts` (pairing lines only), tests |
| 2 | **F** | Sonnet | §2.3 owner add-on traits API and editor | `lib/suggest/addonTraitsValidate.ts` (new), `app/api/owner/suggest/addon-traits/route.ts` (new), `components/owner/suggestions/AddonTraitsSection.tsx` (new), `TraitsTab.tsx` (mount only), tests |
| 2 | **G** | Haiku | §4.4 owner card, `/coffey` article section | `lib/suggest/pairingStats.ts` (new, + an optional server query file), `components/owner/suggestions/PairingsWidget.tsx` (new), `app/owner/suggestions/page.tsx` (mount only), `app/coffey/page.tsx` (one section), tests |
| 3 | — | Opus | Merge, full gate, adversarial review, eval, push | — |

**Why this split:**
- The scoring, ranking and UI packages carry the judgement calls, so Sonnet builds them.
- The SQL, the flag, the verify-db check, a stats query and article copy are pattern-following, so Haiku builds them.
- The contract (the types and this spec) is fixed before any package starts. The worktrees can therefore run in parallel without ever waiting on each other, and a merge conflict means someone broke file ownership.
