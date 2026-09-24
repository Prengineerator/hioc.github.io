# HIOC Revamp — Phase 7 "Help Me Choose" — Coffee Suggestion Engine — Detailed Spec

**Companion to:** `docs/REVAMP-REQUIREMENTS.md`, `docs/PHASE-2-SPEC.md` (accounts, favorites), `docs/PHASE-6-SPEC.md`, `docs/SECURITY-PLAYBOOK.md`
**Version:** 0.1 (Draft for grooming)
**Date:** 2026-09-24
**Owner:** Product (Senior PM)
**Scope:** A suggestion engine on the website. The customer picks what they want (hot/iced, coffee or not, sweet, something to eat, budget) and how they feel ("need a boost", "cosy"). We suggest up to three items from **our real menu**, gently and politely, and each one can be added to the cart in one tap, which leads into the existing checkout. Signed-in customers get suggestions shaped by a **per-account preference cache** built from their past orders and their usual spend. The owner gets a **Suggestions** dashboard showing how customers respond. Every judgment call in the product is made by Claude **Opus**; mechanical work goes to Claude **Sonnet** or plain code.

---

## 0. Phase-7 goal & definition of done

**Goal:** About 120 real items across 15 categories (Petpooja export) is a lot to scroll through on a phone. A first-time visitor can't tell a *Creme Coffee* from an *Iced Coffee*, and a regular has to find their usual again every time. The engine gets a customer to a confident choice in under 30 seconds, feels like a friendly barista rather than an upsell machine, and **never** suggests something that breaks what the customer asked for.

**Current-state facts (verified in code, 2026-09-24):**

| # | Fact | Evidence |
|---|---|---|
| F1 | Menu items carry **no taste attributes**: only name, description, category, parent_category (`Hot`/`Creme`/`Iced Drinks`/''), `is_veg`, availability, variants with prices, addon groups. Nothing encodes caffeine, sweetness, temperature or heaviness. The engine must add these facts before it can match anything. | `supabase/schema.sql:16-27`, `lib/types.ts` `MenuItem` |
| F2 | 120 real items, 15 categories. Many drinks have **required** addon groups (e.g. `Sugar` `min_select=1`, `Upgrade To Cold Brew` `min_select=1`), so a one-tap add must go through the customize modal whenever a required choice exists. | `supabase/seed.sql`, `components/menu/MenuItemCard.tsx` (`isSimple`) |
| F3 | The cart is client-side (`localStorage` `hioc.cart.v2`), and every public page mounts its own `CartProvider`. Adding a line from a new surface uses the same `addItem` contract. | `lib/cart/CartContext.tsx` |
| F4 | Past orders are linked to accounts through `orders.user_id` (web session) **or** `orders.customer_user_id` (counter, verified phone). A preference profile has to read **both** or it will miss every counter visit. | `lib/types.ts` `Order`, `lib/analytics/customerSegments.ts` `identifiedKey()` |
| F5 | `favorites` (ACC-5) already exists per user. That is an explicit preference signal we can use for free. | `supabase/phase2-migration.sql:111`, `app/api/account/favorites/route.ts` |
| F6 | The owner overview reads through a typed, server-only analytics layer; pure aggregation lives in dependency-free libs with unit tests. New analytics follow the same split. | `lib/analytics/queries.ts`, `lib/analytics/customerSegments.ts`, `tests/customerSegments.test.ts` |
| F7 | `rateLimitOk()` (backed by `rate_limits`) exists and **fails open**. That is acceptable for auth. For a paid LLM endpoint it is not enough on its own, so a spend cap is required as well (SUG-6). | `lib/api/rateLimit.ts` |
| F8 | The repo has **no LLM dependency** today. This phase adds `@anthropic-ai/sdk` (server-only) and `ANTHROPIC_API_KEY`, which must never reach a client bundle (playbook C-1). | `package.json` |
| F9 | Feature flags default from env via `lib/flags.ts`. New customer surfaces ship dark. | `lib/flags.ts` |
| F10 | Vercel Cron is already wired (`vercel.json`, `CRON_SECRET`, fail-closed). The weekly owner digest reuses it. | `vercel.json`, `app/api/cron/*` |

**Release-level Definition of Done**

- [ ] A guest completes **preferences → mood → 3 suggestions → add to cart → checkout** on a phone, and the order carries its suggestion attribution.
- [ ] **Hard-constraint precision is 100%.** No suggestion is ever unavailable, over the chosen budget, caffeinated when "no caffeine" was chosen, iced when "hot" was chosen (or the reverse), or outside the menu. This is enforced in deterministic code, not left to the model, and covered by unit tests.
- [ ] **Relevance ≥ 90%** on the offline eval set (§6): for ≥ 90% of the labelled scenarios, at least one of the top 3 picks is in the barista-labelled "good fit" set. Measured before the flag goes on.
- [ ] Signed-in customers see a **"Your usual"** card and suggestions weighted by their own history and typical spend. They can see and **reset** their taste profile from `/account`.
- [ ] Every suggestion is written in the **house tone** (§4). It never mentions the customer's spending, never pressures, and always offers a "just browse the menu" way out.
- [ ] If the LLM is slow, down, over budget or refuses, the customer still gets correct suggestions within 1.5 s from the deterministic ranker. They never see an error.
- [ ] `/owner/suggestions` shows the funnel, attributed revenue, mood mix, per-item hit rates, feedback, the fallback rate, latency and LLM cost, plus a weekly Sonnet-written digest.
- [ ] Everything ships dark behind `NEXT_PUBLIC_FLAG_SUGGEST`. Migrations ship with `verify:db` probes, and all scoring and aggregation logic lives in pure, unit-tested libs.

**Conventions:** Same as Phases 1–6. AC in Given/When/Then; integer rupees; UTC-stored / IST-displayed; authorization enforced on the server and by RLS; `lib/types.ts` kept in exact sync with migrations.

---

## 1. Who decides what: model routing

The owner's rule: **decision-making is done by the most capable model (Opus); execution is done by cheaper agents (Sonnet) or by plain code.** Applied to the product:

| Job | Kind | Done by | Why |
|---|---|---|---|
| Tag each menu item with taste traits (caffeine, sweetness, temperature, body, mood fit, time of day) | **Decision.** Every later match depends on it. | **Opus** (`claude-opus-5`), owner-reviewed | Needs real-world coffee knowledge. Runs rarely (menu changes), so cost is negligible. |
| Enforce hard constraints (availability, budget, hot/iced, caffeine) | Rules | **Deterministic code** | Must hold 100% of the time. Never delegated to a model. |
| Score and shortlist ~12 candidates from preferences + mood + taste profile | Mechanical ranking | **Deterministic code** | Fast (< 20 ms), testable, and it is the fallback. |
| Choose the final 3 from the shortlist and write the gentle one-line reason | **Decision** | **Opus** (`claude-opus-5`, effort `low`, structured JSON) | This is where "accuracy should be very high" is won: weighing mood, history and pairing like a barista would. |
| Build the per-account taste profile (the preference cache) | Aggregation | **Deterministic code** | Numbers from orders. No model sees raw order history. |
| Weekly owner digest: "what customers told the engine this week" | Summarising numbers already computed | **Sonnet** (`claude-sonnet-5`) | Execution work; cheaper model. |
| Tone lint on customer-facing copy | Rules | **Deterministic code** | Banned-phrase list and length cap applied to every model output. |

**Development follows the same rule:** this spec, the data contracts (`supabase/2026-09-suggestion-engine.sql`, `lib/suggest/types.ts`) and final review are the Opus work. Implementation tickets SUG-1…SUG-12 are executed by Sonnet agents against those contracts.

Model IDs live in one place (`lib/suggest/models.ts`), overridable by env (`SUGGEST_DECIDER_MODEL`, `SUGGEST_WORKER_MODEL`), so moving to a newer model is a config change.

---

## 2. Milestones

| Milestone | Tickets | Theme | Gate |
|---|---|---|---|
| **7A** | SUG-1, SUG-2, SUG-3 | The menu knows what it tastes like | **Gate 7A:** every available item has owner-confirmed traits; the scorer passes the hard-constraint suite |
| **7B** | SUG-4, SUG-5, SUG-6 | The engine answers well, and always answers | **Gate 7B:** eval ≥ 90%; p90 < 4 s with Opus, < 1.5 s fallback; spend cap proven |
| **7C** | SUG-7, SUG-8, SUG-9 | From mood to cart to order | **Gate 7C:** golden path on a real phone; attribution lands on the order |
| **7D** | SUG-10, SUG-11, SUG-12 | The owner sees how it lands | **Gate 7D:** dashboard numbers reconcile with raw events for one test day |

---

## 3. Customer experience

### 3.1 Entry points
- **Home hero:** secondary button "Not sure? Help me choose ☕" → `/suggest`.
- **Menu page:** a slim banner above the category tabs: "Can't decide? Tell us your mood →".
- **Signed in with ≥ 1 past order:** the banner reads "Your usual, or something new? →".

### 3.2 Flow (`/suggest`, single page with three steps, phone-first)

**Step 1: "What are you in the mood for?"** (preselection, all optional, multi-select chips)
- Temperature: `Hot` · `Iced` · `Either`
- Base: `Coffee` · `No coffee` · `Either`
- Extras: `Something sweet` · `Something to eat` · `Light` · `Filling`
- Needs: `No caffeine` · `Less sugar`
- Budget (single): `Under ₹150` · `₹150–₹300` · `Treat myself` · `No preference`

**Step 2: "How are you feeling?"** (single choice, big cards)
- ⚡ `Need a boost` · ☕ `Calm & cosy` · 🎉 `Celebrating` · 🤗 `Need some comfort` · 🧊 `Hot day, cool me down` · ✨ `Surprise me`
- An optional line, "Anything else? (e.g. 'meeting a friend')", max 140 characters.

**Step 3: suggestions**
- A header in the house tone, e.g. "Here's what we'd pour for you ☕".
- For returning signed-in customers, a **"Your usual"** card first (their most-ordered item that is still available and not ruled out by today's hard constraints), labelled separately from the picks.
- Up to **3 picks**. Each shows image, name, price range, veg mark, and a one-line reason ("Bold and smooth: a good lift for a busy afternoon"). Buttons: **Add to cart** and 👍 / 👎.
  - Add to cart: if the item is "simple" (1 variant, no addon groups; same rule as `MenuItemCard`) it adds directly. Otherwise it opens the existing `MenuItemCustomizeModal`. The line carries `suggestionSessionId`.
- **"Show me something different"** re-runs with the shown items excluded (max 2 refines; after that, "Browse the full menu").
- A persistent quiet link: **"No thanks, I'll browse the menu"**.
- A floating cart bar and drawer, as on `/menu`. The checkout CTA goes to the existing `/checkout` funnel unchanged.

### 3.3 States
- Store closed or not accepting orders → the same `StoreStatusBanner` as `/menu`. Suggestions still render so people can plan, and add-to-cart follows the existing menu behaviour.
- Nothing matches the hard constraints → a polite empty state that names the constraint to relax ("Nothing iced under ₹150 right now. Want to see options up to ₹200?") with a one-tap relax. Never an empty grid.
- Loading → skeleton cards plus rotating copy ("Grinding some ideas…"). A hard client timeout of 8 s triggers a retry, which gets the fallback.

---

## 4. Tone guide (binding on prompts, templates and lint)

The engine speaks like a warm, unhurried barista.

**Do:** "You might enjoy…", "If you fancy…", "A lovely pick for…", "Our regulars love…". One sentence per reason, ≤ 120 characters. Name the taste, not the sale.

**Never:**
- mention the customer's spending, income, "budget" level, or past-order counts ("since you spend a lot…", "you always order…"). Profile signals shape the ranking **silently**.
- pressure or create urgency: "hurry", "don't miss", "only today", "you should", "you must", "best deal".
- make health or medical claims: "healthy", "boosts immunity", "good for stress".
- guess at the customer's feelings beyond what they chose: no "you seem sad".
- use more than one emoji per reason.

**Enforcement:** `lib/suggest/tone.ts` `lintReason()` checks every model-written reason against a banned-phrase list and the length cap. A failing reason is replaced by the deterministic template for that item's top matching trait. It is never shown raw.

---

## 5. Engine architecture

```
customer inputs ──► POST /api/suggest
                        │
      ┌─────────────────┼──────────────────────────────────────┐
      │ 1. load menu (available) + traits        [cache 60 s]  │
      │ 2. load taste profile (signed in)        [cache table] │
      │ 3. HARD FILTER   lib/suggest/filter.ts   (pure)        │
      │ 4. SCORE → top 12 lib/suggest/score.ts   (pure)        │
      │ 5. DECIDE: Opus picks 3 + reasons        (≤ 5 s)       │
      │      └─ timeout / error / refusal / budget cap         │
      │           → deterministic top 3 + template reasons     │
      │ 6. VALIDATE: ids ⊆ shortlist, tone lint               │
      │ 7. persist suggestion_sessions + 'shown' events       │
      └─────────────────┼──────────────────────────────────────┘
                        ▼
              { sessionId, usual?, picks[3], source }
```

### 5.1 Menu traits (SUG-2)
Table `menu_item_traits` (one row per menu item):

| Field | Values |
|---|---|
| `temperature` | `hot` · `iced` · `either` (served either way) · `ambient` (food/dessert) |
| `caffeine` | `none` · `low` · `medium` · `high` |
| `is_coffee` | boolean (coffee-based) |
| `sweetness` | 0–3 |
| `body` | `light` · `medium` · `rich` (for food: portion heaviness) |
| `kind` | `drink` · `food` · `dessert` |
| `moods` | subset of the six mood keys it suits |
| `dayparts` | subset of `morning` · `afternoon` · `evening` · `late` |
| `flavor_notes` | ≤ 5 short tags ("chocolate", "nutty", "citrus") |
| `source` | `opus` · `owner` |
| `confirmed` | boolean; set when the owner confirms or edits |

- **Tagging:** `POST /api/owner/suggest/traits/generate` (owner-only) sends the whole menu (name, description, category, parent) to **Opus** with the trait schema as structured JSON output, in batches of ~40. It upserts only rows that are missing or unconfirmed (**never overwrites `confirmed` rows**).
- **Owner review:** the `/owner/suggestions` → Traits tab is a compact table with inline edit and "Confirm all visible". Unconfirmed traits **are** used (the flag is off until Gate 7A anyway). The dashboard shows "N items unconfirmed".
- An item with **no traits row** is never suggested. It stays on the menu and is excluded from the engine. That exclusion is safer than guessing.

### 5.2 Hard filter (SUG-3, pure)
An item is a candidate only if **all** of these hold:
1. `isMenuItemAvailable(item)` (reuse `lib/menu/availability.ts`) and it has a traits row.
2. Temperature: `Hot` excludes `iced`; `Iced` excludes `hot`. `either` and `ambient` pass both.
3. `No caffeine` excludes `caffeine ≠ none`. `No coffee` excludes `is_coffee`. `Coffee` keeps only `is_coffee` **for drinks** (food still passes).
4. Budget uses the **cheapest variant** price: `Under ₹150` → ≤ 150; `₹150–₹300` → 150–300 inclusive; `Treat myself` / none → no cap.
5. `Less sugar` excludes `sweetness = 3`.
6. Not in `excludeItemIds` (refine).

If fewer than 3 candidates remain, the response carries `relaxHint` naming the single constraint whose removal adds the most candidates (budget first, then temperature, then extras). The engine never relaxes a constraint silently.

### 5.3 Scoring (SUG-3, pure)
`score = 0.35·mood + 0.20·extras + 0.15·daypart + 0.20·profile + 0.10·popularity`, each term in [0, 1]:
- **mood:** 1 if the mood key ∈ `moods`; plus a mood-specific trait bonus (boost → caffeine high/medium; cosy → hot + rich; celebrating → dessert or sweetness ≥ 2; comfort → rich or sweetness ≥ 2; cool-down → iced; surprise → a novelty bonus for items **not** in the profile's top items).
- **extras:** the fraction of chosen extras satisfied (sweet → sweetness ≥ 2; eat → kind food/dessert; light → body light; filling → body rich).
- **daypart:** 1 if the current IST daypart ∈ `dayparts`.
- **profile** (signed in only, else 0): category affinity + trait affinity (hot/iced ratio, sweetness preference) + price-comfort fit (§5.5). Items the customer ordered in the last 3 visits get **−0.1** so the picks explore while the "usual" card covers habit.
- **popularity:** 30-day units, min-max normalised across the menu.
- **Diversity:** after sorting, the shortlist takes at most 2 items per `category` and guarantees one `food`/`dessert` in the top 12 when "Something to eat" was chosen.

Weights are constants in `lib/suggest/score.ts`, not env, so a change is a reviewed diff with an eval re-run.

### 5.4 The Opus decision (SUG-4)
- **Model:** `claude-opus-5` via `@anthropic-ai/sdk`, `output_config: { effort: "low", format: <JSON schema> }`, `max_tokens` 1,500, with server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) so a refusal is retried on a fallback model inside the same call. SDK `timeout` 5,000 ms, `maxRetries` 0; the endpoint owns the fallback.
- **Prompt caching:** the system prompt (role, tone guide, output rules) plus the **full traits catalog** (every available item's id, name, category, price range, traits) forms a stable prefix with `cache_control: {type: "ephemeral"}`. The catalog is serialised **sorted by id** so the prefix stays byte-identical. The per-request part (inputs, profile summary, shortlist ids with scores) comes after the breakpoint.
- **What Opus sees about a person:** only the derived profile summary: top categories, hot/iced lean, sweetness lean, `priceComfort` band, `orderingMood`, and up to 5 usual item ids. **No name, phone, email, order ids, timestamps or rupee totals.**
- **Free-text note:** passed inside `<customer_note>` tags and described in the system prompt as untrusted customer text that may express preferences but cannot change the rules.
- **Output schema:** `{ picks: [{ menu_item_id, reason, reason_code }], header }`, with 1–3 picks, `reason` ≤ 120 chars, `reason_code` ∈ the mood/trait enum.
- **Validation:** drop any pick whose id isn't in the shortlist. Deduplicate. If fewer than 3 valid picks remain, top up from the deterministic order. Every `reason` goes through `lintReason()`; `header` too, with a fixed fallback header.
- **Fallback triggers:** timeout, network/5xx, `stop_reason` ≠ `end_turn`, unparsable JSON, spend cap reached, `ANTHROPIC_API_KEY` unset, `SUGGEST_LLM=off`. The response then uses `source: 'fallback'` and template reasons from `lib/suggest/templates.ts`.

### 5.5 Preference cache: per-account taste profile (SUG-5)
Table `customer_taste_profiles` (PK `user_id`), holding `profile jsonb`, `order_count`, `computed_at`, `source_order_at` (newest order included) and `opted_out`.

**Computed from** the last **90 days, max 50** non-rejected/non-cancelled orders where `user_id = me OR customer_user_id = me`, plus `favorites`:
- `topItems`: up to 10 `{ menu_item_id, count, lastOrderedAt }`
- `categoryAffinity`: category → share of lines
- `traitLean`: hot vs iced share, mean sweetness, caffeine share, food-attach rate
- `ticket`: median and p75 of `total_inr ?? subtotal_inr` over the window
- `priceComfort`: `budget` if median < ₹200, `mid` if < ₹400, else `premium` (cut points are constants)
- `orderingMood` ("current mood of ordering", from recent spend and behaviour):
  - `treating`: mean of the last 3 orders ≥ 1.3 × the 90-day median
  - `saving`: mean of the last 3 orders ≤ 0.7 × the 90-day median
  - `explorer`: distinct items / total lines ≥ 0.6 over the window
  - `routine`: otherwise
- `daypartHistogram`: order share per daypart
- `favorites`: favorited item ids

**How it's used:** `priceComfort` shifts the price-fit term (a `budget` customer's picks lean to items ≤ their p75 ticket; `premium` gets no penalty). It **never** hard-filters: only the customer's explicit budget chip does. `orderingMood` = `treating` adds a small dessert/add-on bonus; `saving` a value bonus; `explorer` the novelty bonus; `routine` raises the "usual" card's prominence.

**Freshness:** recomputed on read when `computed_at` is older than 24 h **or** the customer has an order newer than `source_order_at`. `POST /api/orders` also marks the profile stale (best-effort `computed_at = epoch`), which is cheaper than recomputing inside checkout.

**Privacy (DPDP-aligned):** `/account` gets a "Your taste profile" card: a plain-language summary ("You usually go for iced coffee in the afternoon"), a **Reset** button (deletes the row and recomputes), and a **Don't personalise** toggle (`opted_out = true` means the profile is not used or recomputed, and suggestions behave as for a guest). Only the owning user and service-role code can read it. The owner dashboard shows **aggregates only**, never an individual's profile.

### 5.6 Cost & abuse controls (SUG-6)
- **Rate limits:** 20 suggestion requests per 10 min per IP, and 60 per day per signed-in user, via `rateLimitOk()`. Beyond the limit the request succeeds using the **fallback path only** (no LLM call); it is not refused.
- **Spend cap:** each LLM call records `input_tokens`, `cache_read_tokens`, `output_tokens` and `cost_usd_micros` on its session. Before calling Opus, the endpoint sums today's `cost_usd_micros` (IST day); at or above `SUGGEST_DAILY_BUDGET_USD` (default 3) it uses the fallback. This is a DB-backed check, not in-memory, so it holds across serverless instances.
- **Pricing constants** (USD per MTok) live in `lib/suggest/models.ts`: Opus 5 in $5 / out $25 / cache read $0.50; Sonnet 5 in $2 / out $10 / cache read $0.20. Expected cost: ~3k cached + ~600 fresh input and ~250 output tokens ≈ **$0.01 per suggestion**.
- `ANTHROPIC_API_KEY` is read only in `lib/suggest/llm.ts`, which imports `'server-only'` (playbook C-1).

---

## 6. Accuracy: how "very high" is measured

1. **Hard constraints (100%):** a property-style unit test runs the filter plus the full pipeline (with the LLM mocked to return *adversarial* ids: off-shortlist, unavailable, over budget) across every combination of chips × a fixture menu, and asserts no violating item is ever returned.
2. **Offline relevance eval (≥ 90% top-3 hit):** `tests/fixtures/suggest-eval.json` holds ≥ 60 scenarios (inputs + optional profile + a `goodFit` item-name list labelled by a barista/owner). `scripts/eval-suggest.mjs` runs them against the real engine and prints hit rate, per-mood hit rate and the misses. It runs once with the fallback and once with Opus, and both numbers are reported. Opus must reach ≥ 90%; the fallback's number is the floor we're protecting.
3. **Online signals (dashboard):** add-to-cart rate per session (target ≥ 25%), 👍 share of rated picks (target ≥ 80%), refine rate (lower is better), and the per-item "suggested but never added" list, which is the prompt for the owner to fix that item's traits.

---

## 7. Analytics model (SUG-10)

**`suggestion_sessions`**: one row per engine answer: `id`, `user_id` (nullable), `anon_id` (client UUID from `localStorage`, for guests' funnel continuity), `inputs jsonb`, `profile_used boolean`, `ordering_mood`, `candidate_ids uuid[]`, `pick_ids uuid[]`, `usual_item_id`, `source` (`llm`/`fallback`), `fallback_reason`, `model`, `latency_ms`, token counts, `cost_usd_micros`, `refine_of` (parent session), `created_at`.

**`suggestion_events`**: `id`, `session_id`, `event` ∈ `shown · added_to_cart · feedback_up · feedback_down · refined · dismissed · browse_menu · checkout_started · ordered`, `menu_item_id` (nullable), `order_id` (nullable), `value_inr` (nullable), `created_at`.
- `shown` is written server-side with the session (one per pick plus the usual).
- Client events go through `POST /api/suggest/events`: a whitelist of events, the session must exist and be < 24 h old, rate-limited. `ordered` **cannot** be posted by the client.
- `ordered` is written by `POST /api/orders` when the body carries `suggestion_session_ids` (from cart lines): one event per order line whose `menu_item_id` was a pick/usual in that session, with `value_inr = line_total_inr`. It is best-effort and **never fails or delays the order** (wrapped, logged, awaited after the order commit). The order stores no new column; attribution lives in events.

**Owner dashboard `/owner/suggestions`** (owner-only, nav entry "Suggestions", shown only when the flag is on):
- **Window selector:** Today · 7 days · 30 days.
- **Funnel:** sessions → with ≥ 1 add → checkout started → ordered, with conversion % at each step.
- **Attributed revenue** and **AOV of suggestion orders vs all web orders** in the window.
- **Mood mix** (bar) and **conversion by mood**.
- **Top picks:** per item: times suggested, added, ordered, hit rate, 👍/👎. Sortable; "never added" flagged.
- **Personalised vs guest:** conversion for `profile_used` true vs false.
- **Engine health:** LLM vs fallback share, fallback reasons, latency p50/p90, cost today / 30 days vs cap.
- **Weekly digest** (SUG-12): the latest Sonnet-written summary card.
- **Traits** tab (SUG-2).

Pure aggregation goes in `lib/suggest/analytics.ts`; server queries in `lib/suggest/queries.ts` (`'server-only'`), mirroring F6.

---

## 8. Tickets

### SUG-1 — Foundation: migration, types, flag, SDK
**What:** `supabase/2026-09-suggestion-engine.sql` (`menu_item_traits`, `customer_taste_profiles`, `suggestion_sessions`, `suggestion_events`, `suggestion_digests`; RLS on; `customer_taste_profiles` gets a select-own policy, everything else is service-role only; indexes on `suggestion_sessions(created_at)`, `(user_id)`, `suggestion_events(session_id)`, `(created_at, event)`); `lib/suggest/types.ts` (the contract); mirror row types into `lib/types.ts`; `flags.suggest` (`NEXT_PUBLIC_FLAG_SUGGEST`, default OFF); add `@anthropic-ai/sdk`; `.env.local.example` entries; `verify:db` probes (tables exist, RLS on, the CHECK on `suggestion_events.event` rejects `'bogus'`).
**AC:** Given the migration is applied twice, then the second run is a no-op. Given an anon client, when it selects `suggestion_sessions`, then it gets zero rows.

### SUG-2 — Menu traits: Opus tagging + owner review
**What:** `lib/suggest/traitsPrompt.ts`, `POST /api/owner/suggest/traits/generate` (owner-only, rate-limited to 5 per hour), `GET/PATCH /api/owner/suggest/traits`, and the Traits tab UI.
**AC:** Given 3 confirmed rows, when generate runs, then those rows are byte-identical afterwards. Given the owner edits `caffeine` to `none`, then `source='owner'` and `confirmed=true`.

### SUG-3 — Deterministic filter, scorer, templates, tone lint
**What:** pure `lib/suggest/filter.ts`, `score.ts`, `templates.ts`, `tone.ts`, `daypart.ts`, with unit tests including the §6.1 hard-constraint suite.
**AC:** For every chip combination on the fixture menu, no returned item violates §5.2. `lintReason` rejects every banned phrase in §4.

### SUG-4 — `POST /api/suggest` with the Opus decision + fallback
**What:** `lib/suggest/llm.ts` (Opus call, caching, schema, validation), `lib/suggest/engine.ts` (orchestration; injectable LLM for tests), the route, and session + `shown` persistence.
**AC:** Given the LLM mock returns an off-shortlist id, then it is dropped and topped up. Given the LLM mock hangs, then the response arrives with `source:'fallback'` within the timeout budget. Given `SUGGEST_LLM=off`, then no SDK call is made.

### SUG-5 — Preference cache (taste profile)
**What:** pure `lib/suggest/profile.ts` (`buildTasteProfile(orders, favorites, traits, now)`), server `lib/suggest/profileStore.ts` (read-through cache, staleness rules), stale-marking in `POST /api/orders`, and `GET/DELETE/PATCH /api/account/taste-profile` plus the `/account` card.
**AC:** Given orders linked only via `customer_user_id`, then they count. Given `opted_out`, then the engine gets `profile: null`. Given a new order, then the next suggest call recomputes.

### SUG-6 — Rate limits & spend cap
**What:** as §5.6, with `lib/suggest/budget.ts` (pure cost maths plus a server check).
**AC:** Given today's cost ≥ cap, then the engine never calls the LLM and records `fallback_reason='budget'`.

### SUG-7 — `/suggest` page (3-step wizard)
**What:** `app/suggest/page.tsx` + `components/suggest/*`, per §3. Accessible (chips are toggle buttons with `aria-pressed`; mood cards are a radiogroup), phone-first, brand tokens, reusing `MenuItemImage`, `MenuItemCustomizeModal`, `FloatingCartBar`, `CartDrawer`.
**AC:** Given the flag is off, then `/suggest` renders a friendly "coming soon" page and no entry points show.

### SUG-8 — Entry points & cart attribution
**What:** Home and menu banners (flag-gated); `CartItem.suggestionSessionId?`; add-to-cart from `/suggest` sets it (the cart key is unchanged, so the same line from the menu merges); `CheckoutForm` sends the distinct `suggestion_session_ids` (max 5) in the order body.
**AC:** Given a line added from `/suggest`, then the order POST body includes its session id. Given no suggested lines, then the field is absent.

### SUG-9 — Order attribution & client events
**What:** `POST /api/suggest/events`; `ordered` events written from `POST /api/orders` (best-effort, after commit).
**AC:** Given `suggestion_session_ids` with an unknown id, then the order still succeeds and nothing is written for that id. Given a client posting `ordered`, then 400.

### SUG-10 — Owner Suggestions dashboard
**What:** `app/owner/suggestions/page.tsx`, `lib/suggest/analytics.ts` (pure, tested), `lib/suggest/queries.ts`, and the nav entry.
**AC:** Given a seeded fixture of events, then the funnel counts and conversion % match the hand-computed values in the test.

### SUG-11 — Offline eval harness
**What:** `tests/fixtures/suggest-eval.json` (≥ 60 scenarios, drafted from the real menu and to be owner-reviewed) and `scripts/eval-suggest.mjs` plus the `npm run eval:suggest` script.
**AC:** It prints hit rate for fallback and, when a key is present, for Opus, and exits non-zero below `--min`.

### SUG-12 — Weekly Sonnet digest
**What:** `GET /api/cron/suggest-digest` (Mondays 04:00 IST; `CRON_SECRET`, fail-closed), which computes the 7-day aggregates (SUG-10 lib), asks **Sonnet** (`claude-sonnet-5`, effort `low`) for a ≤ 120-word owner-facing summary with 3 bullet actions, and stores it in `suggestion_digests`. The dashboard shows the latest. Only aggregates are sent.
**AC:** Given the cron secret is missing, then 401. Given the LLM fails, then a digest row with the plain numbers and `source='template'`.

---

## 9. Security checklist (added to SECURITY-PLAYBOOK as S-1…S-5)

- **S-1:** `ANTHROPIC_API_KEY` is only read in `'server-only'` modules. It is never `NEXT_PUBLIC_`.
- **S-2:** A model output is **data**. Ids are validated against the shortlist, text is linted, and nothing from the model is rendered as HTML.
- **S-3:** No PII goes to any model: no name, phone, email or order ids. The profile summary only.
- **S-4:** `ordered` attribution is server-written only. Client events are whitelisted and session-bound.
- **S-5:** Every LLM route has a fallback path and a DB-backed spend cap. A missing key means the fallback, never a 500.

## 10. Out of scope (Phase 7)
Staff-POS suggestions, WhatsApp suggestions, push/email re-engagement using profiles, A/B testing framework (the `source` field allows a crude LLM-vs-fallback comparison), multi-language copy.
