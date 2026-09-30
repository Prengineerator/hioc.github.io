// Petpooja "Item Addon Recipe" export -> recipe book (docs/INVENTORY-RECIPE-BOOK.md,
// "Importing from Petpooja").
//
// Pure (no fs, no clock, no randomness): the CSV text goes in, the book's files
// and a structured report come out, and the same inputs always give identical
// output. scripts/inventory/import-petpooja-recipes.ts does the reading and
// writing. Nothing here contains recipe data: the report names items, add-ons
// and materials but never a quantity.

import { extractTrailingParens } from '@/lib/petpooja/items';
import { matchMenuItem, normalize } from '@/lib/petpooja/match';
import type { MenuSnapshotItem } from '@/lib/petpooja/types';
import {
  STOCK_CATEGORIES,
  type AddonRecipeEntry,
  type AddonScopeEntry,
  type MenuSnapshot,
  type RecipeFile,
  type RecipeItemEntry,
  type RecipeLineEntry,
  type SnapshotAddonOption,
  type SnapshotItem,
  type StockItemEntry,
} from '@/lib/inventory/recipeBook';
import { roundQty, type InventoryUnit } from '@/lib/inventory/rules';

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface PetpoojaMaterialCell {
  /** Trimmed cell text; '' when the cell is empty. */
  material: string;
  qty: string;
  unit: string;
}

export interface PetpoojaRecipeRow {
  /** 1-based record number in the file (the header is record 1). */
  line: number;
  /** The ID cell as written ("0x3134…"). */
  rawId: string;
  /** Decoded: `itemId#variationId` for an Item, `itemId#variationId#addonId` for an Addon. */
  id: string;
  name: string;
  /** The ItemType cell: "Item" or "Addon". */
  type: string;
  /** Every (material, qty, unit) triple that has at least one non-empty cell. */
  materials: PetpoojaMaterialCell[];
}

/** petpooja/materials.json: "<Petpooja material, trimmed>" -> the stock item it is. */
export interface MaterialMapping {
  name: string;
  category: string;
  tracks_expiry: boolean;
}
export type MaterialsMap = Record<string, MaterialMapping>;

/** petpooja/aliases.json. A null value means "not on the menu: ignore". */
export interface PetpoojaAliases {
  items?: Record<string, string | null>;
  addons?: Record<string, string | null>;
}

/** An add-on entry, with the contract's per-item / per-size `scopes`. */
export type AddonOptionEntry = AddonRecipeEntry & { scopes?: AddonScopeEntry[] };

/** What stock-items.json holds; `category` is '' for a material still to be mapped. */
export type ImportedStockItem = Omit<StockItemEntry, 'category'> & { category: string };

export interface ExistingBook {
  stockItems?: { items?: StockItemEntry[] };
  recipeFiles?: { path: string; file: RecipeFile }[];
  addonRecipes?: { options?: AddonOptionEntry[] };
}

export interface ImportInput {
  rows: PetpoojaRecipeRow[];
  snapshot: Pick<MenuSnapshot, 'items' | 'addon_options'>;
  aliases: PetpoojaAliases;
  materials: MaterialsMap;
  existing: ExistingBook;
}

// ── The report ──────────────────────────────────────────────────────────────

export interface MatchedItemReport {
  menu_item: string;
  category: string;
  /** The Petpooja item names (as written in the export) that gave it a recipe. */
  petpooja: string[];
  via: 'alias' | 'auto';
  /** The live sizes the recipe covers; "(all sizes)" for one recipe that applies to every size. */
  covers: string[];
  /** True when there is one recipe for an item that has several sizes. */
  appliesToAllSizes: boolean;
}
export interface UnmatchedItemReport {
  /** The name to alias: as written, without ` [n]` and without a trailing size. */
  name: string;
  rows: number;
  /** The trailing parentheses seen after it, e.g. "(Large)". */
  suffixes: string[];
}
export interface SizeNotLiveReport {
  petpooja: string;
  menu_item: string;
  size: string;
  liveSizes: string[];
}
export interface DuplicateReport {
  menu_item: string;
  size: string;
  kept: string;
  dropped: string;
}
export interface MissingItemReport {
  category: string;
  menu_item: string;
  sizes: string[];
}
export interface MissingSizesReport {
  category: string;
  menu_item: string;
  missing: string[];
  have: string[];
}
/** An entry imported as a draft because Petpooja left something out of it. */
export interface DraftReport {
  /** The menu item's name, or "Group › Option" for an add-on. */
  name: string;
  category: string;
  /** Sizes (menu items) or "Item, Size" (add-ons) that lost a line; "(all sizes)" for no size. Names only. */
  where: string[];
  incomplete: string;
}
export interface KeptEntryReport {
  name: string;
  status: string;
  source: string;
}
export interface UnitConflictReport {
  material: string;
  /** The unit used (the most common). */
  used: string;
  others: { unit: string; count: number; items: string[] }[];
}
export interface UnitMergeErrorReport {
  stock_item: string;
  kept: string;
  materials: { material: string; unit: string }[];
}
export interface DroppedLineReport {
  /** The Petpooja row's item name (never a quantity). */
  item: string;
  material: string;
  reason: string;
}
export interface MergeReport {
  stock_item: string;
  materials: string[];
}
export interface AddonScopeReport {
  group: string;
  option: string;
  scopes: number;
}

export interface ImportReport {
  counts: {
    csvRows: number;
    itemRows: number;
    addonRows: number;
    menuItems: number;
    recipesImported: number;
    /** Of those imported, how many are drafts (a line was lost). */
    recipesDraft: number;
    recipesKeptOwnerOrPos: number;
    recipesKeptOther: number;
    recipesMissing: number;
    itemsWithMissingSizes: number;
    addonOptions: number;
    addonsImported: number;
    addonsDraft: number;
    addonsKeptOwnerOrPos: number;
    addonsKeptOther: number;
    addonsMissing: number;
    addonScopes: number;
    stockItems: number;
    stockItemsImported: number;
    stockItemsKept: number;
    materialsNeedingMapping: number;
    unitConflicts: number;
    droppedLines: number;
    merges: number;
  };
  matchedItems: MatchedItemReport[];
  /** Distinct Petpooja names an alias says are not on the menu. */
  ignoredByAlias: string[];
  unmatchedItems: UnmatchedItemReport[];
  sizeNotLive: SizeNotLiveReport[];
  /** Matched Petpooja items that had no usable line. */
  matchedButEmpty: string[];
  duplicates: DuplicateReport[];
  /** STILL MISSING: live items with no recipe at all, in snapshot order. */
  missingItems: MissingItemReport[];
  /** STILL MISSING: matched items that lack a recipe for some live sizes. */
  missingSizes: MissingSizesReport[];
  keptItems: KeptEntryReport[];
  /** Menu items imported as drafts: a line was lost to a blank quantity, material or unit. */
  draftItems: DraftReport[];
  /** Existing entries whose item / add-on is no longer in the snapshot: dropped. */
  droppedEntries: { kind: 'recipe' | 'add-on'; name: string }[];
  /** Existing recipe files this import does not write but that still hold entries. */
  staleRecipeFiles: string[];
  invalidItemAliases: { name: string; target: string }[];
  addons: {
    matched: number;
    /** Add-on rows under a matched item that match no snapshot option. */
    unmatched: { key: string; rows: number }[];
    ignoredByAlias: { key: string; rows: number }[];
    invalidAliases: { key: string; target: string }[];
    withScopes: AddonScopeReport[];
    emptyIgnored: number;
    duplicateRows: number;
    /** Add-on rows whose item row is not a matched menu item. */
    parentNotMatchedRows: number;
    /** Add-on rows on an item that does not offer the option's group (they could never apply): left out. */
    notOffered: { menu_item: string; group: string; rows: number }[];
    /** Add-on rows whose ID prefix names no Item row. */
    orphanRows: number;
    /** Add-on rows whose name did not parse. */
    unparsedRows: number;
    kept: KeptEntryReport[];
    /** Options imported as drafts, like `draftItems`. */
    draft: DraftReport[];
    missing: { group: string; option: string }[];
  };
  unitConflicts: UnitConflictReport[];
  unitMergeErrors: UnitMergeErrorReport[];
  droppedLines: DroppedLineReport[];
  /** Petpooja materials whose stock item still has no category. */
  materialsNeedingMapping: string[];
  merges: MergeReport[];
}

export interface ImportResult {
  stockItems: { items: ImportedStockItem[] };
  /** Only files that have entries, in the contract's order. */
  recipeFiles: { path: string; file: RecipeFile }[];
  addonRecipes: { options: AddonOptionEntry[] };
  /** The input map plus a placeholder for every material it had no entry for, sorted by key. */
  materials: MaterialsMap;
  report: ImportReport;
}

// ── The category -> file table (contract) ───────────────────────────────────

const FILE_TABLE: { path: string; categories: string[] }[] = [
  { path: 'recipes/hot.json', categories: ['Coffee', 'Hot Non-Coffee'] },
  { path: 'recipes/iced.json', categories: ['Iced Coffee', 'Iced Non-Coffee', 'Cold Brews', 'Monthly Drops'] },
  { path: 'recipes/creme.json', categories: ['Creme Coffee', 'Creme Non-Coffee', 'Sundae'] },
  { path: 'recipes/waffles.json', categories: ['Stick Waffles', 'Stuffed Waffles', 'Waffle Chips'] },
  { path: 'recipes/bakery-eatery.json', categories: ['Cup Cakes', 'Cheesecakes', 'Eatery', 'In-store'] },
];
const OTHER_FILE = 'recipes/other.json';

// ── Small helpers ───────────────────────────────────────────────────────────

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpCi(a: string, b: string): number {
  return cmp(a.toLowerCase(), b.toLowerCase()) || cmp(a, b);
}

function lc(s: string): string {
  return s.trim().toLowerCase();
}

function has(obj: object | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function isOwnerOrPos(source: unknown): boolean {
  return source === 'owner' || source === 'pos';
}

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** RFC-4180: quoted cells, "" escapes, CRLF or LF, embedded newlines; a leading BOM is skipped. */
export function parseCsvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** "0x31…" (hex-encoded ASCII) -> the text; anything else comes back unchanged. */
export function decodeHexId(raw: string): string {
  const m = /^0x((?:[0-9a-f]{2})+)$/i.exec(raw.trim());
  if (!m) return raw.trim();
  let out = '';
  for (let i = 0; i < m[1].length; i += 2) out += String.fromCharCode(parseInt(m[1].slice(i, i + 2), 16));
  return out;
}

/** Parses the Item_Addon_Recipe.csv text into rows. Throws when it is not that export. */
export function parsePetpoojaRecipeCsv(text: string): PetpoojaRecipeRow[] {
  const records = parseCsvRecords(text);
  if (records.length === 0 || records[0][0]?.trim().toLowerCase() !== 'itemid') {
    throw new Error('petpooja: this is not an Item Addon Recipe export (the first column should be ItemID)');
  }
  const rows: PetpoojaRecipeRow[] = [];
  records.slice(1).forEach((cells, index) => {
    const rawId = (cells[0] ?? '').trim();
    const name = (cells[1] ?? '').trim();
    if (!rawId && !name) return;
    const materials: PetpoojaMaterialCell[] = [];
    for (let i = 3; i < cells.length; i += 3) {
      const triple = { material: (cells[i] ?? '').trim(), qty: (cells[i + 1] ?? '').trim(), unit: (cells[i + 2] ?? '').trim() };
      if (triple.material || triple.qty || triple.unit) materials.push(triple);
    }
    rows.push({ line: index + 2, rawId, id: decodeHexId(rawId), name, type: (cells[2] ?? '').trim(), materials });
  });
  return rows;
}

// ── Names ───────────────────────────────────────────────────────────────────

/** `[n)` is a typo for the ` [n]` marker. */
function fixMarkerTypo(s: string): string {
  return s.replace(/\[n\)/gi, '[n]');
}

/** Drops the ` [n]` marker wherever it is, and tidies whitespace. */
function stripMarker(s: string): string {
  return s.replace(/\s*\[n\]/gi, '').replace(/\s+/g, ' ').trim();
}

function tidy(s: string): string {
  return fixMarkerTypo(s).replace(/\s+/g, ' ').trim();
}

/** The last balanced "(…)" group of `s`, or null when it does not end with one. */
function lastGroup(s: string): { rest: string; inside: string } | null {
  if (!s.endsWith(')')) return null;
  const r = extractTrailingParens(s);
  return r.rest === s ? null : { rest: r.rest, inside: r.inside.trim() };
}

export interface ParsedItemName {
  /** The name without ` [n]`, whole (a trailing parenthesis stays in it). */
  full: string;
  /** When the name ends with a parenthesis: the name without it, and its text. */
  withoutSuffix?: string;
  suffix?: string;
}

/** `Name [n] (Size)` / `Name (Size)` / `Name [n]` / `Name`. Whether the parenthesis is
 * a size depends on the item it matches, so both readings are kept. */
export function parseItemName(raw: string): ParsedItemName {
  const s = tidy(raw);
  const full = stripMarker(s);
  const g = lastGroup(s);
  if (!g) return { full };
  return { full, withoutSuffix: stripMarker(g.rest), suffix: g.inside };
}

export interface ParsedAddonName {
  option: string;
  group: string;
}

/**
 * `<Option> (<Parent item incl. [n]>) [(<Size>)] (<Group>)`, read from the end.
 * `parentName` is the parent Item row's name without its size; `parentSize` its
 * size text ('' when the row has none). The option itself may contain
 * parentheses. Returns null when the name does not have that shape.
 */
export function parseAddonName(raw: string, parentName: string, parentSize: string): ParsedAddonName | null {
  const s = tidy(raw);
  const groupPart = lastGroup(s);
  if (!groupPart || !groupPart.inside) return null;
  let rest = groupPart.rest;

  if (parentSize) {
    const sizePart = lastGroup(rest);
    if (sizePart && lc(sizePart.inside) === lc(parentSize)) rest = sizePart.rest;
  }

  const parent = tidy(parentName);
  const wanted = `(${parent})`.toLowerCase();
  if (parent && rest.toLowerCase().endsWith(wanted) && rest.length > wanted.length) {
    rest = rest.slice(0, rest.length - wanted.length);
  } else {
    const parentPart = lastGroup(rest);
    if (!parentPart) return null;
    rest = parentPart.rest;
  }
  const option = rest.trim();
  return option ? { option, group: groupPart.inside } : null;
}

// ── Units and quantities ────────────────────────────────────────────────────

const UNIT_WORDS: Record<string, InventoryUnit> = {
  g: 'g',
  gm: 'g',
  gms: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  kgs: 'kg',
  ml: 'ml',
  l: 'l',
  lt: 'l',
  ltr: 'l',
  litre: 'l',
  litres: 'l',
  liter: 'l',
  liters: 'l',
  pcs: 'pcs',
  pc: 'pcs',
  piece: 'pcs',
  pieces: 'pcs',
  nos: 'pcs',
  pack: 'pack',
  packs: 'pack',
};

/** '' when blank, null when it is not a unit we know. */
export function mapPetpoojaUnit(raw: string): InventoryUnit | '' | null {
  const u = raw.trim().toLowerCase();
  if (!u) return '';
  return UNIT_WORDS[u] ?? null;
}

const QTY_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

interface Cell {
  material: string;
  qty: number | null;
  qtyProblem: string;
  unit: InventoryUnit | '' | null;
  unitText: string;
}

function readCell(c: PetpoojaMaterialCell): Cell {
  let qty: number | null = null;
  let qtyProblem = '';
  if (!c.qty) qtyProblem = 'blank quantity';
  else if (!QTY_RE.test(c.qty)) qtyProblem = 'non-numeric quantity';
  else {
    const n = Number(c.qty);
    if (!(roundQty(n) > 0)) qtyProblem = 'quantity is zero';
    else qty = n;
  }
  return { material: c.material, qty, qtyProblem, unit: mapPetpoojaUnit(c.unit), unitText: c.unit };
}

// ── Resolution ──────────────────────────────────────────────────────────────

type ItemMatch =
  | { kind: 'item'; item: SnapshotItem; via: 'alias' | 'auto' }
  | { kind: 'ignored' }
  | { kind: 'badAlias'; target: string }
  | { kind: 'none' };

type ItemResolution =
  | { kind: 'matched'; row: PetpoojaRecipeRow; item: SnapshotItem; size: string; sizeText: string; parentText: string; via: 'alias' | 'auto' }
  | { kind: 'ignored'; row: PetpoojaRecipeRow; name: string }
  | { kind: 'unmatched'; row: PetpoojaRecipeRow; name: string; suffix: string }
  | { kind: 'sizeNotLive'; row: PetpoojaRecipeRow; item: SnapshotItem; sizeText: string };

interface StockLine {
  /** lower-cased stock item name. */
  stock: string;
  qty: number;
  /** The Petpooja materials that fed it. */
  materials: string[];
}

type LostKind = 'quantity' | 'unit' | 'material';

/** A line Petpooja had but the import could not use. `where` says which size (or
 * which item and size, for an add-on) it was on. */
interface LostLine {
  material: string;
  kind: LostKind;
  where: string;
}

/** "Incomplete in Petpooja — no quantity for: Milk (Large), Ice (Large)": names only, never a quantity. */
function incompleteNote(lost: LostLine[]): string {
  const by: Record<LostKind, string[]> = { quantity: [], unit: [], material: [] };
  for (const l of lost) {
    const label = l.kind === 'material' ? 'a line with no material name' : l.material;
    pushUnique(by[l.kind], l.where ? `${label} (${l.where})` : label);
  }
  const parts: string[] = [];
  if (by.quantity.length > 0) parts.push(`no quantity for: ${by.quantity.join(', ')}`);
  if (by.unit.length > 0) parts.push(`no known unit for: ${by.unit.join(', ')}`);
  if (by.material.length > 0) parts.push(by.material.join(', '));
  return `Incomplete in Petpooja — ${parts.join('; ')}`;
}

function lostWhere(lost: LostLine[]): string[] {
  const where: string[] = [];
  for (const l of lost) pushUnique(where, l.where || '(all sizes)');
  return where;
}

interface Gathered {
  lines: StockLine[];
  names: string[];
}

function linesKey(lines: { stock: string; qty: number }[]): string {
  return JSON.stringify(
    lines
      .map((l) => [l.stock, l.qty] as const)
      .sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]),
  );
}

function sumInto(target: StockLine[], stock: string, qty: number, material: string): void {
  const line = target.find((l) => l.stock === stock);
  if (line) {
    line.qty += qty;
    pushUnique(line.materials, material);
  } else {
    target.push({ stock, qty, materials: [material] });
  }
}

/**
 * Turns the export into the book's files plus a report. `materials` and
 * `existing` are what is on disk already; the returned `materials` is the input
 * plus placeholders for materials that were not mapped yet.
 */
export function importPetpoojaRecipes(input: ImportInput): ImportResult {
  const { rows, snapshot } = input;
  const aliasItems = input.aliases?.items ?? {};
  const aliasAddons = input.aliases?.addons ?? {};
  const materialsIn: MaterialsMap = input.materials ?? {};
  const existingStock = input.existing?.stockItems?.items ?? [];
  const existingFiles = input.existing?.recipeFiles ?? [];
  const existingOptions = input.existing?.addonRecipes?.options ?? [];

  const items = snapshot.items;
  const itemById = new Map(items.map((i) => [i.id, i]));
  const itemByLcName = new Map<string, SnapshotItem>();
  for (const i of items) if (!itemByLcName.has(lc(i.name))) itemByLcName.set(lc(i.name), i);
  const menuForMatcher: MenuSnapshotItem[] = items.map((i) => ({ id: i.id, name: i.name, variants: i.sizes.map((s) => ({ label: s.label })) }));

  const report: ImportReport = {
    counts: {
      csvRows: rows.length,
      itemRows: 0,
      addonRows: 0,
      menuItems: items.length,
      recipesImported: 0,
      recipesDraft: 0,
      recipesKeptOwnerOrPos: 0,
      recipesKeptOther: 0,
      recipesMissing: 0,
      itemsWithMissingSizes: 0,
      addonOptions: snapshot.addon_options.length,
      addonsImported: 0,
      addonsDraft: 0,
      addonsKeptOwnerOrPos: 0,
      addonsKeptOther: 0,
      addonsMissing: 0,
      addonScopes: 0,
      stockItems: 0,
      stockItemsImported: 0,
      stockItemsKept: 0,
      materialsNeedingMapping: 0,
      unitConflicts: 0,
      droppedLines: 0,
      merges: 0,
    },
    matchedItems: [],
    ignoredByAlias: [],
    unmatchedItems: [],
    sizeNotLive: [],
    matchedButEmpty: [],
    duplicates: [],
    missingItems: [],
    missingSizes: [],
    keptItems: [],
    draftItems: [],
    droppedEntries: [],
    staleRecipeFiles: [],
    invalidItemAliases: [],
    addons: {
      matched: 0,
      unmatched: [],
      ignoredByAlias: [],
      invalidAliases: [],
      withScopes: [],
      emptyIgnored: 0,
      duplicateRows: 0,
      parentNotMatchedRows: 0,
      notOffered: [],
      orphanRows: 0,
      unparsedRows: 0,
      kept: [],
      draft: [],
      missing: [],
    },
    unitConflicts: [],
    unitMergeErrors: [],
    droppedLines: [],
    materialsNeedingMapping: [],
    merges: [],
  };

  // ── 1. Item rows -> menu item + size ──────────────────────────────────────
  const aliasItemNorm = new Map<string, string | null>();
  for (const key of Object.keys(aliasItems)) {
    const k = normalize(key);
    if (!aliasItemNorm.has(k)) aliasItemNorm.set(k, aliasItems[key]);
  }
  const badAliasSeen = new Set<string>();

  function matchName(name: string): ItemMatch {
    if (!name) return { kind: 'none' };
    let target: string | null | undefined;
    if (has(aliasItems, name)) target = aliasItems[name];
    else if (aliasItemNorm.has(normalize(name))) target = aliasItemNorm.get(normalize(name));
    if (target === null) return { kind: 'ignored' };
    if (typeof target === 'string') {
      const item = itemById.get(target) ?? itemByLcName.get(lc(target));
      if (item) return { kind: 'item', item, via: 'alias' };
      if (!badAliasSeen.has(name)) {
        badAliasSeen.add(name);
        report.invalidItemAliases.push({ name, target });
      }
      return { kind: 'badAlias', target };
    }
    const m = matchMenuItem(name, '', menuForMatcher);
    const item = m.menu_item_id ? itemById.get(m.menu_item_id) : undefined;
    return item ? { kind: 'item', item, via: 'auto' } : { kind: 'none' };
  }

  function liveSize(item: SnapshotItem, text: string): string | undefined {
    const wanted = lc(text);
    return wanted ? item.sizes.find((s) => lc(s.label) === wanted)?.label : undefined;
  }

  function resolveItem(row: PetpoojaRecipeRow): ItemResolution {
    const parsed = parseItemName(row.name);
    let missedSize: { item: SnapshotItem; text: string } | null = null;
    if (parsed.withoutSuffix !== undefined && parsed.suffix !== undefined) {
      const m = matchName(parsed.withoutSuffix);
      if (m.kind === 'ignored') return { kind: 'ignored', row, name: parsed.withoutSuffix };
      if (m.kind === 'item') {
        const size = liveSize(m.item, parsed.suffix);
        if (size !== undefined) {
          // How an add-on row spells its parent: the row's name without the size, [n] kept.
          const parentText = lastGroup(tidy(row.name))?.rest ?? tidy(row.name);
          return { kind: 'matched', row, item: m.item, size, sizeText: parsed.suffix, parentText, via: m.via };
        }
        missedSize = { item: m.item, text: parsed.suffix };
      }
    }
    // No size in the name, or the parenthesis is part of the name.
    const m = matchName(parsed.full);
    if (m.kind === 'ignored') return { kind: 'ignored', row, name: parsed.full };
    if (m.kind === 'item') return { kind: 'matched', row, item: m.item, size: '', sizeText: '', parentText: tidy(row.name), via: m.via };
    if (missedSize) return { kind: 'sizeNotLive', row, item: missedSize.item, sizeText: missedSize.text };
    return { kind: 'unmatched', row, name: parsed.withoutSuffix ?? parsed.full, suffix: parsed.suffix !== undefined ? `(${parsed.suffix})` : '' };
  }

  const itemRows = rows.filter((r) => lc(r.type) === 'item');
  const addonRows = rows.filter((r) => lc(r.type) === 'addon');
  report.counts.itemRows = itemRows.length;
  report.counts.addonRows = addonRows.length;

  const resolutionById = new Map<string, ItemResolution>();
  const resolutions: ItemResolution[] = [];
  for (const row of itemRows) {
    const res = resolveItem(row);
    resolutions.push(res);
    if (!resolutionById.has(row.id)) resolutionById.set(row.id, res);
  }

  // Non-matches, for the report.
  {
    const ignored = new Set<string>();
    const unmatched = new Map<string, { rows: number; suffixes: string[] }>();
    for (const res of resolutions) {
      if (res.kind === 'ignored') ignored.add(res.name);
      else if (res.kind === 'unmatched') {
        const u = unmatched.get(res.name) ?? { rows: 0, suffixes: [] };
        u.rows += 1;
        if (res.suffix) pushUnique(u.suffixes, res.suffix);
        unmatched.set(res.name, u);
      } else if (res.kind === 'sizeNotLive') {
        report.sizeNotLive.push({ petpooja: res.row.name, menu_item: res.item.name, size: res.sizeText, liveSizes: res.item.sizes.map((s) => s.label) });
      }
    }
    report.ignoredByAlias = [...ignored].sort(cmpCi);
    report.unmatchedItems = [...unmatched]
      .map(([name, u]) => ({ name, rows: u.rows, suffixes: u.suffixes.sort(cmpCi) }))
      .sort((a, b) => cmpCi(a.name, b.name));
    report.sizeNotLive.sort((a, b) => cmpCi(a.menu_item, b.menu_item) || cmpCi(a.size, b.size));
    report.invalidItemAliases.sort((a, b) => cmpCi(a.name, b.name));
  }

  // ── 2. Add-on rows -> parent + snapshot option ────────────────────────────
  const optionIndex = new Map<string, SnapshotAddonOption>();
  const indexOption = (group: string, option: string, o: SnapshotAddonOption) => {
    const key = `${normalize(group)}\u0000${normalize(option)}`;
    if (!optionIndex.has(key)) optionIndex.set(key, o);
  };
  for (const o of snapshot.addon_options) indexOption(o.group, o.option, o);
  for (const o of snapshot.addon_options) indexOption(o.group_label ?? '', o.option, o);
  const optionById = new Map(snapshot.addon_options.map((o) => [o.id, o]));
  const aliasAddonNorm = new Map<string, string | null>();
  for (const key of Object.keys(aliasAddons)) {
    const bar = key.indexOf('|');
    const k = bar < 0 ? normalize(key) : `${normalize(key.slice(0, bar))}\u0000${normalize(key.slice(bar + 1))}`;
    if (!aliasAddonNorm.has(k)) aliasAddonNorm.set(k, aliasAddons[key]);
  }

  interface AddonResolved {
    row: PetpoojaRecipeRow;
    parent: Extract<ItemResolution, { kind: 'matched' }>;
    option: SnapshotAddonOption;
    key: string;
  }
  const addonsResolved: AddonResolved[] = [];
  const addonUnmatched = new Map<string, number>();
  const addonIgnored = new Map<string, number>();
  const addonBadAlias = new Map<string, string>();
  const notOffered = new Map<string, { menu_item: string; group: string; rows: number }>();

  for (const row of addonRows) {
    const lastHash = row.id.lastIndexOf('#');
    const parentRes = lastHash > 0 && row.id.split('#').length >= 3 ? resolutionById.get(row.id.slice(0, lastHash)) : undefined;
    if (!parentRes) {
      report.addons.orphanRows += 1;
      continue;
    }
    if (parentRes.kind !== 'matched') {
      report.addons.parentNotMatchedRows += 1;
      continue;
    }
    const parsed = parseAddonName(row.name, parentRes.parentText, parentRes.sizeText);
    if (!parsed) {
      report.addons.unparsedRows += 1;
      continue;
    }
    const key = `${parsed.group}|${parsed.option}`;
    const nk = `${normalize(parsed.group)}\u0000${normalize(parsed.option)}`;
    let target: string | null | undefined;
    if (has(aliasAddons, key)) target = aliasAddons[key];
    else if (aliasAddonNorm.has(nk)) target = aliasAddonNorm.get(nk);
    let option: SnapshotAddonOption | undefined;
    if (target === null) {
      addonIgnored.set(key, (addonIgnored.get(key) ?? 0) + 1);
      continue;
    }
    if (typeof target === 'string') {
      option = optionById.get(target);
      if (!option) {
        addonBadAlias.set(key, target);
        addonUnmatched.set(key, (addonUnmatched.get(key) ?? 0) + 1);
        continue;
      }
    } else {
      option = optionIndex.get(nk);
    }
    if (!option) {
      addonUnmatched.set(key, (addonUnmatched.get(key) ?? 0) + 1);
      continue;
    }
    if (!parentRes.item.addon_groups.includes(option.group)) {
      const k = `${parentRes.item.id}\u0000${option.group}`;
      const n = notOffered.get(k) ?? { menu_item: parentRes.item.name, group: option.group, rows: 0 };
      n.rows += 1;
      notOffered.set(k, n);
      continue;
    }
    addonsResolved.push({ row, parent: parentRes, option, key });
  }
  report.addons.notOffered = [...notOffered.values()].sort((a, b) => cmpCi(a.menu_item, b.menu_item) || cmpCi(a.group, b.group));
  report.addons.unmatched = [...addonUnmatched].map(([key, n]) => ({ key, rows: n })).sort((a, b) => cmpCi(a.key, b.key));
  report.addons.ignoredByAlias = [...addonIgnored].map(([key, n]) => ({ key, rows: n })).sort((a, b) => cmpCi(a.key, b.key));
  report.addons.invalidAliases = [...addonBadAlias].map(([key, target]) => ({ key, target })).sort((a, b) => cmpCi(a.key, b.key));

  // ── 3. Units per material ─────────────────────────────────────────────────
  // Only rows that will be used count towards a material's unit; a blank unit
  // may also be filled in from anywhere in the export.
  const relevant: PetpoojaRecipeRow[] = [
    ...resolutions.filter((r) => r.kind === 'matched').map((r) => r.row),
    ...addonsResolved.map((a) => a.row),
  ];

  interface UnitTally {
    count: number;
    first: number;
    items: string[];
  }
  function tally(source: PetpoojaRecipeRow[]): Map<string, Map<InventoryUnit, UnitTally>> {
    const out = new Map<string, Map<InventoryUnit, UnitTally>>();
    let order = 0;
    for (const row of source) {
      for (const raw of row.materials) {
        const c = readCell(raw);
        if (!c.material || c.qty === null || !c.unit) continue;
        const perMaterial = out.get(c.material) ?? new Map<InventoryUnit, UnitTally>();
        out.set(c.material, perMaterial);
        const t = perMaterial.get(c.unit) ?? { count: 0, first: order++, items: [] };
        t.count += 1;
        pushUnique(t.items, row.name);
        perMaterial.set(c.unit, t);
      }
    }
    return out;
  }
  function majority(perMaterial: Map<InventoryUnit, UnitTally>): InventoryUnit {
    let best: InventoryUnit | null = null;
    for (const [unit, t] of perMaterial) {
      const b = best ? perMaterial.get(best)! : null;
      if (!b || t.count > b.count || (t.count === b.count && t.first < b.first)) best = unit;
    }
    return best as InventoryUnit;
  }
  const relevantTally = tally(relevant);
  const globalTally = tally(rows);
  const materialUnit = new Map<string, InventoryUnit>();
  for (const [material, perMaterial] of relevantTally) {
    const used = majority(perMaterial);
    materialUnit.set(material, used);
    if (perMaterial.size > 1) {
      report.unitConflicts.push({
        material,
        used,
        others: [...perMaterial]
          .filter(([unit]) => unit !== used)
          .map(([unit, t]) => ({ unit, count: t.count, items: [...t.items].sort(cmpCi) }))
          .sort((a, b) => cmp(a.unit, b.unit)),
      });
    }
  }
  report.unitConflicts.sort((a, b) => cmpCi(a.material, b.material));
  function unitFor(material: string): InventoryUnit | undefined {
    const known = materialUnit.get(material);
    if (known) return known;
    const global = globalTally.get(material);
    return global ? majority(global) : undefined;
  }

  // ── 4. Materials -> stock items; a row's lines ────────────────────────────
  const existingStockByKey = new Map<string, StockItemEntry>();
  for (const s of existingStock) if (s && typeof s.name === 'string' && !existingStockByKey.has(lc(s.name))) existingStockByKey.set(lc(s.name), s);
  const materialKeyByLc = new Map<string, string>();
  for (const key of Object.keys(materialsIn)) if (!materialKeyByLc.has(lc(key))) materialKeyByLc.set(lc(key), key);

  function mappingFor(material: string): MaterialMapping | undefined {
    const key = has(materialsIn, material) ? material : materialKeyByLc.get(lc(material));
    return key === undefined ? undefined : materialsIn[key];
  }
  function stockNameFor(material: string): string {
    return (mappingFor(material)?.name ?? '').trim() || material;
  }

  const materialsUsed: string[] = []; // first appearance in written lines
  const droppedLineKeys = new Set<string>();

  /** The usable lines of a row, and the lines it lost (`where` is filled in by the caller). */
  function buildLines(row: PetpoojaRecipeRow): { lines: StockLine[]; lost: { material: string; kind: LostKind }[] } {
    const lines: StockLine[] = [];
    const lost: { material: string; kind: LostKind }[] = [];
    for (const raw of row.materials) {
      const c = readCell(raw);
      const drop = (reason: string, kind: LostKind) => {
        lost.push({ material: c.material, kind });
        const k = `${row.name}\u0000${c.material}\u0000${reason}`;
        if (droppedLineKeys.has(k)) return;
        droppedLineKeys.add(k);
        report.droppedLines.push({ item: row.name, material: c.material || '(blank material name)', reason });
      };
      if (!c.material) {
        drop('blank material name', 'material');
        continue;
      }
      if (c.qty === null) {
        drop(c.qtyProblem, 'quantity');
        continue;
      }
      if (c.unit === null) {
        drop(`unknown unit "${c.unitText}"`, 'unit');
        continue;
      }
      if (c.unit === '' && !unitFor(c.material)) {
        drop('blank unit, and no unit for this material anywhere else', 'unit');
        continue;
      }
      sumInto(lines, lc(stockNameFor(c.material)), c.qty, c.material);
    }
    for (const l of lines) l.qty = roundQty(l.qty);
    return { lines: lines.filter((l) => l.qty > 0), lost };
  }

  // ── 5. Menu-item recipes ──────────────────────────────────────────────────
  interface ItemRecipes {
    item: SnapshotItem;
    bySize: Map<string, Gathered>; // '' = one recipe for every size
    via: 'alias' | 'auto';
  }
  const recipesByItem = new Map<string, ItemRecipes>();
  const lostByItem = new Map<string, LostLine[]>();
  for (const res of resolutions) {
    if (res.kind !== 'matched') continue;
    const { lines, lost } = buildLines(res.row);
    const noteLost = () => {
      if (lost.length === 0) return;
      const list = lostByItem.get(res.item.id) ?? [];
      lostByItem.set(res.item.id, list);
      for (const l of lost) list.push({ ...l, where: res.size });
    };
    if (lines.length === 0) {
      report.matchedButEmpty.push(res.row.name);
      noteLost();
      continue;
    }
    const entry = recipesByItem.get(res.item.id) ?? { item: res.item, bySize: new Map<string, Gathered>(), via: res.via };
    recipesByItem.set(res.item.id, entry);
    const first = entry.bySize.get(res.size);
    if (first) {
      report.duplicates.push({ menu_item: res.item.name, size: res.size || '(all sizes)', kept: first.names[0], dropped: res.row.name });
      continue;
    }
    entry.bySize.set(res.size, { lines, names: [res.row.name] });
    noteLost();
  }
  report.matchedButEmpty.sort(cmpCi);
  report.duplicates.sort((a, b) => cmpCi(a.menu_item, b.menu_item) || cmpCi(a.size, b.size));

  interface Finished {
    entry: Omit<RecipeItemEntry, 'base' | 'sizes'> & { base: StockLine[]; sizes: Record<string, StockLine[]> };
    missing: string[];
    have: string[];
    covers: string[];
    petpooja: string[];
    appliesToAllSizes: boolean;
    lost: LostLine[];
  }
  const finishedByItem = new Map<string, Finished>();
  for (const { item, bySize } of recipesByItem.values()) {
    const live = item.sizes.map((s) => s.label);
    const base = bySize.get('');
    const effective = (label: string) => bySize.get(label) ?? base;
    const covered = live.filter((l) => effective(l));
    const missing = live.filter((l) => !effective(l));
    const names: string[] = [];
    for (const g of bySize.values()) for (const n of g.names) pushUnique(names, n);
    const keys = new Set(covered.map((l) => linesKey(effective(l)!.lines)));
    let baseLines: StockLine[] = [];
    const sizes: Record<string, StockLine[]> = {};
    let covers: string[];
    if (covered.length === live.length && keys.size === 1) {
      baseLines = effective(live[0])!.lines;
      covers = live.length > 1 ? ['(all sizes)'] : [live[0]];
    } else {
      for (const l of covered) sizes[l] = effective(l)!.lines;
      covers = covered;
    }
    // A recipe that lost a line is a draft until Petpooja's data is fixed.
    const lost = lostByItem.get(item.id) ?? [];
    finishedByItem.set(item.id, {
      entry: {
        menu_item_id: item.id,
        menu_item: item.name,
        status: lost.length > 0 ? 'draft' : 'confirmed',
        source: 'petpooja',
        notes: lost.length > 0 ? `Petpooja: ${names.join('; ')}. ${incompleteNote(lost)}` : `Petpooja: ${names.join('; ')}`,
        base: baseLines,
        sizes,
      },
      missing,
      have: covered,
      covers,
      petpooja: names,
      appliesToAllSizes: !!base && live.length > 1,
      lost,
    });
  }

  // ── 6. Add-on options ─────────────────────────────────────────────────────
  interface OptionEntry {
    item: SnapshotItem;
    size: string;
    lines: StockLine[];
    key: string;
  }
  const entriesByOption = new Map<string, OptionEntry[]>();
  const originalNames = new Map<string, string[]>();
  const seenAddon = new Set<string>();
  const lostByOption = new Map<string, LostLine[]>();
  for (const a of addonsResolved) {
    const { lines, lost } = buildLines(a.row);
    const noteLost = () => {
      if (lost.length === 0) return;
      const list = lostByOption.get(a.option.id) ?? [];
      lostByOption.set(a.option.id, list);
      const where = a.parent.size ? `${a.parent.item.name}, ${a.parent.size}` : a.parent.item.name;
      for (const l of lost) list.push({ ...l, where });
    };
    if (lines.length === 0) {
      report.addons.emptyIgnored += 1;
      noteLost();
      continue;
    }
    const dupKey = `${a.option.id}\u0000${a.parent.item.id}\u0000${a.parent.size}`;
    if (seenAddon.has(dupKey)) {
      report.addons.duplicateRows += 1;
      continue;
    }
    seenAddon.add(dupKey);
    noteLost();
    const list = entriesByOption.get(a.option.id) ?? [];
    entriesByOption.set(a.option.id, list);
    list.push({ item: a.parent.item, size: a.parent.size, lines, key: linesKey(lines) });
    const names = originalNames.get(a.option.id) ?? [];
    originalNames.set(a.option.id, names);
    pushUnique(names, a.key);
  }

  interface FinishedOption {
    lines: StockLine[];
    scopes: { item: SnapshotItem; size: string; lines: StockLine[] }[];
    petpooja: string[];
    lost: LostLine[];
  }
  const finishedOptions = new Map<string, FinishedOption>();
  const itemOrder = new Map(items.map((i, index) => [i.id, index]));
  for (const [optionId, entries] of entriesByOption) {
    // General = the most common line-set; a tie goes to the one on more menu
    // items, then to the smaller JSON.
    const stats = new Map<string, { count: number; items: Set<string>; lines: StockLine[] }>();
    for (const e of entries) {
      const s = stats.get(e.key) ?? { count: 0, items: new Set<string>(), lines: e.lines };
      s.count += 1;
      s.items.add(e.item.id);
      stats.set(e.key, s);
    }
    const generalKey = [...stats.keys()].sort((a, b) => {
      const sa = stats.get(a)!;
      const sb = stats.get(b)!;
      return sb.count - sa.count || sb.items.size - sa.items.size || cmp(a, b);
    })[0];

    const byItem = new Map<string, OptionEntry[]>();
    for (const e of entries) byItem.set(e.item.id, [...(byItem.get(e.item.id) ?? []), e]);
    const scopes: FinishedOption['scopes'] = [];
    const orderedItems = [...byItem.keys()].sort((a, b) => (itemOrder.get(a) ?? 0) - (itemOrder.get(b) ?? 0));
    for (const itemId of orderedItems) {
      const list = byItem.get(itemId)!;
      const item = list[0].item;
      const live = item.sizes.map((s) => s.label);
      const own = new Map(list.map((e) => [e.size, e]));
      const effective = (label: string) => own.get(label) ?? own.get('');
      const covered = live.filter((l) => effective(l));
      const keys = new Set(covered.map((l) => effective(l)!.key));
      if (covered.length === live.length && keys.size === 1) {
        const e = effective(live[0])!;
        if (e.key !== generalKey) scopes.push({ item, size: '', lines: e.lines });
      } else {
        for (const l of covered) {
          const e = effective(l)!;
          if (e.key !== generalKey) scopes.push({ item, size: l, lines: e.lines });
        }
      }
    }
    finishedOptions.set(optionId, { lines: stats.get(generalKey)!.lines, scopes, petpooja: originalNames.get(optionId) ?? [], lost: lostByOption.get(optionId) ?? [] });
  }

  // ── 7. Merge with what is already in the book ─────────────────────────────
  const stockLinesUsed = new Set<string>(); // stock keys referenced by written lines
  const materialsOfStock = new Map<string, string[]>(); // stock key -> Petpooja materials (written)
  const noteLines = (lines: StockLine[]) => {
    for (const l of lines) {
      stockLinesUsed.add(l.stock);
      const fed = materialsOfStock.get(l.stock) ?? [];
      materialsOfStock.set(l.stock, fed);
      for (const m of l.materials) {
        pushUnique(materialsUsed, m);
        pushUnique(fed, m);
      }
    }
  };

  // Canonical spelling of each stock item: the existing item's, else the mapped name.
  const canonicalName = new Map<string, string>();
  function canonical(stock: string, fallbackMaterial: string): string {
    const known = canonicalName.get(stock);
    if (known) return known;
    const name = existingStockByKey.get(stock)?.name.trim() || stockNameFor(fallbackMaterial);
    canonicalName.set(stock, name);
    return name;
  }
  const toLines = (lines: StockLine[]): RecipeLineEntry[] =>
    lines.map((l) => ({ ingredient: canonical(l.stock, l.materials[0]), qty: l.qty }));

  // Existing entries by id (the first wins, as in the checker).
  const existingRecipe = new Map<string, RecipeItemEntry>();
  const existingRecipePaths = new Map<string, string>();
  for (const { path, file } of existingFiles) {
    for (const entry of Array.isArray(file?.items) ? file.items : []) {
      if (entry && typeof entry.menu_item_id === 'string' && !existingRecipe.has(entry.menu_item_id)) {
        existingRecipe.set(entry.menu_item_id, entry);
        existingRecipePaths.set(entry.menu_item_id, path);
      }
    }
  }

  const fileItems = new Map<string, RecipeItemEntry[]>();
  const fileOf = (category: string): string => FILE_TABLE.find((f) => f.categories.includes(category))?.path ?? OTHER_FILE;
  for (const item of items) {
    const existing = existingRecipe.get(item.id);
    const finished = finishedByItem.get(item.id);
    let out: RecipeItemEntry | undefined;
    if (existing && isOwnerOrPos(existing.source)) {
      out = existing;
      report.counts.recipesKeptOwnerOrPos += 1;
      report.keptItems.push({ name: item.name, status: String(existing.status), source: String(existing.source) });
    } else if (finished) {
      out = { ...finished.entry, base: toLines(finished.entry.base), sizes: Object.fromEntries(Object.entries(finished.entry.sizes).map(([k, v]) => [k, toLines(v)])) };
      noteLines(finished.entry.base);
      for (const lines of Object.values(finished.entry.sizes)) noteLines(lines);
      report.counts.recipesImported += 1;
      if (finished.lost.length > 0) {
        report.counts.recipesDraft += 1;
        report.draftItems.push({ name: item.name, category: item.category, where: lostWhere(finished.lost), incomplete: incompleteNote(finished.lost) });
      }
      report.matchedItems.push({
        menu_item: item.name,
        category: item.category,
        petpooja: finished.petpooja,
        via: recipesByItem.get(item.id)!.via,
        covers: finished.covers,
        appliesToAllSizes: finished.appliesToAllSizes,
      });
      if (finished.missing.length > 0) {
        report.counts.itemsWithMissingSizes += 1;
        report.missingSizes.push({ category: item.category, menu_item: item.name, missing: finished.missing, have: finished.have });
      }
    } else if (existing) {
      out = existing;
      report.counts.recipesKeptOther += 1;
      report.keptItems.push({ name: item.name, status: String(existing.status), source: String(existing.source) });
    } else {
      report.counts.recipesMissing += 1;
      report.missingItems.push({ category: item.category, menu_item: item.name, sizes: item.sizes.map((s) => s.label) });
    }
    if (out) {
      const path = fileOf(item.category);
      fileItems.set(path, [...(fileItems.get(path) ?? []), out]);
    }
  }
  for (const [id, entry] of existingRecipe) {
    if (!itemById.has(id)) report.droppedEntries.push({ kind: 'recipe', name: String(entry.menu_item ?? id) });
  }

  const snapshotCategories: string[] = [];
  for (const i of items) pushUnique(snapshotCategories, i.category);
  const tableCategories = new Set(FILE_TABLE.flatMap((f) => f.categories));
  const recipeFiles: { path: string; file: RecipeFile }[] = [];
  for (const f of FILE_TABLE) {
    const entries = fileItems.get(f.path);
    if (entries && entries.length > 0) {
      recipeFiles.push({ path: f.path, file: { categories: f.categories.filter((c) => snapshotCategories.includes(c)), items: entries } });
    }
  }
  const otherEntries = fileItems.get(OTHER_FILE);
  if (otherEntries && otherEntries.length > 0) {
    recipeFiles.push({ path: OTHER_FILE, file: { categories: snapshotCategories.filter((c) => !tableCategories.has(c)), items: otherEntries } });
  }
  const writtenPaths = new Set(recipeFiles.map((f) => f.path));
  for (const { path, file } of existingFiles) {
    if (!writtenPaths.has(path) && Array.isArray(file?.items) && file.items.length > 0) report.staleRecipeFiles.push(path);
  }
  report.staleRecipeFiles.sort(cmp);

  // Add-on options.
  const existingOption = new Map<string, AddonOptionEntry>();
  for (const o of existingOptions) if (o && typeof o.addon_option_id === 'string' && !existingOption.has(o.addon_option_id)) existingOption.set(o.addon_option_id, o);
  const options: AddonOptionEntry[] = [];
  for (const o of snapshot.addon_options) {
    const existing = existingOption.get(o.id);
    const finished = finishedOptions.get(o.id);
    if (existing && isOwnerOrPos(existing.source)) {
      options.push(existing);
      report.counts.addonsKeptOwnerOrPos += 1;
      report.addons.kept.push({ name: `${o.group} › ${o.option}`, status: String(existing.status), source: String(existing.source) });
    } else if (finished) {
      noteLines(finished.lines);
      for (const s of finished.scopes) noteLines(s.lines);
      const entry: AddonOptionEntry = {
        addon_option_id: o.id,
        group: o.group,
        option: o.option,
        status: finished.lost.length > 0 ? 'draft' : 'confirmed',
        source: 'petpooja',
        notes: `Petpooja: ${finished.petpooja.join('; ')}${finished.lost.length > 0 ? `. ${incompleteNote(finished.lost)}` : ''}`,
        lines: toLines(finished.lines),
      };
      if (finished.lost.length > 0) {
        report.counts.addonsDraft += 1;
        report.addons.draft.push({ name: `${o.group} › ${o.option}`, category: o.group, where: lostWhere(finished.lost), incomplete: incompleteNote(finished.lost) });
      }
      if (finished.scopes.length > 0) {
        entry.scopes = finished.scopes.map((s) => ({ menu_item_id: s.item.id, menu_item: s.item.name, size_label: s.size, lines: toLines(s.lines) }));
        report.addons.withScopes.push({ group: o.group, option: o.option, scopes: entry.scopes.length });
        report.counts.addonScopes += entry.scopes.length;
      }
      options.push(entry);
      report.counts.addonsImported += 1;
      report.addons.matched += 1;
    } else if (existing) {
      options.push(existing);
      report.counts.addonsKeptOther += 1;
      report.addons.kept.push({ name: `${o.group} › ${o.option}`, status: String(existing.status), source: String(existing.source) });
    } else {
      report.counts.addonsMissing += 1;
      report.addons.missing.push({ group: o.group, option: o.option });
    }
  }
  for (const [id, entry] of existingOption) {
    if (!optionById.has(id)) report.droppedEntries.push({ kind: 'add-on', name: `${entry.group ?? ''} › ${entry.option ?? id}` });
  }

  // ── 8. Materials, stock items ─────────────────────────────────────────────
  const materialsOut: MaterialsMap = { ...materialsIn };
  const needingMapping: string[] = [];
  for (const material of materialsUsed) {
    let mapping = mappingFor(material);
    if (!mapping) {
      mapping = { name: material, category: '', tracks_expiry: false };
      materialsOut[material] = mapping;
    }
    if (!mapping.category) needingMapping.push(material);
  }
  report.materialsNeedingMapping = needingMapping.sort(cmpCi);
  report.counts.materialsNeedingMapping = needingMapping.length;
  const sortedMaterials: MaterialsMap = {};
  for (const key of Object.keys(materialsOut).sort(cmp)) sortedMaterials[key] = materialsOut[key];

  interface Produced {
    key: string;
    name: string;
    unit: InventoryUnit;
    category: string;
    tracks_expiry: boolean;
  }
  const produced = new Map<string, Produced>();
  const unitsOfStock = new Map<string, { material: string; unit: InventoryUnit }[]>();
  for (const material of materialsUsed) {
    const key = lc(stockNameFor(material));
    if (!stockLinesUsed.has(key)) continue;
    const unit = unitFor(material);
    if (!unit) continue;
    unitsOfStock.set(key, [...(unitsOfStock.get(key) ?? []), { material, unit }]);
    if (produced.has(key)) continue;
    const mapping = mappingFor(material) ?? { name: material, category: '', tracks_expiry: false };
    const prior = existingStockByKey.get(key);
    // A placeholder must not blank a category the book already has.
    const keepExisting = !mapping.category && !!prior?.category;
    produced.set(key, {
      key,
      name: canonical(key, material),
      unit,
      category: keepExisting ? prior!.category : mapping.category ?? '',
      tracks_expiry: keepExisting ? prior!.tracks_expiry === true : mapping.tracks_expiry === true,
    });
  }
  for (const [key, list] of unitsOfStock) {
    const p = produced.get(key)!;
    if (list.some((m) => m.unit !== p.unit)) {
      report.unitMergeErrors.push({ stock_item: p.name, kept: p.unit, materials: [...list].sort((a, b) => cmpCi(a.material, b.material)) });
    }
  }
  for (const [key, list] of materialsOfStock) {
    if (list.length > 1) report.merges.push({ stock_item: produced.get(key)?.name ?? canonicalName.get(key) ?? key, materials: [...list].sort(cmpCi) });
  }
  report.merges.sort((a, b) => cmpCi(a.stock_item, b.stock_item));
  report.droppedEntries.sort((a, b) => cmp(a.kind, b.kind) || cmpCi(a.name, b.name));
  report.unitMergeErrors.sort((a, b) => cmpCi(a.stock_item, b.stock_item));

  const stockOut: ImportedStockItem[] = [];
  for (const p of produced.values()) {
    const prior = existingStockByKey.get(p.key);
    stockOut.push({
      name: p.name,
      unit: p.unit,
      category: p.category,
      tracks_expiry: p.tracks_expiry,
      par_level: prior?.par_level ?? 0,
      reorder_qty: prior?.reorder_qty ?? 0,
      standalone: prior?.standalone ?? false,
      notes: prior?.notes ?? '',
    });
  }
  report.counts.stockItemsImported = stockOut.length;
  let kept = 0;
  for (const s of existingStock) {
    if (!s || typeof s.name !== 'string' || produced.has(lc(s.name))) continue;
    // A duplicate spelling of an item already listed stays as it is; the checker reports it.
    stockOut.push(s as ImportedStockItem);
    kept += 1;
  }
  report.counts.stockItemsKept = kept;
  const categoryRank = (category: string): number => {
    if (!category) return STOCK_CATEGORIES.length + 1;
    const index = (STOCK_CATEGORIES as readonly string[]).indexOf(category);
    return index < 0 ? STOCK_CATEGORIES.length : index;
  };
  stockOut.sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || cmpCi(a.name, b.name));
  report.counts.stockItems = stockOut.length;

  report.counts.unitConflicts = report.unitConflicts.length;
  report.counts.droppedLines = report.droppedLines.length;
  report.counts.merges = report.merges.length;
  report.droppedLines.sort((a, b) => cmpCi(a.item, b.item) || cmpCi(a.material, b.material) || cmp(a.reason, b.reason));

  return {
    stockItems: { items: stockOut },
    recipeFiles,
    addonRecipes: { options },
    materials: sortedMaterials,
    report,
  };
}

// ── Markdown ────────────────────────────────────────────────────────────────

function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The report as markdown. Names only: no quantities. */
export function renderImportReport(report: ImportReport): string {
  const c = report.counts;
  const out: string[] = [];
  const line = (s = '') => out.push(s);

  line('# Petpooja import report');
  line();
  line('Written by `npm run inventory:import-petpooja`. It is rewritten on every run, and it holds no quantities.');
  line();
  line('## Summary');
  line();
  line(`- Export rows: ${c.csvRows} (${plural(c.itemRows, 'item row')}, ${plural(c.addonRows, 'add-on row')})`);
  line(
    `- Menu items: ${c.menuItems}. Imported from Petpooja: ${c.recipesImported} (${c.recipesDraft} as drafts). Kept as they were: ${c.recipesKeptOwnerOrPos} owner/pos, ${c.recipesKeptOther} other. **Still missing: ${c.recipesMissing}.**`,
  );
  line(`- Matched items with some sizes missing: ${c.itemsWithMissingSizes}`);
  line(
    `- Add-on options: ${c.addonOptions}. Imported: ${c.addonsImported} (${c.addonsDraft} as drafts; ${plural(c.addonScopes, 'scope')}). Kept as they were: ${c.addonsKeptOwnerOrPos} owner/pos, ${c.addonsKeptOther} other. **Still missing: ${c.addonsMissing}.**`,
  );
  line(`- Stock items: ${c.stockItems} (${c.stockItemsImported} from this import, ${c.stockItemsKept} already in the book)`);
  line(`- Materials needing a category: ${c.materialsNeedingMapping} · unit conflicts: ${c.unitConflicts} · lines dropped: ${c.droppedLines} · merged stock items: ${c.merges}`);

  // ── Still missing
  line();
  line('## STILL MISSING');
  line();
  line(`### Menu items with no recipe (${report.missingItems.length})`);
  if (report.missingItems.length === 0) {
    line();
    line('None.');
  } else {
    const byCategory = new Map<string, MissingItemReport[]>();
    for (const m of report.missingItems) byCategory.set(m.category, [...(byCategory.get(m.category) ?? []), m]);
    for (const [category, list] of byCategory) {
      line();
      line(`#### ${category} (${list.length})`);
      line();
      for (const m of list) line(`- ${m.menu_item} — sizes: ${m.sizes.join(', ')}`);
    }
  }
  line();
  line(`### Matched items missing some sizes (${report.missingSizes.length})`);
  line();
  if (report.missingSizes.length === 0) line('None.');
  for (const m of report.missingSizes) line(`- ${m.menu_item} (${m.category}) — no recipe for: ${m.missing.join(', ')}; has: ${m.have.join(', ') || 'none'}`);
  line();
  line(`### Add-on options with no recipe (${report.addons.missing.length})`);
  line();
  if (report.addons.missing.length === 0) line('None.');
  for (const m of report.addons.missing) line(`- ${m.group} › ${m.option}`);

  // ── Drafts
  line();
  line(`## Imported as drafts: Petpooja is missing something (${report.draftItems.length + report.addons.draft.length})`);
  line();
  line('A line had no quantity, material name or unit, so the recipe is incomplete. It is imported as a draft (never deployed) until the data is fixed in Petpooja and re-imported.');
  line();
  if (report.draftItems.length + report.addons.draft.length === 0) line('None.');
  for (const d of report.draftItems) line(`- ${d.name} (${d.category}) — ${d.where.join(', ')} — ${d.incomplete}`);
  for (const d of report.addons.draft) line(`- ${d.name} (add-on) — ${d.where.join('; ')} — ${d.incomplete}`);

  // ── Matched items
  line();
  line(`## Matched menu items (${report.matchedItems.length})`);
  line();
  if (report.matchedItems.length > 0) {
    line('| Petpooja name | Menu item | Sizes | How |');
    line('|---|---|---|---|');
    for (const m of report.matchedItems) {
      const sizes = m.appliesToAllSizes ? '(all sizes; Petpooja gave no size)' : m.covers.join(', ');
      line(`| ${cell(m.petpooja.join('; '))} | ${cell(m.menu_item)} | ${cell(sizes)} | ${m.via} |`);
    }
  }

  // ── Petpooja items that did not match
  line();
  line('## Petpooja items with no live match');
  line();
  line(`### Ignored by alias: not on the menu (${report.ignoredByAlias.length})`);
  line();
  if (report.ignoredByAlias.length === 0) line('None.');
  for (const n of report.ignoredByAlias) line(`- ${n}`);
  line();
  line(`### Unmatched: needs an alias in petpooja/aliases.json, or is discontinued (${report.unmatchedItems.length})`);
  line();
  line('The alias key is the name without ` [n]` and without a trailing size in parentheses.');
  line();
  if (report.unmatchedItems.length === 0) line('None.');
  for (const u of report.unmatchedItems) line(`- ${u.name}${u.suffixes.length > 0 ? ` ${u.suffixes.join(' ')}` : ''} — ${plural(u.rows, 'row')}`);
  line();
  line(`### Matched an item, but the size is not a live size (${report.sizeNotLive.length})`);
  line();
  if (report.sizeNotLive.length === 0) line('None.');
  for (const s of report.sizeNotLive) line(`- ${s.petpooja} → ${s.menu_item}: "${s.size}" is not one of ${s.liveSizes.join(', ')}`);
  if (report.invalidItemAliases.length > 0) {
    line();
    line(`### Item aliases that point at nothing (${report.invalidItemAliases.length})`);
    line();
    for (const a of report.invalidItemAliases) line(`- ${a.name} → ${a.target}`);
  }
  line();
  line(`### Matched, but no usable ingredient line (${report.matchedButEmpty.length})`);
  line();
  if (report.matchedButEmpty.length === 0) line('None.');
  for (const n of report.matchedButEmpty) line(`- ${n}`);
  line();
  line(`### Two Petpooja rows for the same item and size (${report.duplicates.length})`);
  line();
  if (report.duplicates.length === 0) line('None.');
  for (const d of report.duplicates) line(`- ${d.menu_item} (${d.size}): kept ${d.kept}, dropped ${d.dropped}`);

  // ── Add-ons
  const a = report.addons;
  line();
  line('## Add-ons');
  line();
  line(`- Options with a Petpooja recipe: ${a.matched}; with per-item or per-size scopes: ${a.withScopes.length}`);
  line(`- Entries with no ingredient lines (ignored): ${a.emptyIgnored}`);
  line(`- Rows whose item is not a matched menu item: ${a.parentNotMatchedRows} · rows with no item row: ${a.orphanRows} · rows whose name did not parse: ${a.unparsedRows} · repeated rows: ${a.duplicateRows}`);
  if (a.notOffered.length > 0) {
    line();
    line(`### Add-on rows on an item that does not offer the group (${a.notOffered.length}): left out`);
    line();
    line('The live item cannot be ordered with that add-on group, so a scope for it would never apply.');
    line();
    for (const n of a.notOffered) line(`- ${n.menu_item} › ${n.group} — ${plural(n.rows, 'row')}`);
  }
  line();
  line(`### Petpooja add-ons that match no live option (${a.unmatched.length})`);
  line();
  line('The alias key is `<Group>|<Option>` in petpooja/aliases.json (`null` = ignore).');
  line();
  if (a.unmatched.length === 0) line('None.');
  for (const u of a.unmatched) line(`- ${u.key} — ${plural(u.rows, 'row')}`);
  if (a.ignoredByAlias.length > 0) {
    line();
    line(`### Ignored by alias (${a.ignoredByAlias.length})`);
    line();
    for (const u of a.ignoredByAlias) line(`- ${u.key} — ${plural(u.rows, 'row')}`);
  }
  if (a.invalidAliases.length > 0) {
    line();
    line(`### Add-on aliases that point at nothing (${a.invalidAliases.length})`);
    line();
    for (const u of a.invalidAliases) line(`- ${u.key} → ${u.target}`);
  }
  line();
  line(`### Options with scopes (${a.withScopes.length})`);
  line();
  if (a.withScopes.length === 0) line('None.');
  for (const s of a.withScopes) line(`- ${s.group} › ${s.option} — ${plural(s.scopes, 'scope')}`);

  // ── Units
  line();
  line('## Units');
  line();
  line(`### Materials seen with different units (${report.unitConflicts.length})`);
  line();
  line('The most common unit was used; check these.');
  line();
  if (report.unitConflicts.length === 0) line('None.');
  for (const u of report.unitConflicts) {
    line(`- ${u.material}: used ${u.used}; also ${u.others.map((o) => `${o.unit} (${plural(o.count, 'line')}: ${o.items.join('; ')})`).join(', ')}`);
  }
  line();
  line(`### Merged materials that disagree on the unit (${report.unitMergeErrors.length})`);
  line();
  if (report.unitMergeErrors.length === 0) line('None.');
  for (const e of report.unitMergeErrors) line(`- ERROR ${e.stock_item}: kept ${e.kept}; ${e.materials.map((m) => `${m.material} is ${m.unit}`).join(', ')}`);

  // ── Dropped lines
  line();
  line(`## Ingredient lines dropped (${report.droppedLines.length})`);
  line();
  if (report.droppedLines.length === 0) line('None.');
  const byReason = new Map<string, DroppedLineReport[]>();
  for (const d of report.droppedLines) byReason.set(d.reason, [...(byReason.get(d.reason) ?? []), d]);
  for (const [reason, list] of [...byReason].sort((x, y) => cmp(x[0], y[0]))) {
    line(`### ${reason} (${list.length})`);
    line();
    for (const d of list) line(`- ${d.item} — ${d.material}`);
    line();
  }

  // ── Materials
  line('## Materials');
  line();
  line(`### Need a category in petpooja/materials.json (${report.materialsNeedingMapping.length})`);
  line();
  if (report.materialsNeedingMapping.length === 0) line('None.');
  for (const m of report.materialsNeedingMapping) line(`- ${m}`);
  line();
  line(`### Several Petpooja materials in one stock item (${report.merges.length})`);
  line();
  if (report.merges.length === 0) line('None.');
  for (const m of report.merges) line(`- ${m.stock_item}: ${m.materials.join(', ')}`);

  // ── Kept / dropped
  line();
  line(`## Kept as they were (${report.keptItems.length + a.kept.length})`);
  line();
  if (report.keptItems.length + a.kept.length === 0) line('None.');
  for (const k of report.keptItems) line(`- ${k.name} — ${k.status}, ${k.source}`);
  for (const k of a.kept) line(`- ${k.name} (add-on) — ${k.status}, ${k.source}`);
  line();
  line(`## Dropped from the book: no longer in the menu snapshot (${report.droppedEntries.length})`);
  line();
  if (report.droppedEntries.length === 0) line('None.');
  for (const d of report.droppedEntries) line(`- ${d.name} (${d.kind})`);
  if (report.staleRecipeFiles.length > 0) {
    line();
    line('## Old recipe files still holding entries');
    line();
    line('Their entries are now written to the standard files, so remove these files by hand or `inventory:check` will report duplicates.');
    line();
    for (const f of report.staleRecipeFiles) line(`- ${f}`);
  }
  line();
  return out.join('\n');
}
