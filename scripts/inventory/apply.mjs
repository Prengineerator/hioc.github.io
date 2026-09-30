#!/usr/bin/env node
// ===========================================================================
// inventory:apply — apply the recipe book to the database in ONE request
// (docs/INVENTORY-RECIPE-BOOK.md).
//
// The seed's logic is the database function inventory_apply_book
// (supabase/2026-10-inventory-apply-book.sql). This script validates the book,
// compiles it exactly as `npm run inventory:build` does, and calls the function
// over PostgREST (`POST /rest/v1/rpc/inventory_apply_book`, service-role key):
// one request, one transaction, all or nothing. It is for when <book>/seed.sql
// is too big for the Supabase SQL editor and there is no direct connection.
//
// Run:  npm run inventory:apply -- [--dry-run | --yes] [--include-drafts] [--save-only] [--book <dir>]
//   --dry-run         run every step in the database, then roll it all back
//                     (the server ends with an error "DRY RUN OK ...": expected)
//   --yes             required to really apply. Without it (and without
//                     --dry-run) the script only prints what WOULD be applied,
//                     and where, and exits 2
//   --include-drafts  also apply draft recipes (preview/test databases only)
//   --save-only       only save the book in inventory_recipe_book; no stock item
//                     or recipe changes. Allowed while the book has validation
//                     errors (printed as warnings), like `inventory:build`
//   --book <dir>      the book folder (default $INVENTORY_BOOK_DIR, else
//                     data/inventory/book)
//   --help
//
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the environment,
// else .env.local; the environment wins). The key is only ever sent as the
// apikey / Authorization headers and is never printed. The target host is
// printed before anything is sent.
//
// Like scripts/inventory/pull.mjs it talks to PostgREST with plain fetch; tsx's
// tsImport loads the TypeScript. Every decision (the URL, what an answer means,
// how it is worded) is in lib/inventory/recipeBookApply.ts (unit-tested).
//
// Exit 0: applied, or the dry run passed. Exit 1: the book has errors, the
// database refused it, or any failure. Exit 2: bad arguments, or --yes missing.
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

// fileURLToPath, not url.pathname — see scripts/verify-db.mjs.
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function die(msg, code = 1) {
  process.stderr.write(`\ninventory:apply: ${msg}\n`);
  process.exit(code);
}
const say = (line = '') => process.stdout.write(`${line}\n`);

const load = (rel) => tsImport(rel, { parentURL: import.meta.url, tsconfig: path.join(ROOT, 'tsconfig.json') });
const { parseArgs } = await load('./args.ts');
const { loadRecipeBook, resolveBookDir } = await load('../../lib/inventory/recipeBookFs.ts');
const {
  bookCounts,
  buildApplyRequest,
  compileRecipeBook,
  formatIssue,
  seedCounts,
  toBookDocument,
  validateRecipeBook,
} = await load('../../lib/inventory/recipeBook.ts');
const { APPLY_FUNCTION, applyEndpoint, formatApplyFailure, formatBytes, interpretApplyResponse, parseEnvText, pickEnv, targetHost } = await load(
  '../../lib/inventory/recipeBookApply.ts',
);

const MAX_ERRORS_PRINTED = 40;
const TIMEOUT_MS = 180_000;

const USAGE = [
  'usage: npm run inventory:apply -- [--dry-run | --yes] [--include-drafts] [--save-only] [--book <dir>]',
  '',
  '  (no flags)        prints what WOULD be applied and to which host, sends nothing, exits 2',
  '  --dry-run         runs every step in the database, then rolls it all back ("DRY RUN OK")',
  '  --yes             really applies: saves the whole book, then applies the confirmed recipes',
  '  --include-drafts  also apply draft recipes (preview/test databases only)',
  '  --save-only       only saves the book (drafts and notes included); changes no stock items or',
  '                    recipes, so it is allowed while the book has validation errors (shown as',
  '                    warnings). Cannot be combined with --include-drafts',
  '  --book <dir>      the book folder (default $INVENTORY_BOOK_DIR, else data/inventory/book)',
  '',
  `Calls ${APPLY_FUNCTION} over REST with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`,
  '(environment, else .env.local). Needs supabase/2026-10-inventory-apply-book.sql applied first.',
].join('\n');

const args = parseArgs(process.argv.slice(2), ['--include-drafts', '--save-only', '--dry-run', '--yes', '--help'], ['--book']);
if (args.flags.has('--help')) {
  say(USAGE);
  process.exit(0);
}
if (args.problems.length > 0) die(`${args.problems.join('; ')}\n${USAGE}`, 2);
const includeDrafts = args.flags.has('--include-drafts');
const saveOnly = args.flags.has('--save-only');
const dryRun = args.flags.has('--dry-run');
const yes = args.flags.has('--yes');
if (saveOnly && includeDrafts) {
  die(`--include-drafts has no effect with --save-only (the whole book, drafts included, is always saved)\n${USAGE}`, 2);
}

// ── The book: validated exactly like inventory:build ────────────────────────
const bookDirArg = args.values.get('--book');
const bookDir = resolveBookDir(ROOT, bookDirArg);
let book;
try {
  book = loadRecipeBook(ROOT, { bookDir: bookDirArg });
} catch (err) {
  die(err?.message || String(err));
}
const { errors, warnings } = validateRecipeBook(book);
if (errors.length > 0 && !saveOnly) {
  process.stderr.write(`\ninventory:apply: not applying anything — ${errors.length} error${errors.length === 1 ? '' : 's'} in ${bookDir}:\n`);
  for (const issue of errors.slice(0, MAX_ERRORS_PRINTED)) process.stderr.write(`  ERROR ${formatIssue(issue)}\n`);
  if (errors.length > MAX_ERRORS_PRINTED) process.stderr.write(`  …and ${errors.length - MAX_ERRORS_PRINTED} more\n`);
  process.exit(1);
}

let request;
let payload = null;
const doc = toBookDocument(book);
try {
  payload = saveOnly ? null : compileRecipeBook(book, { includeDrafts });
  request = buildApplyRequest(payload, doc, { dryRun });
} catch (err) {
  die(`not applying anything — ${err?.message || String(err)}`);
}
const body = JSON.stringify(request);

// ── Where it goes ───────────────────────────────────────────────────────────
let fileEnv = {};
try {
  fileEnv = parseEnvText(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8'));
} catch {
  // no .env.local: the environment has to have it
}
const BASE = pickEnv('NEXT_PUBLIC_SUPABASE_URL', process.env, fileEnv);
const KEY = pickEnv('SUPABASE_SERVICE_ROLE_KEY', process.env, fileEnv);
if (!BASE) die('need NEXT_PUBLIC_SUPABASE_URL in .env.local (or the environment)');
if (!KEY) die('need SUPABASE_SERVICE_ROLE_KEY in .env.local (or the environment). Calling the function takes the service-role key; the anon key cannot.');
let endpoint;
let host;
try {
  endpoint = applyEndpoint(BASE);
  host = targetHost(BASE);
} catch (err) {
  die(err?.message || String(err));
}

// ── What it is ──────────────────────────────────────────────────────────────
const shown = path.relative(ROOT, bookDir);
const saved = bookCounts(doc);
const mode = saveOnly ? 'SAVE ONLY (the book; no stock items or recipes)' : includeDrafts ? 'confirmed + DRAFT recipes' : 'confirmed recipes only';
say(`inventory:apply — ${mode}${dryRun ? ', DRY RUN' : ''}`);
say(`  Target:   ${host}  (${APPLY_FUNCTION})`);
say(`  Book:     ${shown.startsWith('..') ? bookDir : shown}`);
if (payload) {
  const c = seedCounts(payload);
  say(`  Applies:  ${c.stockItems} stock items · ${c.recipes} menu-item recipes (${c.recipeLines} lines) · ${c.addonRecipes} add-on recipes (${c.addonLines} lines, ${c.addonScopedLines} scoped)`);
}
say(`  Saves the book: ${saved.stockItems} stock items · ${saved.recipeFiles} recipe files (${saved.recipeEntries} items) · ${saved.addonOptions} add-on options${saved.petpooja ? ' · Petpooja aliases/materials' : ''}`);
say(`  Payload:  ${formatBytes(Buffer.byteLength(body))}`);
if (errors.length > 0) {
  say(`  ${errors.length} validation error${errors.length === 1 ? '' : 's'} in the book, saved anyway (fix them before a real apply):`);
  for (const issue of errors.slice(0, MAX_ERRORS_PRINTED)) say(`    warn  ${formatIssue(issue)}`);
  if (errors.length > MAX_ERRORS_PRINTED) say(`    …and ${errors.length - MAX_ERRORS_PRINTED} more`);
}
if (warnings.length > 0) say(`  ${warnings.length} warning${warnings.length === 1 ? '' : 's'} — see npm run inventory:check`);
if (includeDrafts && !dryRun) say('  NOTE: this includes DRAFT recipes — apply it to a preview/test database only.');

if (!dryRun && !yes) {
  say();
  say(`Nothing was sent. This would change the database at ${host}.`);
  say('Run it again with --dry-run to check it (everything is rolled back), then with --yes to apply it.');
  process.exit(2);
}

// ── One request ─────────────────────────────────────────────────────────────
say();
say(dryRun ? `Dry run: sending to ${host} …` : `Applying to ${host} …`);
let res;
let text;
try {
  res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  text = await res.text();
} catch (err) {
  die(
    `no answer from ${host} (${err?.message || err}). The call is one transaction, so it either happened whole or not at all — ` +
      'it is safe to run it again (npm run inventory:pull shows what is saved).',
  );
}

const outcome = interpretApplyResponse({ status: res.status, text }, { dryRun });
switch (outcome.kind) {
  case 'applied':
    say(JSON.stringify(outcome.result, null, 2));
    say('Applied.');
    break;
  case 'dry-run-ok':
    say(outcome.message);
    say('Dry run passed; nothing was saved.');
    break;
  default: {
    process.stderr.write('\n');
    const [first, ...rest] = formatApplyFailure(outcome);
    process.stderr.write(`inventory:apply: ${first}\n`);
    for (const line of rest) process.stderr.write(`${line}\n`);
    if (outcome.code) process.stderr.write('Nothing was saved: the call is one transaction.\n');
    process.exit(1);
  }
}
