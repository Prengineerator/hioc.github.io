import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRecipeBook, resolveBookDir } from '@/lib/inventory/recipeBookFs';

// loadRecipeBook (lib/inventory/recipeBookFs.ts) on a throw-away folder: what
// is optional, the order files are read in, where the book lives, and that a
// bad file is named in the error.

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
