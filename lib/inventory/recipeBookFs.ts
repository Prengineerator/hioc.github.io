// Reads the recipe book from disk (docs/INVENTORY-RECIPE-BOOK.md). Node only:
// used by scripts/inventory/* and the repo-data test; the rules themselves are
// in lib/inventory/recipeBook.ts and take the loaded book.
//
// The menu snapshot is public menu data and always lives in data/inventory/.
// The rest of the book (stock items, recipes, add-on recipes) is the café's
// private recipes and is git-ignored, so its folder is configurable: the
// `bookDir` option, else INVENTORY_BOOK_DIR, else data/inventory/book.

import fs from 'node:fs';
import path from 'node:path';
import type { AddonRecipesFile, MenuSnapshot, RecipeBook, RecipeFile, StockItemsFile } from '@/lib/inventory/recipeBook';

export const SNAPSHOT_DIR = 'data/inventory';
export const DEFAULT_BOOK_DIR = 'data/inventory/book';

/** The book folder as an absolute path: `bookDir` (or INVENTORY_BOOK_DIR, or
 * the default), relative to `rootDir` unless it is already absolute. */
export function resolveBookDir(rootDir: string, bookDir?: string): string {
  return path.resolve(rootDir, bookDir || process.env.INVENTORY_BOOK_DIR || DEFAULT_BOOK_DIR);
}

/** Absolute path of the snapshot; not affected by `bookDir`. */
export function snapshotPath(rootDir: string): string {
  return path.resolve(rootDir, SNAPSHOT_DIR, 'menu-snapshot.json');
}

function readJson<T>(file: string): T {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`inventory: ${file} is not valid JSON — ${(err as Error).message}`);
  }
}

/**
 * Loads the whole book. Only the snapshot is required: a missing
 * stock-items.json, recipes/ folder or addon-recipes.json reads as empty (the
 * book is written piece by piece, and `inventory:check` reports what is
 * missing). A file that is there but is not valid JSON throws an error that
 * names it.
 */
export function loadRecipeBook(rootDir: string, { bookDir }: { bookDir?: string } = {}): RecipeBook {
  const snapshotFile = snapshotPath(rootDir);
  if (!fs.existsSync(snapshotFile)) {
    throw new Error(`inventory: ${snapshotFile} is missing — run \`npm run inventory:snapshot\``);
  }
  const snapshot = readJson<MenuSnapshot>(snapshotFile);

  const dir = resolveBookDir(rootDir, bookDir);
  const stockFile = path.join(dir, 'stock-items.json');
  const stockItems: StockItemsFile = fs.existsSync(stockFile) ? readJson<StockItemsFile>(stockFile) : { items: [] };

  const recipesDir = path.join(dir, 'recipes');
  const recipeFiles = fs.existsSync(recipesDir)
    ? fs
        .readdirSync(recipesDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => ({ path: `recipes/${name}`, file: readJson<RecipeFile>(path.join(recipesDir, name)) }))
    : [];

  const addonFile = path.join(dir, 'addon-recipes.json');
  const addonRecipes: AddonRecipesFile = fs.existsSync(addonFile) ? readJson<AddonRecipesFile>(addonFile) : { options: [] };

  return { snapshot, stockItems, recipeFiles, addonRecipes };
}
