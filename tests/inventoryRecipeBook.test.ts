import { describe, expect, it } from 'vitest';
import {
  compileRecipeBook,
  formatIssue,
  renderSeedSql,
  seedCounts,
  validateRecipeBook,
  type Issue,
  type RecipeBook,
  type RecipeItemEntry,
  type SeedPayload,
  type StockItemEntry,
} from '@/lib/inventory/recipeBook';
import { MAX_QTY } from '@/lib/inventory/rules';

// The recipe book (docs/INVENTORY-RECIPE-BOOK.md): every check the validator
// makes, what the compiler emits, and the seed SQL — all on a tiny in-memory
// menu, without touching the real data or a database.

const LATTE = 'item-latte';
const BROWNIE = 'item-brownie';
const BREW = 'item-brew';
const OAT = 'addon-oat';
const NO_ICE = 'addon-no-ice';

const COFFEE_FILE = 'recipes/coffee.json';
const BAKES_FILE = 'recipes/bakes.json';
const STOCK_FILE = 'stock-items.json';
const ADDON_FILE = 'addon-recipes.json';

function stock(name: string, unit: StockItemEntry['unit'], category: StockItemEntry['category'], extra: Partial<StockItemEntry> = {}): StockItemEntry {
  return { name, unit, category, tracks_expiry: false, par_level: 0, reorder_qty: 0, ...extra };
}

/** A small, valid book: a Latte with two sizes (confirmed), a Brownie with one
 * size (draft), a Cold Brew nobody has written yet, and two add-ons. */
function makeBook(): RecipeBook {
  return {
    snapshot: {
      _comment: 'test',
      captured_at: '2026-09-30T14:40:34.856Z',
      items: [
        {
          id: LATTE, name: 'Latte', category: 'Coffee', parent_category: 'Hot', is_available: true, description: '',
          sizes: [{ label: 'Large', price_inr: 150 }, { label: 'Extra Large', price_inr: 170 }],
          addon_groups: ['ADD ON Milk'],
        },
        {
          id: BROWNIE, name: 'Brownie', category: 'Bakes', parent_category: '', is_available: true, description: '',
          sizes: [{ label: 'Regular', price_inr: 80 }],
          addon_groups: [],
        },
        {
          id: BREW, name: 'Signature Iced Brew', category: 'Cold Brews', parent_category: '', is_available: true, description: '',
          sizes: [{ label: 'Large', price_inr: 155 }, { label: 'Extra Large', price_inr: 175 }],
          addon_groups: [],
        },
      ],
      addon_options: [
        { id: OAT, group: 'ADD ON Milk', group_label: 'Choose Milk', option: 'Oat', price_inr: 40 },
        { id: NO_ICE, group: 'Ice', group_label: 'Ice Level', option: 'No Ice', price_inr: 0 },
      ],
    },
    stockItems: {
      items: [
        stock('Espresso beans', 'g', 'Coffee'),
        stock('Full-cream milk', 'ml', 'Dairy & Alternatives', { tracks_expiry: true }),
        stock('Oat milk', 'ml', 'Dairy & Alternatives', { tracks_expiry: true, par_level: 2000, reorder_qty: 6000 }),
        stock('Hot cup 12 oz', 'pcs', 'Packaging'),
        stock('Brownie', 'pcs', 'Bakery', { tracks_expiry: true }),
        stock('Floor cleaner', 'pack', 'Packaging', { standalone: true }),
      ],
    },
    recipeFiles: [
      {
        path: COFFEE_FILE,
        file: {
          categories: ['Coffee'],
          items: [
            {
              menu_item_id: LATTE, menu_item: 'Latte', status: 'confirmed', source: 'owner', notes: '',
              base: [],
              sizes: {
                Large: [{ ingredient: 'Espresso beans', qty: 18 }, { ingredient: 'Full-cream milk', qty: 240 }, { ingredient: 'Hot cup 12 oz', qty: 1 }],
                'Extra Large': [{ ingredient: 'Espresso beans', qty: 27 }, { ingredient: 'Full-cream milk', qty: 330 }, { ingredient: 'Hot cup 12 oz', qty: 1 }],
              },
            },
          ],
        },
      },
      {
        path: BAKES_FILE,
        file: {
          categories: ['Bakes'],
          items: [
            {
              menu_item_id: BROWNIE, menu_item: 'Brownie', status: 'draft', source: 'chef-default', notes: '',
              base: [{ ingredient: 'Brownie', qty: 1 }],
              sizes: {},
            },
          ],
        },
      },
    ],
    addonRecipes: {
      options: [
        { addon_option_id: OAT, group: 'ADD ON Milk', option: 'Oat', status: 'draft', source: 'chef-default', notes: '', lines: [{ ingredient: 'Oat milk', qty: 240 }] },
        { addon_option_id: NO_ICE, group: 'Ice', option: 'No Ice', status: 'skip', source: 'chef-default', notes: '', lines: [] },
      ],
    },
  };
}

/** Sets a field to a value the types would not allow (the JSON is hand-written). */
function put(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

const latte = (book: RecipeBook): RecipeItemEntry => book.recipeFiles[0].file.items[0];
const brownie = (book: RecipeBook): RecipeItemEntry => book.recipeFiles[1].file.items[0];

function errorsAfter(change: (book: RecipeBook) => void): Issue[] {
  const book = makeBook();
  change(book);
  return validateRecipeBook(book).errors;
}
function warningsAfter(change: (book: RecipeBook) => void): Issue[] {
  const book = makeBook();
  change(book);
  return validateRecipeBook(book).warnings;
}
const issue = (where: string, message: RegExp) => ({ where, message: expect.stringMatching(message) });

describe('validateRecipeBook — a valid book', () => {
  it('has no errors, and only the uncovered Cold Brew as a warning', () => {
    const { errors, warnings } = validateRecipeBook(makeBook());
    expect(errors).toEqual([]);
    expect(warnings).toEqual([issue('Cold Brews › Signature Iced Brew', /no recipe entry/)]);
  });

  it('accepts every source, a size falling back to base, and 60 lines', () => {
    const book = makeBook();
    for (const [source, entry] of [['pos', latte(book)], ['petpooja', brownie(book)]] as const) put(entry, 'source', source);
    // Base covers every size that has no list of its own.
    latte(book).base = [{ ingredient: 'Hot cup 12 oz', qty: 1 }];
    delete latte(book).sizes['Extra Large'];
    // Exactly 60 lines on one item is allowed.
    for (let i = 1; i <= 60; i++) book.stockItems.items.push(stock(`Bulk ${i}`, 'g', 'Powders & Mixes'));
    brownie(book).base = Array.from({ length: 60 }, (_, i) => ({ ingredient: `Bulk ${i + 1}`, qty: 1 }));
    expect(validateRecipeBook(book).errors).toEqual([]);
  });

  it('matches ingredients on trimmed, case-insensitive names, and accepts three decimals', () => {
    const book = makeBook();
    latte(book).sizes.Large = [{ ingredient: '  ESPRESSO beans ', qty: 0.001 }, { ingredient: 'Full-cream milk', qty: 999_999 }];
    expect(validateRecipeBook(book).errors).toEqual([]);
  });

  it('never throws on malformed files', () => {
    const book = makeBook();
    put(book, 'stockItems', {});
    put(book, 'addonRecipes', []);
    book.recipeFiles = [
      { path: 'recipes/null.json', file: null as never },
      { path: 'recipes/items.json', file: { categories: ['Coffee'], items: 'nope' } as never },
      { path: 'recipes/rows.json', file: { categories: ['Bakes'], items: [null, 7, { menu_item_id: BROWNIE, sizes: [], base: 'x' }] } as never },
    ];
    const { errors } = validateRecipeBook(book);
    expect(errors).toContainEqual(issue(STOCK_FILE, /`items` list/));
    expect(errors).toContainEqual(issue(ADDON_FILE, /`options` list/));
    expect(errors).toContainEqual(issue('recipes/null.json', /object/));
    expect(errors).toContainEqual(issue('recipes/items.json', /`items` must be a list/));
    expect(errors).toContainEqual(issue('recipes/rows.json › Brownie', /`sizes` must be an object/));
    expect(errors).toContainEqual(issue('recipes/rows.json › Brownie', /`base` must be a list/));
  });
});

describe('validateRecipeBook — stock items', () => {
  const where = (n: number) => `${STOCK_FILE} › item #${n}`;

  it('rejects a missing name', () => {
    expect(errorsAfter((b) => put(b.stockItems.items[0], 'name', undefined))).toContainEqual(issue(where(1), /name is missing or blank/));
  });

  it('rejects a blank name', () => {
    expect(errorsAfter((b) => (b.stockItems.items[0].name = '   '))).toContainEqual(issue(where(1), /name is missing or blank/));
  });

  it('rejects a name over 80 characters after trimming', () => {
    const long = 'x'.repeat(81);
    expect(errorsAfter((b) => (b.stockItems.items[0].name = `  ${long}  `))).toContainEqual(issue(`${STOCK_FILE} › ${long}`, /81 characters — at most 80/));
    // Exactly 80 is fine.
    expect(errorsAfter((b) => b.stockItems.items.push(stock('x'.repeat(80), 'g', 'Coffee')))).toEqual([]);
  });

  it('rejects a duplicate name regardless of case and surrounding spaces', () => {
    const errors = errorsAfter((b) => b.stockItems.items.push(stock('  ESPRESSO BEANS ', 'g', 'Coffee')));
    expect(errors).toContainEqual(issue(`${STOCK_FILE} › ESPRESSO BEANS`, /duplicate of stock item "Espresso beans"/));
  });

  it('rejects a unit that is not g, kg, ml, l, pcs or pack', () => {
    expect(errorsAfter((b) => put(b.stockItems.items[0], 'unit', 'oz'))).toContainEqual(issue(`${STOCK_FILE} › Espresso beans`, /unit "oz" must be one of g, kg, ml, l, pcs, pack/));
  });

  it('rejects a category outside the contract list', () => {
    expect(errorsAfter((b) => put(b.stockItems.items[0], 'category', 'Snacks'))).toContainEqual(issue(`${STOCK_FILE} › Espresso beans`, /category "Snacks" must be one of Coffee, Dairy & Alternatives/));
  });

  it.each([
    ['not a number', '12'],
    ['negative', -1],
    ['above the maximum', MAX_QTY + 1],
    ['not finite', Infinity],
  ])('rejects a par_level that is %s', (_label, value) => {
    expect(errorsAfter((b) => put(b.stockItems.items[0], 'par_level', value))).toContainEqual(issue(`${STOCK_FILE} › Espresso beans`, /par_level must be a number from 0 to 999999/));
  });

  it.each([
    ['not a number', null],
    ['negative', -0.5],
    ['above the maximum', 2_000_000],
  ])('rejects a reorder_qty that is %s', (_label, value) => {
    expect(errorsAfter((b) => put(b.stockItems.items[0], 'reorder_qty', value))).toContainEqual(issue(`${STOCK_FILE} › Espresso beans`, /reorder_qty must be a number from 0 to 999999/));
  });

  it('rejects a tracks_expiry or standalone that is not a boolean (absent is fine)', () => {
    expect(errorsAfter((b) => put(b.stockItems.items[0], 'tracks_expiry', 'yes'))).toContainEqual(issue(`${STOCK_FILE} › Espresso beans`, /tracks_expiry must be true or false/));
    expect(errorsAfter((b) => put(b.stockItems.items[0], 'standalone', 1))).toContainEqual(issue(`${STOCK_FILE} › Espresso beans`, /standalone must be true or false/));
    expect(errorsAfter((b) => put(b.stockItems.items[0], 'tracks_expiry', undefined))).toEqual([]);
  });
});

describe('validateRecipeBook — recipe files', () => {
  it.each([
    ['empty', []],
    ['not a list', 'Coffee'],
    ['not strings', [7]],
  ])('rejects `categories` that is %s', (_label, value) => {
    expect(errorsAfter((b) => put(b.recipeFiles[0].file, 'categories', value))).toContainEqual(issue(COFFEE_FILE, /`categories` must be a non-empty list/));
  });

  it('rejects a category that is not in the snapshot', () => {
    expect(errorsAfter((b) => b.recipeFiles[0].file.categories.push('Smoothies'))).toContainEqual(issue(COFFEE_FILE, /category "Smoothies" is not in the menu snapshot/));
  });

  it('rejects a category claimed by two files', () => {
    expect(errorsAfter((b) => b.recipeFiles[1].file.categories.push('Coffee'))).toContainEqual(issue(BAKES_FILE, /category "Coffee" is also claimed by recipes\/coffee\.json/));
  });

  it('rejects a menu_item_id that is not in the snapshot', () => {
    expect(errorsAfter((b) => (latte(b).menu_item_id = 'item-gone'))).toContainEqual(issue(`${COFFEE_FILE} › Latte`, /menu_item_id "item-gone" is not in the menu snapshot/));
  });

  it("rejects an item whose snapshot category is not one of its file's categories", () => {
    const errors = errorsAfter((b) => b.recipeFiles[0].file.items.push({ ...brownie(b), menu_item_id: BROWNIE }));
    expect(errors).toContainEqual(issue(`${COFFEE_FILE} › Brownie`, /category "Bakes" is not one of this file's categories \(Coffee\)/));
  });

  it('rejects the same menu_item_id twice, in one file or across files', () => {
    const within = errorsAfter((b) => b.recipeFiles[0].file.items.push(structuredClone(latte(b))));
    expect(within).toContainEqual(issue(`${COFFEE_FILE} › Latte`, /menu_item_id is listed twice — first at recipes\/coffee\.json › Latte/));
    const across = errorsAfter((b) => {
      b.recipeFiles[1].file.categories.push('Coffee');
      b.recipeFiles[1].file.items.push(structuredClone(latte(b)));
    });
    expect(across).toContainEqual(issue(`${BAKES_FILE} › Latte`, /listed twice — first at recipes\/coffee\.json › Latte/));
  });

  it('rejects a status that is not draft, confirmed or skip', () => {
    expect(errorsAfter((b) => put(latte(b), 'status', 'approved'))).toContainEqual(issue(`${COFFEE_FILE} › Latte`, /status "approved" must be one of draft, confirmed, skip/));
  });

  it('rejects a source that is not owner, chef-default, pos or petpooja', () => {
    expect(errorsAfter((b) => put(latte(b), 'source', 'guess'))).toContainEqual(issue(`${COFFEE_FILE} › Latte`, /source "guess" must be one of owner, chef-default, pos, petpooja/));
  });

  it('rejects a sizes key that is not exactly a size label of the item', () => {
    const wrongSize = errorsAfter((b) => (latte(b).sizes.Regular = [{ ingredient: 'Hot cup 12 oz', qty: 1 }]));
    expect(wrongSize).toContainEqual(issue(`${COFFEE_FILE} › Latte › Regular`, /"Regular" is not a size of Latte \(sizes: Large, Extra Large\)/));
    const spaced = errorsAfter((b) => {
      latte(b).sizes['Large '] = latte(b).sizes.Large;
      delete latte(b).sizes.Large;
    });
    expect(spaced).toContainEqual(issue(`${COFFEE_FILE} › Latte › Large `, /is not a size of Latte/));
  });

  it('rejects an ingredient that is not a stock item', () => {
    expect(errorsAfter((b) => (latte(b).sizes.Large[0].ingredient = 'Espresso bean'))).toContainEqual(
      issue(`${COFFEE_FILE} › Latte › Large`, /ingredient "Espresso bean" is not a stock item/),
    );
  });

  it.each([
    ['not a number', '18', /qty of "Espresso beans" must be a number/],
    ['not finite', Infinity, /must be a number/],
    ['zero', 0, /must be more than 0/],
    ['negative', -5, /must be more than 0/],
    ['above the maximum', MAX_QTY + 1, /is above 999999/],
    ['more than 3 decimals', 1.2345, /more than 3 decimals/],
  ])('rejects a qty that is %s', (_label, qty, message) => {
    expect(errorsAfter((b) => put(latte(b).sizes.Large[0], 'qty', qty))).toContainEqual(issue(`${COFFEE_FILE} › Latte › Large`, message));
  });

  it('rejects the same ingredient twice in one size list', () => {
    const errors = errorsAfter((b) => latte(b).sizes.Large.push({ ingredient: ' espresso BEANS', qty: 5 }));
    expect(errors).toContainEqual(issue(`${COFFEE_FILE} › Latte › Large`, /ingredient "espresso BEANS" appears twice/));
  });

  it('rejects the same ingredient twice in base', () => {
    const errors = errorsAfter((b) => (brownie(b).base = [{ ingredient: 'Brownie', qty: 1 }, { ingredient: 'brownie', qty: 2 }]));
    expect(errors).toContainEqual(issue(`${BAKES_FILE} › Brownie`, /ingredient "brownie" appears twice/));
  });

  it('rejects more than 60 lines in one item, base and sizes together', () => {
    const errors = errorsAfter((b) => {
      for (let i = 1; i <= 31; i++) b.stockItems.items.push(stock(`Bulk ${i}`, 'g', 'Powders & Mixes'));
      brownie(b).base = Array.from({ length: 31 }, (_, i) => ({ ingredient: `Bulk ${i + 1}`, qty: 1 }));
      brownie(b).sizes = { Regular: Array.from({ length: 30 }, (_, i) => ({ ingredient: `Bulk ${i + 1}`, qty: 2 })) };
    });
    expect(errors).toContainEqual(issue(`${BAKES_FILE} › Brownie`, /61 lines — at most 60/));
  });

  it('rejects a skip item that has lines', () => {
    expect(errorsAfter((b) => put(brownie(b), 'status', 'skip'))).toContainEqual(issue(`${BAKES_FILE} › Brownie`, /status is skip, so base and sizes must be empty/));
    expect(errorsAfter((b) => Object.assign(brownie(b), { status: 'skip', base: [], sizes: { Regular: [{ ingredient: 'Brownie', qty: 1 }] } }))).toContainEqual(
      issue(`${BAKES_FILE} › Brownie`, /status is skip/),
    );
    expect(errorsAfter((b) => Object.assign(brownie(b), { status: 'skip', base: [], sizes: {} }))).toEqual([]);
  });

  it('rejects a draft or confirmed item where a size ends up with no recipe', () => {
    // Base empty and only Large written: Extra Large has nothing.
    const errors = errorsAfter((b) => delete latte(b).sizes['Extra Large']);
    expect(errors).toContainEqual(issue(`${COFFEE_FILE} › Latte › Extra Large`, /size has no recipe/));
    expect(errors).not.toContainEqual(issue(`${COFFEE_FILE} › Latte › Large`, /size has no recipe/));
    // A single-size item with nothing at all, as a draft.
    expect(errorsAfter((b) => (brownie(b).base = []))).toContainEqual(issue(`${BAKES_FILE} › Brownie › Regular`, /size has no recipe.*draft/));
  });

  it('warns, without an error, when menu_item differs from the live name', () => {
    expect(warningsAfter((b) => (latte(b).menu_item = 'Caffe Latte'))).toContainEqual(issue(`${COFFEE_FILE} › Latte`, /menu_item "Caffe Latte" differs from the live name "Latte"/));
    expect(errorsAfter((b) => (latte(b).menu_item = 'Caffe Latte'))).toEqual([]);
  });
});

describe('validateRecipeBook — add-on recipes', () => {
  const oat = (b: RecipeBook) => b.addonRecipes.options[0];
  const where = `${ADDON_FILE} › ADD ON Milk › Oat`;

  it('rejects an addon_option_id that is not in the snapshot', () => {
    expect(errorsAfter((b) => (oat(b).addon_option_id = 'addon-gone'))).toContainEqual(
      issue(`${ADDON_FILE} › ADD ON Milk › Oat`, /addon_option_id "addon-gone" is not in the menu snapshot/),
    );
  });

  it('rejects an option id listed twice', () => {
    expect(errorsAfter((b) => b.addonRecipes.options.push(structuredClone(oat(b))))).toContainEqual(issue(where, /addon_option_id is listed twice/));
  });

  it('rejects an ingredient that is not a stock item', () => {
    expect(errorsAfter((b) => (oat(b).lines[0].ingredient = 'Almond milk'))).toContainEqual(issue(where, /ingredient "Almond milk" is not a stock item/));
  });

  it.each([
    ['not a number', 'lots', /must be a number/],
    ['zero', 0, /must be more than 0/],
    ['above the maximum', MAX_QTY + 1, /is above 999999/],
    ['more than 3 decimals', 0.0005, /more than 3 decimals/],
  ])('rejects a qty that is %s', (_label, qty, message) => {
    expect(errorsAfter((b) => put(oat(b).lines[0], 'qty', qty))).toContainEqual(issue(where, message));
  });

  it('rejects the same ingredient twice', () => {
    expect(errorsAfter((b) => oat(b).lines.push({ ingredient: 'OAT MILK', qty: 10 }))).toContainEqual(issue(where, /ingredient "OAT MILK" appears twice/));
  });

  it('rejects more than 60 lines', () => {
    const errors = errorsAfter((b) => {
      for (let i = 1; i <= 61; i++) b.stockItems.items.push(stock(`Bulk ${i}`, 'g', 'Powders & Mixes'));
      oat(b).lines = Array.from({ length: 61 }, (_, i) => ({ ingredient: `Bulk ${i + 1}`, qty: 1 }));
    });
    expect(errors).toContainEqual(issue(where, /61 lines — at most 60/));
  });

  it('rejects a status or source outside the lists', () => {
    expect(errorsAfter((b) => put(oat(b), 'status', 'maybe'))).toContainEqual(issue(where, /status "maybe" must be one of/));
    expect(errorsAfter((b) => put(oat(b), 'source', 'me'))).toContainEqual(issue(where, /source "me" must be one of/));
  });

  it('rejects a skip add-on that has lines', () => {
    expect(errorsAfter((b) => put(oat(b), 'status', 'skip'))).toContainEqual(issue(where, /status is skip, so lines must be empty/));
  });

  it('rejects a draft or confirmed add-on with no lines', () => {
    expect(errorsAfter((b) => (oat(b).lines = []))).toContainEqual(issue(where, /no lines \(status is draft\)/));
    expect(errorsAfter((b) => Object.assign(oat(b), { status: 'confirmed', lines: [] }))).toContainEqual(issue(where, /no lines \(status is confirmed\)/));
  });

  it('rejects `scopes`, which the tools cannot load yet (rather than dropping them from the seed)', () => {
    const scoped = errorsAfter((b) => put(oat(b), 'scopes', [{ menu_item_id: LATTE, menu_item: 'Latte', size_label: 'Large', lines: [{ ingredient: 'Oat milk', qty: 200 }] }]));
    expect(scoped).toContainEqual(issue(where, /`scopes` .* not supported/));
    // Absent or empty is fine.
    expect(errorsAfter((b) => put(oat(b), 'scopes', []))).toEqual([]);
  });

  it('warns when group or option differ from the snapshot', () => {
    const warnings = warningsAfter((b) => Object.assign(oat(b), { group: 'Milk', option: 'Oat milk' }));
    expect(warnings).toContainEqual(issue(where, /group "Milk" differs from the live group "ADD ON Milk"/));
    expect(warnings).toContainEqual(issue(where, /option "Oat milk" differs from the live name "Oat"/));
  });
});

describe('validateRecipeBook — warnings and coverage', () => {
  it('warns about a stock item no recipe uses, unless it is standalone', () => {
    const warnings = warningsAfter((b) => b.stockItems.items.push(stock('Vanilla syrup', 'ml', 'Syrups & Sauces'), stock('Spare key', 'pcs', 'Packaging', { standalone: true })));
    expect(warnings).toContainEqual(issue(`${STOCK_FILE} › Vanilla syrup`, /no recipe uses this stock item/));
    expect(warnings).not.toContainEqual(issue(`${STOCK_FILE} › Spare key`, /./));
    // Draft and add-on recipes count as use.
    expect(warnings).not.toContainEqual(issue(`${STOCK_FILE} › Oat milk`, /./));
    expect(warnings).not.toContainEqual(issue(`${STOCK_FILE} › Brownie`, /./));
  });

  it('lists every uncovered menu item and add-on option individually', () => {
    const warnings = warningsAfter((b) => {
      b.recipeFiles.pop();
      b.addonRecipes.options.pop();
    });
    expect(warnings).toContainEqual(issue('Bakes › Brownie', /menu item has no recipe entry/));
    expect(warnings).toContainEqual(issue('Cold Brews › Signature Iced Brew', /menu item has no recipe entry/));
    expect(warnings).toContainEqual(issue('Ice › No Ice', /add-on has no recipe entry/));
  });

  it('counts coverage per category (in snapshot order), for add-ons, and overall', () => {
    const { coverage } = validateRecipeBook(makeBook());
    expect(coverage.categories).toEqual([
      { category: 'Coffee', total: 1, confirmed: 1, draft: 0, skip: 0, missing: 0 },
      { category: 'Bakes', total: 1, confirmed: 0, draft: 1, skip: 0, missing: 0 },
      { category: 'Cold Brews', total: 1, confirmed: 0, draft: 0, skip: 0, missing: 1 },
    ]);
    expect(coverage.menuItems).toEqual({ total: 3, confirmed: 1, draft: 1, skip: 0, missing: 1 });
    expect(coverage.addons).toEqual({ total: 2, confirmed: 0, draft: 1, skip: 1, missing: 0 });
    expect(coverage.overall).toEqual({ total: 5, confirmed: 1, draft: 2, skip: 1, missing: 1 });
  });

  it('counts an entry with an unusable status as missing, and only the first entry of a duplicate', () => {
    const book = makeBook();
    put(latte(book), 'status', 'approved');
    book.recipeFiles[1].file.categories.push('Coffee');
    book.recipeFiles[1].file.items.push({ ...structuredClone(latte(book)), status: 'skip', base: [], sizes: {} });
    const { coverage } = validateRecipeBook(book);
    expect(coverage.categories[0]).toEqual({ category: 'Coffee', total: 1, confirmed: 0, draft: 0, skip: 0, missing: 1 });
  });
});

describe('compileRecipeBook', () => {
  it('emits confirmed recipes only by default, with the stock items they use plus standalone ones', () => {
    const payload = compileRecipeBook(makeBook(), { includeDrafts: false });
    expect(payload.recipes.map((r) => r.id)).toEqual([LATTE]);
    expect(payload.addon_recipes).toEqual([]);
    // stock-items.json order; Oat milk and Brownie are only used by drafts.
    expect(payload.stock_items.map((s) => s.name)).toEqual(['Espresso beans', 'Full-cream milk', 'Hot cup 12 oz', 'Floor cleaner']);
  });

  it('adds drafts with includeDrafts, in snapshot order, add-ons named "Group › Option"', () => {
    const book = makeBook();
    book.recipeFiles.reverse(); // file order must not matter
    const payload = compileRecipeBook(book, { includeDrafts: true });
    expect(payload.recipes.map((r) => r.id)).toEqual([LATTE, BROWNIE]);
    expect(payload.recipes.map((r) => r.name)).toEqual(['Latte', 'Brownie']);
    expect(payload.addon_recipes).toEqual([{ id: OAT, name: 'ADD ON Milk › Oat', lines: [{ ingredient: 'Oat milk', qty: 240 }] }]);
    expect(payload.stock_items.map((s) => s.name)).toEqual(['Espresso beans', 'Full-cream milk', 'Oat milk', 'Hot cup 12 oz', 'Brownie', 'Floor cleaner']);
  });

  it('never emits a skip item, and never lists it as using stock', () => {
    const payload = compileRecipeBook(makeBook(), { includeDrafts: true });
    expect(payload.addon_recipes.map((r) => r.id)).not.toContain(NO_ICE);
  });

  it('writes base lines with size_label "" and size lines with their label, base first, sizes in snapshot order', () => {
    const book = makeBook();
    latte(book).base = [{ ingredient: 'Hot cup 12 oz', qty: 1 }];
    latte(book).sizes = {
      'Extra Large': [{ ingredient: 'Espresso beans', qty: 27 }],
      Large: [{ ingredient: 'Espresso beans', qty: 18 }],
    };
    const { recipes } = compileRecipeBook(book, { includeDrafts: false });
    expect(recipes[0].lines).toEqual([
      { size_label: '', ingredient: 'Hot cup 12 oz', qty: 1 },
      { size_label: 'Large', ingredient: 'Espresso beans', qty: 18 },
      { size_label: 'Extra Large', ingredient: 'Espresso beans', qty: 27 },
    ]);
    const drafts = compileRecipeBook(makeBook(), { includeDrafts: true }).recipes;
    expect(drafts[1].lines).toEqual([{ size_label: '', ingredient: 'Brownie', qty: 1 }]);
  });

  it("writes ingredient names in the stock item's own spelling, and trims stock names", () => {
    const book = makeBook();
    book.stockItems.items[0].name = '  Espresso beans ';
    latte(book).sizes.Large[0].ingredient = ' espresso BEANS';
    const payload = compileRecipeBook(book, { includeDrafts: false });
    expect(payload.recipes[0].lines.filter((l) => l.size_label === 'Large').map((l) => l.ingredient)).toEqual(['Espresso beans', 'Full-cream milk', 'Hot cup 12 oz']);
    expect(payload.stock_items[0].name).toBe('Espresso beans');
  });

  it('emits exactly the seven stock item fields (tracks_expiry defaults to false)', () => {
    const book = makeBook();
    put(book.stockItems.items[0], 'tracks_expiry', undefined);
    put(book.stockItems.items[0], 'notes', 'kept in the book only');
    const payload = compileRecipeBook(book, { includeDrafts: true });
    expect(payload.stock_items[0]).toEqual({ name: 'Espresso beans', unit: 'g', category: 'Coffee', par_level: 0, reorder_qty: 0, tracks_expiry: false });
    expect(payload.stock_items[2]).toEqual({ name: 'Oat milk', unit: 'ml', category: 'Dairy & Alternatives', par_level: 2000, reorder_qty: 6000, tracks_expiry: true });
  });

  it('is deterministic', () => {
    const a = compileRecipeBook(makeBook(), { includeDrafts: true });
    const b = compileRecipeBook(makeBook(), { includeDrafts: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('throws when the book has errors', () => {
    const book = makeBook();
    latte(book).sizes.Large[0].ingredient = 'Nothing';
    expect(() => compileRecipeBook(book, { includeDrafts: false })).toThrow(/inventory: the recipe book has 1 error\(s\), first: recipes\/coffee\.json › Latte › Large: ingredient "Nothing"/);
  });

  it('compiles an empty book to empty lists', () => {
    const book = makeBook();
    book.recipeFiles = [];
    book.addonRecipes = { options: [] };
    book.stockItems = { items: [] };
    expect(compileRecipeBook(book, { includeDrafts: true })).toEqual({ stock_items: [], recipes: [], addon_recipes: [] });
  });

  it('formats issues as "where: message"', () => {
    expect(formatIssue({ where: 'a › b', message: 'oops' })).toBe('a › b: oops');
  });
});

describe('renderSeedSql', () => {
  const payload = (): SeedPayload => compileRecipeBook(makeBook(), { includeDrafts: true });
  const meta = { includeDrafts: false, snapshotCapturedAt: '2026-09-30T14:40:34.856Z' };
  const bookJson = (sql: string) => sql.match(/\$book\$([\s\S]*?)\$book\$::jsonb/)![1];

  it('starts with the fixed header, with the counts and mode filled in', () => {
    const p = payload();
    expect(seedCounts(p)).toEqual({ stockItems: 6, recipes: 2, recipeLines: 7, addonRecipes: 1, addonLines: 1 });
    const sql = renderSeedSql(p, meta);
    expect(sql.split('\n').slice(0, 13).join('\n')).toBe(
      [
        '-- ===========================================================================',
        '-- GENERATED by `npm run inventory:build` from data/inventory/ — DO NOT EDIT.',
        '-- Contract, house defaults and deploy steps: docs/INVENTORY-RECIPE-BOOK.md.',
        '-- Mode: confirmed recipes only',
        '-- Stock items: 6 · Menu-item recipes: 2 (7 lines) · Add-on recipes: 1 (1 lines)',
        '-- Menu snapshot: 2026-09-30T14:40:34.856Z',
        '-- Needs supabase/2026-10-inventory.sql. One DO block: all or nothing. Safe to re-run:',
        '-- stock items are matched by name (unit never changed; a par/reorder of 0 in the',
        '-- book leaves the live value alone); each listed recipe is replaced whole;',
        '-- menu items and add-ons not listed here are left as they are.',
        '-- ===========================================================================',
        'do $seed$',
        'declare',
      ].join('\n'),
    );
  });

  it('says so in the header when drafts are included', () => {
    expect(renderSeedSql(payload(), { ...meta, includeDrafts: true })).toContain('-- Mode: confirmed + DRAFT recipes (preview/test databases only)\n');
  });

  it('carries the guards and the by-name upsert', () => {
    const sql = renderSeedSql(payload(), meta);
    expect(sql).toContain('on conflict ((lower(trim(name)))) do update');
    expect(sql).toContain('if not exists (select 1 from inventory_batches) then');
    expect(sql).toContain('update store_settings set stock_auto_hide = false where is_singleton and stock_auto_hide;');
    expect(sql).toContain("raise exception 'inventory seed: unit differs from the live stock item: %', v_bad;");
    expect(sql).toContain("raise exception 'inventory seed: menu items not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;");
    expect(sql).toContain("raise exception 'inventory seed: add-on options not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;");
    expect(sql).toContain('perform inventory_set_recipe(r.id, null, v_lines);');
    expect(sql).toContain('perform inventory_set_addon_recipe(r.id, null, v_lines);');
    expect(sql).toContain('-- >= 6\n');
    expect(sql.endsWith('-- ---------------------------------------------------------------------------\n')).toBe(true);
  });

  it('embeds the payload as JSON that parses back to the payload', () => {
    const p = payload();
    const sql = renderSeedSql(p, meta);
    expect(JSON.parse(bookJson(sql))).toEqual(p);
    // Quoting tags appear exactly once each way round.
    expect(sql.match(/\$book\$/g)).toHaveLength(2);
    expect(sql.match(/\$seed\$/g)).toHaveLength(2);
  });

  it('keeps the three lists present even when empty', () => {
    const sql = renderSeedSql({ stock_items: [], recipes: [], addon_recipes: [] }, meta);
    expect(JSON.parse(bookJson(sql))).toEqual({ stock_items: [], recipes: [], addon_recipes: [] });
    expect(sql).toContain('-- Stock items: 0 · Menu-item recipes: 0 (0 lines) · Add-on recipes: 0 (0 lines)');
  });

  it('ends with a notice normally, and with the DRY RUN exception when dryRun is set', () => {
    const normal = renderSeedSql(payload(), meta);
    expect(normal).toContain("raise notice 'inventory seed: % stock items, % menu-item recipes, % add-on recipes',");
    expect(normal).not.toContain('DRY RUN');

    const dry = renderSeedSql(payload(), { ...meta, dryRun: true });
    expect(dry).toContain('-- DRY RUN: ends by raising an exception so nothing is saved.\n');
    expect(dry).toContain(
      "  raise exception 'DRY RUN OK (nothing was saved): % stock items, % menu-item recipes, % add-on recipes',\n" +
        "    jsonb_array_length(v_book->'stock_items'), jsonb_array_length(v_book->'recipes'), jsonb_array_length(v_book->'addon_recipes');\nend\n$seed$;",
    );
    expect(dry).not.toContain('raise notice');
    // Everything else is the same as the real thing.
    expect(dry.replace('-- DRY RUN: ends by raising an exception so nothing is saved.\n', '').replace(/raise exception 'DRY RUN OK \(nothing was saved\)/, "raise notice 'inventory seed")).toBe(normal);
  });

  it('refuses a payload that contains the quoting tags', () => {
    const p = payload();
    p.stock_items[0].name = 'Bad $book$ name';
    expect(() => renderSeedSql(p, meta)).toThrow(/\$book\$/);
    const q = payload();
    q.recipes[0].name = 'Bad $seed$ name';
    expect(() => renderSeedSql(q, meta)).toThrow(/\$seed\$/);
  });

  it('keeps quotes, backslashes and non-ASCII in names intact', () => {
    const p = payload();
    p.stock_items[0].name = `Mom's "special" \\ Crème`;
    expect(JSON.parse(bookJson(renderSeedSql(p, meta))).stock_items[0].name).toBe(`Mom's "special" \\ Crème`);
  });

  it('keeps a stray newline in the snapshot time out of the header comment', () => {
    const sql = renderSeedSql(payload(), { ...meta, snapshotCapturedAt: '2026-09-30\nselect 1;' });
    expect(sql).toContain('-- Menu snapshot: 2026-09-30 select 1;\n');
  });
});
