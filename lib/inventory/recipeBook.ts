// The recipe book — the inventory setup as data (docs/INVENTORY-RECIPE-BOOK.md).
// Stock items and every menu item's and add-on's recipe live as JSON in
// data/inventory/. This file checks that data against the live menu snapshot,
// compiles it, and renders the one idempotent SQL file that loads it into
// Supabase (scripts/inventory/*).
//
// Pure (no I/O, no clock): the files are read by lib/inventory/recipeBookFs.ts,
// so every rule here is unit-tested (tests/inventoryRecipeBook.test.ts) and the
// real book is held to it by tests/inventoryRecipeBookData.test.ts.

import { INVENTORY_UNITS, isInventoryUnit, MAX_LINES, MAX_QTY, roundQty, type InventoryUnit } from '@/lib/inventory/rules';

// ── The files, as the contract writes them ──────────────────────────────────

export const STOCK_CATEGORIES = [
  'Coffee',
  'Dairy & Alternatives',
  'Syrups & Sauces',
  'Powders & Mixes',
  'Chocolate & Spreads',
  'Toppings & Inclusions',
  'Fruit & Purees',
  'Frozen',
  'Bakery',
  'Savoury',
  'Beverages',
  'Packaging',
] as const;
export type StockCategory = (typeof STOCK_CATEGORIES)[number];

export const RECIPE_STATUSES = ['draft', 'confirmed', 'skip'] as const;
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];

export const RECIPE_SOURCES = ['owner', 'chef-default', 'pos', 'petpooja'] as const;
export type RecipeSource = (typeof RECIPE_SOURCES)[number];

/** inventory_items.name: 1–80 characters. */
export const MAX_STOCK_NAME_LENGTH = 80;

export interface StockItemEntry {
  name: string;
  unit: InventoryUnit;
  category: StockCategory;
  tracks_expiry: boolean;
  /** "Low at". 0 = not set (the owner fills it in). */
  par_level: number;
  /** "Usually request". 0 = not set. */
  reorder_qty: number;
  /** Load the item even when no recipe uses it. Default false. */
  standalone?: boolean;
  notes?: string;
}
export interface StockItemsFile {
  items: StockItemEntry[];
}

export interface RecipeLineEntry {
  /** A stock item's name, matched case-insensitively on the trimmed text. */
  ingredient: string;
  /** One serving, in the stock item's own unit. */
  qty: number;
}

export interface RecipeItemEntry {
  menu_item_id: string;
  /** The item's name, for people to read. */
  menu_item: string;
  status: RecipeStatus;
  source: RecipeSource;
  notes?: string;
  /** The recipe for every size that has no list of its own. */
  base: RecipeLineEntry[];
  /** Size label (exactly as in the snapshot) → that size's whole recipe. */
  sizes: Record<string, RecipeLineEntry[]>;
}
export interface RecipeFile {
  /** The snapshot categories this file covers (each belongs to one file). */
  categories: string[];
  items: RecipeItemEntry[];
}

/** An add-on amount that applies to one menu item, or to one size of it. The
 * most specific scope with lines wins: item + size, then item (all sizes), then
 * the option's general `lines`. */
export interface AddonScopeEntry {
  /** A menu item in the snapshot. */
  menu_item_id: string;
  /** The item's name, kept for people to read. */
  menu_item: string;
  /** One of the item's size labels exactly, or '' for all its sizes. */
  size_label: string;
  lines: RecipeLineEntry[];
}

export interface AddonRecipeEntry {
  addon_option_id: string;
  group: string;
  option: string;
  status: RecipeStatus;
  source: RecipeSource;
  notes?: string;
  /** The general recipe: what one serving the add-on is added to uses. */
  lines: RecipeLineEntry[];
  /** Per-item / per-size amounts that replace `lines` where they apply. */
  scopes?: AddonScopeEntry[];
}
export interface AddonRecipesFile {
  options: AddonRecipeEntry[];
}

export interface SnapshotSize {
  label: string;
  price_inr: number;
}
export interface SnapshotItem {
  id: string;
  name: string;
  category: string;
  parent_category: string;
  is_available: boolean;
  sizes: SnapshotSize[];
  addon_groups: string[];
  description: string;
}
export interface SnapshotAddonOption {
  id: string;
  group: string;
  group_label: string;
  option: string;
  price_inr: number;
}
/** data/inventory/menu-snapshot.json — written by `npm run inventory:snapshot`. */
export interface MenuSnapshot {
  _comment: string;
  captured_at: string;
  items: SnapshotItem[];
  addon_options: SnapshotAddonOption[];
}

/** The Petpooja importer's own inputs (`petpooja/aliases.json`, `petpooja/materials.json`).
 * Their shape belongs to the importer; the book only carries them so they are
 * saved with it. The Petpooja CSV is not part of the book. */
export interface BookPetpooja {
  aliases?: unknown;
  materials?: unknown;
}

export interface RecipeBook {
  snapshot: MenuSnapshot;
  stockItems: StockItemsFile;
  /** `path` is relative to the book folder ("recipes/hot.json"), in file-name order. */
  recipeFiles: { path: string; file: RecipeFile }[];
  addonRecipes: AddonRecipesFile;
  /** Absent when the book folder has no petpooja/aliases.json or materials.json. */
  petpooja?: BookPetpooja;
}

// ── The book as one document (what the database saves) ──────────────────────

/** Every file of the book, as one JSON document: what `inventory_recipe_book`
 * stores and `npm run inventory:pull` writes back out. The menu snapshot is not
 * in it (it is public and committed). */
export interface BookDocument {
  version: 1;
  stock_items: StockItemsFile;
  /** `path` is relative to the book folder ("recipes/hot.json"). */
  recipe_files: { path: string; file: RecipeFile }[];
  addon_recipes: AddonRecipesFile;
  petpooja?: BookPetpooja;
}

/** A recipe file's path in the document: one .json file directly in recipes/.
 * The path is written to disk by `inventory:pull`, so nothing else is accepted. */
const RECIPE_FILE_PATH = /^recipes\/[^/\\\0]+\.json$/;

/**
 * The book as its saved document. `extras.petpooja` (else `book.petpooja`) is
 * included only when it has an aliases or a materials file. The pieces are
 * shared with the book, not copied.
 */
export function toBookDocument(book: RecipeBook, extras: { petpooja?: BookPetpooja } = {}): BookDocument {
  const doc: BookDocument = {
    version: 1,
    stock_items: book.stockItems,
    recipe_files: book.recipeFiles.map(({ path, file }) => ({ path, file })),
    addon_recipes: book.addonRecipes,
  };
  const source = extras.petpooja ?? book.petpooja;
  if (source && (source.aliases !== undefined || source.materials !== undefined)) {
    const petpooja: BookPetpooja = {};
    if (source.aliases !== undefined) petpooja.aliases = source.aliases;
    if (source.materials !== undefined) petpooja.materials = source.materials;
    doc.petpooja = petpooja;
  }
  return doc;
}

/**
 * Checks that `doc` is a book document — version 1, the three parts in their
 * shapes, and safe recipe-file paths — and returns it typed. The quantities and
 * names are not checked here (`validateRecipeBook` does that, against the
 * snapshot): a saved draft with mistakes must still come back. Throws an Error
 * that says what is wrong.
 */
export function parseBookDocument(doc: unknown): BookDocument {
  if (!isObject(doc)) throw new Error('inventory: the saved book is not an object');
  if (doc.version !== 1) throw new Error(`inventory: the saved book is version ${JSON.stringify(doc.version)}, but this tool reads version 1 — update the repo`);

  const stock = doc.stock_items;
  if (!isObject(stock) || !Array.isArray(stock.items)) throw new Error("inventory: the saved book's `stock_items` must be an object with an `items` list");

  const files = doc.recipe_files;
  if (!Array.isArray(files)) throw new Error("inventory: the saved book's `recipe_files` must be a list");
  const seen = new Set<string>();
  files.forEach((entry: unknown, index: number) => {
    if (!isObject(entry) || typeof entry.path !== 'string' || !isObject(entry.file)) {
      throw new Error(`inventory: the saved book's recipe file #${index + 1} must be { path, file }`);
    }
    if (!RECIPE_FILE_PATH.test(entry.path)) {
      throw new Error(`inventory: the saved book's recipe file path ${quote(entry.path)} must look like "recipes/<name>.json"`);
    }
    if (seen.has(entry.path)) throw new Error(`inventory: the saved book lists ${entry.path} twice`);
    seen.add(entry.path);
  });

  const addons = doc.addon_recipes;
  if (!isObject(addons) || !Array.isArray(addons.options)) throw new Error("inventory: the saved book's `addon_recipes` must be an object with an `options` list");

  if (doc.petpooja !== undefined && !isObject(doc.petpooja)) throw new Error("inventory: the saved book's `petpooja` must be an object");

  return doc as unknown as BookDocument;
}

/** The book's files from a saved document (no snapshot: that is committed). */
export function fromBookDocument(doc: unknown): Omit<RecipeBook, 'snapshot'> {
  const parsed = parseBookDocument(doc);
  const book: Omit<RecipeBook, 'snapshot'> = {
    stockItems: parsed.stock_items,
    recipeFiles: parsed.recipe_files.map(({ path, file }) => ({ path, file })),
    addonRecipes: parsed.addon_recipes,
  };
  if (parsed.petpooja) book.petpooja = parsed.petpooja;
  return book;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface Issue {
  /** "recipes/hot.json › Latte › Extra Large" */
  where: string;
  message: string;
}

export interface CoverageCounts {
  total: number;
  confirmed: number;
  draft: number;
  skip: number;
  missing: number;
}
export interface CategoryCoverage extends CoverageCounts {
  category: string;
}
export interface Coverage {
  /** One row per snapshot category, in snapshot order. */
  categories: CategoryCoverage[];
  /** All menu items. */
  menuItems: CoverageCounts;
  addons: CoverageCounts;
  /** Menu items and add-ons together. */
  overall: CoverageCounts;
}

export interface Validation {
  errors: Issue[];
  warnings: Issue[];
  coverage: Coverage;
}

export function formatIssue(issue: Issue): string {
  return `${issue.where}: ${issue.message}`;
}

const STOCK_FILE = 'stock-items.json';
const ADDON_FILE = 'addon-recipes.json';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How a stock item is looked up: the same trim + lower-case the database's
 * unique index (inventory_items_name_ci) uses. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function quote(text: unknown): string {
  return `"${String(text)}"`;
}

function emptyCounts(): CoverageCounts {
  return { total: 0, confirmed: 0, draft: 0, skip: 0, missing: 0 };
}

function tally(counts: CoverageCounts, status: RecipeStatus | undefined): void {
  counts.total += 1;
  counts[status ?? 'missing'] += 1;
}

function sumCounts(a: CoverageCounts, b: CoverageCounts): CoverageCounts {
  return {
    total: a.total + b.total,
    confirmed: a.confirmed + b.confirmed,
    draft: a.draft + b.draft,
    skip: a.skip + b.skip,
    missing: a.missing + b.missing,
  };
}

/**
 * Checks the whole book against the contract and the live menu snapshot.
 * ERRORS stop `inventory:build` (they would load wrong data, or fail the seed
 * SQL half way); WARNINGS are things worth a look (a renamed item, an unused
 * stock item, a menu item with no recipe yet). Never throws, whatever the
 * JSON looked like: the files are hand-written by an agent.
 */
export function validateRecipeBook(book: RecipeBook): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const error = (where: string, message: string) => errors.push({ where, message });
  const warn = (where: string, message: string) => warnings.push({ where, message });

  const { snapshot } = book;
  const snapshotItems = new Map(snapshot.items.map((i) => [i.id, i]));
  const snapshotOptions = new Map(snapshot.addon_options.map((o) => [o.id, o]));
  const snapshotCategories = new Set(snapshot.items.map((i) => i.category));

  // ── Stock items ───────────────────────────────────────────────────────────
  // name key → the first item that has it; also the lookup for recipe lines.
  const stock = new Map<string, Json>();
  const stockFile: unknown = book.stockItems;
  if (!isObject(stockFile) || !Array.isArray(stockFile.items)) {
    error(STOCK_FILE, 'must be an object with an `items` list');
  } else {
    stockFile.items.forEach((raw: unknown, index: number) => {
      const position = `item #${index + 1}`;
      if (!isObject(raw)) return error(`${STOCK_FILE} › ${position}`, 'is not an object');
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const where = `${STOCK_FILE} › ${name || position}`;

      if (!name) {
        error(where, 'name is missing or blank');
      } else if (name.length > MAX_STOCK_NAME_LENGTH) {
        error(where, `name is ${name.length} characters — at most ${MAX_STOCK_NAME_LENGTH}`);
      }
      if (name) {
        const key = nameKey(name);
        const first = stock.get(key);
        if (first) error(where, `duplicate of stock item ${quote(String(first.name).trim())} — names are unique regardless of case`);
        else stock.set(key, raw);
      }

      if (!isInventoryUnit(raw.unit)) error(where, `unit ${quote(raw.unit)} must be one of ${INVENTORY_UNITS.join(', ')}`);
      if (!isOneOf(STOCK_CATEGORIES, raw.category)) {
        error(where, `category ${quote(raw.category)} must be one of ${STOCK_CATEGORIES.join(', ')}`);
      }
      for (const field of ['par_level', 'reorder_qty'] as const) {
        const v = raw[field];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_QTY) {
          error(where, `${field} must be a number from 0 to ${MAX_QTY}`);
        }
      }
      for (const field of ['tracks_expiry', 'standalone'] as const) {
        if (raw[field] !== undefined && typeof raw[field] !== 'boolean') error(where, `${field} must be true or false`);
      }
    });
  }

  // ── Recipes ───────────────────────────────────────────────────────────────
  const usedIngredients = new Set<string>();
  const menuStatus = new Map<string, RecipeStatus | undefined>(); // first entry per menu item wins
  const menuWhere = new Map<string, string>();
  const optionStatus = new Map<string, RecipeStatus | undefined>();
  const optionWhere = new Map<string, string>();

  /** One list of { ingredient, qty }. Returns how many lines it has. */
  function checkLines(raw: unknown, where: string, what = 'lines'): number {
    if (!Array.isArray(raw)) {
      error(where, `${what} must be a list of { ingredient, qty }`);
      return 0;
    }
    const seen = new Set<string>();
    raw.forEach((line: unknown, index: number) => {
      if (!isObject(line)) return error(where, `line ${index + 1} is not an object`);
      const ingredient = typeof line.ingredient === 'string' ? line.ingredient.trim() : '';
      const label = ingredient ? quote(ingredient) : `line ${index + 1}`;
      if (!ingredient) {
        error(where, `line ${index + 1} has no ingredient`);
      } else {
        const key = nameKey(ingredient);
        usedIngredients.add(key);
        if (!stock.has(key)) error(where, `ingredient ${label} is not a stock item — add it to stock-items.json or fix the spelling`);
        if (seen.has(key)) error(where, `ingredient ${label} appears twice — an ingredient is listed once per size`);
        seen.add(key);
      }
      const qty = line.qty;
      if (typeof qty !== 'number' || !Number.isFinite(qty)) error(where, `qty of ${label} must be a number`);
      else if (qty <= 0) error(where, `qty of ${label} must be more than 0`);
      else if (qty > MAX_QTY) error(where, `qty of ${label} is above ${MAX_QTY}`);
      else if (roundQty(qty) !== qty) error(where, `qty of ${label} has more than 3 decimals`);
    });
    return raw.length;
  }

  function checkStatusAndSource(entry: Json, where: string): RecipeStatus | undefined {
    if (!isOneOf(RECIPE_SOURCES, entry.source)) error(where, `source ${quote(entry.source)} must be one of ${RECIPE_SOURCES.join(', ')}`);
    if (isOneOf(RECIPE_STATUSES, entry.status)) return entry.status;
    error(where, `status ${quote(entry.status)} must be one of ${RECIPE_STATUSES.join(', ')}`);
    return undefined;
  }

  const categoryClaimedBy = new Map<string, string>();
  for (const { path, file: rawFile } of book.recipeFiles) {
    const file: unknown = rawFile;
    if (!isObject(file)) {
      error(path, 'must be an object with `categories` and `items`');
      continue;
    }

    const declared = new Set<string>();
    const categories = file.categories;
    if (!Array.isArray(categories) || categories.length === 0 || categories.some((c) => typeof c !== 'string' || !c.trim())) {
      error(path, '`categories` must be a non-empty list of menu category names');
    } else {
      for (const category of categories as string[]) {
        declared.add(category);
        if (!snapshotCategories.has(category)) {
          error(path, `category ${quote(category)} is not in the menu snapshot`);
        } else if (categoryClaimedBy.has(category) && categoryClaimedBy.get(category) !== path) {
          error(path, `category ${quote(category)} is also claimed by ${categoryClaimedBy.get(category)} — each category belongs to one file`);
        } else {
          categoryClaimedBy.set(category, path);
        }
      }
    }

    if (!Array.isArray(file.items)) {
      error(path, '`items` must be a list');
      continue;
    }
    file.items.forEach((raw: unknown, index: number) => {
      if (!isObject(raw)) return error(`${path} › item #${index + 1}`, 'is not an object');
      const id = typeof raw.menu_item_id === 'string' ? raw.menu_item_id : '';
      const item = snapshotItems.get(id);
      const listedName = typeof raw.menu_item === 'string' ? raw.menu_item.trim() : '';
      const where = `${path} › ${item?.name ?? (listedName || `item #${index + 1}`)}`;

      if (!item) {
        error(where, id ? `menu_item_id ${quote(id)} is not in the menu snapshot` : 'menu_item_id is missing');
      } else {
        if (!declared.has(item.category)) {
          error(where, `category ${quote(item.category)} is not one of this file's categories (${[...declared].join(', ') || 'none'})`);
        }
        if (listedName !== item.name.trim()) warn(where, `menu_item ${quote(listedName)} differs from the live name ${quote(item.name)} — renamed? update it`);
      }
      const status = checkStatusAndSource(raw, where);
      if (id) {
        if (menuStatus.has(id)) error(where, `menu_item_id is listed twice — first at ${menuWhere.get(id)}`);
        else {
          menuStatus.set(id, status);
          menuWhere.set(id, where);
        }
      }

      // base and sizes: absent means empty, but a wrong type is an error.
      const base = raw.base ?? [];
      const sizes = raw.sizes ?? {};
      const baseCount = checkLines(base, where, '`base`');
      let lineCount = baseCount;
      const ownCounts = new Map<string, number>(); // size label → lines in that size's own list
      if (!isObject(sizes)) {
        error(where, '`sizes` must be an object of size label → lines');
      } else {
        for (const [label, list] of Object.entries(sizes)) {
          const sizeWhere = `${where} › ${label}`;
          if (item && !item.sizes.some((s) => s.label === label)) {
            error(sizeWhere, `${quote(label)} is not a size of ${item.name} (sizes: ${item.sizes.map((s) => s.label).join(', ')})`);
          }
          const count = checkLines(list, sizeWhere);
          ownCounts.set(label, count);
          lineCount += count;
        }
      }

      if (lineCount > MAX_LINES) error(where, `${lineCount} lines — at most ${MAX_LINES} per item, across base and sizes`);
      if (status === 'skip' && lineCount > 0) error(where, 'status is skip, so base and sizes must be empty');
      if ((status === 'draft' || status === 'confirmed') && item) {
        for (const size of item.sizes) {
          const own = ownCounts.get(size.label) ?? 0;
          if ((own > 0 ? own : baseCount) === 0) {
            error(`${where} › ${size.label}`, `size has no recipe — give it its own lines or fill in base (status is ${status})`);
          }
        }
      }
    });
  }

  // ── Add-on recipes ────────────────────────────────────────────────────────
  const addonFile: unknown = book.addonRecipes;
  if (!isObject(addonFile) || !Array.isArray(addonFile.options)) {
    error(ADDON_FILE, 'must be an object with an `options` list');
  } else {
    addonFile.options.forEach((raw: unknown, index: number) => {
      if (!isObject(raw)) return error(`${ADDON_FILE} › option #${index + 1}`, 'is not an object');
      const id = typeof raw.addon_option_id === 'string' ? raw.addon_option_id : '';
      const option = snapshotOptions.get(id);
      const listed = [raw.group, raw.option].map((v) => (typeof v === 'string' ? v.trim() : ''));
      const where = `${ADDON_FILE} › ${option ? `${option.group} › ${option.option}` : listed.filter(Boolean).join(' › ') || `option #${index + 1}`}`;

      if (!option) {
        error(where, id ? `addon_option_id ${quote(id)} is not in the menu snapshot` : 'addon_option_id is missing');
      } else {
        if (listed[0] !== option.group.trim()) warn(where, `group ${quote(listed[0])} differs from the live group ${quote(option.group)}`);
        if (listed[1] !== option.option.trim()) warn(where, `option ${quote(listed[1])} differs from the live name ${quote(option.option)} — renamed? update it`);
      }
      const status = checkStatusAndSource(raw, where);
      if (id) {
        if (optionStatus.has(id)) error(where, `addon_option_id is listed twice — first at ${optionWhere.get(id)}`);
        else {
          optionStatus.set(id, status);
          optionWhere.set(id, where);
        }
      }

      const count = raw.lines === undefined ? 0 : checkLines(raw.lines, where, '`lines`');
      if (count > MAX_LINES) error(where, `${count} lines — at most ${MAX_LINES} per add-on`);

      // Scopes: amounts for one item, or one size of it, that beat the general lines.
      let scopeCount = 0;
      let scopeLineCount = 0;
      if (raw.scopes !== undefined) {
        if (!Array.isArray(raw.scopes)) {
          error(where, '`scopes` must be a list of { menu_item_id, menu_item, size_label, lines }');
        } else {
          scopeCount = raw.scopes.length;
          const seenScopes = new Map<string, string>(); // "item id, size label" → where its first scope is
          raw.scopes.forEach((rawScope: unknown, scopeIndex: number) => {
            if (!isObject(rawScope)) return error(`${where} › scope #${scopeIndex + 1}`, 'is not an object');
            const itemId = typeof rawScope.menu_item_id === 'string' ? rawScope.menu_item_id : '';
            const scopeItem = snapshotItems.get(itemId);
            const listedName = typeof rawScope.menu_item === 'string' ? rawScope.menu_item.trim() : '';
            const sizeLabel = rawScope.size_label;
            const scopeName = scopeItem?.name ?? (listedName || `#${scopeIndex + 1}`);
            const scopeWhere = `${where} › scope ${scopeName} › ${typeof sizeLabel === 'string' && sizeLabel !== '' ? sizeLabel : 'all sizes'}`;

            if (!scopeItem) {
              error(scopeWhere, itemId ? `menu_item_id ${quote(itemId)} is not in the menu snapshot` : 'menu_item_id is missing');
            } else {
              if (listedName !== scopeItem.name.trim()) {
                warn(scopeWhere, `menu_item ${quote(listedName)} differs from the live name ${quote(scopeItem.name)} — renamed? update it`);
              }
              if (option && !scopeItem.addon_groups.includes(option.group)) {
                warn(scopeWhere, `${scopeItem.name} does not offer the add-on group ${quote(option.group)}, so this option can't be ordered on it and the scope never applies`);
              }
            }
            if (typeof sizeLabel !== 'string') {
              error(scopeWhere, 'size_label must be one of the item\'s size labels, or "" for all its sizes');
            } else if (sizeLabel !== '' && scopeItem && !scopeItem.sizes.some((s) => s.label === sizeLabel)) {
              error(scopeWhere, `size_label ${quote(sizeLabel)} is not a size of ${scopeItem.name} (sizes: ${scopeItem.sizes.map((s) => s.label).join(', ')}) — use "" for all sizes`);
            }
            if (itemId && typeof sizeLabel === 'string') {
              const key = `${itemId}\u0000${sizeLabel}`;
              const first = seenScopes.get(key);
              if (first) error(scopeWhere, `scope is listed twice for this item and size — first at ${first}`);
              else seenScopes.set(key, scopeWhere);
            }

            const lines = checkLines(rawScope.lines, scopeWhere, '`lines`');
            scopeLineCount += lines;
            if (Array.isArray(rawScope.lines) && lines === 0) error(scopeWhere, 'scope has no lines — add some or remove the scope');
            if (lines > MAX_LINES) error(scopeWhere, `${lines} lines — at most ${MAX_LINES} per scope`);
          });
        }
      }

      if (status === 'skip' && (count > 0 || scopeCount > 0)) error(where, 'status is skip, so lines and scopes must be empty');
      if ((status === 'draft' || status === 'confirmed') && count === 0 && scopeLineCount === 0) error(where, `no lines (status is ${status})`);
    });
  }

  // ── Warnings that need the whole book ─────────────────────────────────────
  for (const [key, raw] of stock) {
    if (raw.standalone !== true && !usedIngredients.has(key)) {
      warn(`${STOCK_FILE} › ${String(raw.name).trim()}`, 'no recipe uses this stock item and it is not standalone, so it will not be loaded');
    }
  }
  for (const item of snapshot.items) {
    if (!menuStatus.has(item.id)) warn(`${item.category} › ${item.name}`, 'menu item has no recipe entry yet');
  }
  for (const option of snapshot.addon_options) {
    if (!optionStatus.has(option.id)) warn(`${option.group} › ${option.option}`, 'add-on has no recipe entry yet');
  }

  // ── Coverage ──────────────────────────────────────────────────────────────
  const byCategory = new Map<string, CoverageCounts>();
  const menuItems = emptyCounts();
  for (const item of snapshot.items) {
    const counts = byCategory.get(item.category) ?? emptyCounts();
    byCategory.set(item.category, counts);
    const status = menuStatus.get(item.id);
    tally(counts, status);
    tally(menuItems, status);
  }
  const addons = emptyCounts();
  for (const option of snapshot.addon_options) tally(addons, optionStatus.get(option.id));

  return {
    errors,
    warnings,
    coverage: {
      categories: [...byCategory].map(([category, counts]) => ({ category, ...counts })),
      menuItems,
      addons,
      overall: sumCounts(menuItems, addons),
    },
  };
}

// ── Compile ─────────────────────────────────────────────────────────────────

export interface SeedStockItem {
  name: string;
  unit: InventoryUnit;
  category: StockCategory;
  par_level: number;
  reorder_qty: number;
  tracks_expiry: boolean;
}
export interface SeedRecipeLine {
  /** '' = the base recipe; else a size's label. */
  size_label: string;
  ingredient: string;
  qty: number;
}
export interface SeedRecipe {
  id: string;
  name: string;
  lines: SeedRecipeLine[];
}
export interface SeedAddonLine {
  /** null = the option's general recipe; else the menu item this line is scoped to. */
  menu_item_id: string | null;
  /** '' = all sizes of the scoped item (or the general recipe); else that size's label. */
  size_label: string;
  ingredient: string;
  qty: number;
}
export interface SeedAddonRecipe {
  id: string;
  /** "Group › Option" */
  name: string;
  /** General lines first, then scopes: items in snapshot order, an item's
   * all-sizes scope before its sizes, sizes in snapshot order. */
  lines: SeedAddonLine[];
}
export interface SeedPayload {
  stock_items: SeedStockItem[];
  recipes: SeedRecipe[];
  addon_recipes: SeedAddonRecipe[];
}

/**
 * The book as the seed SQL loads it: confirmed recipes (plus drafts with
 * `includeDrafts`), in menu-snapshot order, and only the stock items those
 * recipes use or that are marked standalone. Deterministic — no timestamps —
 * so re-running it on unchanged data gives byte-identical SQL. Throws if the
 * book has errors (validate first).
 */
export function compileRecipeBook(book: RecipeBook, { includeDrafts }: { includeDrafts: boolean }): SeedPayload {
  const { errors } = validateRecipeBook(book);
  if (errors.length > 0) {
    throw new Error(`inventory: the recipe book has ${errors.length} error(s), first: ${formatIssue(errors[0])}`);
  }

  const deployed = (status: RecipeStatus) => status === 'confirmed' || (includeDrafts && status === 'draft');
  const stockByKey = new Map<string, StockItemEntry>();
  for (const item of book.stockItems.items) stockByKey.set(nameKey(item.name), item);
  const used = new Set<string>();
  /** The stock item's own spelling, and a note that a recipe uses it. */
  const canonical = (ingredient: string): string => {
    const key = nameKey(ingredient);
    used.add(key);
    return (stockByKey.get(key) as StockItemEntry).name.trim();
  };

  const entries = new Map<string, RecipeItemEntry>();
  for (const { file } of book.recipeFiles) for (const entry of file.items) entries.set(entry.menu_item_id, entry);
  const recipes: SeedRecipe[] = [];
  for (const item of book.snapshot.items) {
    const entry = entries.get(item.id);
    if (!entry || !deployed(entry.status)) continue;
    const lines: SeedRecipeLine[] = (entry.base ?? []).map((l) => ({ size_label: '', ingredient: canonical(l.ingredient), qty: l.qty }));
    for (const size of item.sizes) {
      for (const l of entry.sizes?.[size.label] ?? []) {
        lines.push({ size_label: size.label, ingredient: canonical(l.ingredient), qty: l.qty });
      }
    }
    recipes.push({ id: item.id, name: item.name, lines });
  }

  const options = new Map<string, AddonRecipeEntry>();
  for (const entry of book.addonRecipes.options) options.set(entry.addon_option_id, entry);
  const addonRecipes: SeedAddonRecipe[] = [];
  for (const option of book.snapshot.addon_options) {
    const entry = options.get(option.id);
    if (!entry || !deployed(entry.status)) continue;
    const lines: SeedAddonLine[] = (entry.lines ?? []).map((l) => ({ menu_item_id: null, size_label: '', ingredient: canonical(l.ingredient), qty: l.qty }));

    const scopes = new Map<string, AddonScopeEntry>();
    for (const scope of entry.scopes ?? []) scopes.set(scopeKey(scope.menu_item_id, scope.size_label), scope);
    // Walked in snapshot order, so the SQL does not depend on the order they were written in.
    // A scope is taken out once emitted, so a repeated size label cannot emit it twice.
    if (scopes.size > 0) {
      for (const item of book.snapshot.items) {
        for (const label of ['', ...item.sizes.map((s) => s.label)]) {
          const key = scopeKey(item.id, label);
          const scope = scopes.get(key);
          if (!scope) continue;
          scopes.delete(key);
          for (const l of scope.lines) lines.push({ menu_item_id: item.id, size_label: label, ingredient: canonical(l.ingredient), qty: l.qty });
        }
      }
    }
    addonRecipes.push({ id: option.id, name: `${option.group} › ${option.option}`, lines });
  }

  const stockItems: SeedStockItem[] = book.stockItems.items
    .filter((s) => s.standalone === true || used.has(nameKey(s.name)))
    .map((s) => ({
      name: s.name.trim(),
      unit: s.unit,
      category: s.category,
      par_level: s.par_level,
      reorder_qty: s.reorder_qty,
      tracks_expiry: s.tracks_expiry === true,
    }));

  return { stock_items: stockItems, recipes, addon_recipes: addonRecipes };
}

function scopeKey(menuItemId: string, sizeLabel: string): string {
  return `${menuItemId}\u0000${sizeLabel}`;
}

export interface SeedCounts {
  stockItems: number;
  recipes: number;
  recipeLines: number;
  addonRecipes: number;
  /** All add-on lines, general and scoped. */
  addonLines: number;
  /** Of `addonLines`, the ones inside a per-item / per-size scope. */
  addonScopedLines: number;
}

export function seedCounts(payload: SeedPayload): SeedCounts {
  const addonLines = payload.addon_recipes.flatMap((r) => r.lines);
  return {
    stockItems: payload.stock_items.length,
    recipes: payload.recipes.length,
    recipeLines: payload.recipes.reduce((n, r) => n + r.lines.length, 0),
    addonRecipes: payload.addon_recipes.length,
    addonLines: addonLines.length,
    addonScopedLines: addonLines.filter((l) => l.menu_item_id !== null).length,
  };
}

/** What the book document holds, for the SQL header and the script's summary. */
export interface BookCounts {
  stockItems: number;
  recipeFiles: number;
  /** Menu-item recipe entries across all recipe files, whatever their status. */
  recipeEntries: number;
  addonOptions: number;
  petpooja: boolean;
}

export function bookCounts(doc: BookDocument): BookCounts {
  return {
    stockItems: doc.stock_items.items.length,
    recipeFiles: doc.recipe_files.length,
    recipeEntries: doc.recipe_files.reduce((n, f) => n + (Array.isArray(f.file.items) ? f.file.items.length : 0), 0),
    addonOptions: doc.addon_recipes.options.length,
    petpooja: doc.petpooja !== undefined,
  };
}

// ── Seed SQL ────────────────────────────────────────────────────────────────

export interface SeedMeta {
  includeDrafts: boolean;
  snapshotCapturedAt: string;
  /** The whole book, saved by step 0 (drafts and notes included). */
  bookDocument: BookDocument;
  /** End with an exception, so the whole DO block rolls back and nothing is saved. */
  dryRun?: boolean;
}

/** The quoting tags of the generated SQL, none of which may appear in the data. */
const QUOTING_TAGS = ['$seed$', '$book$', '$doc$'] as const;

function assertNoQuotingTags(json: string): void {
  if (QUOTING_TAGS.some((tag) => json.includes(tag))) {
    throw new Error(`inventory: a name or note in the recipe book contains ${QUOTING_TAGS.map((t) => `"${t}"`).join(', ')}, which the seed SQL uses as quoting`);
  }
}

/** The one-line, comment-safe form of a header value. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const NEEDS_LINE = '-- Needs supabase/2026-10-inventory.sql and supabase/2026-10-inventory-addon-scopes.sql.';

/** Step 0 of the seed, and the whole of a save-only file. */
const SAVE_BOOK_STEP = `  -- 0. The book's permanent home (docs/INVENTORY-RECIPE-BOOK.md): drafts and
  --    notes included, so \`npm run inventory:pull\` can restore it anywhere.
  insert into inventory_recipe_book (id, book, saved_at) values (true, v_doc, now())
  on conflict (id) do update set book = excluded.book, saved_at = excluded.saved_at;`;

/**
 * One `do` block: all or nothing, safe to re-run. The payload and the book
 * document travel as dollar-quoted JSON literals, so nothing in them needs SQL
 * escaping — but the quoting tags must not appear inside them.
 */
export function renderSeedSql(payload: SeedPayload, meta: SeedMeta): string {
  if (!Array.isArray(payload.stock_items) || !Array.isArray(payload.recipes) || !Array.isArray(payload.addon_recipes)) {
    throw new Error('inventory: the seed payload needs stock_items, recipes and addon_recipes lists');
  }
  const doc = parseBookDocument(meta.bookDocument);
  const json = JSON.stringify(payload, null, 2);
  const docJson = JSON.stringify(doc);
  assertNoQuotingTags(json);
  assertNoQuotingTags(docJson);

  const c = seedCounts(payload);
  const b = bookCounts(doc);
  const mode = meta.includeDrafts ? 'confirmed + DRAFT recipes (preview/test databases only)' : 'confirmed recipes only';
  const finish = meta.dryRun
    ? `raise exception 'DRY RUN OK (nothing was saved): % stock items, % menu-item recipes, % add-on recipes',`
    : `raise notice 'inventory seed: % stock items, % menu-item recipes, % add-on recipes',`;

  return `-- ===========================================================================
-- GENERATED by \`npm run inventory:build\` from the recipe book — DO NOT EDIT.
-- Contract, house defaults and deploy steps: docs/INVENTORY-RECIPE-BOOK.md.
-- Mode: ${mode}
${meta.dryRun ? '-- DRY RUN: ends by raising an exception so nothing is saved.\n' : ''}-- Stock items: ${c.stockItems} · Menu-item recipes: ${c.recipes} (${c.recipeLines} lines) · Add-on recipes: ${c.addonRecipes} (${c.addonLines} lines, ${c.addonScopedLines} scoped)
-- Saved book: ${b.stockItems} stock items · ${b.recipeFiles} recipe files (${b.recipeEntries} items) · ${b.addonOptions} add-on options — drafts and notes included
-- Menu snapshot: ${oneLine(meta.snapshotCapturedAt)}
${NEEDS_LINE}
-- One DO block: all or nothing. Safe to re-run: the book is saved whole; stock items
-- are matched by name (unit never changed; a par/reorder of 0 in the book leaves
-- the live value alone); each listed recipe is replaced whole; menu items and
-- add-ons not listed here are left as they are.
-- ===========================================================================
do $seed$
declare
  v_doc   jsonb := $doc$${docJson}$doc$::jsonb;
  v_book  jsonb := $book$${json}$book$::jsonb;
  v_bad   text;
  v_lines jsonb;
  v_total int;
  v_found int;
  r       record;
begin
${SAVE_BOOK_STEP}

  -- 1. Before any stock has been received, every recipe would read "0 on hand"
  --    and auto-hide would pull those items off the live menu (INV-D16) — even
  --    with the app flag off. Keep it off until the opening stock is in.
  if not exists (select 1 from inventory_batches) then
    update store_settings set stock_auto_hide = false where is_singleton and stock_auto_hide;
  end if;

  -- 2. Units lock once an item is used (INV-D15): never silently change one.
  select string_agg(format('%s (live %s, book %s)', i.name, i.unit, s.unit), '; ')
    into v_bad
    from jsonb_to_recordset(v_book->'stock_items') s(name text, unit text)
    join inventory_items i on lower(trim(i.name)) = lower(trim(s.name))
   where i.unit <> s.unit;
  if v_bad is not null then
    raise exception 'inventory seed: unit differs from the live stock item: %', v_bad;
  end if;

  -- 3. Stock items: add new ones, update existing ones (matched by name).
  insert into inventory_items (name, unit, category, par_level, reorder_qty, tracks_expiry)
  select trim(s.name), s.unit, s.category, s.par_level, s.reorder_qty, s.tracks_expiry
    from jsonb_to_recordset(v_book->'stock_items')
         s(name text, unit text, category text, par_level numeric, reorder_qty numeric, tracks_expiry boolean)
  on conflict ((lower(trim(name)))) do update
     set category      = case when excluded.category <> '' then excluded.category else inventory_items.category end,
         par_level     = case when excluded.par_level > 0 then excluded.par_level else inventory_items.par_level end,
         reorder_qty   = case when excluded.reorder_qty > 0 then excluded.reorder_qty else inventory_items.reorder_qty end,
         tracks_expiry = excluded.tracks_expiry,
         is_active     = true,
         updated_at    = now();

  -- 4. Every menu item and add-on in the book must exist live (add-on scopes
  --    name menu items too).
  select string_agg(format('%s (%s)', x.name, x.id), '; ') into v_bad
    from jsonb_to_recordset(v_book->'recipes') x(id uuid, name text)
   where not exists (select 1 from menu_items m where m.id = x.id);
  if v_bad is not null then
    raise exception 'inventory seed: menu items not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;
  end if;
  select string_agg(format('%s (%s)', x.name, x.id), '; ') into v_bad
    from jsonb_to_recordset(v_book->'addon_recipes') x(id uuid, name text)
   where not exists (select 1 from addon_options o where o.id = x.id);
  if v_bad is not null then
    raise exception 'inventory seed: add-on options not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;
  end if;
  select string_agg(distinct format('%s (%s)', x.name, l.menu_item_id), '; ') into v_bad
    from jsonb_to_recordset(v_book->'addon_recipes') x(name text, lines jsonb),
         jsonb_to_recordset(x.lines) l(menu_item_id uuid)
   where l.menu_item_id is not null
     and not exists (select 1 from menu_items m where m.id = l.menu_item_id);
  if v_bad is not null then
    raise exception 'inventory seed: add-on scopes name menu items not found live — refresh data/inventory/menu-snapshot.json: %', v_bad;
  end if;

  -- 5. Recipes, through the same functions the POS editor uses.
  for r in select * from jsonb_to_recordset(v_book->'recipes') x(id uuid, name text, lines jsonb) loop
    select count(*), count(i.id),
           coalesce(jsonb_agg(jsonb_build_object('size_label', l.size_label, 'item_id', i.id, 'qty', l.qty))
                      filter (where i.id is not null), '[]'::jsonb)
      into v_total, v_found, v_lines
      from jsonb_to_recordset(r.lines) l(size_label text, ingredient text, qty numeric)
      left join inventory_items i on lower(trim(i.name)) = lower(trim(l.ingredient));
    if v_found <> v_total then
      raise exception 'inventory seed: a line of "%" names a stock item that does not exist', r.name;
    end if;
    perform inventory_set_recipe(r.id, null, v_lines);
  end loop;

  for r in select * from jsonb_to_recordset(v_book->'addon_recipes') x(id uuid, name text, lines jsonb) loop
    select count(*), count(i.id),
           coalesce(jsonb_agg(jsonb_build_object('menu_item_id', l.menu_item_id, 'size_label', l.size_label, 'item_id', i.id, 'qty', l.qty))
                      filter (where i.id is not null), '[]'::jsonb)
      into v_total, v_found, v_lines
      from jsonb_to_recordset(r.lines) l(menu_item_id uuid, size_label text, ingredient text, qty numeric)
      left join inventory_items i on lower(trim(i.name)) = lower(trim(l.ingredient));
    if v_found <> v_total then
      raise exception 'inventory seed: a line of "%" names a stock item that does not exist', r.name;
    end if;
    perform inventory_set_addon_recipe_scopes(r.id, null, v_lines);
  end loop;

  ${finish}
    jsonb_array_length(v_book->'stock_items'), jsonb_array_length(v_book->'recipes'), jsonb_array_length(v_book->'addon_recipes');
end
$seed$;

-- ---------------------------------------------------------------------------
-- Verify:
--   select saved_at, jsonb_array_length(book->'recipe_files') as recipe_files
--     from inventory_recipe_book;                                       -- the book is saved
--   select count(*) from inventory_items;                               -- >= ${c.stockItems}
--   select count(distinct menu_item_id) from recipe_lines;              -- >= ${c.recipes}
--   select count(distinct addon_option_id) from addon_recipe_lines;     -- >= ${c.addonRecipes}
--   select stock_auto_hide from store_settings where is_singleton;      -- false until opening stock is received
--   select m.name, rl.size_label, i.name, rl.qty, i.unit
--     from recipe_lines rl join menu_items m on m.id = rl.menu_item_id
--     join inventory_items i on i.id = rl.item_id order by 1, 2, 3;
-- ---------------------------------------------------------------------------
`;
}

export interface SaveOnlyMeta {
  snapshotCapturedAt: string;
  /** End with an exception, so nothing is saved. */
  dryRun?: boolean;
}

/**
 * The seed's step 0 on its own: one `do` block that saves the book and touches
 * no stock items or recipes. The book is stored as it is — it does not have to
 * pass `validateRecipeBook` — only its shape is checked (`parseBookDocument`).
 */
export function renderSaveOnlySql(doc: BookDocument, meta: SaveOnlyMeta): string {
  const parsed = parseBookDocument(doc);
  const docJson = JSON.stringify(parsed);
  assertNoQuotingTags(docJson);
  const b = bookCounts(parsed);
  const finish = meta.dryRun
    ? `raise exception 'DRY RUN OK (nothing was saved): % stock items, % recipe files, % add-on options',`
    : `raise notice 'inventory seed: book saved (% stock items, % recipe files, % add-on options)',`;

  return `-- ===========================================================================
-- GENERATED by \`npm run inventory:build -- --save-only\` from the recipe book — DO NOT EDIT.
-- SAVE ONLY: stores the book; changes no stock items or recipes.
-- Contract and deploy steps: docs/INVENTORY-RECIPE-BOOK.md.
${meta.dryRun ? '-- DRY RUN: ends by raising an exception so nothing is saved.\n' : ''}-- Saved book: ${b.stockItems} stock items · ${b.recipeFiles} recipe files (${b.recipeEntries} items) · ${b.addonOptions} add-on options — drafts and notes included
-- Menu snapshot: ${oneLine(meta.snapshotCapturedAt)}
${NEEDS_LINE}
-- One DO block. Safe to re-run: it replaces the saved book.
-- ===========================================================================
do $seed$
declare
  v_doc jsonb := $doc$${docJson}$doc$::jsonb;
begin
${SAVE_BOOK_STEP}

  ${finish}
    jsonb_array_length(v_doc->'stock_items'->'items'), jsonb_array_length(v_doc->'recipe_files'), jsonb_array_length(v_doc->'addon_recipes'->'options');
end
$seed$;

-- ---------------------------------------------------------------------------
-- Verify:
--   select saved_at, jsonb_array_length(book->'recipe_files') as recipe_files
--     from inventory_recipe_book;
-- ---------------------------------------------------------------------------
`;
}
