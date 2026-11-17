# Ask Coffey — the suggestion engine, v2 — Spec

**Companion to:** `docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md` (v1; still the reference for everything this file doesn't change), `docs/research/COFFEY-PSYCHOLOGY-RESEARCH.md` (the evidence behind §2), `docs/SECURITY-PLAYBOOK.md`
**Date:** 2026-09-29
**Scope:** The "Help me choose" engine becomes **Coffey**, a mascot-fronted pick-helper. Four changes:
1. **Brand.** "Not sure? Help me choose ☕" becomes **Ask Coffey**, and there is a new article page, `/coffey`.
2. **Questions.** The wizard is rebuilt around food-choice psychology: pick up to two feelings, a 5-point sweetness scale, and explicit "drink / sweet / savoury" choices. Every contradictory multi-select chip is removed.
3. **Traits v2.** Jev re-tags every item on 14 taste dimensions, up from 9: sweetness goes to 0–10, and strength, refreshment, indulgence, novelty, textures and a graded fit per mood are added. There is a real **Regenerate** path that works even when every row is confirmed.
4. **Decision v2.** Jev now sees each candidate's full taste profile and grades every candidate. Its judgement is blended with the deterministic ranking, and the three picks are forced to be different from each other. Picks carry "why it matches" tags. Coffee drinks open with the sugar option already set to the customer's sweetness choice.

Where this file and the v1 spec disagree, this file wins.

---

## 0. Why: what the live data showed (2026-09-29)

Read-only look at production (`menu_item_traits`, 117 rows; `suggestion_sessions`, 8 rows):

| Finding | Evidence | Consequence |
|---|---|---|
| **The decider is starved.** Jev's options were bare labels, `"Name — Category, ₹min"`, and the answer came from one softmax. | "Need a boost + iced" → Cappucino Iced, Latte Iced, Brookie Creme. On The Rocks, Americano Iced and Signature Iced Brew (all tagged `high` caffeine + `boost`) were not picked. "Boost" and "cool me down" returned the **same** two mochas. | Picks ignore the traits we already have; #2 and #3 copy #1. |
| **Traits don't discriminate.** | `afternoon` on 114/117 items; `comfort` on 70 and `celebrate` on 60; 60% at sweetness 3; 62% `rich`. No strength, refreshment, novelty or texture. | The scorer's terms are near-constant, so the shortlist is close to a coin toss among sweet, rich items. |
| **Contradictory chips.** "Something sweet" + "Less sugar", and "Light" + "Filling", can both be on. | Session: `extras=['chocolatey','filling','fruity']` → "fruity" silently lost. | Requests the engine can't satisfy. |
| **Regenerate is impossible.** Generate only re-tags missing/unconfirmed rows. | All 117 rows are confirmed (95 bulk-confirmed model rows, 22 owner-edited). | The owner can't re-tag anything. |
| **Descriptions are thin.** | 49/117 items have an empty description (waffle crepes, chips, cupcakes, cheesecakes, eatery). | The tagger only has the name to work from. |
| **Sugar is a customisation, not a fixed trait.** | "Choice of Sugar" (Stevia ₹10 / Brown Sugar / No Sugar / Normal, required) is on 35 items: every hot coffee except 2, all cold brews, 8/9 coffee cremes, all iced coffees. Nothing else has it. | "Not too sweet" must not hide a latte that can be made without sugar. Sweetness is inherent sweetness plus optional sugar. |

---

## 1. Customer flow

Entry points (all behind `flags.suggest`, unchanged):
- **Home hero:** the secondary button becomes **[Coffey icon] Ask Coffey**. Below the hero there's a "Meet Coffey" teaser card with the mascot, three one-line capabilities, **Ask Coffey** and **How Coffey works →** (`/coffey`).
- **Menu page banner:** [Coffey icon] "Can't decide? **Ask Coffey** →".
- **`/coffey`:** the article (§6.3). It is visible even when the flag is off. With the flag off, its call to action says "Coffey is almost ready" and links to the menu.

`/suggest` (title "Ask Coffey") is a 3-step wizard with Coffey on every step: the mascot plus a speech bubble.

### Step 1 — "How are you feeling?" (pick one or two)
Eight cards in a 2×4 grid, **multi-select capped at 2**. At least one is required to continue. With two picked, the rest are disabled and a hint says "Pick up to two — tap one to swap." The first one tapped is the *primary* mood.

| key | card | icon | the need it covers |
|---|---|---|---|
| `boost` | Tired — need a boost | ⚡ | low arousal; wants energy and caffeine |
| `focus` | Focused — working or studying | 🎯 | a goal state; steady alertness, not too sweet or heavy (**new**) |
| `unwind` | Stressed — need to unwind | 🧘 | high arousal, negative; soothing, easy on caffeine (**new**) |
| `cosy` | Calm & cosy | ☕ | low arousal, positive |
| `comfort` | Low — need some comfort | 🤗 | low arousal, negative; familiar, creamy, sweet-leaning |
| `celebrate` | Celebrating or treating myself | 🎉 | high arousal, positive; hedonic licence, indulgence |
| `cool` | Hot — cool me down | 🧊 | thermal need; cold and refreshing |
| `surprise` | Curious — surprise me | ✨ | novelty-seeking |

**Why two:** mixed states happen, and a feeling often comes with a physical need ("tired **and** hot" = a strong iced coffee). The research found no test of an "up to N" cap. Two is a judgement call that keeps a clear primary signal, and most people will pick one.

**Why `unwind` was added:** the v1 set had no high-arousal negative state, and the research brief shows that stress changes what people eat and drink. See `docs/research/COFFEY-PSYCHOLOGY-RESEARCH.md`.

### Step 2 — "What sounds good?"
All groups are optional and preselected to their neutral default, except "What would you like", which defaults to **A drink**.

| group | format | options → engine value | notes |
|---|---|---|---|
| **What would you like?** | multi, ≥1 (the last one can't be un-ticked) | ☕ A drink → `drink` · 🧇 Something sweet to eat → `dessert` · 🥪 Something savoury → `food` | Replaces "Something to eat", "Filling" and the implicit v1 composition rule. Picking two gives a pairing (§4.4). |
| **Hot or iced?** | single | Hot · Iced · Either | Shown only while "A drink" is ticked (desserts and food are never filtered by temperature). |
| **Coffee?** | single | Strong coffee → `base:coffee, strength:strong` · Smooth & milky coffee → `base:coffee, strength:mild` · No coffee (tea's fine) → `base:no_coffee` · No caffeine at all → `base:no_coffee, needs:[no_caffeine]` · Either → `base:either, strength:any` | Shown only while "A drink" is ticked. The options are worded to be mutually exclusive. Hint: "Strong = bold and espresso-forward. Smooth = milky and mellow." Strength is a *soft* preference; coffee / no coffee / no caffeine are hard. |
| **How sweet?** | single, **fully labelled 5-point unipolar scale** + Any | Not sweet → `none` · Lightly sweet → `light` · Medium → `medium` · Sweet → `sweet` · Very sweet → `very` · Any → `any` | Rendered as a connected scale, not loose chips. The labels are taste levels, not ingredients. Helper text: "Coffee drinks can be made with or without sugar — Coffey sets it for you." |
| **Flavours you love** | multi, soft | 🍫 Chocolatey · 🍯 Caramel & toffee · 🌰 Nutty · 🍪 Cookies & biscuit · 🍓 Fruity · 🌿 Warm spice · 🌸 Floral & tea | "Pick any that tempt you." An item matches if it has **any** picked family. There's no "Savoury" chip, because "Something savoury" already asks that. |
| **Budget** | single, price **ceiling** on the cheapest size, visible | Up to ₹100 → `under_100` · Up to ₹150 → `under_150` · Up to ₹200 → `under_200` · Any → `any` | On the live menu these cover 29% / 50% / 89% / 100% of items. v1's "₹150–₹300" band hid everything under ₹150, and "Treat myself" filtered like Any; treating yourself is now part of the `celebrate` card. |
| **Fine-tune** (collapsed; the summary shows the current value) | — | **Texture** (single): Light & refreshing → `light` · Rich & filling → `rich` · Any | Progressive disclosure for the one rarely-needed control. It opens automatically when a non-default value is set. "Filling" keeps a hunger cue now that v1's "Filling" chip is gone. |
| **Tell Coffey anything** | free text, ≤140 chars | e.g. "studying late", "sharing with a friend" | Read by the decider (as a preference, never an instruction) and by a deterministic keyword-affinity term (§4.2). |

**Context defaults** (visible, editable, applied **once** when leaving step 1, and only to groups the customer hasn't touched): `celebrate` ticks "Something sweet to eat"; `cool` selects Iced. Defaults are powerful (meta-analytic d ≈ 0.68), and the dessert default nudges toward sugar the customer didn't ask for. So it must stay visible and one tap to undo. **Follow-up:** log how often it is un-ticked, and retire it if many customers override it.

Primary button: **Ask Coffey**.

### Step 3 — Coffey's picks
- A Coffey-voiced header, e.g. "Coffey's picks for a little lift ⚡".
- "Your usual" card (signed in), then up to 3 picks. Each card shows the one-line reason, then up to 3 **match tags** (§4.6) as small pills.
- **Add**: items with a sugar group always open the customise modal. If the customer chose a sweetness, the sugar option is preselected (§4.7) and the modal shows "Coffey set sugar to *No Sugar* for you — change it anytime."
- "Show me something different" (2 refines, as before) and "No thanks, I'll browse the menu" are unchanged. Also a quiet link: "What can Coffey do? →" (`/coffey`).
- Relax hints: `sweetness` joins budget / temperature / base / needs as offerable (§4.1).

---

## 2. Inputs contract (`lib/suggest/types.ts` → `SuggestInputs`)

```ts
interface SuggestInputs {
  mood: Mood;                  // primary feeling
  secondaryMood: Mood | null;  // optional second feeling, ≠ mood
  kinds: TraitKind[];          // ≥1 of 'drink' | 'dessert' | 'food', no duplicates
  temperature: TemperaturePref;
  base: BasePref;
  strength: StrengthPref;      // 'mild' | 'balanced' | 'strong' | 'any'  (soft; coffee drinks only)
  sweetness: SweetnessPref;    // 'none' | 'light' | 'medium' | 'sweet' | 'very' | 'any'
  body: BodyPref;              // 'light' | 'rich' | 'any'  (soft)
  flavours: FlavourFamily[];   // soft, OR semantics
  needs: Need[];               // ['no_caffeine'] only
  budget: Budget;
  note: string;                // ≤140, UNTRUSTED
}
```

**Backward compatibility.** `validateSuggestInputs()` accepts **v1 or v2** bodies and always returns v2. That covers old browser bundles, stored sessions and the eval fixtures. v1 is detected by the absence of both `kinds` and `sweetness`. `upgradeV1Inputs()` (pure, `lib/suggest/inputs.ts`) maps it:

| v1 | v2 |
|---|---|
| `mood` | `mood`; `secondaryMood: null` |
| (always) | `kinds` starts as `['drink']` |
| `extras: eat` | `kinds` += `dessert`, `food` |
| `extras: filling` | `kinds` += `dessert`, `food`; `body: 'rich'` |
| `extras: light` | `body: 'light'` (both light and filling → `body: 'any'`) |
| `extras: sweet` | `kinds` += `dessert`; `sweetness: 'sweet'` |
| `mood: celebrate` | `kinds` += `dessert` (the v1 composition rule) |
| `extras: chocolatey` / `fruity` | `flavours` += `chocolatey` / `fruity` |
| `needs: less_sugar` | `sweetness: 'light'` (wins over `extras: sweet`); removed from `needs` |
| `budget: under_150` / `150_300` / `treat` / `any` | `under_150` / `any` / `any` / `any` |
| — | `strength: 'any'`; `sweetness: 'any'` and `body: 'any'` unless set above |

This is a lossless mapping of v1 *behaviour*, which is how the v1 eval fixtures stay meaningful.

---

## 3. Traits v2

### 3.1 Schema (`supabase/2026-10-coffey-traits-v2.sql`, re-runnable)
New nullable columns on `menu_item_traits`. `null` means "not yet tagged at v2", and every consumer treats it as neutral.

| column | type / check | meaning |
|---|---|---|
| `sweetness_level` | smallint 0–10 | **inherent** sweetness as the kitchen makes it, *not* counting optional table sugar |
| `intensity` | smallint 0–3 | flavour strength: gentle → bold |
| `refreshment` | smallint 0–3 | how refreshing / thirst-quenching |
| `indulgence` | smallint 0–3 | everyday → a real treat |
| `novelty` | smallint 0–3 | familiar classic → adventurous |
| `textures` | text[] ⊆ `TEXTURES`, ≤3 | e.g. `silky`, `crunchy` |
| `mood_fit` | jsonb object, keys ⊆ `MOODS`, values 0–3 (1 decimal) | graded fit per feeling |
| `traits_version` | smallint not null default 1 | `2` = tagged with this spec (`CURRENT_TRAITS_VERSION`) |

The migration also widens the `moods` check to include `focus` and `unwind`. It backfills `sweetness_level` from the legacy 0–3 `sweetness` where null (0→0, 1→3, 2→6, 3→9), so the new scale works before the regenerate runs. The legacy `sweetness` column stays and is **derived** on every v2 write (`legacySweetnessFromLevel`: ≤1→0, ≤4→1, ≤7→2, else 3), so the taste profile and older code paths keep working.

### 3.2 Tagging with Jev (`lib/suggest/traitsPrompt.ts`)
One `systemOne` call per item, same pool/budget model as v1. The `state` carries name, category, parent, description, **sizes with prices**, **customisation groups with options**, and a `related_description`. The related description is used when the item's own description is empty: it is the description of another menu item sharing a distinctive name token (e.g. "Oreo Heaven Cupcake" ← "Oreo-Heaven" waffle). Generic words (waffle, creme, crepes, chips, cupcake, slice, iced, latte, signature, hioc's, stuffed, cheesecake, cold, brew, hot) never count as distinctive.

Questions (`TRAIT_QUESTION_COUNT` = 69, derived from the vocabularies in `lib/suggest/traitVocabulary.ts`):

| field | Jev question | stored as |
|---|---|---|
| temperature, caffeine, kind, body | `choice`; criteria name concrete examples from this menu (e.g. caffeine `high` = espresso, americano, long black, cold brew; chocolate/cocoa/Nutella/Oreo are ALWAYS `none`) | choice |
| is_coffee | `noul` with true/false criteria | P ≥ 0.5 |
| sweetness_level | `score`, 6 anchors 0–5 with menu examples, asked "as the kitchen makes it, not counting optional table sugar" | `clamp(round(score × 2), 0, 10)` |
| intensity, refreshment, indulgence, novelty | `score`, 4 anchors each | `clamp(round(score), 0, 3)` |
| mood fit ×8 | `score` 0–3: not a fit / could work / good fit / ideal, with the §1 need descriptions | `mood_fit[m] = round(score, 1)`; `moods` = fit ≥ 2 (max 3, fit desc, ties in `MOODS` order), else the single best |
| dayparts ×4 | `noul`, with hour ranges (morning 6–12, afternoon 12–5, evening 5–9, late after 9) and examples | P ≥ 0.6, max 3, else the single best |
| textures ×12 | `noul` per word | P ≥ 0.6, max 3, by P desc |
| flavours ×35 | `noul` per note of `FLAVOR_VOCABULARY` | P ≥ 0.6, max 5, by P desc → `flavor_notes` |

**Needs review** (display-only, as v1): the choice confidence for temperature/caffeine/kind is < 0.6, **or** is_coffee is in (0.35, 0.65), **or** the sweetness score's confidence is < 0.5.

### 3.3 Regenerate (`POST /api/owner/suggest/traits/generate`)
- **Before the migration:** probe `traits_version`. If the column is missing, return **409** "Apply supabase/2026-10-coffey-traits-v2.sql in Supabase, then press Regenerate again." Never 500.
- **Targets:** rows that are missing, OR `confirmed = false`, OR `traits_version < CURRENT_TRAITS_VERSION`.
- **Write rules:**
  - Owner-edited rows (`source = 'owner'` and confirmed) keep **every v1 field exactly as the owner left it**. Only the v2 columns are written, plus `traits_version = 2`; `confirmed` and `source` are unchanged.
  - Every other target gets the full v2 row, `source = 'opus'` (the schema's label for any model-tagged row), `confirmed = false`, `traits_version = 2`, `updated_at = now`.
- **Race guard:** re-read `(confirmed, source, traits_version)` after tagging. Drop any row that became confirmed during the run (unless it was already an owner row, which gets the v2-only merge).
- **Resumable:** anything that didn't finish in the ~50 s budget stays at the old version, so pressing again continues from there. The response keeps v1's fields plus `remaining` (targets still below the current version).
- The v1 AC "confirmed rows are byte-identical after Generate" now reads: **confirmed rows already at the current trait version are byte-identical after Generate; owner-edited rows never lose an owner-set v1 value.**

### 3.4 Owner Traits tab
- A banner shows "N items need Coffey's new taste profile" with a **Regenerate with Jev** button. It explains that owner-edited rows keep their edits and model rows come back unconfirmed for a quick review.
- Each row adds compact v2 read-outs: a 0–10 sweetness bar; intensity, refresh, treat and novelty as 0–3 values; textures; top moods. Inline edit covers the v2 fields; the PATCH validator accepts them.
- Wide table → horizontal scroll on phones.

---

## 4. Engine v2

### 4.1 Hard filter (`lib/suggest/filter.ts`), all must hold
1. It has a traits row, it is available, and it is not excluded (unchanged).
2. **Composition:** `inputs.kinds.includes(traits.kind)`. This replaces the v1 eat/sweet/filling/celebrate rule, which lives on only through `upgradeV1Inputs`.
3. Temperature: drinks only (unchanged).
4. Base / caffeine (unchanged).
5. **Sweetness ceiling.** If `sweetness ≠ any`, exclude when `baseLevel > target + SWEETNESS_SCALE.tolerance` (3). Here `baseLevel = sweetnessLevel(traits)`: inherent sweetness, which optional sugar can raise but never lower. Targets: none 0, light 3, medium 5, sweet 7, very 10. Legacy rows map 0→0, 1→3, 2→6, 3→9, which reproduces v1's "less sugar excludes sweetness 3" exactly.
6. **Budget:** the cheapest size must be ≤ `BUDGET_CAPS[budget]`, with no cap for `any`. These are ceilings, not bands.

Relax hints: order `budget, temperature, sweetness, base, needs`. For `sweetness` the message is "Nothing quite that light on sugar fits right now — want to see a little sweeter options?" and the relax sets it to `any`. `kinds` is **never** offered: silently adding food is the v1 bug.

### 4.2 Score (`lib/suggest/score.ts`), each term in [0, 1]
`score = 0.30·mood + 0.25·preference + 0.10·daypart + 0.20·profile + 0.10·popularity + 0.05·note`, then the −0.1 recent-item penalty, then clamp. The weights are exported constants.
- **mood** = the mean over `[mood, secondaryMood]` of `moodFit(traits, m)`. That is `mood_fit[m] / 3` when present.
  Otherwise it is a **graded legacy fit**, `0.5·[m ∈ moods] + 0.5·g(m)`. The v1 all-or-nothing bonus gave a thick shake the same "cool me down" score as an iced americano; the 2026-09-29 baseline eval hit 0% on cool and celebrate. `g` is:

  | mood | `g(m)` |
  |---|---|
  | boost | caffeine high 1 / medium 0.6 / low 0.3 / none 0 |
  | focus | `caff × sweet × bodyF`, where `caff` = high/medium 1, low 0.5, none 0; `sweet` = level ≤ 3 → 1, ≤ 6 → 0.6, else 0.2; `bodyF` = rich 0.5, else 1 |
  | cosy | hot → rich 1 / medium 0.7 / light 0.4; otherwise 0 |
  | comfort | `max(rich 1 / medium 0.5 / light 0, level / 10)` |
  | celebrate | dessert → 1; otherwise `level / 10` |
  | unwind | `{none: 1, low: 0.7, medium: 0.3, high: 0}[caffeine] × (hot ? 1 : 0.8)` |
  | cool | iced → light 1 / medium 0.7 / rich 0.3; otherwise 0 |
  | surprise | 1 if the item is not in the profile's top items (always 1 for a guest) |

  Here `level = sweetnessLevel(traits)`.
- **mood, graded rows only: character tie-break.** When `mood_fit[m]` is present, `moodFit = (1 − CHARACTER_SHARE)·clamp01(mood_fit[m] / 3) + CHARACTER_SHARE·moodCharacter(m)`, with `CHARACTER_SHARE = 0.25` (exported). When a mood's top grade is shared by most of the menu (81 of 117 items have `celebrate` fit 3), `mood_fit / 3` alone ties them and the ranker returns the same three items for every request; the mood's defining traits break the tie. The legacy path is unchanged. `moodCharacter` is in [0, 1] and reads the v2 fields (`x/3` for 0–3 fields). If any v2 field its formula needs is null or undefined, it returns `g(m)` (the table above) instead:

  | mood | `moodCharacter(m)` |
  |---|---|
  | celebrate | `0.6·indulgence/3 + 0.25·novelty/3 + 0.15·[kind = dessert]` |
  | comfort | `0.5·indulgence/3 + 0.3·(1 − novelty/3) + 0.2·{rich 1 / medium 0.5 / light 0}[body]` |
  | cosy | `0.5·[hot] + 0.3·(1 − refreshment/3) + 0.2·(hot ? {rich 1 / medium 0.7 / light 0.4}[body] : 0)` |
  | boost | `0.7·{high 1 / medium 0.6 / low 0.3 / none 0}[caffeine] + 0.3·intensity/3` |
  | focus | `g('focus')` (no v2 dependency) |
  | unwind | `0.7·g('unwind') + 0.3·(1 − intensity/3)` |
  | cool | `0.7·refreshment/3 + 0.3·[iced]` |
  | surprise | `0.7·novelty/3 + 0.3·(item not in the profile's top items ? 1 : 0)` |

  The result is clamped to [0, 1].
- **preference** = the mean of the sub-fits that apply (1 when none apply):
  - sweetness (≠ any): `achievable = adjustable ? clamp(target, base, min(10, base + SWEETNESS_SCALE.sugarAdds)) : base`; fit = `1 − |achievable − target| / 10`.
  - body (≠ any): light → light 1 / medium 0.5 / rich 0. With `refreshment` present, the light fit is averaged with `refreshment / 3`. Rich → rich 1 / medium 0.5 / light 0.
  - strength (≠ any, **coffee drinks only**): intensity = `traits.intensity ?? {high:3, medium:2, low:1, none:0}[caffeine]`. strong → `intensity / 3`; mild → `1 − intensity / 3`; balanced → `1 − |intensity − 1.5| / 1.5`.
  - flavours (non-empty): 1 if `flavourFamiliesOf(name, flavor_notes)` shares any family with `inputs.flavours`, else 0.
- **daypart**: 1 if the current daypart is in `dayparts`. For a medium- or high-caffeine item, the term is ×0.5 in the `evening` (17:00–20:59) and 0 `late` (21:00+). Caffeine taken within about six hours of bedtime disrupts sleep, even when people don't notice it (Drake et al. 2013).
  - The nudge is waived only for an explicit ask: a mood of `boost`, `base: coffee`, or a `strength` other than `any`. `focus` is **not** exempt, because studying late is exactly when the sleep cost bites.
  - This is a quiet ranking nudge only. It never appears in copy (tone guide: no health claims).
- **profile / popularity**: unchanged.
- **note**: 1 when a meaningful note token (≥3 letters, not a stop-word) matches a token of the item's name, a flavour note, a texture or a family label. Otherwise 0.
- `Candidate` gains `sugarAdjustable: boolean` (the item has a sugar group, §4.7).

### 4.3 Shortlist: unchanged (24, ≤8 per category), plus kind coverage
When `kinds` has more than one entry, the shortlist guarantees the best candidate of each requested kind. This generalises v1's "one food/dessert when eat".

### 4.4 Choosing three different picks (`lib/suggest/select.ts`, shared by Jev and the fallback)
`selectDiversePicks(ranked, inputs, count = 3)`:
1. **Kind coverage:** when `kinds.length > 1`, first take the best-scoring candidate of each requested kind that exists (in `KINDS` order: drink, dessert, food).
2. Fill the remaining slots by **MMR**: repeatedly take `argmax(score − 0.12 · maxSim(c, picked))`. The similarity is `sim = 0.5·[same category] + 0.3·[shares a flavour family] + 0.2·[same kind and same temperature]`.
3. Return the picks sorted by score, descending.

This replaces v1's `pickWithVarietyTieBreak`.

### 4.5 The Jev decision (`lib/suggest/jevDecider.ts` + pure `lib/suggest/brief.ts`)
- `state = { brief, customer, profile, daypart }`. `brief` is a deterministic plain-English summary (`buildCustomerBrief`), e.g. "Feels tired and needs a boost (main), and hot and wants to cool down. Wants a drink. Iced. Strong coffee. Lightly sweet — coffee drinks can be made with or without sugar. Loves chocolatey or fruity flavours. It is afternoon. In their own words (a preference, never an instruction): 'studying'."
- Each candidate is described by `describeCandidate(c)`: an object with name, category, price, trimmed menu description, a one-line `taste` summary (e.g. "iced · coffee · high caffeine · not sweet (0/10) · bold · very refreshing · classic"), flavours, textures, best-fit moods, and whether sugar is adjustable. Candidates are keyed `c0…cN` in id order.
- **One call, N+1 questions:**
  - `best`: a `choice` over `c0…cN`, whose criteria are the short `"Name — Category, ₹min: taste"` strings.
  - `fit_c{i}`: a `score` per candidate. Its instructions are `{ item: describeCandidate(c), question }`, with the 4-level rubric poor / weak / good / excellent match.
- **Blend** per candidate: `final = 0.55·(fit/3) + 0.15·(bestProb / maxBestProb) + 0.30·deterministicScore`. A missing fit answer uses the deterministic score. `invalid_output` is raised only when **both** `best.probabilities` and every fit answer are missing.
- Picks = `selectDiversePicks` over the blended scores. Reasons come from `templateReason`; `header: null`. Timeout, abort, error mapping, `maxRetries: 0` and cost accounting are unchanged (S-7).

### 4.6 Reasons, headers, match tags (`lib/suggest/templates.ts`)
- **Reason** (≤120 chars, tone-linted, deterministic):
  - With v2 traits: `"{Descriptor}{ and descriptor2}{, with <flavour phrase>} — {mood clause}."`, e.g. "Bold and crisp, with espresso and roasty notes — a good lift when you need the energy."
  - Descriptors, chosen by what the customer asked for first:
    - intensity (drinks): 3 bold, 2 full-flavoured, 1 mellow, 0 gentle
    - sweetness (only when the customer set one, or it is ≤1 or ≥8): 0–1 unsweetened, 2–3 lightly sweet, 4–5 medium-sweet, 6–8 sweet, 9–10 dessert-sweet. These bands line up with the customer scale (targets 0 / 3 / 5 / 7 / 10), so an item that hits the target reads as the customer's own word
    - refreshment ≥2: crisp and refreshing
    - the first texture
  - Flavour phrase: the customer's requested family if it matched (chocolatey → "rich chocolate notes", caramel → "buttery caramel notes", nutty → "toasty nutty notes", biscuit → "cookie-crumb notes", fruity → "a bright, fruity flavour", spiced → "warm spice", floral → "delicate floral notes", savoury → "cheesy, savoury comfort"). Otherwise the top two flavour notes.
  - Mood clause: `MOOD_INFO[m].clause` (the v1 wording, plus `focus` → "easy to sip while you focus" and `unwind` → "soothing and gentle, easy to unwind with").
  - Without v2 traits the reason falls back to the exact v1 shapes.
- **Headers:** "Coffey's picks for a little lift ⚡", "…to help you focus ☕", "…for a cosy moment ☕", "…for some comfort ☕", "…to celebrate 🎉", "…to cool you down 🧊", "…to surprise you ✨".
- **Match tags** (`matchTagsFor`, ≤3, fixed vocabulary, in priority order):
  1. mood (fit ≥ 2 or membership): `MOOD_INFO[m].tag`, i.e. A proper lift / Good for focus / Calming / Cosy / Comforting / A treat / Refreshing / Something new
  2. the matched requested flavour family label
  3. the sweetness label (Not sweet / Lightly sweet / Medium sweet / Sweet / Very sweet), only when the achievable sweetness falls in the **same band** as the target, so the tag never contradicts the reason's descriptor
  4. Strong / Smooth & milky, when requested and matched
  5. Iced / Hot, when requested
  6. Light & refreshing / Rich & filling, when requested and matched
  7. the budget label (Up to ₹100 / Up to ₹150 / Up to ₹200)
  8. Caffeine-free, when requested

### 4.7 Sugar presets (`lib/suggest/sugar.ts`, pure)
- `findSugarGroup(item)`: the addon group whose `name` is `Sugar` (case-insensitive) or whose `display_name` matches /sugar/i, **and** which offers both a "No Sugar" and a "Normal" option.
- `sugarPresetFor(item, pref, baseLevel)`: `null` for `any` or with no sugar group. Otherwise choose between **No Sugar** (achieves `baseLevel`) and **Normal** (achieves `min(10, baseLevel + 3)`), whichever is closer to the target; a tie goes to No Sugar. It never auto-selects a paid option (Stevia) or a flavour choice (Brown Sugar), and never an unavailable option.
- The engine attaches `sugarPreset: { groupId, optionId, label }` to each pick and to the usual. The wizard passes it to `MenuItemCustomizeModal` via `initialSelection(item, presets)`.

---

## 5. Response contract additions
`SuggestionPick` gains `matchTags?: string[]` and `sugarPreset?: SugarPreset | null`. `RelaxHint.constraint` gains `'sweetness'`. Both are optional, so old clients ignore them.

## 6. UI

### 6.1 Coffey the mascot (`components/coffey/`)
An inline-SVG coffee-cup character in brand tokens only:
- a charcoal outline, a white cup, a tan-dark coffee top and handle, and steam wisps in `tan` (decoration only);
- a friendly face: two eyes, a smile, soft cheeks;
- expressions `happy | thinking | wink`;
- sizes from 20 px (inline in buttons) to 160 px (the article hero).

It is decorative (`aria-hidden`) unless given a `title`. The steam animation respects the global reduced-motion rule. `CoffeyBubble` is the mascot plus a speech bubble for the wizard.

### 6.2 Copy voice
Warm, brief, first person ("I'm Coffey"), and bound by the v1 tone guide. Coffey never mentions spending, never pressures, and makes no health claims.

### 6.3 The article (`/coffey`, "Meet Coffey")
Sections:
1. **Hi, I'm Coffey**
2. **What I can do**, with capability cards
3. **How I choose**, as a 4-step pipeline: your rules → shortlist → Jev decides → three different picks
4. **Why I ask what I ask**, the research in plain words, no invented statistics
5. **Sugar, your way**
6. **Your data**
7. **What I can't do** (no chat, no allergen answers — ask the counter)
8. A call to action

Numbers on the page come from code constants, so they stay true: `MOODS.length`, `TRAIT_DIMENSIONS.length`, `TRAIT_QUESTION_COUNT`, `FLAVOUR_FAMILIES.length`. No accuracy percentages, no speed claims beyond "in a few seconds".

## 7. Rollout
1. Merge. Nothing breaks before the migration: v2 columns are optional in the types, and the engine treats them as neutral.
2. The owner runs `supabase/2026-10-coffey-traits-v2.sql` in Supabase. This is safe to re-run, and `npm run verify:db` checks it.
3. Owner → Suggestions → Traits → **Regenerate with Jev**, pressed again until "0 remaining". Owner-edited rows keep their edits.
4. Review the "needs review" items, then Confirm all visible.
5. `npm run eval:suggest` (fallback), plus `--llm` when `TYPESAFE_API_KEY` is set.

---

## 8. What the research changed (2026-09-29)
`docs/research/COFFEY-PSYCHOLOGY-RESEARCH.md` reviewed the first draft of §1. It found no page-level verification of DOIs (the resolvers were blocked where it ran), and it flags each unverified reference. Adopted:
- the `unwind` mood, completing the valence × arousal circumplex
- budget as visible **ceilings**
- no Savoury flavour chip, since it duplicated "Something savoury"
- mutually exclusive coffee options with a strength hint
- taste-level sweetness labels ("Not sweet", not "No sugar")
- "Rich & filling", which keeps a hunger cue
- a caffeine ramp from 17:00, with `focus` no longer exempt

Kept as judgement calls, with no direct evidence either way: the two-mood cap, and the 0/3/5/7/10 mapping of the five sweetness labels onto the item scale.


## 9. Measured (2026-09-29, before regenerating with Jev)
This is `npm run eval:suggest -- --min 0 --now 2026-09-29T15:00:00+05:30`, the deterministic fallback ranker, against the live menu (116 customer items). It uses the **old** v1 traits, because the migration and Regenerate haven't run yet. "Before" is origin/main's engine on the same menu, the same 64 v1 scenarios and the same pinned clock.

| | Before | After |
|---|---|---|
| Top-3 hit rate | 31.3% (20/64) | **46.9% (30/64)** |
| boost | 9.1% | 81.8% |
| surprise | 40.0% | 70.0% |
| cosy | 27.3% | 36.4% |
| comfort | 50.0% | 30.0% |
| celebrate | 9.1% | 9.1% |
| cool | 54.5% | 54.5% |
| Distinct pick sets / scenarios | 0.51 | 0.63 |
| Most repeated item | 34.9% of scenarios | 23.8% |

The result depends on the time of day, and "after" wins at every clock tried:

| Clock | Before | After |
|---|---|---|
| 10:30 | 46.9% | 57.8% |
| 15:00 | 31.3% | 46.9% |
| 19:00 | 18.8% | 34.4% |
| 22:30 | 20.3% | 46.9% |

**Read with care:**
- A random top-3 from each scenario's hard-filtered pool scores 19.0%.
- 14 of the 64 draft labels include items that are no longer on the menu or that break the scenario's own hard rules. The harness prints a label audit.
- The 14 new v2 scenarios reach 86–100%, but their pools are much tighter, so they are an easier test.
- What remains is mostly **ties from the old traits**. The legacy mood term is 1.0 for 56 of 116 items on comfort and 36 on celebrate, so the top score is often a 30+-way tie.
  - The harness has no popularity data, so ties fall to id order. In production, popularity breaks them.
  - Jev's graded `mood_fit` (§3.2) exists to separate exactly these items.
- **Re-run after Regenerate, with the same `--now`**, for a like-for-like number. Add `--llm` once `TYPESAFE_API_KEY` is available to measure the Jev decision.

---

## 10. v2.1: fewer questions, choices kept (2026-11-17)

Where this section and §1, §4.2–§4.6 disagree, this section wins. Nothing here changes the request contract (§2), the hard filter (§4.1), the score weights (§4.2), the traits (§3) or any table.

### 10.0 Why: what the live data showed

Read-only look at production (`suggestion_sessions`, `suggestion_events`, 26 Sep – 1 Nov) and Vercel page views (19 Oct – 17 Nov). The sample is small and part of it is the team testing, so read these as direction, not as rates.

| Finding | Evidence | Consequence |
|---|---|---|
| **People leave inside the wizard.** | 14 visitors opened `/suggest` in the last 30 days; 2 reached the picks. Nothing is logged before the "Ask Coffey" press, so the step they left on is unknown. | Step 2 was 28 tappable options over 3–4 phone screens, with the only way forward at the bottom. |
| **Those who finish work hard, then walk away.** | 47 sessions, 40 first asks. Median 4–5 of the optional groups set. 6 sessions added a pick to the cart (13%; the gate in the v1 spec §6 is 25%), 1 ordered, 21 dismissed. | The picks did not repay the effort. |
| **Three groups are barely used.** | Of 32 v2 first asks: sweetness set in 81%, flavours 78%, hot/iced 70%, a coffee choice 59%, a second feeling 47%; budget 17%, texture 16%, the note 7.5%, "No caffeine at all" 0. | Budget, texture, the note and caffeine-free move behind one "More options". |
| **The choices people make most are the ones the engine kept least.** | Flavours, strength, sweetness and texture were soft terms sharing one 0.25 weight (and about 7.5% of the final score on the Jev path). Replaying the 40 live first asks through the old engine: the pick carried the requested flavour 49% of the time, the strength 76%, the sweetness 68%. | A customer who taps "Chocolatey" and gets none stops believing the rest. |
| **Tags could claim what the item doesn't have.** | 30 of 118 replayed picks carried a "<Flavour> add-on" tag (true only with a paid extra) or a budget tag that could contradict the price range on the card; an intensity-2 latte was tagged "Strong". | Tags now come from the same test that picks the items. |
| **The menu can't serve some chips at all.** | Caramel is on 3 drinks and 2 desserts; no dessert is floral; no food item carries any flavour family. | Don't offer what can't be served. |

### 10.1 The wizard

**Step 1, one feeling, one tap.** Tapping a card selects it and goes straight to step 2: no "Next", no second feeling. The request still has `secondaryMood` (always `null` from this wizard; the API still accepts one). Why: a second feeling was averaged with the first, halving its pull, and it cost a decision plus a tap. The research (§3, §6 of the brief) supports two feelings but calls the cap untested; this is a friction trade, and `MAX_MOODS` stays in `types.ts` if it is ever wanted back. The two context defaults of §1 (Celebrating ticks "Something sweet to eat"; "cool me down" selects Iced) are unchanged.

**Step 2, five visible groups.** Every chip is a toggle: tap to choose, tap again to clear, and cleared means no preference. There is no "Either" or "Any" chip.

| group | options → engine value | notes |
|---|---|---|
| **What would you like?** | A drink → `drink` · Something sweet to eat → `dessert` · Something savoury → `food` | multi, at least one, as before |
| **Hot or iced?** | Hot · Iced | drinks only; cleared = `either` |
| **Coffee?** | Strong coffee → `base:coffee, strength:strong` · Smooth & milky coffee → `base:coffee, strength:mild` · No coffee → `base:no_coffee` | drinks only; cleared = `base:either, strength:any` |
| **How sweet?** | Not sweet → `none` · Lightly sweet → `light` · Sweet → `sweet` | three levels, not five: the menu holds 16 of 118 items at levels 1–5 and 54 at 9–10, so the engine could not tell "Medium" from "Sweet" from "Very sweet". The research's five-point advice (§4 of the brief) is about measuring attitudes and is flagged there as weak for sweetness. `medium` and `very` are still valid on the wire. |
| **Any flavour you fancy?** | the seven families | multi, OR. A family is offered only when the ticked kinds hold at least `FLAVOUR_OFFER_MIN` (3) items that carry it themselves; the group is hidden when none qualifies. |
| **More options** (one collapsed section; its closed state lists what is set inside) | Caffeine-free only → `needs:[no_caffeine]` · Budget: Up to ₹100 / ₹150 / ₹200 · Texture: Light & refreshing / Rich & filling · the note | Caffeine-free switches Strong and Smooth off (there is no caffeine-free coffee). |

That is at most 18 visible options instead of 28. The primary button, **Show my picks**, is sticky at the bottom of the screen (lifted above the floating cart bar when the cart has items), so a customer can stop choosing at any point. The shortest path to picks is two taps.

**No dead ends.** The page loads one compact record per orderable item (`lib/suggest/facets.ts`, `menuFacets`: for every chip, whether the item keeps it, is ruled out by it, or is unaffected), computed on the server with the engine's own `passesHardConstraints` and `satisfiesChoice`. A chip is greyed out when no item of the ticked kinds keeps it together with the choices already made in the other groups ("Greyed out: not on the menu with your other choices."). A selected chip is never greyed, so it can always be cleared. If the record fails to load, every chip stays enabled and the engine's own honesty (§10.2, §10.4) is the backstop.

**Results.** Under the heading: "You asked for: …" in the customer's own chip words, with **Change** (back to step 2, everything kept). After "Show me something different": "Here are some different picks." The error state has **Try again** (same request). The empty state mentions the relax option only when one is offered.

### 10.2 Honoured choices (`lib/suggest/promises.ts`)

Four choices (`HONOURED_CHOICES`, in priority order: flavours, strength, sweetness, texture) are kept whenever the menu can keep them. One predicate, `satisfiesChoice(choice, item, inputs)`, decides everywhere: narrowing, pins, tags, the reason's sweetness word, `misses`, `unmet` and the wizard's greyed chips.

| choice | applies to | kept when |
|---|---|---|
| flavours | drinks, desserts | the item carries a requested family itself (name or notes). A flavour only an add-on supplies does not count. |
| strength | coffee drinks | Strong: intensity 3. Smooth & milky: intensity ≤ 2. (`balanced`: 1–2.) A non-coffee drink never keeps it. |
| sweetness | drinks, desserts | the **delivered** level (`deliveredSweetness`: the item's own level, or with the sugar option Coffey preselects) is inside `SWEETNESS_BANDS`: none 0–3, light 2–4, medium 4–6, sweet 5–10, very 8–10. "Not sweet" runs to 3 because an unsweetened latte or cappuccino is tagged 2–3 for its milk. The one-sided hard ceiling of §4.1 is unchanged and still applies first. |
| texture | everything | `traits.body` equals the choice. |

`honourChoices(filtered, inputs)` runs between the hard filter and scoring and returns `{ pool, pinnedIds }`. Per requested kind, candidates are ranked into tiers by which active choices they keep, lexicographically in priority order (keeping the flavour outranks everything after it). Tiers are taken best-first until at least `need` items are in: `need` is 3 when only one requested kind has candidates, otherwise 2 per kind (`PROMISE_MIN_POOL`). The tier that reaches `need` is taken whole; items in the tiers before it are **pinned**. So:
- when enough items keep every choice, the pool for that kind is exactly those, and Jev and the ranking choose among them;
- when only one or two do, they are pinned and the next-best tier fills the remaining slots;
- it only ever removes candidates, never takes a request that could fill three picks below three, and never touches `relaxHintFor` or the usual (both still use the hard filter alone).

Pinned items are always in the shortlist (`buildShortlist(scored, inputs, pinnedIds)`), and `enforcePins` in `engine.ts` gives them a slot on every path (Jev, fallback, after the usual is removed): it replaces the last unpinned pick of the same kind, or failing that the last unpinned pick of a kind that holds two or more picks, so no requested kind loses its only pick; pinned picks come first. Why flavours first: it is what the item *is* and the choice customers use most; strength is fixed by the recipe; sweetness can still be changed at the counter and has the hard ceiling behind it; texture is the least used. The order is one constant.

The similarity term of §4.4 no longer counts a flavour family the customer asked for: sharing it is the point, not a reason to mark a pick down.

### 10.3 Tags and reasons (`templates.ts`)

Order: flavour, sweetness, Strong / Smooth & milky, Iced / Hot, texture, Caffeine-free, then the feeling. Still at most three, so the customer's own choices are shown before the feeling. A tag about a choice appears only when `satisfiesChoice` is true; Iced / Hot only when the item's own temperature equals the choice. The "<Flavour> add-on" tag and the budget tag are gone (the add-on tip line and the add-on's place in the reason, COFFEY-ADDONS-PAIRINGS-SPEC §3.3, stay). The reason's sweetness word is the customer's own when the pick keeps their choice, and the delivered level otherwise. One exception: a pick kept for "Not sweet" at a delivered level of 2–3 (a latte with no sugar is milk-sweet) reads "barely sweet", because "unsweetened" would be a claim about what is in the cup.

### 10.4 Response additions

- `SuggestionPick.misses?: HonouredChoice[]`: the choices this pick does not keep. The card shows "Closest we have: not …".
- `SuggestResponse.unmet?: HonouredChoice[]`: the union over the picks. The page shows one line when it is non-empty.

Both are optional, computed from the final picks, and not persisted.

### 10.5 Measured (2026-11-17)

Deterministic fallback, live menu (126 orderable items, 118 tagged), clock pinned to 11:00 IST, no popularity or profile. Two request sets: the 40 real first asks since launch (notes dropped), and a grid of 6,336 requests covering every combination of the new step-2 chips for a drink, a drink with something sweet, and something sweet, for each feeling. Both engines are scored with the one predicate above.

| | Before | After |
|---|---|---|
| Live: picks carrying the requested flavour | 49% | 71% |
| Live: picks keeping the strength / sweetness / texture asked | 76% / 68% / 59% | 83% / 78% / 67% |
| Live: requests where every pick keeps every choice | 5 of 35 | 17 of 35 |
| Picks with an add-on or price tag (live) | 30 of 118 | 0 |
| Requests the greyed chips still allow, grid: first pick keeps every choice | 78.0% | 99.1% |
| …every pick keeps every choice | 34.2% | 61.7% |
| …picks keeping every choice | 61.4% | 80.5% |
| Requests returning fewer than three picks (grid) | 7.6% | 7.6% |

Read with care: in 13 of the 18 live requests still flagged `unmet`, no item on the menu keeps all of the customer's choices at once; those combinations are now greyed out before they can be asked for. What remains is thin coverage (one or two items fit, the rest are marked "closest we have"). The offline top-3 eval of §9 is not a usable gate until its labels are redone: 21 of 78 scenarios name an item that is off the menu or that the scenario's own rules exclude.

### 10.6 Judgement calls, and what to watch

- One feeling, three sweetness levels, budget behind "More options", and the priority order of §10.2 are judgement calls backed by the usage above, not by an experiment. Each is a small, local change to reverse.
- "Celebrating" still ticks "Something sweet to eat" (§1). The research says retire it if customers untick it; there is still no log of that.
- **Not built: step tracking.** Abandonment before the picks is only visible as page views minus sessions. A `wizard_step` event (step shown, picks requested) would show where people leave; it needs a table change, so it is left for the owner to decide.
- **Owner follow-ups:** eight orderable items have no traits row and can never be suggested (Tiramisu Latte, Creamy Corn Toast, Mysterious Mocha Cupcake, Choconut Chip Creme, Coconut Creme, Lemon Americano, Lemon Americano Iced, Peach Lemonata): Owner → Suggestions → Traits → Generate. Re-label `tests/fixtures/suggest-eval.json` against today's menu before reading §9's hit rate again.
