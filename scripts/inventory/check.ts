// inventory:check — validate the recipe book against the live menu snapshot and
// print how much of the menu has a recipe (docs/INVENTORY-RECIPE-BOOK.md).
//
//   npm run inventory:check                 # data/inventory/book, or $INVENTORY_BOOK_DIR
//   npm run inventory:check -- --book <dir> # a book kept elsewhere
//
// Exit 0: no errors (warnings and missing coverage are fine). Exit 1: errors,
// or a book file that cannot be read. Exit 2: bad arguments.

import { loadRecipeBook, resolveBookDir } from '@/lib/inventory/recipeBookFs';
import { formatIssue, validateRecipeBook, type CoverageCounts } from '@/lib/inventory/recipeBook';
import { parseArgs } from './args';

const MAX_WARNINGS_PRINTED = 40;

function table(rows: { label: string; counts: CoverageCounts }[]): string[] {
  const header = ['Category', 'total', 'confirmed', 'draft', 'skip', 'missing'];
  const cells = rows.map((r) => [r.label, ...(['total', 'confirmed', 'draft', 'skip', 'missing'] as const).map((k) => String(r.counts[k]))]);
  const widths = header.map((h, col) => Math.max(h.length, ...cells.map((c) => c[col].length)));
  const line = (parts: string[]) => parts.map((p, col) => (col === 0 ? p.padEnd(widths[col]) : p.padStart(widths[col]))).join(' | ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('-|-'), ...cells.map(line)];
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), [], ['--book']);
  if (args.problems.length > 0) {
    console.error(`inventory:check: ${args.problems.join('; ')}\nusage: npm run inventory:check -- [--book <dir>]`);
    return 2;
  }

  const root = process.cwd();
  const bookDir = args.values.get('--book');
  let book;
  try {
    book = loadRecipeBook(root, { bookDir });
  } catch (err) {
    console.error(`inventory:check: ${(err as Error).message}`);
    return 1;
  }

  const { errors, warnings, coverage } = validateRecipeBook(book);
  console.log(`Recipe book: ${resolveBookDir(root, bookDir)}`);
  console.log(`Menu snapshot captured ${book.snapshot.captured_at} · ${book.stockItems.items?.length ?? 0} stock items · ${book.recipeFiles.length} recipe files`);

  if (errors.length > 0) {
    console.log(`\n${errors.length} error${errors.length === 1 ? '' : 's'}:`);
    for (const issue of errors) console.log(`  ERROR ${formatIssue(issue)}`);
  }
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`);
    for (const issue of warnings.slice(0, MAX_WARNINGS_PRINTED)) console.log(`  warn  ${formatIssue(issue)}`);
    if (warnings.length > MAX_WARNINGS_PRINTED) console.log(`  …and ${warnings.length - MAX_WARNINGS_PRINTED} more`);
  }

  console.log('');
  const rows = [
    ...coverage.categories.map((c) => ({ label: c.category, counts: c })),
    { label: 'Add-ons', counts: coverage.addons },
  ];
  for (const l of table(rows)) console.log(l);

  const m = coverage.menuItems;
  const a = coverage.addons;
  console.log(
    `\nCoverage: ${m.confirmed} confirmed · ${m.draft} draft · ${m.skip} skip · ${m.missing} missing of ${m.total} menu items; ` +
      `add-ons ${a.confirmed}/${a.draft}/${a.skip}/${a.missing} of ${a.total}`,
  );
  console.log(errors.length > 0 ? `\nFAILED: ${errors.length} error${errors.length === 1 ? '' : 's'}.` : '\nOK: no errors.');
  return errors.length > 0 ? 1 : 0;
}

process.exitCode = main();
