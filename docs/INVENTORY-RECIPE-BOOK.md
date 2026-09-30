# Recipe book: the inventory setup as data

Status: **DRAFT DATA** (2026-09-30). The recipe book is the source of truth for the
stock-item list and for every menu item's and add-on's recipe. It is plain JSON in
`data/inventory/`. A script checks it against the live menu and compiles it to one
SQL file that loads it into Supabase. The tables and flow it feeds are in
[`INVENTORY-SPEC.md`](INVENTORY-SPEC.md). This file replaces requirement-sheet items
B1 (stock item list) and B2 (recipes) there.

```
 owner says the basics ──► chef agent ──► data/inventory/*.json ──► npm run inventory:check
 ("Latte large: double                     (stock items,              (errors, coverage)
  shot, 220 ml milk")                        recipes, add-ons)                │
                                                                              ▼
                              Supabase ◄── supabase/2026-10-inventory-seed.sql ◄── npm run inventory:build
                          (applied by hand         (generated, idempotent)
                           or the deploy step)
```

## Files

| Path | What | Who edits |
|---|---|---|
| `data/inventory/menu-snapshot.json` | The **live** menu: item ids, names, categories, size labels, add-on groups; add-on option ids. Recipes are checked against it. | `npm run inventory:snapshot` only |
| `data/inventory/stock-items.json` | Every ingredient and packaging item that stock is kept of. | chef agent |
| `data/inventory/recipes/<slug>.json` | Menu-item recipes, one file per menu section. | chef agent |
| `data/inventory/addon-recipes.json` | Add-on option recipes. | chef agent |
| `supabase/2026-10-inventory-seed.sql` | **Generated.** Never edit by hand. | `npm run inventory:build` |

### `stock-items.json`

```json
{
  "items": [
    { "name": "Espresso beans", "unit": "g", "category": "Coffee",
      "tracks_expiry": false, "par_level": 0, "reorder_qty": 0,
      "standalone": false, "notes": "" }
  ]
}
```

- `name`: 1–80 characters and unique regardless of case. Recipes refer to stock items by this exact name.
- `unit`: one of `g kg ml l pcs pack`. Every quantity of the item, in recipes and in stock, is in this unit. **It locks** once the item is used live (INV-D15), so choose the unit a recipe is naturally written in: `g` for solids, `ml` for liquids, `pcs` for countables.
- `category`: one of `Coffee`, `Dairy & Alternatives`, `Syrups & Sauces`, `Powders & Mixes`, `Chocolate & Spreads`, `Toppings & Inclusions`, `Fruit & Purees`, `Frozen`, `Bakery`, `Savoury`, `Beverages`, `Packaging`.
- `tracks_expiry`: `true` means receiving the item needs an expiry date (dairy, bakery, fruit, anything that spoils within weeks).
- `par_level` / `reorder_qty`: "low at" and "usually request". `0` means not set; the owner fills them in.
- `standalone`: `true` loads the item even when no recipe uses it (cleaning supplies, for example). By default, only items that a deployed recipe uses are loaded.

### `recipes/<slug>.json`

```json
{
  "categories": ["Coffee"],
  "items": [
    {
      "menu_item_id": "0b398e3e-…",
      "menu_item": "Latte",
      "status": "draft",
      "source": "chef-default",
      "notes": "Large = 12 oz cup, double shot. XL = 16 oz, triple shot.",
      "base": [],
      "sizes": {
        "Large":       [ { "ingredient": "Espresso beans", "qty": 18 }, { "ingredient": "Full-cream milk", "qty": 240 } ],
        "Extra Large": [ { "ingredient": "Espresso beans", "qty": 27 }, { "ingredient": "Full-cream milk", "qty": 330 } ]
      }
    }
  ]
}
```

- `categories`: the menu categories (as in the snapshot) this file covers. Each snapshot category belongs to exactly one file.
- `menu_item_id` must be in the snapshot. `menu_item` is the item's name, kept for people to read.
- `status`:
  - `draft`: proposed, not yet approved by the owner. **Not deployed** unless `--include-drafts` is passed.
  - `confirmed`: the owner approved it. It is deployed.
  - `skip`: deliberately uses no stock. `base` and `sizes` must be empty.
- `source`: `owner` (the owner said it), `chef-default` (the chef agent's industry-standard guess), or `pos` (read back from the live recipe).
- **One serving, in each stock item's own unit** (INV-D11). The quantity is the amount used, not the amount bought: for example 18 g of beans, not "1 shot".
- `base` is the recipe for every size. A key in `sizes` is a size label exactly as in the snapshot ("Extra Large", "B", "Focaccia Bread"), and a size's list **replaces** `base` for that size; it is not added to it. Rules of thumb:
  - An item with one size uses `base` only.
  - An item whose sizes differ gives every size its own full list, and `base` is `[]`.
  - Every size of a `draft` or `confirmed` item must end up with a non-empty recipe.
- Each ingredient appears at most once per size (or once in base). `qty` is greater than 0, at most 999999, with at most 3 decimals. At most 60 lines per item across base and sizes, the same as the POS editor.

### `addon-recipes.json`

```json
{
  "options": [
    { "addon_option_id": "6755ed84-…", "group": "ADD ON Milk", "option": "Oat",
      "status": "draft", "source": "chef-default", "notes": "",
      "lines": [ { "ingredient": "Oat milk", "qty": 240 } ] }
  ]
}
```

An add-on's lines are what it uses **per serving it is added to** (INV-D19). A line of two lattes with an extra shot uses the add-on twice. `status` works the same as for menu items: "No Ice", "No Sugar" and "Assemble It By You" are `skip`.

## House defaults for `chef-default` drafts

Drafts follow these defaults so that one agent's Latte matches another's Mocha. The owner overrides them item by item, and an override is recorded in `notes`.

| Thing | Default |
|---|---|
| Cup sizes | Large = 12 oz (350 ml) · Extra Large = 16 oz (470 ml) |
| Espresso | single shot 9 g of beans · a Large milk drink has a double (18 g) · an Extra Large has a triple (27 g) · the "Espresso" item: Large = double, Extra Large = triple |
| Cold brew | 25 g coarse beans for a Large serve, 35 g for an Extra Large (the steep's yield already counted) |
| Milk | the space left in the cup after shots, sauce and foam. Iced drinks leave about 30 % of the cup for ice. |
| Syrup / sauce | 15 ml for a Large, 20 ml for an Extra Large. A drizzle garnish is 10 ml. |
| Powders | matcha 3 g / 4 g · cocoa or chocolate powder 20 g / 28 g · chai premix 20 g / 28 g (Large / Extra Large) |
| Creme (blended) | the base powder or ice-cream plus milk, blended. Ice cream 60 g a scoop. Whipped cream topping 30 g. |
| Ice cream | one scoop = 60 g, stocked in `g` |
| Sugar | the "Normal" sugar add-on = 10 g white sugar · Brown = 10 g brown sugar · Stevia = 1 sachet (`pcs`) |
| Ice | **not tracked** (made on site). Ice-level add-ons are `skip`. |
| Waffles | batter premix in `g`: stick waffle B = 60 g, L = 110 g · a stuffed waffle = 120 g · a waffle-chips serve = 70 g |
| Bought-in bakes | croissants, cupcakes, cheesecake slices, brownies and cookies are counted in `pcs`, not built from flour |
| Packaging | each drink uses its cup, lid and (for iced or creme drinks) a straw; takeaway food uses its box. Cups: `Hot cup 12 oz`, `Hot cup 16 oz`, `Hot cup lid`, `Cold cup 12 oz`, `Cold cup 16 oz`, `Cold cup dome lid`, `Straw`. |

## Commands

```
npm run inventory:check                    # validate, and print coverage by section
npm run inventory:build                    # write supabase/2026-10-inventory-seed.sql (confirmed only)
npm run inventory:build -- --include-drafts   # also drafts, for a preview/test database
npm run inventory:snapshot                 # refresh menu-snapshot.json from the live menu
```

`inventory:build` refuses to write while `inventory:check` has errors.

## What the generated SQL does

This is one `do $$ … $$` block, so it applies completely or not at all. It is safe to re-run.

1. **Auto-hide guard.** If no stock has ever been received (`inventory_batches` is empty), it sets `store_settings.stock_auto_hide = false`. Otherwise, every item with a recipe would read "0 on hand" and disappear from the live menu (INV-D16). This happens at the database level, whether the app flag is on or off. Switch auto-hide back on (Stock tab) **after** the opening stock is received.
2. **Unit guard.** It refuses to run if a stock item already exists live with a different unit.
3. **Stock items.** It adds new stock items and updates existing ones, matched by name regardless of case. The unit is never changed.
4. **Existence guard.** It refuses to run if any menu item or add-on option id in the book is missing live. Refresh the snapshot in that case.
5. **Recipes.** Each recipe in the file replaces that menu item's or add-on's whole recipe, through `inventory_set_recipe` / `inventory_set_addon_recipe`, so the size-label check applies. Items not in the file are left alone.

## Deploy

1. Every item the owner wants tracked is `confirmed`, and `npm run inventory:check` shows no errors.
2. Run `npm run inventory:build`, then commit the data and the generated SQL together.
3. Apply `supabase/2026-10-inventory-seed.sql` in the Supabase SQL editor, or ask Claude to apply it. Then run the verify queries at the foot of the file.
4. Continue with the go-live steps in `INVENTORY-SPEC.md` §C: receive the opening stock (C4), run the walk-through (C5), switch the flag on (C6), then switch auto-hide on.

A recipe edited later on the POS is **overwritten** the next time the seed is applied. Tell the chef agent about the change so the book stays the source of truth.

## Known limits of recipes (from the engine)

- **Milk swaps add, they don't swap.** "Oat" on a latte uses the add-on's oat milk **and** the base recipe's dairy milk (add-on recipes are only added). Until the engine supports substitutions, dairy milk will read slightly low against the shelf on days with many swaps. A count corrects it.
- **Combos** (for example "Hot Chocolate + Mocha Combo") need their full recipe written out. The engine does not expand one menu item into others.
- **Per-size auto-hide is not supported.** See INVENTORY-SPEC "Known limits".
