import { describe, expect, it } from 'vitest';
import {
  bookCounts,
  compileRecipeBook,
  formatIssue,
  fromBookDocument,
  parseBookDocument,
  renderSaveOnlySql,
  renderSeedSql,
  seedCounts,
  toBookDocument,
  validateRecipeBook,
  type AddonScopeEntry,
  type BookDocument,
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
    expect(errorsAfter((b) => put(oat(b), 'status', 'skip'))).toContainEqual(issue(where, /status is skip, so lines and scopes must be empty/));
  });

  it('rejects a draft or confirmed add-on with no lines', () => {
    expect(errorsAfter((b) => (oat(b).lines = []))).toContainEqual(issue(where, /no lines \(status is draft\)/));
    expect(errorsAfter((b) => Object.assign(oat(b), { status: 'confirmed', lines: [] }))).toContainEqual(issue(where, /no lines \(status is confirmed\)/));
  });

  it('warns when group or option differ from the snapshot', () => {
    const warnings = warningsAfter((b) => Object.assign(oat(b), { group: 'Milk', option: 'Oat milk' }));
    expect(warnings).toContainEqual(issue(where, /group "Milk" differs from the live group "ADD ON Milk"/));
    expect(warnings).toContainEqual(issue(where, /option "Oat milk" differs from the live name "Oat"/));
  });
});

describe('validateRecipeBook — add-on scopes', () => {
  const oat = (b: RecipeBook) => b.addonRecipes.options[0];
  const where = `${ADDON_FILE} › ADD ON Milk › Oat`;
  const scopeWhere = (item: string, size: string) => `${where} › scope ${item} › ${size}`;
  const scope = (size: string, lines: { ingredient: string; qty: number }[] = [{ ingredient: 'Oat milk', qty: 200 }], id = LATTE, name = 'Latte'): AddonScopeEntry => ({
    menu_item_id: id,
    menu_item: name,
    size_label: size,
    lines,
  });
  const withScopes = (...scopes: AddonScopeEntry[]) => (b: RecipeBook) => {
    oat(b).scopes = scopes;
  };

  it('accepts a size scope, an item-wide scope, and both on the same item, with no warnings', () => {
    const book = makeBook();
    withScopes(scope('Large'), scope('Extra Large', [{ ingredient: 'Oat milk', qty: 300 }]), scope(''))(book);
    const { errors, warnings } = validateRecipeBook(book);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([issue('Cold Brews › Signature Iced Brew', /no recipe entry/)]);
  });

  it('accepts the same size label on different items, and the same item with different sizes', () => {
    const book = makeBook();
    book.snapshot.items[2].addon_groups = ['ADD ON Milk']; // the Brew has Large and Extra Large too
    withScopes(scope('Large'), scope('Extra Large'), scope('Large', undefined, BREW, 'Signature Iced Brew'))(book);
    expect(validateRecipeBook(book).errors).toEqual([]);
  });

  it('accepts an option that has scopes and no general lines', () => {
    const book = makeBook();
    oat(book).lines = [];
    withScopes(scope('Large'))(book);
    expect(validateRecipeBook(book).errors).toEqual([]);
    Object.assign(oat(book), { status: 'confirmed' });
    expect(validateRecipeBook(book).errors).toEqual([]);
  });

  it('treats `scopes` absent, [] or on a skip option as fine', () => {
    expect(errorsAfter(withScopes())).toEqual([]);
    const skip = errorsAfter((b) => b.addonRecipes.options[1].scopes = []);
    expect(skip).toEqual([]);
  });

  it('rejects a menu_item_id that is not in the snapshot, or is missing', () => {
    expect(errorsAfter(withScopes(scope('', undefined, 'item-gone', 'Ghost')))).toContainEqual(
      issue(scopeWhere('Ghost', 'all sizes'), /menu_item_id "item-gone" is not in the menu snapshot/),
    );
    const missing = errorsAfter((b) => {
      const s = scope('Large');
      put(s, 'menu_item_id', undefined);
      withScopes(s)(b);
    });
    expect(missing).toContainEqual(issue(scopeWhere('Latte', 'Large'), /menu_item_id is missing/));
  });

  it("rejects a size_label that is not '' and not exactly a size of that item", () => {
    expect(errorsAfter(withScopes(scope('Regular')))).toContainEqual(
      issue(scopeWhere('Latte', 'Regular'), /size_label "Regular" is not a size of Latte \(sizes: Large, Extra Large\) — use "" for all sizes/),
    );
    expect(errorsAfter(withScopes(scope('large')))).toContainEqual(issue(scopeWhere('Latte', 'large'), /is not a size of Latte/));
    expect(errorsAfter(withScopes(scope('Large ')))).toContainEqual(issue(scopeWhere('Latte', 'Large '), /is not a size of Latte/));
  });

  it('rejects a size_label that is not a string', () => {
    const errors = errorsAfter((b) => {
      const s = scope('Large');
      put(s, 'size_label', undefined);
      withScopes(s)(b);
    });
    expect(errors).toContainEqual(issue(scopeWhere('Latte', 'all sizes'), /size_label must be one of the item's size labels, or "" for all its sizes/));
  });

  it('rejects the same (menu_item_id, size_label) twice in one option', () => {
    const sized = errorsAfter(withScopes(scope('Large'), scope('Large', [{ ingredient: 'Oat milk', qty: 5 }])));
    expect(sized).toContainEqual(issue(scopeWhere('Latte', 'Large'), /scope is listed twice for this item and size — first at .* › scope Latte › Large/));
    const wide = errorsAfter(withScopes(scope(''), scope('')));
    expect(wide).toContainEqual(issue(scopeWhere('Latte', 'all sizes'), /listed twice/));
    // The same pair in two different options is fine.
    const book = makeBook();
    withScopes(scope('Large'))(book);
    book.addonRecipes.options[1] = { ...structuredClone(oat(book)), addon_option_id: NO_ICE, group: 'Ice', option: 'No Ice' };
    expect(validateRecipeBook(book).errors).toEqual([]);
  });

  it('holds scope lines to the usual line rules: known ingredient, qty, no duplicates', () => {
    const w = scopeWhere('Latte', 'Large');
    expect(errorsAfter(withScopes(scope('Large', [{ ingredient: 'Almond milk', qty: 1 }])))).toContainEqual(issue(w, /ingredient "Almond milk" is not a stock item/));
    for (const [qty, message] of [
      ['200', /qty of "Oat milk" must be a number/],
      [0, /must be more than 0/],
      [-1, /must be more than 0/],
      [MAX_QTY + 1, /is above 999999/],
      [0.0005, /more than 3 decimals/],
    ] as const) {
      const line = { ingredient: 'Oat milk', qty: 1 };
      put(line, 'qty', qty);
      expect(errorsAfter(withScopes(scope('Large', [line])))).toContainEqual(issue(w, message));
    }
    expect(errorsAfter(withScopes(scope('Large', [{ ingredient: 'Oat milk', qty: 1 }, { ingredient: ' OAT milk', qty: 2 }])))).toContainEqual(
      issue(w, /ingredient "OAT milk" appears twice/),
    );
    // The same ingredient in the general lines and in a scope is normal.
    expect(errorsAfter(withScopes(scope('Large')))).toEqual([]);
  });

  it('allows 60 lines in a scope and rejects 61', () => {
    const many = (n: number) => (b: RecipeBook) => {
      for (let i = 1; i <= n; i++) b.stockItems.items.push(stock(`Bulk ${i}`, 'g', 'Powders & Mixes'));
      withScopes(scope('Large', Array.from({ length: n }, (_, i) => ({ ingredient: `Bulk ${i + 1}`, qty: 1 }))))(b);
    };
    expect(errorsAfter(many(60))).toEqual([]);
    expect(errorsAfter(many(61))).toContainEqual(issue(scopeWhere('Latte', 'Large'), /61 lines — at most 60 per scope/));
  });

  it('rejects a scope with an empty (or missing, or malformed) lines list', () => {
    expect(errorsAfter(withScopes(scope('Large', [])))).toContainEqual(issue(scopeWhere('Latte', 'Large'), /scope has no lines/));
    const noLines = errorsAfter((b) => {
      const s = scope('Large');
      put(s, 'lines', undefined);
      withScopes(s)(b);
    });
    expect(noLines).toContainEqual(issue(scopeWhere('Latte', 'Large'), /`lines` must be a list/));
    expect(noLines).not.toContainEqual(issue(scopeWhere('Latte', 'Large'), /scope has no lines/));
  });

  it('rejects `scopes` that is not a list, and a scope that is not an object', () => {
    expect(errorsAfter((b) => put(oat(b), 'scopes', 'all'))).toContainEqual(issue(where, /`scopes` must be a list/));
    expect(errorsAfter((b) => put(oat(b), 'scopes', null))).toContainEqual(issue(where, /`scopes` must be a list/));
    expect(errorsAfter((b) => put(oat(b), 'scopes', [null, 7]))).toEqual(
      expect.arrayContaining([issue(`${where} › scope #1`, /is not an object/), issue(`${where} › scope #2`, /is not an object/)]),
    );
  });

  it('rejects a skip option with lines or with any scope', () => {
    const skip = (change: (o: RecipeBook['addonRecipes']['options'][number]) => void) => (b: RecipeBook) => {
      Object.assign(oat(b), { status: 'skip', lines: [] });
      change(oat(b));
    };
    expect(errorsAfter(skip((o) => (o.lines = [{ ingredient: 'Oat milk', qty: 1 }])))).toContainEqual(issue(where, /status is skip, so lines and scopes must be empty/));
    expect(errorsAfter(skip((o) => (o.scopes = [scope('Large')])))).toContainEqual(issue(where, /status is skip, so lines and scopes must be empty/));
    // Even a scope with no lines counts.
    expect(errorsAfter(skip((o) => (o.scopes = [scope('Large', [])])))).toContainEqual(issue(where, /status is skip, so lines and scopes must be empty/));
    expect(errorsAfter(skip(() => undefined))).toEqual([]);
  });

  it('rejects a draft or confirmed option with no line anywhere, general or scoped', () => {
    const none = (status: string, scopes: AddonScopeEntry[]) => (b: RecipeBook) => {
      Object.assign(oat(b), { status, lines: [], scopes });
    };
    expect(errorsAfter(none('draft', []))).toContainEqual(issue(where, /no lines \(status is draft\)/));
    expect(errorsAfter(none('confirmed', []))).toContainEqual(issue(where, /no lines \(status is confirmed\)/));
    // Only scopes, and every one is empty: still nothing to deploy.
    expect(errorsAfter(none('confirmed', [scope('Large', [])]))).toEqual(
      expect.arrayContaining([issue(where, /no lines \(status is confirmed\)/), issue(scopeWhere('Latte', 'Large'), /scope has no lines/)]),
    );
    // One scope with a line is enough.
    expect(errorsAfter(none('confirmed', [scope('Large', []), scope('Extra Large')])).map((e) => e.message).join('\n')).not.toMatch(/no lines \(status/);
  });

  it('warns, without an error, when a scope\'s menu_item differs from the snapshot name', () => {
    const book = makeBook();
    withScopes(scope('Large', undefined, LATTE, 'Caffe Latte'))(book);
    expect(validateRecipeBook(book).errors).toEqual([]);
    expect(validateRecipeBook(book).warnings).toContainEqual(issue(scopeWhere('Latte', 'Large'), /menu_item "Caffe Latte" differs from the live name "Latte"/));
  });

  it("warns when the scoped item's add-on groups do not include the option's group (it can't be ordered there)", () => {
    const book = makeBook();
    withScopes(scope('Regular', undefined, BROWNIE, 'Brownie'))(book);
    expect(validateRecipeBook(book).errors).toEqual([]);
    expect(validateRecipeBook(book).warnings).toContainEqual(
      issue(scopeWhere('Brownie', 'Regular'), /Brownie does not offer the add-on group "ADD ON Milk", so this option can't be ordered on it/),
    );
    // No warning on an item that does offer the group.
    const ok = makeBook();
    withScopes(scope('Large'))(ok);
    expect(validateRecipeBook(ok).warnings.filter((w) => /does not offer/.test(w.message))).toEqual([]);
  });

  it('counts scope lines as use of a stock item', () => {
    const book = makeBook();
    book.stockItems.items.push(stock('Oat cream', 'ml', 'Dairy & Alternatives'), stock('Almond cream', 'ml', 'Dairy & Alternatives'));
    withScopes(scope('Large', [{ ingredient: 'Oat cream', qty: 30 }]))(book);
    const warnings = validateRecipeBook(book).warnings;
    expect(warnings).not.toContainEqual(issue(`${STOCK_FILE} › Oat cream`, /./));
    expect(warnings).toContainEqual(issue(`${STOCK_FILE} › Almond cream`, /no recipe uses this stock item/));
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
    expect(payload.addon_recipes).toEqual([
      { id: OAT, name: 'ADD ON Milk › Oat', lines: [{ menu_item_id: null, size_label: '', ingredient: 'Oat milk', qty: 240 }] },
    ]);
    expect(payload.stock_items.map((s) => s.name)).toEqual(['Espresso beans', 'Full-cream milk', 'Oat milk', 'Hot cup 12 oz', 'Brownie', 'Floor cleaner']);
  });

  describe('add-on scopes', () => {
    const oat = (b: RecipeBook) => b.addonRecipes.options[0];
    const line = (ingredient: string, qty: number) => ({ ingredient, qty });
    /** Oat with general lines and scopes written in a deliberately jumbled order. */
    function scopedBook(): RecipeBook {
      const book = makeBook();
      book.snapshot.items[2].addon_groups = ['ADD ON Milk']; // Latte, Brownie, Brew: Latte and Brew take Oat
      oat(book).status = 'confirmed';
      oat(book).lines = [line('Oat milk', 240), line('Hot cup 12 oz', 1)];
      oat(book).scopes = [
        { menu_item_id: BREW, menu_item: 'Signature Iced Brew', size_label: 'Extra Large', lines: [line('Oat milk', 400)] },
        { menu_item_id: LATTE, menu_item: 'Latte', size_label: 'Extra Large', lines: [line('Oat milk', 330), line('Espresso beans', 1)] },
        { menu_item_id: LATTE, menu_item: 'Latte', size_label: '', lines: [line('Oat milk', 250)] },
        { menu_item_id: BREW, menu_item: 'Signature Iced Brew', size_label: '', lines: [line('Oat milk', 300)] },
        { menu_item_id: LATTE, menu_item: 'Latte', size_label: 'Large', lines: [line('Oat milk', 200)] },
      ];
      return book;
    }

    it('emits general lines first, then scopes by snapshot item order, an item-wide scope before its sizes, sizes in snapshot order', () => {
      const [addon] = compileRecipeBook(scopedBook(), { includeDrafts: false }).addon_recipes;
      expect(addon.lines).toEqual([
        { menu_item_id: null, size_label: '', ingredient: 'Oat milk', qty: 240 },
        { menu_item_id: null, size_label: '', ingredient: 'Hot cup 12 oz', qty: 1 },
        { menu_item_id: LATTE, size_label: '', ingredient: 'Oat milk', qty: 250 },
        { menu_item_id: LATTE, size_label: 'Large', ingredient: 'Oat milk', qty: 200 },
        { menu_item_id: LATTE, size_label: 'Extra Large', ingredient: 'Oat milk', qty: 330 },
        { menu_item_id: LATTE, size_label: 'Extra Large', ingredient: 'Espresso beans', qty: 1 },
        { menu_item_id: BREW, size_label: '', ingredient: 'Oat milk', qty: 300 },
        { menu_item_id: BREW, size_label: 'Extra Large', ingredient: 'Oat milk', qty: 400 },
      ]);
    });

    it('does not depend on the order the scopes were written in', () => {
      const a = scopedBook();
      const b = scopedBook();
      oat(b).scopes!.reverse();
      expect(JSON.stringify(compileRecipeBook(a, { includeDrafts: false }))).toBe(JSON.stringify(compileRecipeBook(b, { includeDrafts: false })));
    });

    it('emits an option with only scopes (no general lines), and one with no scopes as before', () => {
      const book = scopedBook();
      oat(book).lines = [];
      oat(book).scopes = [{ menu_item_id: LATTE, menu_item: 'Latte', size_label: 'Large', lines: [line('Oat milk', 200)] }];
      expect(compileRecipeBook(book, { includeDrafts: false }).addon_recipes[0].lines).toEqual([
        { menu_item_id: LATTE, size_label: 'Large', ingredient: 'Oat milk', qty: 200 },
      ]);
      delete oat(book).scopes;
      oat(book).lines = [line('Oat milk', 240)];
      expect(compileRecipeBook(book, { includeDrafts: false }).addon_recipes[0].lines).toEqual([{ menu_item_id: null, size_label: '', ingredient: 'Oat milk', qty: 240 }]);
    });

    it("writes scope ingredients in the stock item's own spelling", () => {
      const book = scopedBook();
      oat(book).scopes![2].lines = [line(' OAT milk ', 250)];
      const lines = compileRecipeBook(book, { includeDrafts: false }).addon_recipes[0].lines;
      expect(lines.find((l) => l.menu_item_id === LATTE && l.size_label === '')?.ingredient).toBe('Oat milk');
    });

    it('counts scope lines when it prunes stock items, and leaves out the scopes of a draft option', () => {
      const book = scopedBook();
      book.stockItems.items.push(stock('Oat cream', 'ml', 'Dairy & Alternatives'));
      oat(book).lines = [];
      oat(book).scopes = [{ menu_item_id: LATTE, menu_item: 'Latte', size_label: 'Large', lines: [line('Oat cream', 30)] }];
      // Confirmed: a stock item only a scope uses is loaded; Oat milk (now used by nothing confirmed) is pruned.
      expect(compileRecipeBook(book, { includeDrafts: false }).stock_items.map((s) => s.name)).toContain('Oat cream');
      expect(compileRecipeBook(book, { includeDrafts: false }).stock_items.map((s) => s.name)).not.toContain('Oat milk');
      // Draft: neither the option nor its scopes are deployed, so the stock item is pruned too.
      oat(book).status = 'draft';
      const plain = compileRecipeBook(book, { includeDrafts: false });
      expect(plain.addon_recipes).toEqual([]);
      expect(plain.stock_items.map((s) => s.name)).not.toContain('Oat cream');
      expect(compileRecipeBook(book, { includeDrafts: true }).stock_items.map((s) => s.name)).toContain('Oat cream');
    });

    it('counts scope lines in the add-on line count, and the scoped ones on their own', () => {
      expect(seedCounts(compileRecipeBook(scopedBook(), { includeDrafts: false }))).toMatchObject({ addonRecipes: 1, addonLines: 8, addonScopedLines: 6 });
    });
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

describe('toBookDocument / fromBookDocument', () => {
  it('holds every file of the book, version 1, without the snapshot', () => {
    const book = makeBook();
    const doc = toBookDocument(book);
    expect(Object.keys(doc)).toEqual(['version', 'stock_items', 'recipe_files', 'addon_recipes']);
    expect(doc.version).toBe(1);
    expect(doc.stock_items).toEqual(book.stockItems);
    expect(doc.recipe_files.map((f) => f.path)).toEqual([COFFEE_FILE, BAKES_FILE]);
    expect(doc.recipe_files[1].file).toEqual(book.recipeFiles[1].file);
    expect(doc.addon_recipes).toEqual(book.addonRecipes);
  });

  it('carries the Petpooja aliases and materials from the book or from `extras`, and only when there are some', () => {
    const book = makeBook();
    expect(toBookDocument(book)).not.toHaveProperty('petpooja');
    expect(toBookDocument({ ...book, petpooja: {} })).not.toHaveProperty('petpooja');
    expect(toBookDocument({ ...book, petpooja: { aliases: { items: { Latte: LATTE } } } }).petpooja).toEqual({ aliases: { items: { Latte: LATTE } } });
    const both = toBookDocument(book, { petpooja: { aliases: { items: {} }, materials: { Milk: { name: 'Full-cream milk' } } } });
    expect(both.petpooja).toEqual({ aliases: { items: {} }, materials: { Milk: { name: 'Full-cream milk' } } });
    // extras win over the book's own.
    expect(toBookDocument({ ...book, petpooja: { aliases: { a: 1 } } }, { petpooja: { materials: { b: 2 } } }).petpooja).toEqual({ materials: { b: 2 } });
  });

  it('round-trips through JSON (the database) back to the same files', () => {
    const book = { ...makeBook(), petpooja: { aliases: { items: { Latte: LATTE } }, materials: { Milk: { name: 'Full-cream milk', category: 'Dairy & Alternatives', tracks_expiry: true } } } };
    book.addonRecipes.options[0].scopes = [{ menu_item_id: LATTE, menu_item: 'Latte', size_label: 'Large', lines: [{ ingredient: 'Oat milk', qty: 200 }] }];
    const stored = JSON.parse(JSON.stringify(toBookDocument(book)));
    const back = fromBookDocument(stored);
    expect(back).toEqual({ stockItems: book.stockItems, recipeFiles: book.recipeFiles, addonRecipes: book.addonRecipes, petpooja: book.petpooja });
    expect(toBookDocument({ snapshot: book.snapshot, ...back })).toEqual(stored);
    // Without the Petpooja files there is no `petpooja` key at all.
    expect(fromBookDocument(JSON.parse(JSON.stringify(toBookDocument(makeBook()))))).not.toHaveProperty('petpooja');
  });

  it('keeps a book with validation errors: the document only has to be the right shape', () => {
    const book = makeBook();
    latte(book).sizes.Large[0].ingredient = 'Nothing';
    expect(validateRecipeBook(book).errors).not.toEqual([]);
    expect(fromBookDocument(toBookDocument(book)).recipeFiles).toEqual(book.recipeFiles);
  });

  it('counts what the document holds', () => {
    expect(bookCounts(toBookDocument(makeBook()))).toEqual({ stockItems: 6, recipeFiles: 2, recipeEntries: 2, addonOptions: 2, petpooja: false });
    expect(bookCounts(toBookDocument(makeBook(), { petpooja: { aliases: {} } })).petpooja).toBe(true);
  });

  describe('rejects a document that is not a book', () => {
    const good = () => JSON.parse(JSON.stringify(toBookDocument(makeBook()))) as Record<string, unknown>;
    const bad = (change: (doc: Record<string, unknown>) => void) => {
      const doc = good();
      change(doc);
      return () => fromBookDocument(doc);
    };

    it('accepts the good one', () => {
      expect(() => fromBookDocument(good())).not.toThrow();
      expect(parseBookDocument(good()).version).toBe(1);
    });

    it.each([null, 'book', 7, [], undefined])('when it is %j', (value) => {
      expect(() => fromBookDocument(value)).toThrow(/the saved book is not an object/);
    });

    it('when the version is not 1', () => {
      expect(bad((d) => (d.version = 2))).toThrow(/is version 2, but this tool reads version 1/);
      expect(bad((d) => delete d.version)).toThrow(/is version undefined/);
      expect(bad((d) => (d.version = '1'))).toThrow(/is version "1"/);
    });

    it('when a part has the wrong shape', () => {
      expect(bad((d) => (d.stock_items = []))).toThrow(/`stock_items` must be an object with an `items` list/);
      expect(bad((d) => (d.stock_items = { items: 'x' }))).toThrow(/`stock_items`/);
      expect(bad((d) => (d.recipe_files = {}))).toThrow(/`recipe_files` must be a list/);
      expect(bad((d) => (d.recipe_files = [{ path: 'recipes/a.json' }]))).toThrow(/recipe file #1 must be \{ path, file \}/);
      expect(bad((d) => (d.recipe_files = [{ path: 3, file: {} }]))).toThrow(/recipe file #1/);
      expect(bad((d) => (d.addon_recipes = { options: {} }))).toThrow(/`addon_recipes` must be an object with an `options` list/);
      expect(bad((d) => (d.petpooja = []))).toThrow(/`petpooja` must be an object/);
    });

    it('when a recipe file path could write outside recipes/, or is listed twice', () => {
      for (const path of ['../x.json', 'recipes/../x.json', '/etc/x.json', 'recipes/sub/x.json', 'recipes\\x.json', 'stock-items.json', 'recipes/x.txt', 'recipes/.json/', '', 'recipes/']) {
        expect(bad((d) => (d.recipe_files = [{ path, file: { categories: [], items: [] } }])), path).toThrow(/must look like "recipes\/<name>\.json"/);
      }
      expect(bad((d) => (d.recipe_files = [{ path: 'recipes/a.json', file: {} }, { path: 'recipes/a.json', file: {} }]))).toThrow(/lists recipes\/a\.json twice/);
      // Ordinary names are fine, spaces included.
      expect(() => fromBookDocument({ ...good(), recipe_files: [{ path: 'recipes/bakery eatery.json', file: {} }] })).not.toThrow();
    });
  });
});

describe('renderSeedSql', () => {
  const payload = (): SeedPayload => compileRecipeBook(makeBook(), { includeDrafts: true });
  const bookDocument = (): BookDocument => toBookDocument(makeBook());
  const meta = () => ({ includeDrafts: false, snapshotCapturedAt: '2026-09-30T14:40:34.856Z', bookDocument: bookDocument() });
  const bookJson = (sql: string) => sql.match(/\$book\$([\s\S]*?)\$book\$::jsonb/)![1];
  const docJson = (sql: string) => sql.match(/\$doc\$([\s\S]*?)\$doc\$::jsonb/)![1];

  it('starts with the fixed header, with the counts and mode filled in', () => {
    const p = payload();
    expect(seedCounts(p)).toEqual({ stockItems: 6, recipes: 2, recipeLines: 7, addonRecipes: 1, addonLines: 1, addonScopedLines: 0 });
    const sql = renderSeedSql(p, meta());
    expect(sql.split('\n').slice(0, 16).join('\n')).toBe(
      [
        '-- ===========================================================================',
        '-- GENERATED by `npm run inventory:build` from the recipe book — DO NOT EDIT.',
        '-- Contract, house defaults and deploy steps: docs/INVENTORY-RECIPE-BOOK.md.',
        '-- Mode: confirmed recipes only',
        '-- Stock items: 6 · Menu-item recipes: 2 (7 lines) · Add-on recipes: 1 (1 lines, 0 scoped)',
        '-- Saved book: 6 stock items · 2 recipe files (2 items) · 2 add-on options — drafts and notes included',
        '-- Menu snapshot: 2026-09-30T14:40:34.856Z',
        '-- Needs supabase/2026-10-inventory.sql and supabase/2026-10-inventory-addon-scopes.sql.',
        '-- One DO block: all or nothing. Safe to re-run: the book is saved whole; stock items',
        '-- are matched by name (unit never changed; a par/reorder of 0 in the book leaves',
        '-- the live value alone); each listed recipe is replaced whole; menu items and',
        '-- add-ons not listed here are left as they are.',
        '-- ===========================================================================',
        'do $seed$',
        'declare',
        '  v_doc   jsonb := $doc$' + JSON.stringify(bookDocument()) + '$doc$::jsonb;',
      ].join('\n'),
    );
  });

  it('says so in the header when drafts are included', () => {
    expect(renderSeedSql(payload(), { ...meta(), includeDrafts: true })).toContain('-- Mode: confirmed + DRAFT recipes (preview/test databases only)\n');
  });

  it('carries the guards and the by-name upsert', () => {
    const sql = renderSeedSql(payload(), meta());
    expect(sql).toContain('on conflict ((lower(trim(name)))) do update');
    expect(sql).toContain('if not exists (select 1 from inventory_batches) then');
    expect(sql).toContain('update store_settings set stock_auto_hide = false where is_singleton and stock_auto_hide;');
    expect(sql).toContain("raise exception 'inventory seed: unit differs from the live stock item: %', v_bad;");
    expect(sql).toContain("raise exception 'inventory seed: menu items not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;");
    expect(sql).toContain("raise exception 'inventory seed: add-on options not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;");
    expect(sql).toContain('perform inventory_set_recipe(r.id, null, v_lines);');
    expect(sql).toContain('-- >= 6\n');
    expect(sql.endsWith('-- ---------------------------------------------------------------------------\n')).toBe(true);
  });

  it('numbers its steps 0 to 5 in the contract order', () => {
    const sql = renderSeedSql(payload(), meta());
    const at = ['-- 0. The book', '-- 1. Before any stock', '-- 2. Units lock', '-- 3. Stock items:', '-- 4. Every menu item', '-- 5. Recipes,'].map((step) => sql.indexOf(step));
    expect(at.every((n) => n > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("saves the whole book first (step 0), before the auto-hide guard and any change", () => {
    const sql = renderSeedSql(payload(), meta());
    const insert = sql.indexOf('insert into inventory_recipe_book (id, book, saved_at) values (true, v_doc, now())');
    expect(insert).toBeGreaterThan(0);
    expect(sql).toContain('  on conflict (id) do update set book = excluded.book, saved_at = excluded.saved_at;');
    expect(insert).toBeLessThan(sql.indexOf('if not exists (select 1 from inventory_batches)'));
    expect(insert).toBeLessThan(sql.indexOf('insert into inventory_items'));
    expect(insert).toBeLessThan(sql.indexOf('perform inventory_set_recipe'));
  });

  it('loads add-on recipes through the scopes function, with the item and size on every line', () => {
    const sql = renderSeedSql(payload(), meta());
    expect(sql).toContain('perform inventory_set_addon_recipe_scopes(r.id, null, v_lines);');
    expect(sql).not.toContain('perform inventory_set_addon_recipe(');
    expect(sql).toContain(
      [
        "  for r in select * from jsonb_to_recordset(v_book->'addon_recipes') x(id uuid, name text, lines jsonb) loop",
        '    select count(*), count(i.id),',
        "           coalesce(jsonb_agg(jsonb_build_object('menu_item_id', l.menu_item_id, 'size_label', l.size_label, 'item_id', i.id, 'qty', l.qty))",
        "                      filter (where i.id is not null), '[]'::jsonb)",
        '      into v_total, v_found, v_lines',
        '      from jsonb_to_recordset(r.lines) l(menu_item_id uuid, size_label text, ingredient text, qty numeric)',
        '      left join inventory_items i on lower(trim(i.name)) = lower(trim(l.ingredient));',
        '    if v_found <> v_total then',
        `      raise exception 'inventory seed: a line of "%" names a stock item that does not exist', r.name;`,
        '    end if;',
        '    perform inventory_set_addon_recipe_scopes(r.id, null, v_lines);',
        '  end loop;',
      ].join('\n'),
    );
  });

  it('refuses to run when a scoped menu item is not live, before any recipe is written', () => {
    const sql = renderSeedSql(payload(), meta());
    const guard = [
      "  select string_agg(distinct format('%s (%s)', x.name, l.menu_item_id), '; ') into v_bad",
      "    from jsonb_to_recordset(v_book->'addon_recipes') x(name text, lines jsonb),",
      '         jsonb_to_recordset(x.lines) l(menu_item_id uuid)',
      '   where l.menu_item_id is not null',
      '     and not exists (select 1 from menu_items m where m.id = l.menu_item_id);',
      '  if v_bad is not null then',
      "    raise exception 'inventory seed: add-on scopes name menu items not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;",
      '  end if;',
    ].join('\n');
    expect(sql).toContain(guard);
    expect(sql.indexOf(guard)).toBeLessThan(sql.indexOf('perform inventory_set_recipe'));
    expect(sql.indexOf(guard)).toBeGreaterThan(sql.indexOf("add-on options not found live"));
  });

  it('embeds scoped add-on lines in the payload with their menu_item_id, ready for the SQL', () => {
    const book = makeBook();
    book.addonRecipes.options[0].scopes = [{ menu_item_id: LATTE, menu_item: 'Latte', size_label: 'Large', lines: [{ ingredient: 'Oat milk', qty: 200 }] }];
    const p = compileRecipeBook(book, { includeDrafts: true });
    const sql = renderSeedSql(p, { ...meta(), includeDrafts: true, bookDocument: toBookDocument(book) });
    expect(JSON.parse(bookJson(sql)).addon_recipes[0].lines).toEqual([
      { menu_item_id: null, size_label: '', ingredient: 'Oat milk', qty: 240 },
      { menu_item_id: LATTE, size_label: 'Large', ingredient: 'Oat milk', qty: 200 },
    ]);
    expect(sql).toContain('-- Stock items: 6 · Menu-item recipes: 2 (7 lines) · Add-on recipes: 1 (2 lines, 1 scoped)');
  });

  it('embeds the payload as JSON that parses back to the payload', () => {
    const p = payload();
    const sql = renderSeedSql(p, meta());
    expect(JSON.parse(bookJson(sql))).toEqual(p);
    // Quoting tags appear exactly once each way round.
    expect(sql.match(/\$book\$/g)).toHaveLength(2);
    expect(sql.match(/\$doc\$/g)).toHaveLength(2);
    expect(sql.match(/\$seed\$/g)).toHaveLength(2);
  });

  it('embeds the whole book as a second JSON literal that parses back to the document', () => {
    const book = { ...makeBook(), petpooja: { aliases: { items: { Latte: LATTE } } } };
    latte(book).notes = 'a note only the book keeps';
    brownie(book).status = 'draft'; // drafts are in the document although not in the payload
    const doc = toBookDocument(book);
    const sql = renderSeedSql(compileRecipeBook(book, { includeDrafts: false }), { ...meta(), bookDocument: doc });
    const saved = JSON.parse(docJson(sql));
    expect(saved).toEqual(JSON.parse(JSON.stringify(doc)));
    expect(saved.recipe_files[0].file.items[0].notes).toBe('a note only the book keeps');
    expect(saved.recipe_files[1].file.items[0].status).toBe('draft');
    expect(saved.petpooja).toEqual({ aliases: { items: { Latte: LATTE } } });
    expect(saved.version).toBe(1);
    // ... and the doc round-trips into the same book files.
    expect(fromBookDocument(saved).recipeFiles).toEqual(book.recipeFiles);
  });

  it('keeps the three lists present even when empty', () => {
    const empty = toBookDocument({ ...makeBook(), stockItems: { items: [] }, recipeFiles: [], addonRecipes: { options: [] } });
    const sql = renderSeedSql({ stock_items: [], recipes: [], addon_recipes: [] }, { ...meta(), bookDocument: empty });
    expect(JSON.parse(bookJson(sql))).toEqual({ stock_items: [], recipes: [], addon_recipes: [] });
    expect(sql).toContain('-- Stock items: 0 · Menu-item recipes: 0 (0 lines) · Add-on recipes: 0 (0 lines, 0 scoped)');
    expect(sql).toContain('-- Saved book: 0 stock items · 0 recipe files (0 items) · 0 add-on options');
  });

  it('ends with a notice normally, and with the DRY RUN exception when dryRun is set', () => {
    const normal = renderSeedSql(payload(), meta());
    expect(normal).toContain("raise notice 'inventory seed: % stock items, % menu-item recipes, % add-on recipes',");
    expect(normal).not.toContain('DRY RUN');

    const dry = renderSeedSql(payload(), { ...meta(), dryRun: true });
    expect(dry).toContain('-- DRY RUN: ends by raising an exception so nothing is saved.\n');
    expect(dry).toContain(
      "  raise exception 'DRY RUN OK (nothing was saved): % stock items, % menu-item recipes, % add-on recipes',\n" +
        "    jsonb_array_length(v_book->'stock_items'), jsonb_array_length(v_book->'recipes'), jsonb_array_length(v_book->'addon_recipes');\nend\n$seed$;",
    );
    expect(dry).not.toContain('raise notice');
    // Everything else is the same as the real thing (step 0 is inside the block that rolls back).
    expect(dry.replace('-- DRY RUN: ends by raising an exception so nothing is saved.\n', '').replace(/raise exception 'DRY RUN OK \(nothing was saved\)/, "raise notice 'inventory seed")).toBe(normal);
  });

  it('refuses a payload or a document that contains a quoting tag', () => {
    for (const tag of ['$book$', '$seed$', '$doc$']) {
      const p = payload();
      p.stock_items[0].name = `Bad ${tag} name`;
      expect(() => renderSeedSql(p, meta()), tag).toThrow(/which the seed SQL uses as quoting/);

      // In the document only: a note, which the payload does not carry.
      const book = makeBook();
      latte(book).notes = `note with ${tag}`;
      expect(() => renderSeedSql(compileRecipeBook(book, { includeDrafts: false }), { ...meta(), bookDocument: toBookDocument(book) }), tag).toThrow(/which the seed SQL uses as quoting/);
      expect(() => renderSaveOnlySql(toBookDocument(book), { snapshotCapturedAt: 'x' }), tag).toThrow(/which the seed SQL uses as quoting/);
    }
    const q = payload();
    q.recipes[0].name = 'Bad $seed$ name';
    expect(() => renderSeedSql(q, meta())).toThrow(/\$seed\$/);
  });

  it('refuses a document that is not a book document', () => {
    expect(() => renderSeedSql(payload(), { ...meta(), bookDocument: { version: 2 } as never })).toThrow(/version 1/);
    expect(() => renderSaveOnlySql({ version: 1 } as never, { snapshotCapturedAt: 'x' })).toThrow(/stock_items/);
  });

  it('keeps quotes, backslashes and non-ASCII in names intact', () => {
    const p = payload();
    p.stock_items[0].name = `Mom's "special" \\ Crème`;
    expect(JSON.parse(bookJson(renderSeedSql(p, meta()))).stock_items[0].name).toBe(`Mom's "special" \\ Crème`);
    const book = makeBook();
    book.stockItems.items[0].name = `Mom's "special" \\ Crème`;
    latte(book).sizes.Large[0].ingredient = `Mom's "special" \\ Crème`;
    latte(book).sizes['Extra Large'][0].ingredient = `Mom's "special" \\ Crème`;
    const sql = renderSeedSql(compileRecipeBook(book, { includeDrafts: false }), { ...meta(), bookDocument: toBookDocument(book) });
    expect(JSON.parse(docJson(sql)).stock_items.items[0].name).toBe(`Mom's "special" \\ Crème`);
  });

  it('keeps a stray newline in the snapshot time out of the header comment', () => {
    const sql = renderSeedSql(payload(), { ...meta(), snapshotCapturedAt: '2026-09-30\nselect 1;' });
    expect(sql).toContain('-- Menu snapshot: 2026-09-30 select 1;\n');
  });
});

describe('renderSaveOnlySql', () => {
  const doc = (): BookDocument => toBookDocument({ ...makeBook(), petpooja: { materials: { Milk: { name: 'Full-cream milk' } } } });
  const meta = { snapshotCapturedAt: '2026-09-30T14:40:34.856Z' };
  const docJson = (sql: string) => sql.match(/\$doc\$([\s\S]*?)\$doc\$::jsonb/)![1];

  it('is a DO block with only the save step: no stock item, recipe or setting is touched', () => {
    const sql = renderSaveOnlySql(doc(), meta);
    expect(sql).toContain('-- SAVE ONLY: stores the book; changes no stock items or recipes.');
    expect(sql).toContain('insert into inventory_recipe_book (id, book, saved_at) values (true, v_doc, now())');
    expect(sql).toContain('on conflict (id) do update set book = excluded.book, saved_at = excluded.saved_at;');
    expect(sql).toContain('-- Needs supabase/2026-10-inventory.sql and supabase/2026-10-inventory-addon-scopes.sql.');
    expect(sql).toContain('-- Saved book: 6 stock items · 2 recipe files (2 items) · 2 add-on options');
    expect(sql).toContain("raise notice 'inventory seed: book saved (% stock items, % recipe files, % add-on options)',");
    expect(sql).toContain("jsonb_array_length(v_doc->'stock_items'->'items'), jsonb_array_length(v_doc->'recipe_files'), jsonb_array_length(v_doc->'addon_recipes'->'options');");
    // Nothing of the seed's other steps.
    for (const not of ['v_book', 'inventory_items', 'inventory_set_recipe', 'inventory_set_addon_recipe', 'store_settings', 'inventory_batches', '$book$', 'menu_items']) {
      expect(sql, not).not.toContain(not);
    }
    expect(sql.match(/\$seed\$/g)).toHaveLength(2);
    expect(sql.match(/\$doc\$/g)).toHaveLength(2);
    // The only statements are the declaration, the insert and the notice.
    expect(sql.match(/^ {2}(insert|update|delete|perform|select|raise)\b/gm)).toEqual(['  insert', '  raise']);
  });

  it('embeds the whole document, drafts, notes and Petpooja files included', () => {
    const d = doc();
    expect(JSON.parse(docJson(renderSaveOnlySql(d, meta)))).toEqual(JSON.parse(JSON.stringify(d)));
    expect(JSON.parse(docJson(renderSaveOnlySql(d, meta))).petpooja).toEqual({ materials: { Milk: { name: 'Full-cream milk' } } });
  });

  it('is saved even when the book has validation errors (only its shape is checked)', () => {
    const book = makeBook();
    latte(book).sizes.Large[0].ingredient = 'Nothing';
    expect(validateRecipeBook(book).errors).not.toEqual([]);
    expect(() => renderSaveOnlySql(toBookDocument(book), meta)).not.toThrow();
    expect(() => renderSaveOnlySql({ version: 1, stock_items: {}, recipe_files: [], addon_recipes: { options: [] } } as never, meta)).toThrow(/stock_items/);
  });

  it('ends with the DRY RUN exception when dryRun is set, and is otherwise identical', () => {
    const normal = renderSaveOnlySql(doc(), meta);
    const dry = renderSaveOnlySql(doc(), { ...meta, dryRun: true });
    expect(dry).toContain('-- DRY RUN: ends by raising an exception so nothing is saved.\n');
    expect(dry).toContain("raise exception 'DRY RUN OK (nothing was saved): % stock items, % recipe files, % add-on options',");
    expect(dry).not.toContain('raise notice');
    expect(dry.replace('-- DRY RUN: ends by raising an exception so nothing is saved.\n', '').replace(/raise exception 'DRY RUN OK \(nothing was saved\): /, "raise notice 'inventory seed: book saved (").replace('add-on options\',', 'add-on options)\',')).toBe(normal);
  });
});
