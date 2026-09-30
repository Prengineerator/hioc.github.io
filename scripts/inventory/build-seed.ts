// inventory:build — validate the recipe book, compile it, and write the seed
// SQL that loads it into Supabase (docs/INVENTORY-RECIPE-BOOK.md).
//
//   npm run inventory:build                       # confirmed recipes only
//   npm run inventory:build -- --include-drafts   # also drafts (preview/test databases)
//   npm run inventory:build -- --save-only        # only save the book in the database
//   npm run inventory:build -- --dry-run          # SQL that rolls itself back
//   npm run inventory:build -- --out <path>       # see --help for the default
//   npm run inventory:build -- --book <dir>       # a book kept elsewhere
//
// The seed SQL is one `select inventory_apply_book(...)` (the logic is the
// database function in supabase/2026-10-inventory-apply-book.sql, which must be
// applied first). Too big for the SQL editor? `npm run inventory:apply` makes the
// same call over REST. It holds the café's recipe quantities, so it goes in the
// git-ignored book folder by default, never in supabase/. Refuses to write while
// `npm run inventory:check` has errors (except --save-only, see --help).
// Exit 1: errors or an unreadable book file. Exit 2: bad arguments, or an --out
// path that is refused.

import fs from 'node:fs';
import path from 'node:path';
import { checkSeedOutPath, defaultSeedName, loadRecipeBook, resolveBookDir, type SeedMode } from '@/lib/inventory/recipeBookFs';
import {
  bookCounts,
  compileRecipeBook,
  formatIssue,
  parseBookDocument,
  renderSaveOnlySql,
  renderSeedSql,
  seedCounts,
  toBookDocument,
  validateRecipeBook,
} from '@/lib/inventory/recipeBook';
import { parseArgs } from './args';

const MAX_ERRORS_PRINTED = 40;

const USAGE = [
  'usage: npm run inventory:build -- [--include-drafts] [--save-only] [--dry-run] [--out <path>] [--force-out] [--book <dir>]',
  '',
  '  (no flags)        <book>/seed.sql: saves the whole book in the database, then applies the',
  '                    confirmed recipes. Refuses to write while `npm run inventory:check` has errors.',
  '  --include-drafts  also apply draft recipes (preview/test databases only)',
  '  --save-only       <book>/save-only.sql: ONLY saves the book (drafts and notes included) in',
  '                    inventory_recipe_book. It changes no stock items or recipes, so it is allowed',
  '                    while the book has validation errors: they are printed as warnings and the',
  '                    book is saved as it is. Only a book of the wrong SHAPE (a file that is not an',
  '                    object with its lists) is refused. Cannot be combined with --include-drafts.',
  '  --dry-run         same SQL, but the call is made with p_dry_run: it ends by raising an exception',
  '                    so nothing is saved.',
  '                    Writes <book>/seed.dry-run.sql (with --save-only: <book>/save-only.dry-run.sql)',
  '  --out <path>      write the SQL here instead. A path inside the repository but outside the book',
  '                    folder (and outside the OS temp folder) is refused unless --force-out is given:',
  '                    the SQL holds recipe quantities and must not land in a committed path',
  '  --force-out       allow such an --out path',
  '  --book <dir>      the book folder (default $INVENTORY_BOOK_DIR, else data/inventory/book)',
].join('\n');

function main(): number {
  const args = parseArgs(process.argv.slice(2), ['--include-drafts', '--dry-run', '--save-only', '--force-out', '--help'], ['--out', '--book']);
  if (args.flags.has('--help')) {
    console.log(USAGE);
    return 0;
  }
  if (args.problems.length > 0) {
    console.error(`inventory:build: ${args.problems.join('; ')}\n${USAGE}`);
    return 2;
  }
  const includeDrafts = args.flags.has('--include-drafts');
  const dryRun = args.flags.has('--dry-run');
  const saveOnly = args.flags.has('--save-only');
  if (saveOnly && includeDrafts) {
    console.error(`inventory:build: --include-drafts has no effect with --save-only (the whole book, drafts included, is always saved)\n${USAGE}`);
    return 2;
  }

  const root = process.cwd();
  const bookDir = args.values.get('--book');
  const bookDirAbs = resolveBookDir(root, bookDir);
  const mode: SeedMode = saveOnly ? (dryRun ? 'save-only-dry-run' : 'save-only') : dryRun ? 'dry-run' : 'seed';
  const out = args.values.get('--out') ?? path.join(bookDirAbs, defaultSeedName(mode));
  const outCheck = checkSeedOutPath(root, bookDirAbs, out, { forceOut: args.flags.has('--force-out') });
  if (!outCheck.ok) {
    console.error(`inventory:build: not writing anything — ${outCheck.reason}`);
    return 2;
  }

  let book;
  try {
    book = loadRecipeBook(root, { bookDir });
  } catch (err) {
    console.error(`inventory:build: ${(err as Error).message}`);
    return 1;
  }

  const { errors, warnings, coverage } = validateRecipeBook(book);
  if (errors.length > 0 && !saveOnly) {
    console.error(`inventory:build: not writing anything — ${errors.length} error${errors.length === 1 ? '' : 's'} in ${bookDirAbs}:`);
    for (const issue of errors) console.error(`  ERROR ${formatIssue(issue)}`);
    return 1;
  }

  // The document is what gets saved. Its shape must be right even for --save-only.
  const doc = toBookDocument(book);
  try {
    parseBookDocument(doc);
  } catch (err) {
    console.error(`inventory:build: not writing anything — the book cannot be saved: ${(err as Error).message}`);
    return 1;
  }

  const outFile = path.resolve(root, out);
  const shown = path.relative(root, outFile);
  const where = shown.startsWith('..') ? outFile : shown;
  const saved = bookCounts(doc);
  const savedLine = `  Saves the book: ${saved.stockItems} stock items · ${saved.recipeFiles} recipe files (${saved.recipeEntries} items) · ${saved.addonOptions} add-on options${saved.petpooja ? ' · Petpooja aliases/materials' : ''}`;

  if (saveOnly) {
    const sql = renderSaveOnlySql(doc, { snapshotCapturedAt: book.snapshot.captured_at, dryRun });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, sql);
    console.log(`Wrote ${where} (SAVE ONLY${dryRun ? ', DRY RUN' : ''})`);
    console.log(savedLine);
    console.log('  It changes no stock items or recipes.');
    if (errors.length > 0) {
      console.log(`  ${errors.length} validation error${errors.length === 1 ? '' : 's'} in the book, saved anyway (fix them before a real build):`);
      for (const issue of errors.slice(0, MAX_ERRORS_PRINTED)) console.log(`    warn  ${formatIssue(issue)}`);
      if (errors.length > MAX_ERRORS_PRINTED) console.log(`    …and ${errors.length - MAX_ERRORS_PRINTED} more`);
    }
    if (dryRun) console.log('  DRY RUN: run it in the SQL editor to check it; it ends with an exception so nothing is saved.');
    console.log('  Needs supabase/2026-10-inventory-apply-book.sql applied first. Or: npm run inventory:apply -- --save-only');
    if (warnings.length > 0) console.log(`  ${warnings.length} warning${warnings.length === 1 ? '' : 's'} — see npm run inventory:check`);
    return 0;
  }

  const payload = compileRecipeBook(book, { includeDrafts });
  const sql = renderSeedSql(payload, { includeDrafts, snapshotCapturedAt: book.snapshot.captured_at, bookDocument: doc, dryRun });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, sql);

  const c = seedCounts(payload);
  console.log(`Wrote ${where} (${includeDrafts ? 'confirmed + DRAFT recipes' : 'confirmed recipes only'}${dryRun ? ', DRY RUN' : ''})`);
  console.log(`  Stock items: ${c.stockItems} · Menu-item recipes: ${c.recipes} (${c.recipeLines} lines) · Add-on recipes: ${c.addonRecipes} (${c.addonLines} lines, ${c.addonScopedLines} scoped)`);
  console.log(savedLine);
  if (!includeDrafts) {
    const left = coverage.overall.draft;
    if (left > 0) console.log(`  ${left} draft recipe${left === 1 ? '' : 's'} left out — they are deployed only once confirmed (or with --include-drafts on a preview database).`);
  } else if (!dryRun) {
    console.log('  NOTE: this file has DRAFT recipes in it — apply it to a preview/test database only, and do not commit it.');
  }
  if (dryRun) console.log('  DRY RUN: run it in the SQL editor to see what would happen; it ends with an exception so nothing is saved.');
  console.log('  Needs supabase/2026-10-inventory-apply-book.sql applied first. Too big for the SQL editor? npm run inventory:apply -- --dry-run, then --yes');
  if (warnings.length > 0) console.log(`  ${warnings.length} warning${warnings.length === 1 ? '' : 's'} — see npm run inventory:check`);
  return 0;
}

process.exitCode = main();
