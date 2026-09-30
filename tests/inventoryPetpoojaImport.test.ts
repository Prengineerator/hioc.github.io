// The Petpooja recipe importer (lib/inventory/petpoojaRecipes.ts). Every
// fixture here is invented ("Test Latte", "Beans X 18 gm"): the café's real
// recipes are private and never belong in a test.

import { describe, expect, it } from 'vitest';
import {
  decodeHexId,
  importPetpoojaRecipes,
  mapPetpoojaUnit,
  parseAddonName,
  parseCsvRecords,
  parseItemName,
  parsePetpoojaRecipeCsv,
  renderImportReport,
  type ExistingBook,
  type ImportInput,
  type MaterialsMap,
  type PetpoojaAliases,
} from '@/lib/inventory/petpoojaRecipes';
import type { RecipeItemEntry, SnapshotAddonOption, SnapshotItem } from '@/lib/inventory/recipeBook';

// ── Fixtures ────────────────────────────────────────────────────────────────

const HEADER = 'ItemID,ItemName,ItemType,RawMaterial,Qty,Unit,RawMaterial,Qty,Unit';

function hex(s: string): string {
  return `0x${Array.from(s)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')}`;
}

type Mat = [material: string, qty: string | number, unit: string];

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV record. The id is plain text here and hex-encoded like the real export. */
function record(id: string, name: string, type: 'Item' | 'Addon', mats: Mat[] = []): string {
  return [hex(id), name, type, ...mats.flatMap(([m, q, u]) => [m, String(q), u]), '', '', ''].map(csvCell).join(',');
}
const item = (id: string, name: string, mats: Mat[] = []) => record(id, name, 'Item', mats);
const addon = (id: string, name: string, mats: Mat[] = []) => record(id, name, 'Addon', mats);
const csv = (records: string[]) => `${[HEADER, ...records].join('\r\n')}\r\n`;

function snapItem(id: string, name: string, category: string, sizes: string[], addon_groups: string[] = []): SnapshotItem {
  return { id, name, category, parent_category: '', is_available: true, sizes: sizes.map((label) => ({ label, price_inr: 100 })), addon_groups, description: '' };
}
function snapOption(id: string, group: string, option: string): SnapshotAddonOption {
  return { id, group, group_label: `Pick ${group}`, option, price_inr: 0 };
}

const ITEMS: SnapshotItem[] = [
  snapItem('i-latte', 'Test Latte', 'Coffee', ['Large', 'Extra Large'], ['Sugar', 'Milk']),
  snapItem('i-espresso', 'Test Espresso', 'Coffee', ['Large', 'Extra Large'], ['Sugar']),
  snapItem('i-frappe', 'Test Frappe', 'Hot Non-Coffee', ['Large', 'Extra Large'], ['Sugar']),
  snapItem('i-mocha', 'Test Mocha', 'Hot Non-Coffee', ['Large', 'Extra Large'], ['Sugar']),
  snapItem('i-iced', 'Test Iced', 'Iced Coffee', ['Regular'], ['Sugar']),
  snapItem('i-creme', 'Test Creme (Choc-Mint)', 'Creme Coffee', ['Large', 'Extra Large']),
  snapItem('i-tea', 'Test Tea', 'Iced Non-Coffee', ['Large', 'Mini(For Store)']),
  snapItem('i-waffle', 'Test Waffle', 'Stick Waffles', ['B', 'L']),
  snapItem('i-cake', 'Test Cake', 'Cup Cakes', ['Regular']),
  snapItem('i-sandwich', 'Test Sandwich', 'Eatery', ['White Bread', 'Focaccia Bread']),
  snapItem('i-future', 'Test Future', 'Brand New Category', ['Regular']),
];
const OPTIONS: SnapshotAddonOption[] = [
  snapOption('o-normal', 'Sugar', 'Normal'),
  snapOption('o-brown', 'Sugar', 'Brown Sugar'),
  snapOption('o-tie-a', 'Sugar', 'Tie A'),
  snapOption('o-tie-b', 'Sugar', 'Tie B'),
  snapOption('o-oat', 'Milk', 'Oat'),
  snapOption('o-nosugar', 'Sugar', 'No Sugar'),
];
const SNAPSHOT = { items: ITEMS, addon_options: OPTIONS };

const MATERIALS: MaterialsMap = {
  'Beans X': { name: 'Coffee beans', category: 'Coffee', tracks_expiry: false },
  'Beans X (old)': { name: 'Coffee beans', category: 'Coffee', tracks_expiry: false },
  Milk: { name: 'Milk', category: 'Dairy & Alternatives', tracks_expiry: true },
  Sugar: { name: 'Sugar', category: 'Powders & Mixes', tracks_expiry: false },
  'Cup 12oz': { name: 'Cup 12oz', category: 'Packaging', tracks_expiry: false },
};

function run(records: string[], overrides: Partial<Omit<ImportInput, 'rows'>> = {}) {
  return importPetpoojaRecipes({
    rows: parsePetpoojaRecipeCsv(csv(records)),
    snapshot: SNAPSHOT,
    aliases: {},
    materials: MATERIALS,
    existing: {},
    ...overrides,
  });
}

function recipeOf(result: ReturnType<typeof run>, id: string): RecipeItemEntry | undefined {
  for (const { file } of result.recipeFiles) {
    const found = file.items.find((i) => i.menu_item_id === id);
    if (found) return found;
  }
  return undefined;
}
function optionOf(result: ReturnType<typeof run>, id: string) {
  return result.addonRecipes.options.find((o) => o.addon_option_id === id);
}
const lines = (...pairs: [string, number][]) => pairs.map(([ingredient, qty]) => ({ ingredient, qty }));

// A latte with both sizes, used by several tests.
const LATTE_ROWS = [
  item('100#1', 'Test Latte [n] (Large)', [['Beans X', 18, 'gm'], ['Milk', 240, 'gm']]),
  item('100#2', 'Test Latte [n] (Extra Large)', [['Beans X', 27, 'gm'], ['Milk', 330, 'gm']]),
];

// ── CSV, ids, names ─────────────────────────────────────────────────────────

describe('csv parsing', () => {
  it('reads RFC-4180 quoting, escaped quotes, CRLF, blank lines and a BOM', () => {
    const text = '\uFEFFa,b,c\r\n"x, y","say ""hi""",z\r\n\r\n1,2,3';
    expect(parseCsvRecords(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'z'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps a newline inside a quoted cell', () => {
    expect(parseCsvRecords('a,"b\nc"\n')).toEqual([['a', 'b\nc']]);
  });

  it('rejects a file that is not the export', () => {
    expect(() => parsePetpoojaRecipeCsv('Name,Qty\nx,1\n')).toThrow(/ItemID/);
  });

  it('parses rows: decoded id, trimmed cells, quoted names with commas, padding dropped', () => {
    const rows = parsePetpoojaRecipeCsv(csv([item('9#8', 'Toast, Butter (Large)', [[' Beans X ', ' 5 ', 'gm '], ['', '', '']])]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '9#8', name: 'Toast, Butter (Large)', type: 'Item', rawId: hex('9#8') });
    expect(rows[0].materials).toEqual([{ material: 'Beans X', qty: '5', unit: 'gm' }]);
  });

  it('decodes hex ids and leaves anything else alone', () => {
    expect(decodeHexId(hex('141#5#77'))).toBe('141#5#77');
    expect(decodeHexId('0X313A32')).toBe('1:2');
    expect(decodeHexId(' plain-id ')).toBe('plain-id');
    expect(decodeHexId('0x313')).toBe('0x313'); // odd length: not hex-encoded text
  });
});

describe('name parsing', () => {
  it('splits name, marker and size', () => {
    expect(parseItemName('Test Latte [n] (Large)')).toEqual({ full: 'Test Latte (Large)', withoutSuffix: 'Test Latte', suffix: 'Large' });
    expect(parseItemName('Test Latte (Large)')).toMatchObject({ withoutSuffix: 'Test Latte', suffix: 'Large' });
    expect(parseItemName('Test Latte [N]')).toEqual({ full: 'Test Latte' });
    expect(parseItemName('Test Latte')).toEqual({ full: 'Test Latte' });
  });

  it('reads a nested size parenthesis whole', () => {
    expect(parseItemName('Test Tea (Mini(For Store))')).toMatchObject({ withoutSuffix: 'Test Tea', suffix: 'Mini(For Store)' });
  });

  it('keeps both readings of a name with a non-size parenthesis', () => {
    expect(parseItemName('Test Dawn [n] (nutella)')).toEqual({ full: 'Test Dawn (nutella)', withoutSuffix: 'Test Dawn', suffix: 'nutella' });
    expect(parseItemName('Test Creme (mango) [n] (Large)')).toMatchObject({ withoutSuffix: 'Test Creme (mango)', suffix: 'Large' });
  });

  it('tolerates the [n) typo', () => {
    expect(parseItemName('Test Latte [n) (Extra Large)')).toMatchObject({ withoutSuffix: 'Test Latte', suffix: 'Extra Large' });
    expect(parseItemName('Test Latte [n)')).toEqual({ full: 'Test Latte' });
  });

  it('parses add-on names from the end', () => {
    expect(parseAddonName("Sprinkles(dark) (90's Test [n]) (Large) (Add On Waffles)", "90's Test [n]", 'Large')).toEqual({ option: 'Sprinkles(dark)', group: 'Add On Waffles' });
    expect(parseAddonName('Ice Cream - Choc (Test Slice) (Yes, For Me)', 'Test Slice', '')).toEqual({ option: 'Ice Cream - Choc', group: 'Yes, For Me' });
    // The option has parentheses of its own.
    expect(parseAddonName('Test Croissant (mini) (Test Mocha [n]) (Extra Large) (Add A Slider)', 'Test Mocha [n]', 'Extra Large')).toEqual({
      option: 'Test Croissant (mini)',
      group: 'Add A Slider',
    });
    // A parent whose own name has a parenthesis, with no size.
    expect(parseAddonName('Extra (Test Creme (mango) [n]) (Sugar)', 'Test Creme (mango) [n]', '')).toEqual({ option: 'Extra', group: 'Sugar' });
    // The [n) typo in the parent.
    expect(parseAddonName('Normal (Test Latte [n)) (Extra Large) (Sugar)', 'Test Latte [n) ', 'Extra Large')).toEqual({ option: 'Normal', group: 'Sugar' });
  });

  it('does not take the option\'s parenthesis for the size when the row repeats no size', () => {
    expect(parseAddonName('Tonic (light) (Test Tea [n]) (Fizz)', 'Test Tea [n]', 'Large')).toEqual({ option: 'Tonic (light)', group: 'Fizz' });
  });

  it('returns null for a name without a group', () => {
    expect(parseAddonName('Just a name', 'Test', '')).toBeNull();
  });
});

describe('units', () => {
  it('maps Petpooja units', () => {
    expect(mapPetpoojaUnit('gm')).toBe('g');
    expect(mapPetpoojaUnit(' GM ')).toBe('g');
    expect(mapPetpoojaUnit('pcs')).toBe('pcs');
    expect(mapPetpoojaUnit('Pcs')).toBe('pcs');
    expect(mapPetpoojaUnit('ml')).toBe('ml');
    expect(mapPetpoojaUnit('kg')).toBe('kg');
    expect(mapPetpoojaUnit('Ltr')).toBe('l');
    expect(mapPetpoojaUnit('l')).toBe('l');
    expect(mapPetpoojaUnit('')).toBe('');
    expect(mapPetpoojaUnit('barrel')).toBeNull();
  });

  it('gives a stock item its Petpooja unit, and a blank unit takes the material\'s other unit', () => {
    const result = run([
      item('1#1', 'Test Latte (Large)', [['Beans X', 18, 'gm'], ['Cup 12oz', 1, 'Pcs']]),
      item('1#2', 'Test Latte (Extra Large)', [['Beans X', 27, ''], ['Cup 12oz', 1, 'pcs']]),
    ]);
    const stock = Object.fromEntries(result.stockItems.items.map((s) => [s.name, s.unit]));
    expect(stock).toEqual({ 'Coffee beans': 'g', 'Cup 12oz': 'pcs' });
    expect(recipeOf(result, 'i-latte')?.sizes['Extra Large']).toEqual(lines(['Coffee beans', 27], ['Cup 12oz', 1]));
    expect(result.report.droppedLines).toEqual([]);
  });

  it('takes a blank unit from elsewhere in the export, even from an item that is not on the menu', () => {
    const result = run([
      item('1#1', 'Test Latte (Large)', [['Beans X', 18, ''], ['Milk', 200, 'gm']]),
      item('1#2', 'Test Latte (Extra Large)', [['Beans X', 20, 'gm'], ['Milk', 300, 'gm']]),
      item('2#1', 'Not On The Menu', [['Sprinkles', 5, 'pcs']]),
      item('3#1', 'Test Cake', [['Sprinkles', 4, '']]),
    ]);
    expect(result.report.droppedLines).toEqual([]);
    expect(result.stockItems.items.find((s) => s.name === 'Sprinkles')?.unit).toBe('pcs');
  });

  it('drops and reports a line whose unit is blank and known nowhere', () => {
    const result = run([item('1#1', 'Test Cake', [['Sprinkles', 4, ''], ['Milk', 5, 'gm']])]);
    expect(result.report.droppedLines).toEqual([{ item: 'Test Cake', material: 'Sprinkles', reason: 'blank unit, and no unit for this material anywhere else' }]);
    expect(recipeOf(result, 'i-cake')?.base).toEqual(lines(['Milk', 5]));
  });

  it('drops a unit it does not know', () => {
    const result = run([item('1#1', 'Test Cake', [['Sprinkles', 4, 'barrel'], ['Milk', 5, 'gm']])]);
    expect(result.report.droppedLines[0]).toMatchObject({ material: 'Sprinkles', reason: 'unknown unit "barrel"' });
  });

  it('uses the most common unit for a material and reports the conflict with the item names', () => {
    const result = run([
      item('1#1', 'Test Latte (Large)', [['Beans X', 1, 'gm']]),
      item('1#2', 'Test Latte (Extra Large)', [['Beans X', 2, 'gm']]),
      item('2#1', 'Test Cake', [['Beans X', 3, 'pcs']]),
    ]);
    expect(result.stockItems.items.find((s) => s.name === 'Coffee beans')?.unit).toBe('g');
    expect(result.report.unitConflicts).toEqual([{ material: 'Beans X', used: 'g', others: [{ unit: 'pcs', count: 1, items: ['Test Cake'] }] }]);
  });
});

describe('quantities', () => {
  it('drops a blank or non-numeric quantity, reporting the item and material but never the value', () => {
    const result = run([
      item('1#1', 'Test Cake', [['Milk', '', 'gm'], ['Sugar', 'a lot', 'gm'], ['Beans X', 0, 'gm'], ['Cup 12oz', 1, 'pcs']]),
    ]);
    expect(recipeOf(result, 'i-cake')?.base).toEqual(lines(['Cup 12oz', 1]));
    expect(result.report.droppedLines).toEqual([
      { item: 'Test Cake', material: 'Beans X', reason: 'quantity is zero' },
      { item: 'Test Cake', material: 'Milk', reason: 'blank quantity' },
      { item: 'Test Cake', material: 'Sugar', reason: 'non-numeric quantity' },
    ]);
    expect(JSON.stringify(result.report)).not.toContain('a lot');
  });

  it('does not write a recipe for an item whose lines were all dropped, and reports it', () => {
    const result = run([item('1#1', 'Test Cake', [['Milk', '', 'gm']])]);
    expect(recipeOf(result, 'i-cake')).toBeUndefined();
    expect(result.report.matchedButEmpty).toEqual(['Test Cake']);
    expect(result.report.missingItems.map((m) => m.menu_item)).toContain('Test Cake');
  });

  it('rounds sums to three decimals', () => {
    const result = run([item('1#1', 'Test Cake', [['Beans X', 0.1, 'gm'], ['Beans X (old)', 0.2, 'gm'], ['Milk', 1.00049, 'gm']])]);
    expect(recipeOf(result, 'i-cake')?.base).toEqual(lines(['Coffee beans', 0.3], ['Milk', 1]));
  });
});

// ── Matching ────────────────────────────────────────────────────────────────

describe('item matching', () => {
  it('matches the name automatically and reads the size from the trailing parenthesis', () => {
    const result = run(LATTE_ROWS);
    const latte = recipeOf(result, 'i-latte');
    expect(latte).toMatchObject({ menu_item: 'Test Latte', status: 'confirmed', source: 'petpooja', notes: 'Petpooja: Test Latte [n] (Large); Test Latte [n] (Extra Large)', base: [] });
    expect(Object.keys(latte!.sizes)).toEqual(['Large', 'Extra Large']);
    expect(latte!.sizes.Large).toEqual(lines(['Coffee beans', 18], ['Milk', 240]));
    expect(result.report.matchedItems.find((m) => m.menu_item === 'Test Latte')).toMatchObject({ via: 'auto', covers: ['Large', 'Extra Large'] });
  });

  it('tries the aliases file first: its target wins over the automatic match', () => {
    const aliases: PetpoojaAliases = { items: { 'Test Latte': 'i-mocha' } };
    const result = run(LATTE_ROWS, { aliases });
    expect(recipeOf(result, 'i-mocha')).toBeDefined();
    expect(recipeOf(result, 'i-latte')).toBeUndefined();
    expect(result.report.matchedItems.find((m) => m.menu_item === 'Test Mocha')?.via).toBe('alias');
  });

  it('uses an alias for a name the matcher cannot match, and finds the key case-insensitively', () => {
    const result = run(
      [item('1#1', 'Old Name [n] (Regular)', [['Milk', 5, 'gm']])],
      { aliases: { items: { 'old name': 'i-iced' } } },
    );
    expect(recipeOf(result, 'i-iced')?.notes).toBe('Petpooja: Old Name [n] (Regular)');
  });

  it('ignores an item whose alias is null and lists it as not on the menu', () => {
    const result = run(
      [item('1#1', 'Test Latte [n] (Large)', [['Milk', 5, 'gm']]), item('2#1', 'Test Cake', [['Milk', 1, 'gm']])],
      { aliases: { items: { 'Test Latte': null } } },
    );
    expect(recipeOf(result, 'i-latte')).toBeUndefined();
    expect(recipeOf(result, 'i-cake')).toBeDefined();
    expect(result.report.ignoredByAlias).toEqual(['Test Latte']);
    expect(result.report.unmatchedItems).toEqual([]);
  });

  it('reports an alias that points at nothing, and a name that matches nothing', () => {
    const result = run(
      [item('1#1', 'Ghost (Large)', [['Milk', 5, 'gm']]), item('2#1', 'Phantom', [['Milk', 5, 'gm']])],
      { aliases: { items: { Ghost: 'no-such-id' } } },
    );
    expect(result.report.invalidItemAliases).toEqual([{ name: 'Ghost', target: 'no-such-id' }]);
    expect(result.report.unmatchedItems.map((u) => u.name)).toEqual(['Ghost', 'Phantom']);
    expect(result.report.unmatchedItems[0]).toMatchObject({ rows: 1, suffixes: ['(Large)'] });
  });

  it('keeps a non-size parenthesis as part of the name', () => {
    const result = run([
      item('1#1', 'Test Creme (Choc-Mint) [n] (Large)', [['Milk', 5, 'gm']]),
      item('1#2', 'Test Creme (Choc-Mint) [n] (Extra Large)', [['Milk', 6, 'gm']]),
    ]);
    expect(Object.keys(recipeOf(result, 'i-creme')!.sizes)).toEqual(['Large', 'Extra Large']);

    // Same name, no size: the whole thing is the name.
    const noSize = run([item('1#1', 'Test Creme (Choc-Mint) [n]', [['Milk', 5, 'gm']])]);
    expect(recipeOf(noSize, 'i-creme')?.base).toEqual(lines(['Milk', 5]));
  });

  it('reads a nested size label', () => {
    const result = run([
      item('1#1', 'Test Tea (Large)', [['Milk', 5, 'gm']]),
      item('1#2', 'Test Tea (Mini(For Store))', [['Milk', 3, 'gm']]),
    ]);
    expect(Object.keys(recipeOf(result, 'i-tea')!.sizes)).toEqual(['Large', 'Mini(For Store)']);
  });

  it('understands the [n) typo', () => {
    const result = run([item('1#1', 'Test Latte [n) (Extra Large)', [['Milk', 5, 'gm']])]);
    expect(Object.keys(recipeOf(result, 'i-latte')!.sizes)).toEqual(['Extra Large']);
  });

  it('matches a size case-insensitively and writes the snapshot spelling', () => {
    const result = run([item('1#1', 'Test Latte (large)', [['Milk', 5, 'gm']])]);
    expect(Object.keys(recipeOf(result, 'i-latte')!.sizes)).toEqual(['Large']);
  });

  it('skips a size that is not live and reports it', () => {
    const result = run([item('1#1', 'Test Latte (Jumbo)', [['Milk', 5, 'gm']])]);
    expect(recipeOf(result, 'i-latte')).toBeUndefined();
    expect(result.report.sizeNotLive).toEqual([{ petpooja: 'Test Latte (Jumbo)', menu_item: 'Test Latte', size: 'Jumbo', liveSizes: ['Large', 'Extra Large'] }]);
  });

  it('keeps the first of two rows for the same item and size', () => {
    const result = run([
      item('1#1', 'Test Latte [n] (Large)', [['Milk', 5, 'gm']]),
      item('1#2', 'Test Latte (Large)', [['Milk', 9, 'gm']]),
    ]);
    expect(recipeOf(result, 'i-latte')?.sizes.Large).toEqual(lines(['Milk', 5]));
    expect(result.report.duplicates).toEqual([{ menu_item: 'Test Latte', size: 'Large', kept: 'Test Latte [n] (Large)', dropped: 'Test Latte (Large)' }]);
  });
});

// ── Sizes ───────────────────────────────────────────────────────────────────

describe('sizes', () => {
  it('writes one base recipe when every live size is identical', () => {
    const result = run([
      item('1#1', 'Test Latte (Large)', [['Milk', 5, 'gm'], ['Beans X', 1, 'gm']]),
      item('1#2', 'Test Latte (Extra Large)', [['Beans X', 1, 'gm'], ['Milk', 5, 'gm']]), // same lines, other order
    ]);
    const latte = recipeOf(result, 'i-latte')!;
    expect(latte.sizes).toEqual({});
    expect(latte.base).toEqual(lines(['Milk', 5], ['Coffee beans', 1]));
    expect(result.report.matchedItems.find((m) => m.menu_item === 'Test Latte')?.covers).toEqual(['(all sizes)']);
  });

  it('writes each size when they differ', () => {
    const latte = recipeOf(run(LATTE_ROWS), 'i-latte')!;
    expect(latte.base).toEqual([]);
    expect(Object.keys(latte.sizes)).toEqual(['Large', 'Extra Large']);
  });

  it('writes only the sizes it has and reports the live sizes that are missing', () => {
    const result = run([item('1#1', 'Test Latte (Extra Large)', [['Milk', 5, 'gm']])]);
    expect(Object.keys(recipeOf(result, 'i-latte')!.sizes)).toEqual(['Extra Large']);
    expect(result.report.missingSizes).toEqual([{ category: 'Coffee', menu_item: 'Test Latte', missing: ['Large'], have: ['Extra Large'] }]);
    expect(result.report.counts.itemsWithMissingSizes).toBe(1);
    expect(renderImportReport(result.report)).toMatch(/Test Latte \(Coffee\) — no recipe for: Large; has: Extra Large/);
  });

  it('treats a row with no size as base for an item with one size', () => {
    const result = run([item('1#1', 'Test Cake', [['Milk', 5, 'gm']])]);
    expect(recipeOf(result, 'i-cake')).toMatchObject({ base: lines(['Milk', 5]), sizes: {} });
    expect(result.report.matchedItems.find((m) => m.menu_item === 'Test Cake')).toMatchObject({ covers: ['Regular'], appliesToAllSizes: false });
  });

  it('treats a row with no size as base for an item with several sizes, and says so', () => {
    const result = run([item('1#1', 'Test Latte', [['Milk', 5, 'gm']])]);
    expect(recipeOf(result, 'i-latte')).toMatchObject({ base: lines(['Milk', 5]), sizes: {} });
    expect(result.report.matchedItems.find((m) => m.menu_item === 'Test Latte')).toMatchObject({ appliesToAllSizes: true });
    expect(renderImportReport(result.report)).toContain('(all sizes; Petpooja gave no size)');
  });

  it('lets a size row override a no-size row for that size', () => {
    const result = run([
      item('1#1', 'Test Latte', [['Milk', 5, 'gm']]),
      item('1#2', 'Test Latte (Extra Large)', [['Milk', 8, 'gm']]),
    ]);
    const latte = recipeOf(result, 'i-latte')!;
    expect(latte.base).toEqual([]);
    expect(latte.sizes).toEqual({ Large: lines(['Milk', 5]), 'Extra Large': lines(['Milk', 8]) });
    expect(result.report.missingSizes).toEqual([]);
  });
});

// ── Materials and stock items ───────────────────────────────────────────────

describe('materials and stock items', () => {
  it('maps materials to stock items and takes category and expiry from the materials file', () => {
    const result = run(LATTE_ROWS);
    expect(result.stockItems.items).toEqual([
      { name: 'Coffee beans', unit: 'g', category: 'Coffee', tracks_expiry: false, par_level: 0, reorder_qty: 0, standalone: false, notes: '' },
      { name: 'Milk', unit: 'g', category: 'Dairy & Alternatives', tracks_expiry: true, par_level: 0, reorder_qty: 0, standalone: false, notes: '' },
    ]);
  });

  it('adds a placeholder for an unmapped material, sorted, and reports it', () => {
    const result = run([item('1#1', 'Test Cake', [['Zebra Dust', 5, 'gm'], ['Apple Crumb', 2, 'pcs'], ['Milk', 1, 'gm']])]);
    expect(result.materials['Zebra Dust']).toEqual({ name: 'Zebra Dust', category: '', tracks_expiry: false });
    expect(Object.keys(result.materials)).toEqual([...Object.keys(result.materials)].sort());
    expect(result.report.materialsNeedingMapping).toEqual(['Apple Crumb', 'Zebra Dust']);
    // The stock item exists, with no category yet, after the categorised ones.
    expect(result.stockItems.items.map((s) => [s.name, s.category])).toEqual([
      ['Milk', 'Dairy & Alternatives'],
      ['Apple Crumb', ''],
      ['Zebra Dust', ''],
    ]);
    expect(MATERIALS['Zebra Dust']).toBeUndefined(); // the input is not touched
  });

  it('does not add placeholders for materials that only appear on items not on the menu', () => {
    const result = run([item('1#1', 'Test Cake', [['Milk', 1, 'gm']]), item('2#1', 'Not On The Menu', [['Mystery', 1, 'gm']])]);
    expect(result.materials.Mystery).toBeUndefined();
  });

  it('merges several Petpooja materials into one stock item, summing them in a recipe', () => {
    const result = run([item('1#1', 'Test Cake', [['Beans X', 10, 'gm'], ['Milk', 4, 'gm'], ['Beans X (old)', 5.5, 'gm']])]);
    expect(recipeOf(result, 'i-cake')?.base).toEqual(lines(['Coffee beans', 15.5], ['Milk', 4]));
    expect(result.report.merges).toEqual([{ stock_item: 'Coffee beans', materials: ['Beans X', 'Beans X (old)'] }]);
    expect(result.stockItems.items.filter((s) => s.name === 'Coffee beans')).toHaveLength(1);
  });

  it('sums repeated lines of the same material', () => {
    const result = run([item('1#1', 'Test Cake', [['Milk', 4, 'gm'], ['Milk', 6, 'gm']])]);
    expect(recipeOf(result, 'i-cake')?.base).toEqual(lines(['Milk', 10]));
  });

  it('merges names that differ only in case, keeping the first spelling', () => {
    const result = run([item('1#1', 'Test Cake', [['Oat milk', 4, 'gm'], ['Oat Milk', 6, 'gm']])]);
    expect(result.stockItems.items.filter((s) => s.name.toLowerCase() === 'oat milk')).toHaveLength(1);
    expect(recipeOf(result, 'i-cake')?.base).toHaveLength(1);
  });

  it('reports merged materials that disagree on the unit, and keeps the first', () => {
    const result = run([item('1#1', 'Test Cake', [['Beans X', 10, 'gm'], ['Beans X (old)', 2, 'pcs']])]);
    expect(result.stockItems.items.find((s) => s.name === 'Coffee beans')?.unit).toBe('g');
    expect(result.report.unitMergeErrors).toEqual([
      { stock_item: 'Coffee beans', kept: 'g', materials: [{ material: 'Beans X', unit: 'g' }, { material: 'Beans X (old)', unit: 'pcs' }] },
    ]);
    expect(renderImportReport(result.report)).toContain('ERROR Coffee beans');
  });

  it('orders stock items by the contract\'s category order, blank categories last, then by name', () => {
    const result = run([
      item('1#1', 'Test Cake', [['Cup 12oz', 1, 'pcs'], ['Sugar', 1, 'gm'], ['Milk', 1, 'gm'], ['Beans X', 1, 'gm'], ['Unmapped B', 1, 'gm'], ['Unmapped A', 1, 'gm']]),
    ]);
    expect(result.stockItems.items.map((s) => s.name)).toEqual(['Coffee beans', 'Milk', 'Sugar', 'Cup 12oz', 'Unmapped A', 'Unmapped B']);
  });

  it('keeps existing stock items the import does not produce, and existing par, reorder, standalone and notes for the ones it does', () => {
    const existing: ExistingBook = {
      stockItems: {
        items: [
          { name: 'Chef Special Glaze', unit: 'ml', category: 'Syrups & Sauces', tracks_expiry: true, par_level: 3, reorder_qty: 4, standalone: true, notes: 'chef' },
          { name: 'milk', unit: 'ml', category: 'Dairy & Alternatives', tracks_expiry: true, par_level: 5000, reorder_qty: 10000, standalone: true, notes: 'bulk' },
        ],
      },
    };
    const result = run([item('1#1', 'Test Cake', [['Milk', 4, 'gm']])], { existing });
    const byName = Object.fromEntries(result.stockItems.items.map((s) => [s.name, s]));
    expect(byName['Chef Special Glaze']).toEqual(existing.stockItems!.items![0]);
    // The unit is Petpooja's; the chef's numbers and spelling stay.
    expect(byName.milk).toEqual({ name: 'milk', unit: 'g', category: 'Dairy & Alternatives', tracks_expiry: true, par_level: 5000, reorder_qty: 10000, standalone: true, notes: 'bulk' });
    expect(byName.Milk).toBeUndefined();
    expect(recipeOf(result, 'i-cake')?.base).toEqual(lines(['milk', 4]));
    expect(result.report.counts).toMatchObject({ stockItems: 2, stockItemsImported: 1, stockItemsKept: 1 });
  });

  it('does not blank a category the book already has when the material is still a placeholder', () => {
    const existing: ExistingBook = { stockItems: { items: [{ name: 'Mystery', unit: 'g', category: 'Bakery', tracks_expiry: true, par_level: 0, reorder_qty: 0 }] } };
    const result = run([item('1#1', 'Test Cake', [['Mystery', 4, 'gm']])], { existing });
    expect(result.stockItems.items[0]).toMatchObject({ name: 'Mystery', category: 'Bakery', tracks_expiry: true });
    expect(result.materials.Mystery.category).toBe(''); // still to be mapped
    expect(result.report.materialsNeedingMapping).toEqual(['Mystery']);
  });
});

// ── Recipe files ────────────────────────────────────────────────────────────

describe('recipe files', () => {
  const rows = [
    item('1#1', 'Test Latte', [['Milk', 1, 'gm']]),
    item('2#1', 'Test Frappe', [['Milk', 2, 'gm']]),
    item('3#1', 'Test Iced', [['Milk', 3, 'gm']]),
    item('4#1', 'Test Creme (Choc-Mint)', [['Milk', 4, 'gm']]),
    item('5#1', 'Test Waffle', [['Milk', 5, 'gm']]),
    item('6#1', 'Test Cake', [['Milk', 6, 'gm']]),
    item('7#1', 'Test Future', [['Milk', 7, 'gm']]),
  ];

  it('files items by the contract\'s category table, in snapshot order', () => {
    const result = run(rows);
    expect(result.recipeFiles.map((f) => f.path)).toEqual([
      'recipes/hot.json',
      'recipes/iced.json',
      'recipes/creme.json',
      'recipes/waffles.json',
      'recipes/bakery-eatery.json',
      'recipes/other.json',
    ]);
    const hot = result.recipeFiles[0].file;
    expect(hot.categories).toEqual(['Coffee', 'Hot Non-Coffee']);
    expect(hot.items.map((i) => i.menu_item)).toEqual(['Test Latte', 'Test Frappe']);
    // Only the categories the snapshot has are listed.
    expect(result.recipeFiles[1].file.categories).toEqual(['Iced Coffee', 'Iced Non-Coffee']);
    expect(result.recipeFiles[5].file.categories).toEqual(['Brand New Category']);
  });

  it('writes only files that have content', () => {
    const result = run([item('1#1', 'Test Cake', [['Milk', 1, 'gm']])]);
    expect(result.recipeFiles.map((f) => f.path)).toEqual(['recipes/bakery-eatery.json']);
  });

  it('lists live items with no recipe as still missing, by category, with their sizes', () => {
    const result = run([item('1#1', 'Test Cake', [['Milk', 1, 'gm']])]);
    expect(result.report.counts.recipesMissing).toBe(ITEMS.length - 1);
    const missing = result.report.missingItems;
    expect(missing[0]).toEqual({ category: 'Coffee', menu_item: 'Test Latte', sizes: ['Large', 'Extra Large'] });
    expect(missing.find((m) => m.menu_item === 'Test Sandwich')?.sizes).toEqual(['White Bread', 'Focaccia Bread']);
    const md = renderImportReport(result.report);
    expect(md).toContain('#### Coffee (2)');
    expect(md).toContain('- Test Latte — sizes: Large, Extra Large');
  });
});

// ── Existing entries ────────────────────────────────────────────────────────

describe('existing recipes', () => {
  const ownerEntry: RecipeItemEntry = {
    menu_item_id: 'i-latte',
    menu_item: 'Test Latte',
    status: 'confirmed',
    source: 'owner',
    notes: 'owner says',
    base: lines(['Milk', 111]),
    sizes: {},
  };
  const posEntry: RecipeItemEntry = { ...ownerEntry, menu_item_id: 'i-cake', menu_item: 'Test Cake', source: 'pos', notes: '', base: lines(['Milk', 222]) };
  const chefEntry: RecipeItemEntry = { ...ownerEntry, menu_item_id: 'i-iced', menu_item: 'Test Iced', source: 'chef-default', status: 'draft', notes: 'guess', base: lines(['Milk', 333]) };
  const skipEntry: RecipeItemEntry = { ...ownerEntry, menu_item_id: 'i-espresso', menu_item: 'Test Espresso', source: 'chef-default', status: 'skip', notes: '', base: [] };
  const earlierImport: RecipeItemEntry = { ...ownerEntry, menu_item_id: 'i-waffle', menu_item: 'Test Waffle', source: 'petpooja', notes: 'old', base: lines(['Milk', 444]) };
  const goneEntry: RecipeItemEntry = { ...ownerEntry, menu_item_id: 'i-deleted', menu_item: 'Test Deleted', source: 'owner', base: lines(['Milk', 555]) };

  const existing: ExistingBook = {
    recipeFiles: [
      { path: 'recipes/hot.json', file: { categories: ['Coffee', 'Hot Non-Coffee'], items: [ownerEntry, skipEntry, goneEntry] } },
      { path: 'recipes/misc.json', file: { categories: ['Cup Cakes', 'Iced Coffee'], items: [posEntry, chefEntry, earlierImport] } },
    ],
  };
  const rows = [
    item('1#1', 'Test Latte', [['Milk', 1, 'gm']]),
    item('2#1', 'Test Cake', [['Milk', 2, 'gm']]),
    item('3#1', 'Test Iced', [['Milk', 3, 'gm']]),
    item('4#1', 'Test Espresso', [['Milk', 4, 'gm']]),
    item('5#1', 'Test Waffle (B)', [['Milk', 5, 'gm']]),
    item('5#2', 'Test Waffle (L)', [['Milk', 5, 'gm']]),
  ];

  it('never overwrites an owner or pos entry, and replaces chef-default entries and earlier imports', () => {
    const result = run(rows, { existing });
    expect(recipeOf(result, 'i-latte')).toBe(ownerEntry);
    expect(recipeOf(result, 'i-cake')).toBe(posEntry);
    expect(recipeOf(result, 'i-iced')).toMatchObject({ status: 'confirmed', source: 'petpooja', base: lines(['Milk', 3]) });
    expect(recipeOf(result, 'i-espresso')).toMatchObject({ status: 'confirmed', source: 'petpooja', base: lines(['Milk', 4]) });
    expect(recipeOf(result, 'i-waffle')).toMatchObject({ source: 'petpooja', notes: 'Petpooja: Test Waffle (B); Test Waffle (L)', base: lines(['Milk', 5]) });
    expect(result.report.counts).toMatchObject({ recipesKeptOwnerOrPos: 2, recipesImported: 3 });
    expect(result.report.keptItems.map((k) => k.name)).toEqual(['Test Latte', 'Test Cake']);
  });

  it('keeps a chef-default draft or skip that Petpooja has nothing for', () => {
    const result = run([item('2#1', 'Test Cake', [['Milk', 2, 'gm']])], { existing });
    expect(recipeOf(result, 'i-iced')).toBe(chefEntry);
    expect(recipeOf(result, 'i-espresso')).toBe(skipEntry);
    expect(result.report.counts.recipesKeptOther).toBe(3); // the draft, the skip and the earlier import
    expect(result.report.missingItems.map((m) => m.menu_item)).not.toContain('Test Iced');
    expect(result.report.missingItems.map((m) => m.menu_item)).toContain('Test Frappe');
  });

  it('drops entries whose item is no longer in the snapshot, and says so', () => {
    const result = run(rows, { existing });
    expect(recipeOf(result, 'i-deleted')).toBeUndefined();
    expect(result.report.droppedEntries).toEqual([{ kind: 'recipe', name: 'Test Deleted' }]);
  });

  it('moves kept entries into the standard files and warns about the old file', () => {
    const result = run(rows, { existing });
    expect(result.recipeFiles.find((f) => f.path === 'recipes/bakery-eatery.json')?.file.items.map((i) => i.menu_item_id)).toContain('i-cake');
    expect(result.report.staleRecipeFiles).toEqual(['recipes/misc.json']);
  });
});

// ── Add-ons ─────────────────────────────────────────────────────────────────

/** An add-on row under an item row; `size` '' for none. */
function addonRow(parentId: string, addonId: string, option: string, parentName: string, size: string, group: string, mats: Mat[]): string {
  const name = `${option} (${parentName})${size ? ` (${size})` : ''} (${group})`;
  return addon(`${parentId}#${addonId}`, name, mats);
}
const sugar = (qty: number): Mat[] => [['Sugar', qty, 'gm']];

const ADDON_PARENTS = [
  item('10#1', 'Test Latte [n] (Large)', [['Milk', 1, 'gm']]),
  item('10#2', 'Test Latte [n] (Extra Large)', [['Milk', 2, 'gm']]),
  item('20#1', 'Test Espresso [n] (Large)', [['Milk', 1, 'gm']]),
  item('20#2', 'Test Espresso [n] (Extra Large)', [['Milk', 2, 'gm']]),
  item('30#1', 'Test Frappe [n] (Large)', [['Milk', 1, 'gm']]),
  item('30#2', 'Test Frappe [n] (Extra Large)', [['Milk', 2, 'gm']]),
  item('40#1', 'Test Mocha [n] (Large)', [['Milk', 1, 'gm']]),
  item('40#2', 'Test Mocha [n] (Extra Large)', [['Milk', 2, 'gm']]),
  item('50#1', 'Test Iced [n]', [['Milk', 1, 'gm']]),
];

describe('add-ons', () => {
  const normalRows = [
    // Latte: both sizes = 20 (the general recipe, the mode)
    addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', sugar(20)),
    addonRow('10#2', 'a1', 'Normal', 'Test Latte [n]', 'Extra Large', 'Sugar', sugar(20)),
    // Espresso: both sizes = 10 -> one item-wide scope
    addonRow('20#1', 'a1', 'Normal', 'Test Espresso [n]', 'Large', 'Sugar', sugar(10)),
    addonRow('20#2', 'a1', 'Normal', 'Test Espresso [n]', 'Extra Large', 'Sugar', sugar(10)),
    // Frappe: only Extra Large differs -> one size scope
    addonRow('30#1', 'a1', 'Normal', 'Test Frappe [n]', 'Large', 'Sugar', sugar(20)),
    addonRow('30#2', 'a1', 'Normal', 'Test Frappe [n]', 'Extra Large', 'Sugar', sugar(25)),
    // Mocha: only Large has an entry, and it differs -> a size scope (not item-wide)
    addonRow('40#1', 'a1', 'Normal', 'Test Mocha [n]', 'Large', 'Sugar', sugar(15)),
    // Iced: one size, no size in the name, same as the general recipe
    addonRow('50#1', 'a1', 'Normal', 'Test Iced [n]', '', 'Sugar', sugar(20)),
  ];

  it('makes the most common line-set the general recipe, with item-wide and size scopes for the rest', () => {
    const result = run([...ADDON_PARENTS, ...normalRows]);
    const normal = optionOf(result, 'o-normal')!;
    expect(normal).toMatchObject({
      addon_option_id: 'o-normal',
      group: 'Sugar',
      option: 'Normal',
      status: 'confirmed',
      source: 'petpooja',
      notes: 'Petpooja: Sugar|Normal',
      lines: lines(['Sugar', 20]),
    });
    expect(normal.scopes).toEqual([
      { menu_item_id: 'i-espresso', menu_item: 'Test Espresso', size_label: '', lines: lines(['Sugar', 10]) },
      { menu_item_id: 'i-frappe', menu_item: 'Test Frappe', size_label: 'Extra Large', lines: lines(['Sugar', 25]) },
      { menu_item_id: 'i-mocha', menu_item: 'Test Mocha', size_label: 'Large', lines: lines(['Sugar', 15]) },
    ]);
    expect(result.report.addons.withScopes).toEqual([{ group: 'Sugar', option: 'Normal', scopes: 3 }]);
    expect(result.report.counts).toMatchObject({ addonsImported: 1, addonScopes: 3 });
  });

  it('omits scopes when nothing differs from the general recipe', () => {
    const result = run([
      ...ADDON_PARENTS,
      addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', sugar(20)),
      addonRow('20#1', 'a1', 'Normal', 'Test Espresso [n]', 'Large', 'Sugar', sugar(20)),
    ]);
    expect(optionOf(result, 'o-normal')).not.toHaveProperty('scopes');
  });

  it('uses an item-wide scope when Petpooja gave the parent row no size for an item with several', () => {
    const result = run([
      item('10#1', 'Test Latte [n] (Large)', [['Milk', 1, 'gm']]),
      item('20#1', 'Test Espresso [n] (Large)', [['Milk', 1, 'gm']]),
      item('30#1', 'Test Frappe [n]', [['Milk', 1, 'gm']]), // no size: one recipe for both sizes
      addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', sugar(20)),
      addonRow('20#1', 'a1', 'Normal', 'Test Espresso [n]', 'Large', 'Sugar', sugar(20)),
      addonRow('30#1', 'a1', 'Normal', 'Test Frappe [n]', '', 'Sugar', sugar(12)),
    ]);
    const normal = optionOf(result, 'o-normal')!;
    expect(normal.lines).toEqual(lines(['Sugar', 20]));
    expect(normal.scopes).toEqual([{ menu_item_id: 'i-frappe', menu_item: 'Test Frappe', size_label: '', lines: lines(['Sugar', 12]) }]);
  });

  it('breaks a tie by the number of menu items, then by the smaller JSON, whatever the row order', () => {
    // Tie A: set 30 on Latte Large + Extra Large (1 item), set 10 on Espresso Large + Frappe Large (2 items) -> 10 wins.
    const tieA = [
      addonRow('10#1', 'a2', 'Tie A', 'Test Latte [n]', 'Large', 'Sugar', sugar(30)),
      addonRow('10#2', 'a2', 'Tie A', 'Test Latte [n]', 'Extra Large', 'Sugar', sugar(30)),
      addonRow('20#1', 'a2', 'Tie A', 'Test Espresso [n]', 'Large', 'Sugar', sugar(10)),
      addonRow('30#1', 'a2', 'Tie A', 'Test Frappe [n]', 'Large', 'Sugar', sugar(10)),
    ];
    // Tie B: one entry each on one item each; the smaller JSON is 12 (not 9).
    const tieB = [
      addonRow('10#1', 'a3', 'Tie B', 'Test Latte [n]', 'Large', 'Sugar', sugar(9)),
      addonRow('20#1', 'a3', 'Tie B', 'Test Espresso [n]', 'Large', 'Sugar', sugar(12)),
    ];
    const rows = [...tieA, ...tieB];
    const forward = run([...ADDON_PARENTS, ...rows]);
    const backward = run([...ADDON_PARENTS, ...[...rows].reverse()]);
    for (const result of [forward, backward]) {
      expect(optionOf(result, 'o-tie-a')!.lines).toEqual(lines(['Sugar', 10]));
      expect(optionOf(result, 'o-tie-b')!.lines).toEqual(lines(['Sugar', 12]));
    }
    expect(forward.addonRecipes.options.map((o) => o.lines)).toEqual(backward.addonRecipes.options.map((o) => o.lines));
    // JSON string order: "12" sorts before "9".
    expect(optionOf(forward, 'o-tie-b')!.scopes).toEqual([{ menu_item_id: 'i-latte', menu_item: 'Test Latte', size_label: 'Large', lines: lines(['Sugar', 9]) }]);
  });

  it('ignores entries with no lines, and reports an option with nothing as missing rather than skip', () => {
    const result = run([
      ...ADDON_PARENTS,
      addonRow('10#1', 'a1', 'Brown Sugar', 'Test Latte [n]', 'Large', 'Sugar', []),
      addonRow('10#2', 'a1', 'Brown Sugar', 'Test Latte [n]', 'Extra Large', 'Sugar', [['Sugar', '', 'gm']]),
      addonRow('10#1', 'a4', 'No Sugar', 'Test Latte [n]', 'Large', 'Sugar', []),
    ]);
    expect(optionOf(result, 'o-brown')).toBeUndefined();
    expect(optionOf(result, 'o-nosugar')).toBeUndefined();
    expect(result.report.addons.emptyIgnored).toBe(3);
    expect(result.report.addons.missing.map((m) => m.option)).toEqual(expect.arrayContaining(['Brown Sugar', 'No Sugar']));
    expect(result.report.counts.addonsMissing).toBe(OPTIONS.length);
  });

  it('matches group and option by normalised equality', () => {
    const result = run([
      ...ADDON_PARENTS,
      addonRow('10#1', 'a1', 'BROWN-sugar', 'Test Latte [n]', 'Large', 'sugar', sugar(7)),
    ]);
    expect(optionOf(result, 'o-brown')).toMatchObject({ group: 'Sugar', option: 'Brown Sugar', notes: 'Petpooja: sugar|BROWN-sugar', lines: lines(['Sugar', 7]) });
  });

  it('tries the add-on alias first, and ignores an option whose alias is null', () => {
    const aliases: PetpoojaAliases = { addons: { 'Sugar|Old Sugar': 'o-brown', 'Sugar|Normal': null } };
    const result = run(
      [
        ...ADDON_PARENTS,
        addonRow('10#1', 'a1', 'Old Sugar', 'Test Latte [n]', 'Large', 'Sugar', sugar(7)),
        addonRow('10#1', 'a2', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', sugar(20)),
        addonRow('10#1', 'a3', 'Mystery', 'Test Latte [n]', 'Large', 'Sugar', sugar(1)),
        addonRow('10#2', 'a3', 'Mystery', 'Test Latte [n]', 'Extra Large', 'Sugar', sugar(1)),
      ],
      { aliases },
    );
    expect(optionOf(result, 'o-brown')?.lines).toEqual(lines(['Sugar', 7]));
    expect(optionOf(result, 'o-normal')).toBeUndefined();
    expect(result.report.addons.ignoredByAlias).toEqual([{ key: 'Sugar|Normal', rows: 1 }]);
    expect(result.report.addons.unmatched).toEqual([{ key: 'Sugar|Mystery', rows: 2 }]);
  });

  it('reports an add-on alias that points at nothing', () => {
    const result = run([...ADDON_PARENTS, addonRow('10#1', 'a1', 'Old Sugar', 'Test Latte [n]', 'Large', 'Sugar', sugar(7))], { aliases: { addons: { 'Sugar|Old Sugar': 'nope' } } });
    expect(result.report.addons.invalidAliases).toEqual([{ key: 'Sugar|Old Sugar', target: 'nope' }]);
    expect(result.report.addons.unmatched).toEqual([{ key: 'Sugar|Old Sugar', rows: 1 }]);
  });

  it('links an add-on row to the item row whose id is its prefix, and skips rows under items that did not match', () => {
    const result = run([
      item('10#1', 'Test Latte [n] (Large)', [['Milk', 1, 'gm']]),
      item('90#1', 'Not On The Menu (Large)', [['Milk', 1, 'gm']]),
      addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', sugar(20)),
      addonRow('90#1', 'a1', 'Normal', 'Not On The Menu', 'Large', 'Sugar', sugar(99)),
      addonRow('77#7', 'a1', 'Normal', 'Nobody', 'Large', 'Sugar', sugar(98)), // no parent row at all
    ]);
    expect(optionOf(result, 'o-normal')?.lines).toEqual(lines(['Sugar', 20]));
    expect(result.report.addons.parentNotMatchedRows).toBe(1);
    expect(result.report.addons.orphanRows).toBe(1);
    expect(result.report.addons.notOffered).toEqual([]);
  });

  it('leaves out rows on an item that does not offer the option\'s group', () => {
    const result = run([
      item('10#1', 'Test Latte [n] (Large)', [['Milk', 1, 'gm']]),
      item('70#1', 'Test Cake [n]', [['Milk', 1, 'gm']]),
      addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', sugar(20)),
      addonRow('70#1', 'a1', 'Normal', 'Test Cake [n]', '', 'Sugar', sugar(50)),
    ]);
    expect(optionOf(result, 'o-normal')).not.toHaveProperty('scopes');
    expect(result.report.addons.notOffered).toEqual([{ menu_item: 'Test Cake', group: 'Sugar', rows: 1 }]);
  });

  it('keeps an owner or pos option, replaces a chef-default one, and drops an option that left the snapshot', () => {
    const owner = { addon_option_id: 'o-normal', group: 'Sugar', option: 'Normal', status: 'confirmed' as const, source: 'owner' as const, notes: '', lines: lines(['Sugar', 1]) };
    const chef = { addon_option_id: 'o-brown', group: 'Sugar', option: 'Brown Sugar', status: 'draft' as const, source: 'chef-default' as const, notes: '', lines: lines(['Sugar', 2]) };
    const chefSkip = { addon_option_id: 'o-oat', group: 'Milk', option: 'Oat', status: 'skip' as const, source: 'chef-default' as const, notes: '', lines: [] };
    const gone = { addon_option_id: 'o-gone', group: 'Sugar', option: 'Gone', status: 'confirmed' as const, source: 'owner' as const, notes: '', lines: lines(['Sugar', 3]) };
    const result = run(
      [
        ...ADDON_PARENTS,
        addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', sugar(20)),
        addonRow('10#1', 'a2', 'Brown Sugar', 'Test Latte [n]', 'Large', 'Sugar', sugar(8)),
      ],
      { existing: { addonRecipes: { options: [owner, chef, chefSkip, gone] } } },
    );
    expect(optionOf(result, 'o-normal')).toBe(owner);
    expect(optionOf(result, 'o-brown')).toMatchObject({ status: 'confirmed', source: 'petpooja', lines: lines(['Sugar', 8]) });
    expect(optionOf(result, 'o-oat')).toBe(chefSkip); // nothing from Petpooja: the chef's entry stays
    expect(optionOf(result, 'o-gone')).toBeUndefined();
    expect(result.report.droppedEntries).toEqual([{ kind: 'add-on', name: 'Sugar › Gone' }]);
    expect(result.report.addons.kept.map((k) => k.name)).toEqual(['Sugar › Normal', 'Milk › Oat']);
    expect(result.addonRecipes.options.map((o) => o.addon_option_id)).toEqual(['o-normal', 'o-brown', 'o-oat']); // snapshot order
  });

  it('feeds add-on materials into the stock items', () => {
    const result = run([...ADDON_PARENTS, addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', [['Sprinkle', 3, 'pcs']])]);
    expect(result.stockItems.items.map((s) => s.name)).toContain('Sprinkle');
    expect(result.report.materialsNeedingMapping).toContain('Sprinkle');
  });
});

// ── Incomplete recipes are drafts ───────────────────────────────────────────

describe('incomplete in Petpooja', () => {
  it('imports a menu item that lost a line as a draft, naming the material and size but no quantity', () => {
    const result = run([
      item('1#1', 'Test Latte (Large)', [['Beans X', 18, 'gm'], ['Milk', '', 'gm']]),
      item('1#2', 'Test Latte (Extra Large)', [['Beans X', 27, 'gm'], ['Milk', 33, 'gm']]),
      item('2#1', 'Test Cake', [['Milk', 6, 'gm']]),
    ]);
    const latte = recipeOf(result, 'i-latte')!;
    expect(latte).toMatchObject({
      status: 'draft',
      source: 'petpooja',
      notes: 'Petpooja: Test Latte (Large); Test Latte (Extra Large). Incomplete in Petpooja — no quantity for: Milk (Large)',
    });
    // The lines that were usable are still there.
    expect(latte.sizes.Large).toEqual(lines(['Coffee beans', 18]));
    expect(latte.sizes['Extra Large']).toEqual(lines(['Coffee beans', 27], ['Milk', 33]));
    // Everything else stays confirmed.
    expect(recipeOf(result, 'i-cake')).toMatchObject({ status: 'confirmed', notes: 'Petpooja: Test Cake' });
    expect(result.report.counts).toMatchObject({ recipesImported: 2, recipesDraft: 1 });
    expect(result.report.draftItems).toEqual([
      { name: 'Test Latte', category: 'Coffee', where: ['Large'], incomplete: 'Incomplete in Petpooja — no quantity for: Milk (Large)' },
    ]);
    const md = renderImportReport(result.report);
    expect(md).toContain('## Imported as drafts');
    expect(md).toContain('- Test Latte (Coffee) — Large — Incomplete in Petpooja — no quantity for: Milk (Large)');
  });

  it('names every material and size that lost a line, and treats a blank material name or unit the same way', () => {
    const result = run([
      item('1#1', 'Test Latte (Large)', [['Beans X', 'n/a', 'gm'], ['Milk', '', 'gm'], ['', 5, 'gm']]),
      item('1#2', 'Test Latte (Extra Large)', [['Beans X', '', 'gm'], ['Sprinkles', 4, ''], ['Milk', 33, 'gm']]),
    ]);
    const latte = recipeOf(result, 'i-latte')!;
    expect(latte.status).toBe('draft');
    expect(latte.notes).toBe(
      'Petpooja: Test Latte (Extra Large). Incomplete in Petpooja — no quantity for: Beans X (Large), Milk (Large), Beans X (Extra Large); ' +
        'no known unit for: Sprinkles (Extra Large); a line with no material name (Large)',
    );
    expect(latte.notes).not.toMatch(/\b(33|4|5)\b/);
  });

  it('leaves out the size in the note for a recipe with no size', () => {
    const result = run([item('1#1', 'Test Cake', [['Milk', '', 'gm'], ['Sugar', 3, 'gm']])]);
    expect(recipeOf(result, 'i-cake')).toMatchObject({ status: 'draft', notes: 'Petpooja: Test Cake. Incomplete in Petpooja — no quantity for: Milk' });
  });

  it('counts a size whose every line was lost, and ignores the lost lines of a repeated row', () => {
    const result = run([
      item('1#1', 'Test Latte (Large)', [['Milk', '', 'gm']]),
      item('1#2', 'Test Latte (Extra Large)', [['Milk', 33, 'gm']]),
      item('2#1', 'Test Cake', [['Milk', 6, 'gm']]),
      item('2#2', 'Test Cake', [['Milk', '', 'gm'], ['Sugar', 1, 'gm']]), // repeated row: dropped whole
    ]);
    const latte = recipeOf(result, 'i-latte')!;
    expect(latte.status).toBe('draft');
    expect(Object.keys(latte.sizes)).toEqual(['Extra Large']);
    expect(latte.notes).toContain('no quantity for: Milk (Large)');
    expect(recipeOf(result, 'i-cake')).toMatchObject({ status: 'confirmed', notes: 'Petpooja: Test Cake' });
  });

  it('imports an add-on option that lost a line as a draft, naming the material, item and size', () => {
    const result = run([
      ...ADDON_PARENTS,
      addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', [['Sugar', 20, 'gm'], ['Milk', '', 'gm']]),
      addonRow('10#2', 'a1', 'Normal', 'Test Latte [n]', 'Extra Large', 'Sugar', sugar(20)),
      addonRow('50#1', 'a1', 'Normal', 'Test Iced [n]', '', 'Sugar', [['Beans X', '', 'gm']]), // lost its only line
      addonRow('10#1', 'a2', 'Brown Sugar', 'Test Latte [n]', 'Large', 'Sugar', sugar(8)),
    ]);
    expect(optionOf(result, 'o-normal')).toMatchObject({
      status: 'draft',
      source: 'petpooja',
      notes: 'Petpooja: Sugar|Normal. Incomplete in Petpooja — no quantity for: Milk (Test Latte, Large), Beans X (Test Iced)',
      lines: lines(['Sugar', 20]),
    });
    expect(optionOf(result, 'o-brown')).toMatchObject({ status: 'confirmed', notes: 'Petpooja: Sugar|Brown Sugar' });
    expect(result.report.counts).toMatchObject({ addonsImported: 2, addonsDraft: 1 });
    expect(result.report.addons.draft).toEqual([
      { name: 'Sugar › Normal', category: 'Sugar', where: ['Test Latte, Large', 'Test Iced'], incomplete: 'Incomplete in Petpooja — no quantity for: Milk (Test Latte, Large), Beans X (Test Iced)' },
    ]);
    expect(renderImportReport(result.report)).toContain('- Sugar › Normal (add-on)');
  });

  it('does not import an option whose only lines were lost', () => {
    const result = run([...ADDON_PARENTS, addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', [['Sugar', '', 'gm']])]);
    expect(optionOf(result, 'o-normal')).toBeUndefined();
    expect(result.report.addons.draft).toEqual([]);
  });

  it('treats these drafts as earlier imports: a re-import with fixed data upgrades them to confirmed', () => {
    const parents = (milk: Mat) => [
      item('10#1', 'Test Latte [n] (Large)', [['Beans X', 18, 'gm'], milk]),
      item('10#2', 'Test Latte [n] (Extra Large)', [['Beans X', 27, 'gm'], ['Milk', 33, 'gm']]),
    ];
    const first = run([
      ...parents(['Milk', '', 'gm']),
      addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', [['Sugar', 20, 'gm'], ['Milk', '', 'gm']]),
    ]);
    expect(recipeOf(first, 'i-latte')?.status).toBe('draft');
    expect(optionOf(first, 'o-normal')?.status).toBe('draft');

    const second = run(
      [
        ...parents(['Milk', 22, 'gm']),
        addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', [['Sugar', 20, 'gm'], ['Milk', 5, 'gm']]),
      ],
      {
        materials: first.materials,
        existing: { stockItems: first.stockItems as ExistingBook['stockItems'], recipeFiles: first.recipeFiles, addonRecipes: first.addonRecipes },
      },
    );
    expect(recipeOf(second, 'i-latte')).toMatchObject({ status: 'confirmed', source: 'petpooja', notes: 'Petpooja: Test Latte [n] (Large); Test Latte [n] (Extra Large)' });
    expect(optionOf(second, 'o-normal')).toMatchObject({ status: 'confirmed', source: 'petpooja', notes: 'Petpooja: Sugar|Normal' });
    expect(second.report.counts).toMatchObject({ recipesDraft: 0, addonsDraft: 0 });
  });

  it('never replaces an owner or pos entry, even when the Petpooja data is incomplete', () => {
    const owner: RecipeItemEntry = { menu_item_id: 'i-cake', menu_item: 'Test Cake', status: 'confirmed', source: 'owner', notes: '', base: lines(['Milk', 9]), sizes: {} };
    const ownerOption = { addon_option_id: 'o-normal', group: 'Sugar', option: 'Normal', status: 'confirmed' as const, source: 'pos' as const, notes: '', lines: lines(['Sugar', 1]) };
    const result = run(
      [...ADDON_PARENTS, item('2#1', 'Test Cake', [['Milk', '', 'gm']]), addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', [['Sugar', 20, 'gm'], ['Milk', '', 'gm']])],
      { existing: { recipeFiles: [{ path: 'recipes/bakery-eatery.json', file: { categories: ['Cup Cakes'], items: [owner] } }], addonRecipes: { options: [ownerOption] } } },
    );
    expect(recipeOf(result, 'i-cake')).toBe(owner);
    expect(optionOf(result, 'o-normal')).toBe(ownerOption);
    expect(result.report.counts).toMatchObject({ recipesDraft: 0, addonsDraft: 0 });
  });

  it('is deterministic', () => {
    const rows = [
      item('1#1', 'Test Latte (Large)', [['Milk', '', 'gm'], ['Beans X', 18, 'gm']]),
      ...ADDON_PARENTS,
      addonRow('10#1', 'a1', 'Normal', 'Test Latte [n]', 'Large', 'Sugar', [['Sugar', 20, 'gm'], ['Milk', '', 'gm']]),
    ];
    expect(JSON.stringify(run(rows))).toBe(JSON.stringify(run(rows)));
  });
});

// ── The report, and determinism ─────────────────────────────────────────────

describe('report and determinism', () => {
  const rows = [
    ...LATTE_ROWS,
    item('3#1', 'Test Cake', [['Milk', 123.456, 'gm'], ['Zebra Dust', 7, 'gm'], ['Sugar', '', 'gm']]),
    item('4#1', 'Gone Item (Large)', [['Milk', 1, 'gm']]),
  ];

  it('gives identical output for identical input', () => {
    const a = run(rows);
    const b = run(rows);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(renderImportReport(b.report)).toBe(renderImportReport(a.report));
  });

  it('is stable when its own output is fed back as the existing book', () => {
    const first = run(rows);
    const second = run(rows, {
      materials: first.materials,
      existing: { stockItems: first.stockItems as ExistingBook['stockItems'], recipeFiles: first.recipeFiles, addonRecipes: first.addonRecipes },
    });
    expect(second.stockItems).toEqual(first.stockItems);
    expect(second.recipeFiles).toEqual(first.recipeFiles);
    expect(second.addonRecipes).toEqual(first.addonRecipes);
    expect(second.materials).toEqual(first.materials);
  });

  it('is stable against the order of the rows for the sorted parts', () => {
    const a = run(rows);
    const b = run([...rows].reverse());
    expect(b.stockItems).toEqual(a.stockItems);
    expect(b.report.missingItems).toEqual(a.report.missingItems);
    expect(b.report.unmatchedItems).toEqual(a.report.unmatchedItems);
    expect(Object.keys(b.materials)).toEqual(Object.keys(a.materials));
  });

  it('renders a markdown report with the sections, and no quantities', () => {
    const md = renderImportReport(run(rows).report);
    for (const heading of ['## STILL MISSING', '### Menu items with no recipe', '## Matched menu items', '## Petpooja items with no live match', '## Add-ons', '## Units', '## Materials']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('Gone Item');
    expect(md).toContain('Zebra Dust');
    for (const quantity of ['123.456', '240', '330']) expect(md).not.toContain(quantity);
  });

  it('never puts a quantity into the report data', () => {
    const json = JSON.stringify(run(rows).report);
    expect(json).not.toContain('123.456');
  });
});
