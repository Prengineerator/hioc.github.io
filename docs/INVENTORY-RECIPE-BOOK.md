# Recipe book: the inventory setup as data

Status: **BUILDING** (2026-09-30). The recipe book is the source of truth for the
stock-item list and for every menu item's and add-on's recipe. A script checks it
against the live menu and compiles it. The compiled book is loaded into Supabase by a
database function, `inventory_apply_book`, called either from a generated SQL file or
over REST by `npm run inventory:apply`.
The tables and flow it feeds are in [`INVENTORY-SPEC.md`](INVENTORY-SPEC.md). This
file replaces requirement-sheet items B1 (stock item list) and B2 (recipes) there.

```
 Petpooja export ──► npm run inventory:import-petpooja ─┐
 (Item_Addon_Recipe.csv)                                ├─► recipe book ──► npm run inventory:check
 owner's basics ──► chef agent ─────────────────────────┘   (private JSON)          │
                                                                                    ▼
             Supabase ◄── inventory_apply_book() ◄─┬─ npm run inventory:apply   (one REST call)
      (recipes applied + the whole book             └─ <book>/seed.sql ◄── npm run inventory:build
       saved in inventory_recipe_book;                  (`select inventory_apply_book(…)`, SQL editor)
       npm run inventory:pull brings the book back on any machine)
```

## The recipes stay private

The GitHub repository is **public**, but the café's recipes are not. The tools, this
document, the chef agent and the menu snapshot (menu data is already public on the
site) are committed. **Everything that contains a quantity is git-ignored**: the
recipe book, the Petpooja export and the generated SQL. The book's permanent home is
the database. Every seed saves the whole book (drafts and notes too) in the
service-role-only table `inventory_recipe_book`, and `inventory:pull` restores it
into a fresh checkout. Never commit a file from the book directory, and never paste
recipe quantities into a commit message, PR or issue.

## Files

| Path | What | Committed? |
|---|---|---|
| `data/inventory/menu-snapshot.json` | The **live** menu: item ids, names, categories, size labels, add-on groups; add-on option ids. Recipes are checked against it. Refresh it with `inventory:snapshot`. | yes |
| `data/inventory/book/` | **The book**: the default book directory. Override it with `INVENTORY_BOOK_DIR` or `--book <dir>`. | **no** (git-ignored) |
| `…/book/stock-items.json` | Every ingredient and packaging item that stock is kept of. | no |
| `…/book/recipes/<slug>.json` | Menu-item recipes, one file per menu section. | no |
| `…/book/addon-recipes.json` | Add-on recipes, including the per-item and per-size amounts. | no |
| `…/book/petpooja/Item_Addon_Recipe.csv` | The Petpooja "Item Addon Recipe" export. | no |
| `…/book/petpooja/aliases.json` | Petpooja name → live menu item or add-on, for names the automatic matcher can't match. | no |
| `…/book/petpooja/materials.json` | Petpooja raw material → stock item (name, category, expiry). | no |
| `…/book/import-report.md` | Written by the importer: what matched, and what is **still missing**. | no |
| `…/book/seed.sql` | **Generated.** One `select inventory_apply_book(…)` around the compiled book. Never edit it by hand. | no |

### `stock-items.json`

```json
{
  "items": [
    { "name": "Coffee beans", "unit": "g", "category": "Coffee",
      "tracks_expiry": false, "par_level": 0, "reorder_qty": 0,
      "standalone": false, "notes": "" }
  ]
}
```

- `name`: 1–80 characters and unique regardless of case. Recipes refer to stock items by this exact name.
- `unit`: one of `g kg ml l pcs pack`. Every quantity of the item, in recipes and in stock, is in this unit. **It locks** once the item is used live (INV-D15).
  - **Petpooja's unit wins** for anything imported from it: `gm` becomes `g` (milk is weighed in grams there), `pcs` stays `pcs`.
  - For new items: `g` for solids, `ml` for liquids, `pcs` for countables.
- `category`: one of `Coffee`, `Dairy & Alternatives`, `Syrups & Sauces`, `Powders & Mixes`, `Chocolate & Spreads`, `Toppings & Inclusions`, `Fruit & Purees`, `Frozen`, `Bakery`, `Savoury`, `Beverages`, `Packaging`.
- `tracks_expiry`: `true` means receiving the item needs an expiry date (dairy, bakery, fruit, anything that spoils within weeks).
- `par_level` / `reorder_qty`: "low at" and "usually request". `0` means not set in the book, and the value on the live item is left alone.
- `standalone`: `true` loads the item even when no recipe uses it. By default, only items that a deployed recipe uses are loaded.

### `recipes/<slug>.json`

```json
{
  "categories": ["Coffee", "Hot Non-Coffee"],
  "items": [
    {
      "menu_item_id": "0b398e3e-…",
      "menu_item": "Latte",
      "status": "confirmed",
      "source": "petpooja",
      "notes": "",
      "base": [],
      "sizes": {
        "Large":       [ { "ingredient": "Coffee beans", "qty": 18 }, { "ingredient": "Milk", "qty": 240 } ],
        "Extra Large": [ { "ingredient": "Coffee beans", "qty": 27 }, { "ingredient": "Milk", "qty": 330 } ]
      }
    }
  ]
}
```

- `categories`: the snapshot categories this file covers. Each category belongs to exactly one file. The importer uses these files:

  | File | Categories |
  |---|---|
  | `hot.json` | Coffee, Hot Non-Coffee |
  | `iced.json` | Iced Coffee, Iced Non-Coffee, Cold Brews, Monthly Drops |
  | `creme.json` | Creme Coffee, Creme Non-Coffee, Sundae |
  | `waffles.json` | Stick Waffles, Stuffed Waffles, Waffle Chips |
  | `bakery-eatery.json` | Cup Cakes, Cheesecakes, Eatery, In-store |
  | `other.json` | any future category |

- `menu_item_id` must be in the snapshot. `menu_item` is the item's name, kept for people to read.
- `status`:
  - `draft`: proposed, not yet approved by the owner. **Not deployed** unless `--include-drafts` is passed.
  - `confirmed`: deployed.
  - `skip`: deliberately uses no stock, so `base` and `sizes` must be empty.
- `source`: `petpooja` (imported from the café's Petpooja inventory setup), `owner` (the owner said it), `chef-default` (the chef agent's estimate), or `pos` (read back from the live recipe).
- **One serving, in each stock item's own unit** (INV-D11).
- `base` is the recipe for every size. A key in `sizes` is a size label exactly as in the snapshot ("Extra Large", "B", "Focaccia Bread"), and a size's list **replaces** `base` for that size.
  - Every size of a `draft` or `confirmed` item must end up with a non-empty recipe.
- Each ingredient appears at most once per list. `qty` is greater than 0, at most 999999, with at most 3 decimals. At most 60 lines per item across base and sizes.

### `addon-recipes.json`

An add-on's recipe can depend on the drink and size it is added to: sugar in a Latte
Extra Large is not sugar in an Espresso. So each option has a general recipe plus
optional **scopes**. The most specific one that has lines wins:

**item + size → item (all sizes) → general.**

```json
{
  "options": [
    { "addon_option_id": "8178c159-…", "group": "Sugar", "option": "Normal",
      "status": "confirmed", "source": "petpooja", "notes": "",
      "lines": [ { "ingredient": "Sugar", "qty": 20 } ],
      "scopes": [
        { "menu_item_id": "0b398e3e-…", "menu_item": "Latte", "size_label": "Extra Large",
          "lines": [ { "ingredient": "Sugar", "qty": 25 } ] },
        { "menu_item_id": "3dd077ea-…", "menu_item": "Espresso", "size_label": "",
          "lines": [ { "ingredient": "Sugar", "qty": 10 } ] }
      ] }
  ]
}
```

- `lines` is the general recipe, used per serving the add-on is added to (INV-D19).
- `scopes` is optional:
  - Each scope names a snapshot item and either one of its size labels or `""` (all its sizes).
  - The pair `(menu_item_id, size_label)` appears at most once per option.
  - Scope lines follow the same line rules as recipe lines.
- `status` works the same as for menu items. A `draft` or `confirmed` option needs at least one line somewhere. A `skip` option has no lines and no scopes: "No Ice", "No Sugar" and "Assemble It By You" are `skip`.

## Importing from Petpooja

```
npm run inventory:import-petpooja [-- --csv <path>]   # default <book>/petpooja/Item_Addon_Recipe.csv
```

- **Rows.**
  - The ID column is hex-encoded ASCII: `itemId#variationId` for an item row, and `itemId#variationId#addonId` for an add-on row. An add-on row belongs to the item row whose ID prefixes it, which gives the menu item and size without parsing the name.
  - Item names read `Name [n] (Size)`. The trailing parenthesis is a size only if it is one of the matched item's live size labels. In `Dusky Dawn (nutella)` it is part of the name.
- **Matching an item.**
  1. `petpooja/aliases.json` (`"items": { "<Petpooja name>": "<menu item id>" | null }`, where null means "not on the menu, ignore").
  2. The existing matcher from the order-history import (`lib/petpooja/match.ts`: `ITEM_ALIASES`, the "… Waffle" suffix and plural rules). It has no fuzzy matching, because a wrong match is worse than none.
- **Matching an add-on.** By add-on group plus option name, normalised the same way, against the snapshot. `aliases.json` `"addons": { "<Group>|<Option>": "<option id>" | null }` covers renames.
- **Raw materials.**
  - Each raw material maps to a stock item through `petpooja/materials.json` (`"<Petpooja name>": { "name", "category", "tracks_expiry" }`). Several Petpooja names may map to one stock item, which merges obvious duplicates such as "RedVelvet Flour" and "Red Velvet Flour". Merged names must share a unit.
  - An unmapped material is added with an empty category, so `inventory:check` fails until it is filled in.
  - Two lines of one recipe that land on the same stock item are summed.
  - A line with a blank quantity is dropped and reported.
- **Add-ons.**
  - Every (item, size) recipe of an option is gathered. Entries with no lines are ignored: Petpooja simply had none set.
  - The most common line-set becomes the general `lines`.
  - An item whose sizes all differ from the general recipe in the same way gets an item scope. Otherwise only the sizes that differ get size scopes.
- **What it writes.**
  - Recipes: `status: confirmed, source: petpooja`. It never overwrites an item or option whose `source` is `owner` or `pos`. It does replace `chef-default` drafts and earlier `petpooja` imports.
  - `stock-items.json`: the import **owns** every stock item whose name (trimmed, any case) is a Petpooja material key in `materials.json` or a `name` a mapping there gives. It rebuilds those on every run and leaves every other item (a chef or owner addition) exactly as it is.
    - One item per mapped name that an imported recipe uses, spelled **exactly as the mapping's `name`**. The mapping wins over an existing spelling, case included, so fixing a name in `materials.json` and re-importing renames the item everywhere the import wrote it. The category and `tracks_expiry` come from the mapping (a mapping still waiting for a category keeps the one the book has).
    - `par_level`, `reorder_qty`, `standalone` and `notes` are carried over from every existing item that collapses into the same mapped name. If two disagree, the first non-default value in file order wins and the report warns.
    - An owned item that no imported recipe uses any more is dropped, unless it has one of those settings. Then it is kept and the report warns ("stale stock item kept because it has owner settings"), and the owner decides.
    - Recipes and add-ons kept as they were (`owner`, `pos`) are never edited. If one still names a replaced spelling, the report warns and `inventory:check` flags it until it is fixed by hand.
  - `import-report.md`: what matched; Petpooja items that are not on the menu; **live items and sizes with no Petpooja recipe (what is still missing)**; add-ons it could not match; unit conflicts; blank quantities; unmapped or merged materials; stock items renamed or dropped; warnings.
- **Idempotent.** The same inputs give byte-identical files. The one exception is the report, which lists the stock items renamed or dropped by that run, so the run after a rename has nothing left to list.

## House defaults for `chef-default` drafts

When the owner or Petpooja leaves something out, the chef agent drafts it. The first choice is always to **copy the proportions of the closest item that has a Petpooja recipe**, for example a Monthly Drops iced cappuccino from Cappucino Iced. The defaults below apply only where no such item exists:

| Thing | Default |
|---|---|
| Cup sizes | Large = 12 oz (350 ml) · Extra Large = 16 oz (470 ml) |
| Espresso | a single shot is 9 g of beans · Large milk drink = double · Extra Large = triple |
| Syrup / sauce | 15 g Large, 20 g Extra Large; a drizzle is 10 g |
| Ice cream | a scoop is 60 g |
| Ice | **not tracked** (made on site) |
| Bought-in bakes | counted in `pcs` |
| Packaging | follow the Petpooja pattern for the same kind of item (cup + lid + straw, plate + spoon + napkin, box …) |

## Commands

```
npm run inventory:import-petpooja             # Petpooja export → book (+ import-report.md)
npm run inventory:check                       # validate; coverage by section
npm run inventory:build                       # <book>/seed.sql: save the book + apply confirmed recipes
npm run inventory:build -- --include-drafts   # also drafts (preview/test databases only)
npm run inventory:build -- --save-only        # only save the book to the database (no recipe changes)
npm run inventory:build -- --dry-run          # same SQL, but it ends by raising, so nothing is saved
npm run inventory:apply -- --dry-run          # the same thing over REST, no SQL editor: everything runs, then rolls back
npm run inventory:apply -- --yes              # ... and for real: one request, one transaction (needs the service-role key)
npm run inventory:pull                        # database → book directory (needs the service-role key)
npm run inventory:snapshot                    # refresh menu-snapshot.json from the live menu
```

`inventory:build` refuses to write while `inventory:check` has errors. The exception is `--save-only`, which saves the book as it is: the errors are shown as warnings, and only a book of the wrong shape is refused.

The output goes to the git-ignored book directory:
- `seed.sql`
- `seed.dry-run.sql`
- `save-only.sql`
- `save-only.dry-run.sql`

An `--out` path elsewhere in the repository is refused unless `--force-out` is passed, so that recipe quantities cannot land in a committed file.

### `inventory:apply`

`seed.sql` is several hundred KB, too big to paste into the Supabase SQL editor, and a checkout has no direct database connection: only the REST API and the service-role key. `inventory:apply` makes the same call as `seed.sql` over REST: `POST /rest/v1/rpc/inventory_apply_book`, in **one request and one transaction**, so it applies completely or not at all.

```
npm run inventory:apply -- --dry-run          # check it: every step runs in the database, then rolls back
npm run inventory:apply -- --yes              # apply it
npm run inventory:apply -- --save-only --yes  # only save the book (allowed while the book has validation errors)
npm run inventory:apply                       # no flag: prints what WOULD be applied and where, sends nothing, exits 2
```

- **Flags.** `--book <dir>`, `--include-drafts` (preview/test databases only), `--save-only`, `--dry-run`, `--yes` (required for a real apply), `--help`.
- **Validation.** The book is checked and compiled exactly as `inventory:build` does. Errors refuse the run, except with `--save-only`, which shows them as warnings, as `inventory:build --save-only` does.
- **Settings.** `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, from the environment or `.env.local` (the environment wins). The key is only sent as the request's `apikey` / `Authorization` headers and is never printed. The **target host** and the payload size are printed before anything is sent, so check them.
- **Answers.**
  - Success: prints the function's result (`{ "saved": true, "stock_items": n, "recipes": n, "addon_recipes": n, "save_only": false }`) and `Applied.`. Exit 0.
  - A dry run: the server ends it with an error whose message starts `DRY RUN OK`. That is the pass. It is printed with `Dry run passed; nothing was saved.`. Exit 0.
  - Any other refusal, such as a guard below or a bad key: PostgREST's message, details and hint are printed. Nothing was saved. Exit 1.
  - The function does not exist: `apply supabase/2026-10-inventory-apply-book.sql first`. Exit 1. (Right after applying the migration, PostgREST may need a moment; `notify pgrst, 'reload schema';` forces it.)
  - Exit 2: bad arguments, or no `--yes`.

## What the generated SQL does

The logic is the database function `inventory_apply_book(p_payload jsonb, p_doc jsonb, p_dry_run boolean default false)` in `supabase/2026-10-inventory-apply-book.sql`. `seed.sql` is a header comment and one statement, `select inventory_apply_book(<payload>, <book>, false)`, with the compiled payload and the book document as JSON literals. `inventory:apply` sends the same three arguments over REST. Either way the call is one transaction, so it applies completely or not at all. It is safe to re-run. It needs `2026-10-inventory.sql`, `2026-10-inventory-addon-scopes.sql` and `2026-10-inventory-apply-book.sql`.

The function is service-role only (`revoke execute … from public, anon, authenticated`). It returns `{ saved, stock_items, recipes, addon_recipes, save_only }`. Its steps are:

0. **Saves the book.** It stores the whole book document in `inventory_recipe_book`, the single row that `inventory:pull` reads back. A missing document is refused. If the payload is `null` (`--save-only`) this is all it does: steps 1 to 5 are skipped and no stock item, recipe or setting is touched. A payload that is not an object with `stock_items`, `recipes` and `addon_recipes` lists is refused up front.
1. **Auto-hide guard.** If no stock has ever been received, it sets `store_settings.stock_auto_hide = false`. Otherwise, every recipe item would read "0 on hand" and vanish from the live menu. This happens at the database level, whatever the app flag says. Switch auto-hide back on (Stock tab) **after** the opening stock is received.
2. **Unit guard.** It refuses to run if a stock item already exists live with a different unit.
3. **Stock items.** It adds new ones and updates existing ones, matched by name regardless of case. It never changes a unit, and never overwrites a live par or reorder level with 0.
4. **Existence guard.** It refuses to run if any menu item, add-on option, or menu item named by an add-on scope is missing live.
5. **Recipes.** Each recipe in the payload replaces that item's whole recipe through `inventory_set_recipe`, so the size-label check applies. Each add-on replaces all of its scopes through `inventory_set_addon_recipe_scopes`. Items and add-ons not in the payload are left alone.

With `p_dry_run` (`--dry-run`) every step runs, and then the function raises `DRY RUN OK (nothing was saved): <result>`, which rolls all of it back. The guards are real, so a dry run that passes means the real call would not be refused.

## Deploy

1. Apply the three migrations, in this order, in the Supabase SQL editor. Each is idempotent and committed:
   - `supabase/2026-10-inventory.sql`
   - `supabase/2026-10-inventory-addon-scopes.sql`
   - `supabase/2026-10-inventory-apply-book.sql` (the `inventory_apply_book` function)
2. Check that everything to be tracked is `confirmed` and that `npm run inventory:check` shows no errors. Refresh the menu snapshot (`npm run inventory:snapshot`) if the menu has changed.
3. Apply the book, either way:
   - **Over REST** (works from a checkout, with `SUPABASE_SERVICE_ROLE_KEY` set):
     ```
     npm run inventory:apply -- --dry-run     # everything runs, then rolls back: "DRY RUN OK"
     npm run inventory:apply -- --yes         # applies for real
     ```
   - **In the SQL editor**: run `npm run inventory:build`, then paste `<book>/seed.sql`, or ask Claude to apply it. (`seed.sql` is large; if the editor will not take it, use the REST way.)

   Run the verify queries at the foot of `seed.sql` afterwards.
4. Continue with the go-live steps in `INVENTORY-SPEC.md` §C: opening stock (C4), the walk-through (C5), the flag (C6), then switch auto-hide on.

A recipe edited later on the POS is **overwritten** the next time the seed is applied. Tell the chef agent about the change so the book stays the source of truth. The POS editor edits only an add-on's general recipe. Its per-item and per-size amounts come from the book.

## Known limits of recipes (from the engine)

- **Milk swaps add, they don't swap.** "Oat" on a latte uses the add-on's oat milk **and** the base recipe's dairy milk. A count corrects the drift.
- **Combos** need their full recipe written out.
- **Per-size auto-hide is not supported.** See INVENTORY-SPEC "Known limits".
