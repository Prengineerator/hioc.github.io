// Reads and writes the recipe book on disk (docs/INVENTORY-RECIPE-BOOK.md).
// Node only: used by scripts/inventory/* and the repo-data test; the rules
// themselves are in lib/inventory/recipeBook.ts and take the loaded book.
//
// The menu snapshot is public menu data and always lives in data/inventory/.
// The rest of the book (stock items, recipes, add-on recipes, the Petpooja
// importer's aliases and materials) is the café's private recipes and is
// git-ignored, so its folder is configurable: the `bookDir` option, else
// INVENTORY_BOOK_DIR, else data/inventory/book.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseBookDocument,
  type AddonRecipesFile,
  type MenuSnapshot,
  type RecipeBook,
  type RecipeFile,
  type StockItemsFile,
} from '@/lib/inventory/recipeBook';

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

/** The book's own files, relative to the book folder. */
const STOCK_ITEMS_FILE = 'stock-items.json';
const ADDON_RECIPES_FILE = 'addon-recipes.json';
const PETPOOJA_ALIASES_FILE = 'petpooja/aliases.json';
const PETPOOJA_MATERIALS_FILE = 'petpooja/materials.json';

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
  const stockFile = path.join(dir, STOCK_ITEMS_FILE);
  const stockItems: StockItemsFile = fs.existsSync(stockFile) ? readJson<StockItemsFile>(stockFile) : { items: [] };

  const recipesDir = path.join(dir, 'recipes');
  const recipeFiles = fs.existsSync(recipesDir)
    ? fs
        .readdirSync(recipesDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => ({ path: `recipes/${name}`, file: readJson<RecipeFile>(path.join(recipesDir, name)) }))
    : [];

  const addonFile = path.join(dir, ADDON_RECIPES_FILE);
  const addonRecipes: AddonRecipesFile = fs.existsSync(addonFile) ? readJson<AddonRecipesFile>(addonFile) : { options: [] };

  // The Petpooja importer's inputs travel with the book (they are saved to the
  // database too). The Petpooja CSV does not.
  const aliasesFile = path.join(dir, PETPOOJA_ALIASES_FILE);
  const materialsFile = path.join(dir, PETPOOJA_MATERIALS_FILE);
  const book: RecipeBook = { snapshot, stockItems, recipeFiles, addonRecipes };
  if (fs.existsSync(aliasesFile) || fs.existsSync(materialsFile)) {
    book.petpooja = {};
    if (fs.existsSync(aliasesFile)) book.petpooja.aliases = readJson<unknown>(aliasesFile);
    if (fs.existsSync(materialsFile)) book.petpooja.materials = readJson<unknown>(materialsFile);
  }
  return book;
}

/** Writes `value` as the book's files are written: 2-space JSON, a trailing
 * newline, parent folders created. */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export interface WriteBookResult {
  /** Files written, relative to the book folder, in the order written. */
  written: string[];
  /** Recipe files already in the folder that the document does not have. They are left alone. */
  stale: string[];
}

/**
 * Writes a saved book document (`inventory_recipe_book.book`) back out as the
 * book's files: stock-items.json, each recipe file at its path,
 * addon-recipes.json, and petpooja/aliases.json and materials.json when the
 * document has them. Nothing is written if the document is not a valid book
 * document. Refuses to touch a folder that already has a stock-items.json
 * unless `force`: a pull must not silently replace work in progress. Files the
 * document does not have (a stale recipe file, an old aliases file) are never
 * deleted; stale recipe files are reported so they can be removed by hand.
 */
export function writeBookDocument(dir: string, doc: unknown, { force = false }: { force?: boolean } = {}): WriteBookResult {
  const parsed = parseBookDocument(doc);
  if (!force && fs.existsSync(path.join(dir, STOCK_ITEMS_FILE))) {
    throw new Error(`inventory: ${path.join(dir, STOCK_ITEMS_FILE)} already exists — pulling would replace this book. Pass --force to overwrite it`);
  }

  const files: { rel: string; value: unknown }[] = [
    { rel: STOCK_ITEMS_FILE, value: parsed.stock_items },
    ...parsed.recipe_files.map(({ path: rel, file }) => ({ rel, value: file })),
    { rel: ADDON_RECIPES_FILE, value: parsed.addon_recipes },
  ];
  if (parsed.petpooja?.aliases !== undefined) files.push({ rel: PETPOOJA_ALIASES_FILE, value: parsed.petpooja.aliases });
  if (parsed.petpooja?.materials !== undefined) files.push({ rel: PETPOOJA_MATERIALS_FILE, value: parsed.petpooja.materials });

  for (const { rel, value } of files) writeJsonFile(path.join(dir, rel), value);

  const wanted = new Set(parsed.recipe_files.map((f) => f.path));
  const recipesDir = path.join(dir, 'recipes');
  const stale = fs.existsSync(recipesDir)
    ? fs
        .readdirSync(recipesDir)
        .filter((name) => name.endsWith('.json') && !wanted.has(`recipes/${name}`))
        .sort()
        .map((name) => `recipes/${name}`)
    : [];
  return { written: files.map((f) => f.rel), stale };
}

// ── Where the generated SQL may go ──────────────────────────────────────────

export type SeedMode = 'seed' | 'dry-run' | 'save-only' | 'save-only-dry-run';

/** The file name the SQL gets inside the book folder unless --out says otherwise. */
export function defaultSeedName(mode: SeedMode): string {
  return { seed: 'seed.sql', 'dry-run': 'seed.dry-run.sql', 'save-only': 'save-only.sql', 'save-only-dry-run': 'save-only.dry-run.sql' }[mode];
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The OS temp folder, as the path it is spelled and as the path it resolves to. */
function tempDirs(tmpDir: string): string[] {
  const dirs = [path.resolve(tmpDir)];
  try {
    dirs.push(fs.realpathSync(tmpDir));
  } catch {
    // no such folder: nothing to add
  }
  return dirs;
}

export type OutCheck = { ok: true } | { ok: false; reason: string };

/**
 * May the generated SQL be written to `out`? It holds recipe quantities, and
 * the repository is public, so a path inside the repo is refused unless it is in
 * the (git-ignored) book folder — or the OS temp folder, or `forceOut`. A path
 * outside the repo is always fine. `out` is resolved against `rootDir`;
 * `bookDir` is the absolute book folder. Pure apart from resolving the temp
 * folder's real path.
 */
export function checkSeedOutPath(
  rootDir: string,
  bookDir: string,
  out: string,
  { forceOut = false, tmpDir = os.tmpdir() }: { forceOut?: boolean; tmpDir?: string } = {},
): OutCheck {
  const outFile = path.resolve(rootDir, out);
  if (isInside(path.resolve(bookDir), outFile)) return { ok: true };
  if (tempDirs(tmpDir).some((dir) => isInside(dir, outFile))) return { ok: true };
  if (!isInside(path.resolve(rootDir), outFile)) return { ok: true };
  if (forceOut) return { ok: true };
  return {
    ok: false,
    reason:
      `--out ${out} is inside the repository but outside the recipe book folder (${bookDir}), and the SQL holds the café's recipe quantities — ` +
      'they must not land in a path that could be committed. Write it inside the book folder, in the OS temp folder or outside the repo, or pass --force-out',
  };
}
