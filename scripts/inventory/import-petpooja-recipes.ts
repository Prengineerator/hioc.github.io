// inventory:import-petpooja — Petpooja "Item Addon Recipe" export -> the recipe
// book (docs/INVENTORY-RECIPE-BOOK.md, "Importing from Petpooja").
//
//   npm run inventory:import-petpooja                       # <book>/petpooja/Item_Addon_Recipe.csv
//   npm run inventory:import-petpooja -- --csv <path>       # another export
//   npm run inventory:import-petpooja -- --book <dir>       # a book kept elsewhere
//
// Writes stock-items.json, recipes/*.json, addon-recipes.json,
// petpooja/materials.json and import-report.md into the book directory (all
// git-ignored: the recipes are private). Never removes a file. Idempotent: the
// same inputs give byte-identical files.
//
// Exit 0: imported. Exit 1: a file could not be read or is not valid. Exit 2: bad arguments.

import fs from 'node:fs';
import path from 'node:path';
import { importPetpoojaRecipes, parsePetpoojaRecipeCsv, renderImportReport, type MaterialsMap, type PetpoojaAliases } from '@/lib/inventory/petpoojaRecipes';
import { loadRecipeBook, resolveBookDir } from '@/lib/inventory/recipeBookFs';
import { parseArgs } from './args';

function readJsonOr<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    throw new Error(`${file} is not valid JSON — ${(err as Error).message}`);
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), [], ['--csv', '--book']);
  if (args.problems.length > 0) {
    console.error(`inventory:import-petpooja: ${args.problems.join('; ')}\nusage: npm run inventory:import-petpooja -- [--csv <path>] [--book <dir>]`);
    return 2;
  }

  const root = process.cwd();
  const bookDir = args.values.get('--book');
  const dir = resolveBookDir(root, bookDir);
  const csvPath = path.resolve(root, args.values.get('--csv') ?? path.join(dir, 'petpooja', 'Item_Addon_Recipe.csv'));

  try {
    if (!fs.existsSync(csvPath)) throw new Error(`${csvPath} is missing — put the Petpooja "Item Addon Recipe" export there, or pass --csv <path>`);
    const rows = parsePetpoojaRecipeCsv(fs.readFileSync(csvPath, 'utf8'));
    const book = loadRecipeBook(root, { bookDir });

    const aliasesFile = path.join(dir, 'petpooja', 'aliases.json');
    const materialsFile = path.join(dir, 'petpooja', 'materials.json');
    const aliases = readJsonOr<PetpoojaAliases>(aliasesFile, { items: {}, addons: {} });
    const materials = readJsonOr<MaterialsMap>(materialsFile, {});
    if (!fs.existsSync(aliasesFile)) writeJson(aliasesFile, { items: {}, addons: {} });

    const result = importPetpoojaRecipes({
      rows,
      snapshot: book.snapshot,
      aliases,
      materials,
      existing: { stockItems: book.stockItems, recipeFiles: book.recipeFiles, addonRecipes: book.addonRecipes },
    });

    writeJson(path.join(dir, 'stock-items.json'), result.stockItems);
    for (const { path: relative, file } of result.recipeFiles) writeJson(path.join(dir, relative), file);
    writeJson(path.join(dir, 'addon-recipes.json'), result.addonRecipes);
    writeJson(materialsFile, result.materials);
    fs.writeFileSync(path.join(dir, 'import-report.md'), renderImportReport(result.report));

    const c = result.report.counts;
    console.log(`Imported ${csvPath}`);
    console.log(`Book: ${dir}`);
    console.log(
      `Menu items: ${c.recipesImported} imported (${c.recipesDraft} draft) · ${c.recipesKeptOwnerOrPos + c.recipesKeptOther} kept · ${c.recipesMissing} missing of ${c.menuItems}` +
        (c.itemsWithMissingSizes > 0 ? ` · ${c.itemsWithMissingSizes} with sizes missing` : ''),
    );
    console.log(
      `Add-ons: ${c.addonsImported} imported (${c.addonsDraft} draft, ${c.addonScopes} scopes) · ${c.addonsKeptOwnerOrPos + c.addonsKeptOther} kept · ${c.addonsMissing} missing of ${c.addonOptions}`,
    );
    console.log(`Stock items: ${c.stockItems} (${c.stockItemsImported} from the import) · ${c.materialsNeedingMapping} materials need a category`);
    console.log(
      `Petpooja items not matched: ${result.report.unmatchedItems.length} · add-ons not matched: ${result.report.addons.unmatched.length} · unit conflicts: ${c.unitConflicts} · lines dropped: ${c.droppedLines}`,
    );
    if (result.report.unitMergeErrors.length > 0) console.log(`ERROR: ${result.report.unitMergeErrors.length} merged stock item(s) disagree on the unit — see import-report.md`);
    if (result.report.staleRecipeFiles.length > 0) console.log(`Warning: remove old recipe file(s) by hand: ${result.report.staleRecipeFiles.join(', ')}`);
    console.log(`Still missing: ${c.recipesMissing} items (see ${path.join(dir, 'import-report.md')})`);
    return 0;
  } catch (err) {
    console.error(`inventory:import-petpooja: ${(err as Error).message}`);
    return 1;
  }
}

process.exitCode = main();
