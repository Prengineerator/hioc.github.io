// inventory:build — validate the recipe book, compile it, and write the seed
// SQL that loads it into Supabase (docs/INVENTORY-RECIPE-BOOK.md).
//
//   npm run inventory:build                       # confirmed recipes only
//   npm run inventory:build -- --include-drafts   # also drafts (preview/test databases)
//   npm run inventory:build -- --dry-run          # SQL that rolls itself back
//   npm run inventory:build -- --out <path>       # default <book>/seed.sql
//   npm run inventory:build -- --book <dir>       # a book kept elsewhere
//
// The seed SQL holds the café's recipe quantities, so it goes in the git-ignored
// book folder by default, never in supabase/. Refuses to write while
// `npm run inventory:check` has errors. Exit 1: errors or an unreadable book
// file. Exit 2: bad arguments.

import fs from 'node:fs';
import path from 'node:path';
import { loadRecipeBook, resolveBookDir } from '@/lib/inventory/recipeBookFs';
import { compileRecipeBook, formatIssue, renderSeedSql, seedCounts, validateRecipeBook } from '@/lib/inventory/recipeBook';
import { parseArgs } from './args';

/** Where the real seed goes by default, inside the book folder. */
const DEFAULT_OUT_NAME = 'seed.sql';
/** Where --dry-run writes by default (so it never replaces the real seed); git-ignored. */
const DRY_RUN_OUT = 'scripts/inventory/.dry-run.sql';

function main(): number {
  const args = parseArgs(process.argv.slice(2), ['--include-drafts', '--dry-run'], ['--out', '--book']);
  if (args.problems.length > 0) {
    console.error(
      `inventory:build: ${args.problems.join('; ')}\n` +
        'usage: npm run inventory:build -- [--include-drafts] [--dry-run] [--out <path>] [--book <dir>]',
    );
    return 2;
  }
  const includeDrafts = args.flags.has('--include-drafts');
  const dryRun = args.flags.has('--dry-run');

  const root = process.cwd();
  const bookDir = args.values.get('--book');
  const defaultOut = path.join(resolveBookDir(root, bookDir), DEFAULT_OUT_NAME);
  const out = args.values.get('--out') ?? (dryRun ? DRY_RUN_OUT : defaultOut);
  let book;
  try {
    book = loadRecipeBook(root, { bookDir });
  } catch (err) {
    console.error(`inventory:build: ${(err as Error).message}`);
    return 1;
  }

  const { errors, warnings, coverage } = validateRecipeBook(book);
  if (errors.length > 0) {
    console.error(`inventory:build: not writing anything — ${errors.length} error${errors.length === 1 ? '' : 's'} in ${resolveBookDir(root, bookDir)}:`);
    for (const issue of errors) console.error(`  ERROR ${formatIssue(issue)}`);
    return 1;
  }

  const payload = compileRecipeBook(book, { includeDrafts });
  const sql = renderSeedSql(payload, { includeDrafts, snapshotCapturedAt: book.snapshot.captured_at, dryRun });
  const outFile = path.resolve(root, out);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, sql);

  const c = seedCounts(payload);
  const shown = path.relative(root, outFile);
  console.log(`Wrote ${shown.startsWith('..') ? outFile : shown} (${includeDrafts ? 'confirmed + DRAFT recipes' : 'confirmed recipes only'}${dryRun ? ', DRY RUN' : ''})`);
  console.log(`  Stock items: ${c.stockItems} · Menu-item recipes: ${c.recipes} (${c.recipeLines} lines) · Add-on recipes: ${c.addonRecipes} (${c.addonLines} lines)`);
  if (!includeDrafts) {
    const left = coverage.overall.draft;
    if (left > 0) console.log(`  ${left} draft recipe${left === 1 ? '' : 's'} left out — they are deployed only once confirmed (or with --include-drafts on a preview database).`);
  } else if (!dryRun) {
    console.log('  NOTE: this file has DRAFT recipes in it — apply it to a preview/test database only, and do not commit it.');
  }
  if (dryRun) console.log('  DRY RUN: run it in the SQL editor to see what would happen; it ends with an exception so nothing is saved.');
  if (warnings.length > 0) console.log(`  ${warnings.length} warning${warnings.length === 1 ? '' : 's'} — see npm run inventory:check`);
  return 0;
}

process.exitCode = main();
