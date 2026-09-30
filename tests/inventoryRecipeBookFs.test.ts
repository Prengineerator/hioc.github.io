import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkSeedOutPath,
  defaultSeedName,
  loadRecipeBook,
  resolveBookDir,
  writeBookDocument,
  writeJsonFile,
} from '@/lib/inventory/recipeBookFs';
import { fromBookDocument, toBookDocument, type BookDocument } from '@/lib/inventory/recipeBook';

// loadRecipeBook, writeBookDocument and the --out check (lib/inventory/recipeBookFs.ts)
// on a throw-away folder: what is optional, the order files are read in, where
// the book lives, that a bad file is named in the error, and that a saved book
// comes back as the same files.

const SNAPSHOT = { _comment: 'test', captured_at: '2026-09-30T00:00:00.000Z', items: [], addon_options: [] };

let root: string;
let savedEnv: string | undefined;

function write(rel: string, content: unknown): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-book-'));
  savedEnv = process.env.INVENTORY_BOOK_DIR;
  delete process.env.INVENTORY_BOOK_DIR;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.INVENTORY_BOOK_DIR;
  else process.env.INVENTORY_BOOK_DIR = savedEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadRecipeBook', () => {
  it('needs only the snapshot; everything else reads as empty', () => {
    write('data/inventory/menu-snapshot.json', SNAPSHOT);
    expect(loadRecipeBook(root)).toEqual({
      snapshot: SNAPSHOT,
      stockItems: { items: [] },
      recipeFiles: [],
      addonRecipes: { options: [] },
    });
  });

  it('says how to get the snapshot when it is missing', () => {
    expect(() => loadRecipeBook(root)).toThrow(/menu-snapshot\.json is missing — run `npm run inventory:snapshot`/);
  });

  it('reads recipes/*.json in file-name order and ignores other files', () => {
    write('data/inventory/menu-snapshot.json', SNAPSHOT);
    write('data/inventory/book/stock-items.json', { items: [{ name: 'Milk' }] });
    write('data/inventory/book/addon-recipes.json', { options: [{ addon_option_id: 'x' }] });
    write('data/inventory/book/recipes/waffles.json', { categories: ['Stick Waffles'], items: [] });
    write('data/inventory/book/recipes/hot.json', { categories: ['Coffee'], items: [] });
    write('data/inventory/book/recipes/README.md', '# not a recipe file');
    const book = loadRecipeBook(root);
    expect(book.recipeFiles.map((f) => f.path)).toEqual(['recipes/hot.json', 'recipes/waffles.json']);
    expect(book.recipeFiles[0].file.categories).toEqual(['Coffee']);
    expect(book.stockItems.items).toHaveLength(1);
    expect(book.addonRecipes.options).toHaveLength(1);
  });

  it('names the file when its JSON does not parse', () => {
    write('data/inventory/menu-snapshot.json', SNAPSHOT);
    write('data/inventory/book/recipes/hot.json', '{ "categories": ["Coffee"], ');
    expect(() => loadRecipeBook(root)).toThrow(/inventory: .*recipes[\\/]hot\.json is not valid JSON/);
    write('data/inventory/book/recipes/hot.json', '{}');
    write('data/inventory/book/stock-items.json', 'nope');
    expect(() => loadRecipeBook(root)).toThrow(/stock-items\.json is not valid JSON/);
  });

  it('names the snapshot when it does not parse', () => {
    write('data/inventory/menu-snapshot.json', '[');
    expect(() => loadRecipeBook(root)).toThrow(/menu-snapshot\.json is not valid JSON/);
  });

  it('reads the book from bookDir (relative to root) while the snapshot stays in data/inventory', () => {
    write('data/inventory/menu-snapshot.json', SNAPSHOT);
    write('data/inventory/book/stock-items.json', { items: [{ name: 'Default folder' }] });
    write('private/book/stock-items.json', { items: [{ name: 'Private' }] });
    write('private/book/recipes/hot.json', { categories: [], items: [] });
    write('private/book/addon-recipes.json', { options: [] });
    const book = loadRecipeBook(root, { bookDir: 'private/book' });
    expect(book.snapshot).toEqual(SNAPSHOT);
    expect(book.stockItems.items[0]).toEqual({ name: 'Private' });
    expect(book.recipeFiles.map((f) => f.path)).toEqual(['recipes/hot.json']);
  });

  it('uses INVENTORY_BOOK_DIR when no bookDir is given, and an option beats the variable', () => {
    write('data/inventory/menu-snapshot.json', SNAPSHOT);
    write('from-env/stock-items.json', { items: [{ name: 'Env' }] });
    write('from-option/stock-items.json', { items: [{ name: 'Option' }] });
    process.env.INVENTORY_BOOK_DIR = path.join(root, 'from-env'); // absolute paths work too
    expect(loadRecipeBook(root).stockItems.items[0]).toEqual({ name: 'Env' });
    expect(loadRecipeBook(root, { bookDir: 'from-option' }).stockItems.items[0]).toEqual({ name: 'Option' });
  });

  it('defaults the book folder to the git-ignored data/inventory/book', () => {
    expect(resolveBookDir(root)).toBe(path.join(root, 'data', 'inventory', 'book'));
  });
});

describe('loadRecipeBook — the Petpooja files', () => {
  it('reads petpooja/aliases.json and materials.json when they are there, and not the CSV', () => {
    write('data/inventory/menu-snapshot.json', SNAPSHOT);
    write('data/inventory/book/petpooja/aliases.json', { items: { Latte: 'abc' }, addons: {} });
    write('data/inventory/book/petpooja/materials.json', { Milk: { name: 'Milk', category: 'Dairy & Alternatives', tracks_expiry: true } });
    write('data/inventory/book/petpooja/Item_Addon_Recipe.csv', 'not,json\n');
    const book = loadRecipeBook(root);
    expect(book.petpooja).toEqual({
      aliases: { items: { Latte: 'abc' }, addons: {} },
      materials: { Milk: { name: 'Milk', category: 'Dairy & Alternatives', tracks_expiry: true } },
    });
    expect(Object.keys(book).sort()).toEqual(['addonRecipes', 'petpooja', 'recipeFiles', 'snapshot', 'stockItems']);
  });

  it('has no `petpooja` key when neither file is there (the CSV alone does not count)', () => {
    write('data/inventory/menu-snapshot.json', SNAPSHOT);
    write('data/inventory/book/petpooja/Item_Addon_Recipe.csv', 'x');
    expect(loadRecipeBook(root)).not.toHaveProperty('petpooja');
  });

  it('reads one of the two on its own, leaving the other undefined', () => {
    write('data/inventory/menu-snapshot.json', SNAPSHOT);
    write('data/inventory/book/petpooja/materials.json', { Milk: {} });
    const petpooja = loadRecipeBook(root).petpooja!;
    expect(petpooja.materials).toEqual({ Milk: {} });
    expect(petpooja.aliases).toBeUndefined();
    expect('aliases' in petpooja).toBe(false);
  });

  it('names the file when it does not parse', () => {
    write('data/inventory/menu-snapshot.json', SNAPSHOT);
    write('data/inventory/book/petpooja/aliases.json', '{ nope');
    expect(() => loadRecipeBook(root)).toThrow(/petpooja[\\/]aliases\.json is not valid JSON/);
  });
});

describe('writeJsonFile', () => {
  it('writes 2-space JSON with a trailing newline, creating folders', () => {
    const file = path.join(root, 'a', 'b', 'x.json');
    writeJsonFile(file, { items: [{ name: 'Milk', qty: 1 }] });
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "items": [\n    {\n      "name": "Milk",\n      "qty": 1\n    }\n  ]\n}\n');
  });
});

describe('writeBookDocument', () => {
  const DOC: BookDocument = {
    version: 1,
    stock_items: { items: [{ name: 'Milk', unit: 'ml', category: 'Dairy & Alternatives', tracks_expiry: true, par_level: 0, reorder_qty: 0, standalone: false, notes: '' }] },
    recipe_files: [
      { path: 'recipes/hot.json', file: { categories: ['Coffee'], items: [] } },
      { path: 'recipes/bakery-eatery.json', file: { categories: ['Cup Cakes'], items: [] } },
    ],
    addon_recipes: {
      options: [
        {
          addon_option_id: 'a1', group: 'Sugar', option: 'Normal', status: 'confirmed', source: 'petpooja', notes: '',
          lines: [{ ingredient: 'Sugar', qty: 20 }],
          scopes: [{ menu_item_id: 'i1', menu_item: 'Latte', size_label: 'Extra Large', lines: [{ ingredient: 'Sugar', qty: 25 }] }],
        },
      ],
    },
    petpooja: { aliases: { items: { Latte: 'i1' } }, materials: { Milk: { name: 'Milk' } } },
  };
  const bookDir = () => path.join(root, 'data', 'inventory', 'book');

  it('writes every file of the book at its path, in a readable order', () => {
    const result = writeBookDocument(bookDir(), DOC);
    expect(result.written).toEqual([
      'stock-items.json',
      'recipes/hot.json',
      'recipes/bakery-eatery.json',
      'addon-recipes.json',
      'petpooja/aliases.json',
      'petpooja/materials.json',
    ]);
    expect(result.stale).toEqual([]);
    for (const rel of result.written) expect(fs.existsSync(path.join(bookDir(), rel)), rel).toBe(true);
  });

  it('writes the files as everything else in the book is written: 2-space JSON and a trailing newline', () => {
    writeBookDocument(bookDir(), DOC);
    const text = fs.readFileSync(path.join(bookDir(), 'stock-items.json'), 'utf8');
    expect(text).toBe(`${JSON.stringify(DOC.stock_items, null, 2)}\n`);
    expect(text.endsWith('}\n')).toBe(true);
    expect(fs.readFileSync(path.join(bookDir(), 'petpooja', 'aliases.json'), 'utf8')).toBe(`${JSON.stringify(DOC.petpooja!.aliases, null, 2)}\n`);
  });

  it('is read back by loadRecipeBook as the same book (the round trip through the database)', () => {
    write('data/inventory/menu-snapshot.json', SNAPSHOT);
    writeBookDocument(bookDir(), JSON.parse(JSON.stringify(DOC))); // as it comes back from PostgREST
    const loaded = loadRecipeBook(root);
    // recipeFiles come back in file-name order; toBookDocument keeps that order
    expect(loaded.recipeFiles.map((f) => f.path)).toEqual(['recipes/bakery-eatery.json', 'recipes/hot.json']);
    const again = toBookDocument(loaded);
    expect(again.stock_items).toEqual(DOC.stock_items);
    expect(again.addon_recipes).toEqual(DOC.addon_recipes);
    expect(again.petpooja).toEqual(DOC.petpooja);
    expect([...again.recipe_files].sort((a, b) => a.path.localeCompare(b.path))).toEqual([...DOC.recipe_files].sort((a, b) => a.path.localeCompare(b.path)));
    // and loading then saving then writing again gives the same files
    const second = path.join(root, 'second-book');
    writeBookDocument(second, again);
    for (const rel of ['stock-items.json', 'recipes/hot.json', 'addon-recipes.json', 'petpooja/aliases.json', 'petpooja/materials.json']) {
      expect(fs.readFileSync(path.join(second, rel), 'utf8'), rel).toBe(fs.readFileSync(path.join(bookDir(), rel), 'utf8'));
    }
    expect(fromBookDocument(again).stockItems).toEqual(DOC.stock_items);
  });

  it('omits the Petpooja files when the document has none, and writes only the one it has', () => {
    const { petpooja: _omit, ...withoutPetpooja } = DOC;
    void _omit;
    expect(writeBookDocument(bookDir(), withoutPetpooja).written).not.toContain('petpooja/aliases.json');
    expect(fs.existsSync(path.join(bookDir(), 'petpooja'))).toBe(false);
    const only = path.join(root, 'only-materials');
    expect(writeBookDocument(only, { ...DOC, petpooja: { materials: { Milk: {} } } }).written.slice(-1)).toEqual(['petpooja/materials.json']);
    expect(fs.existsSync(path.join(only, 'petpooja', 'aliases.json'))).toBe(false);
  });

  it('refuses a folder that already has a stock-items.json, unless forced, and then leaves it untouched', () => {
    write('data/inventory/book/stock-items.json', { items: [{ name: 'Mine' }] });
    expect(() => writeBookDocument(bookDir(), DOC)).toThrow(/stock-items\.json already exists — pulling would replace this book\. Pass --force/);
    expect(JSON.parse(fs.readFileSync(path.join(bookDir(), 'stock-items.json'), 'utf8'))).toEqual({ items: [{ name: 'Mine' }] });
    expect(fs.existsSync(path.join(bookDir(), 'addon-recipes.json'))).toBe(false);

    expect(writeBookDocument(bookDir(), DOC, { force: true }).written).toHaveLength(6);
    expect(JSON.parse(fs.readFileSync(path.join(bookDir(), 'stock-items.json'), 'utf8'))).toEqual(DOC.stock_items);
  });

  it('is fine with a folder that has other files but no stock-items.json (the Petpooja CSV, say)', () => {
    write('data/inventory/book/petpooja/Item_Addon_Recipe.csv', 'csv');
    write('data/inventory/book/seed.sql', '-- old');
    expect(() => writeBookDocument(bookDir(), DOC)).not.toThrow();
    expect(fs.readFileSync(path.join(bookDir(), 'petpooja', 'Item_Addon_Recipe.csv'), 'utf8')).toBe('csv');
  });

  it('writes nothing when the document is not a book document', () => {
    for (const bad of [null, { version: 2 }, { ...DOC, recipe_files: 'x' }, { ...DOC, stock_items: {} }]) {
      expect(() => writeBookDocument(bookDir(), bad)).toThrow(/inventory: the saved book/);
    }
    expect(fs.existsSync(bookDir())).toBe(false);
  });

  it('cannot be made to write outside recipes/ by a hostile path', () => {
    for (const bad of ['../evil.json', 'recipes/../../evil.json', '/tmp/evil.json', 'stock-items.json', 'recipes/a/b.json']) {
      expect(() => writeBookDocument(bookDir(), { ...DOC, recipe_files: [{ path: bad, file: {} }] }), bad).toThrow(/must look like "recipes\/<name>\.json"/);
    }
    expect(fs.existsSync(bookDir())).toBe(false);
    expect(fs.existsSync(path.join(root, 'data', 'evil.json'))).toBe(false);
  });

  it('with --force reports recipe files that are on disk but not in the document, and leaves them alone', () => {
    write('data/inventory/book/stock-items.json', { items: [] });
    write('data/inventory/book/recipes/old.json', { categories: [], items: [] });
    write('data/inventory/book/recipes/hot.json', { categories: ['Old'], items: [] });
    write('data/inventory/book/recipes/README.md', 'x');
    const result = writeBookDocument(bookDir(), DOC, { force: true });
    expect(result.stale).toEqual(['recipes/old.json']);
    expect(fs.existsSync(path.join(bookDir(), 'recipes', 'old.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(bookDir(), 'recipes', 'hot.json'), 'utf8')).categories).toEqual(['Coffee']);
  });
});

describe('the SQL file names and the --out check', () => {
  const book = () => path.join(root, 'data', 'inventory', 'book');
  const tmp = () => path.join(root, '..', 'some-os-tmp'); // stands in for os.tmpdir()
  const check = (out: string, extra: { forceOut?: boolean } = {}) => checkSeedOutPath(root, book(), out, { tmpDir: tmp(), ...extra });

  it('names the default file after the mode', () => {
    expect(defaultSeedName('seed')).toBe('seed.sql');
    expect(defaultSeedName('dry-run')).toBe('seed.dry-run.sql');
    expect(defaultSeedName('save-only')).toBe('save-only.sql');
    expect(defaultSeedName('save-only-dry-run')).toBe('save-only.dry-run.sql');
  });

  it('allows anything inside the book folder, however it is spelled', () => {
    expect(check(path.join(book(), 'seed.sql'))).toEqual({ ok: true });
    expect(check('data/inventory/book/seed.dry-run.sql')).toEqual({ ok: true });
    expect(check('data/inventory/book/sub/dir/x.sql')).toEqual({ ok: true });
    expect(check('./data/inventory/../inventory/book/x.sql')).toEqual({ ok: true });
  });

  it('refuses a path inside the repo but outside the book folder', () => {
    for (const out of ['seed.sql', 'supabase/2026-10-inventory-seed.sql', 'data/inventory/seed.sql', 'data/inventory/book-old/seed.sql', 'scripts/inventory/.dry-run.sql', 'data/inventory/book/../x.sql', path.join(root, 'docs', 'x.sql')]) {
      const result = check(out);
      expect(result.ok, out).toBe(false);
      expect((result as { reason: string }).reason).toMatch(/inside the repository but outside the recipe book folder .* --force-out/);
    }
  });

  it('allows a path outside the repo, and one under the OS temp folder', () => {
    expect(check(path.join(os.tmpdir(), 'seed.sql'))).toEqual({ ok: true });
    expect(check('../elsewhere/seed.sql')).toEqual({ ok: true });
    expect(check(path.join(path.dirname(root), 'other', 'seed.sql'))).toEqual({ ok: true });
    // The temp folder may itself be inside the repo (a custom TMPDIR): still allowed.
    fs.mkdirSync(path.join(root, 'tmp-inside'));
    expect(checkSeedOutPath(root, book(), 'tmp-inside/seed.sql', { tmpDir: path.join(root, 'tmp-inside') })).toEqual({ ok: true });
    expect(checkSeedOutPath(root, book(), 'tmp-insider/seed.sql', { tmpDir: path.join(root, 'tmp-inside') }).ok).toBe(false);
  });

  it('lets --force-out through', () => {
    expect(check('supabase/x.sql', { forceOut: true })).toEqual({ ok: true });
    expect(check('supabase/x.sql', { forceOut: false }).ok).toBe(false);
  });

  it('treats a book folder outside the repo as fine for its own default file, but not for the repo', () => {
    const outside = path.join(path.dirname(root), 'private-book');
    expect(checkSeedOutPath(root, outside, path.join(outside, 'seed.sql'))).toEqual({ ok: true });
    expect(checkSeedOutPath(root, outside, 'data/inventory/book/seed.sql', { tmpDir: tmp() }).ok).toBe(false);
  });
});
