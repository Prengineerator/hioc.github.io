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

export interface AddonRecipeEntry {
  addon_option_id: string;
  group: string;
  option: string;
  status: RecipeStatus;
  source: RecipeSource;
  notes?: string;
  /** What one serving the add-on is added to uses. */
  lines: RecipeLineEntry[];
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

export interface RecipeBook {
  snapshot: MenuSnapshot;
  stockItems: StockItemsFile;
  /** `path` is relative to data/inventory/ ("recipes/hot.json"), in file-name order. */
  recipeFiles: { path: string; file: RecipeFile }[];
  addonRecipes: AddonRecipesFile;
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
      // The contract's per-item / per-size add-on amounts (`scopes`) are not
      // compiled or loaded yet: refuse them rather than drop them silently.
      if (Array.isArray(raw.scopes) ? raw.scopes.length > 0 : raw.scopes !== undefined) {
        error(where, '`scopes` (per-item / per-size amounts) are not supported by these tools yet, so they would be left out of the seed');
      }
      if (id) {
        if (optionStatus.has(id)) error(where, `addon_option_id is listed twice — first at ${optionWhere.get(id)}`);
        else {
          optionStatus.set(id, status);
          optionWhere.set(id, where);
        }
      }

      const count = raw.lines === undefined ? 0 : checkLines(raw.lines, where, '`lines`');
      if (count > MAX_LINES) error(where, `${count} lines — at most ${MAX_LINES} per add-on`);
      if (status === 'skip' && count > 0) error(where, 'status is skip, so lines must be empty');
      if ((status === 'draft' || status === 'confirmed') && count === 0) error(where, `no lines (status is ${status})`);
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
export interface SeedAddonRecipe {
  id: string;
  /** "Group › Option" */
  name: string;
  lines: { ingredient: string; qty: number }[];
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
    addonRecipes.push({
      id: option.id,
      name: `${option.group} › ${option.option}`,
      lines: (entry.lines ?? []).map((l) => ({ ingredient: canonical(l.ingredient), qty: l.qty })),
    });
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

export interface SeedCounts {
  stockItems: number;
  recipes: number;
  recipeLines: number;
  addonRecipes: number;
  addonLines: number;
}

export function seedCounts(payload: SeedPayload): SeedCounts {
  return {
    stockItems: payload.stock_items.length,
    recipes: payload.recipes.length,
    recipeLines: payload.recipes.reduce((n, r) => n + r.lines.length, 0),
    addonRecipes: payload.addon_recipes.length,
    addonLines: payload.addon_recipes.reduce((n, r) => n + r.lines.length, 0),
  };
}

// ── Seed SQL ────────────────────────────────────────────────────────────────

export interface SeedMeta {
  includeDrafts: boolean;
  snapshotCapturedAt: string;
  /** End with an exception, so the whole DO block rolls back and nothing is saved. */
  dryRun?: boolean;
}

/**
 * One `do` block: all or nothing, safe to re-run. The payload travels as a
 * dollar-quoted JSON literal, so nothing in it needs SQL escaping — but the
 * quoting tags must not appear inside it.
 */
export function renderSeedSql(payload: SeedPayload, meta: SeedMeta): string {
  if (!Array.isArray(payload.stock_items) || !Array.isArray(payload.recipes) || !Array.isArray(payload.addon_recipes)) {
    throw new Error('inventory: the seed payload needs stock_items, recipes and addon_recipes lists');
  }
  const json = JSON.stringify(payload, null, 2);
  if (json.includes('$book$') || json.includes('$seed$')) {
    throw new Error('inventory: a name in the recipe book contains "$book$" or "$seed$", which the seed SQL uses as quoting');
  }

  const c = seedCounts(payload);
  const mode = meta.includeDrafts ? 'confirmed + DRAFT recipes (preview/test databases only)' : 'confirmed recipes only';
  const captured = meta.snapshotCapturedAt.replace(/\s+/g, ' ').trim();
  const finish = meta.dryRun
    ? `raise exception 'DRY RUN OK (nothing was saved): % stock items, % menu-item recipes, % add-on recipes',`
    : `raise notice 'inventory seed: % stock items, % menu-item recipes, % add-on recipes',`;

  return `-- ===========================================================================
-- GENERATED by \`npm run inventory:build\` from data/inventory/ — DO NOT EDIT.
-- Contract, house defaults and deploy steps: docs/INVENTORY-RECIPE-BOOK.md.
-- Mode: ${mode}
${meta.dryRun ? '-- DRY RUN: ends by raising an exception so nothing is saved.\n' : ''}-- Stock items: ${c.stockItems} · Menu-item recipes: ${c.recipes} (${c.recipeLines} lines) · Add-on recipes: ${c.addonRecipes} (${c.addonLines} lines)
-- Menu snapshot: ${captured}
-- Needs supabase/2026-10-inventory.sql. One DO block: all or nothing. Safe to re-run:
-- stock items are matched by name (unit never changed; a par/reorder of 0 in the
-- book leaves the live value alone); each listed recipe is replaced whole;
-- menu items and add-ons not listed here are left as they are.
-- ===========================================================================
do $seed$
declare
  v_book  jsonb := $book$${json}$book$::jsonb;
  v_bad   text;
  v_lines jsonb;
  v_total int;
  v_found int;
  r       record;
begin
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

  -- 4. Every menu item and add-on in the book must exist live.
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
           coalesce(jsonb_agg(jsonb_build_object('item_id', i.id, 'qty', l.qty))
                      filter (where i.id is not null), '[]'::jsonb)
      into v_total, v_found, v_lines
      from jsonb_to_recordset(r.lines) l(ingredient text, qty numeric)
      left join inventory_items i on lower(trim(i.name)) = lower(trim(l.ingredient));
    if v_found <> v_total then
      raise exception 'inventory seed: a line of "%" names a stock item that does not exist', r.name;
    end if;
    perform inventory_set_addon_recipe(r.id, null, v_lines);
  end loop;

  ${finish}
    jsonb_array_length(v_book->'stock_items'), jsonb_array_length(v_book->'recipes'), jsonb_array_length(v_book->'addon_recipes');
end
$seed$;

-- ---------------------------------------------------------------------------
-- Verify:
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
