#!/usr/bin/env node
// ===========================================================================
// inventory:pull — bring the recipe book back from the database into the book
// folder (docs/INVENTORY-RECIPE-BOOK.md).
//
// The book's permanent home is the service-role-only table
// `inventory_recipe_book`: every `npm run inventory:build` seed (and
// `--save-only`) saves the whole book there, drafts and notes included. The
// recipes are private (the GitHub repo is public and the book is git-ignored),
// so a fresh checkout or a new machine starts empty; this restores it.
//
// Run:  npm run inventory:pull [-- --book <dir>] [-- --force]
//   --book <dir>  the book folder (default $INVENTORY_BOOK_DIR, else
//                 data/inventory/book)
//   --force       overwrite a book folder that already has a stock-items.json
//                 (without it, pulling refuses: it would replace work in progress)
//
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local (or
// the environment). Unlike inventory:snapshot the anon key is NOT enough: the
// table is readable by the service role only.
//
// Like scripts/inventory/snapshot-menu.mjs it reads .env.local by hand and talks
// to PostgREST with plain fetch. The document-to-files logic is
// writeBookDocument in lib/inventory/recipeBookFs.ts (unit-tested); tsx's
// tsImport loads that TypeScript from plain node.
//
// Exit 0: written. Exit 1: nothing saved yet, a folder that must not be
// overwritten, or any failure. Exit 2: bad arguments.
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

// fileURLToPath, not url.pathname — see scripts/verify-db.mjs.
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function die(msg, code = 1) {
  process.stderr.write(`\ninventory:pull: ${msg}\n`);
  process.exit(code);
}

// Same parsing as scripts/inventory/snapshot-menu.mjs: KEY=value lines, and the
// Supabase values in this repo are written double-quoted, so strip a matched pair.
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const load = (rel) => tsImport(rel, { parentURL: import.meta.url, tsconfig: path.join(ROOT, 'tsconfig.json') });
const { parseArgs } = await load('./args.ts');
const { resolveBookDir, writeBookDocument } = await load('../../lib/inventory/recipeBookFs.ts');

const USAGE = 'usage: npm run inventory:pull -- [--book <dir>] [--force]';
const args = parseArgs(process.argv.slice(2), ['--force', '--help'], ['--book']);
if (args.flags.has('--help')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (args.problems.length > 0) die(`${args.problems.join('; ')}\n${USAGE}`, 2);
const force = args.flags.has('--force');
const bookDir = resolveBookDir(ROOT, args.values.get('--book'));

const fileEnv = loadEnv(path.join(ROOT, '.env.local'));
const env = (name) => fileEnv[name] || process.env[name] || '';

const BASE = env('NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, '');
const KEY = env('SUPABASE_SERVICE_ROLE_KEY');
if (!BASE) die('need NEXT_PUBLIC_SUPABASE_URL in .env.local');
if (!KEY) {
  die(
    'need SUPABASE_SERVICE_ROLE_KEY in .env.local (or the environment). The saved book is in a service-role-only table, so the anon key cannot read it.',
  );
}

// Fail before the network call if the folder is not to be overwritten.
if (!force && fs.existsSync(path.join(bookDir, 'stock-items.json'))) {
  die(`${path.join(bookDir, 'stock-items.json')} already exists — pulling would replace this book. Pass --force to overwrite it.`);
}

const url = `${BASE}/rest/v1/inventory_recipe_book?select=book,saved_at&id=eq.true`;
let res;
try {
  res = await fetch(url, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
} catch (err) {
  die(`could not reach ${BASE} (${err?.message || err})`);
}
if (!res.ok) {
  const body = (await res.text()).slice(0, 300);
  const hint = res.status === 404 ? ' — is supabase/2026-10-inventory-addon-scopes.sql applied (it creates the table)?' : '';
  die(`reading inventory_recipe_book failed: HTTP ${res.status} ${body}${hint}`);
}
const rows = await res.json();
if (!Array.isArray(rows) || rows.length === 0) {
  die('nothing saved yet — run `npm run inventory:build -- --save-only` (or any inventory:build) and apply the SQL first.');
}

let result;
try {
  result = writeBookDocument(bookDir, rows[0].book, { force });
} catch (err) {
  die(err?.message || String(err));
}

const shown = path.relative(ROOT, bookDir);
process.stdout.write(`Wrote ${result.written.length} file${result.written.length === 1 ? '' : 's'} to ${shown.startsWith('..') ? bookDir : shown} (book saved ${rows[0].saved_at}):\n`);
for (const rel of result.written) process.stdout.write(`  ${rel}\n`);
if (result.stale.length > 0) {
  process.stdout.write("Left alone — these recipe files are not in the saved book, remove them if they are old:\n");
  for (const rel of result.stale) process.stdout.write(`  ${rel}\n`);
}
process.stdout.write('Run `npm run inventory:check` next.\n');
