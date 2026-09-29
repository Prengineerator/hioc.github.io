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

