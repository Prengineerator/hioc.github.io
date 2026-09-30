#!/usr/bin/env node
// ===========================================================================
// inventory:snapshot — refresh data/inventory/menu-snapshot.json from the LIVE
// menu (docs/INVENTORY-RECIPE-BOOK.md).
//
// The recipe book refers to menu items, sizes and add-on options by id and by
// exact size label, and `npm run inventory:check` holds it to this file. The
// menu can change on the POS at any time (a rename, a new size, a new add-on),
// so refresh the snapshot before writing or deploying recipes.
//
// Run:  npm run inventory:snapshot
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
// (or the environment). NEXT_PUBLIC_SUPABASE_ANON_KEY works too: the menu tables
// are publicly readable, and this script only ever reads them.
//
// Like scripts/verify-db.mjs it reads .env.local by hand and talks to
// PostgREST with plain fetch (no @supabase/supabase-js: importing it needs a
// global WebSocket, which Node 20 lacks).
//
// The output is deterministic apart from `captured_at`, so a refresh that
// changes nothing on the menu shows up in git as a one-line diff.
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const COMMENT =
  "Snapshot of the LIVE menu (Supabase project 'Hioc Coffee'). Recipes in data/inventory/recipes/ must reference these ids and size labels exactly. Refresh with `npm run inventory:snapshot` (needs service-role env) or ask the chef agent. Do not hand-edit.";

// fileURLToPath, not url.pathname — see scripts/verify-db.mjs.
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = path.join(ROOT, 'data', 'inventory', 'menu-snapshot.json');
const PAGE_SIZE = 1000;

function die(msg) {
  process.stderr.write(`\ninventory:snapshot: ${msg}\n`);
  process.exit(1);
}

// Same parsing as scripts/verify-db.mjs: KEY=value lines, and the Supabase
// values in this repo are written double-quoted, so strip a matched pair.
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

const fileEnv = loadEnv(path.join(ROOT, '.env.local'));
const env = (name) => fileEnv[name] || process.env[name] || '';

const BASE = env('NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, '');
const KEY = env('SUPABASE_SERVICE_ROLE_KEY') || env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
if (!BASE || !KEY) {
  die('need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY) in .env.local');
}
const REST = `${BASE}/rest/v1`;

/** Every row of a PostgREST query, a page at a time (stable order: by id). */
async function fetchAll(table, select) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `${REST}/${table}?select=${encodeURIComponent(select)}&order=id&limit=${PAGE_SIZE}&offset=${offset}`;
    let res;
    try {
      res = await fetch(url, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      die(`could not reach ${BASE} (${err?.message || err})`);
    }
    if (!res.ok) die(`reading ${table} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

// Plain code-unit comparison, so the order does not depend on the machine's locale.
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (v) => (v == null ? '' : String(v));
/** Chain of comparators: the first that says "different" wins. */
const by = (...fns) => (a, b) => {
  for (const fn of fns) {
    const c = fn(a, b);
    if (c !== 0) return c;
  }
  return 0;
};

function shapeItems(rows) {
  return [...rows]
    .sort(
      by(
        (a, b) => compare(text(a.parent_category), text(b.parent_category)),
        (a, b) => compare(text(a.category), text(b.category)),
        (a, b) => compare(a.sort_order ?? 0, b.sort_order ?? 0),
        (a, b) => compare(text(a.name), text(b.name)),
      ),
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      category: text(row.category),
      parent_category: text(row.parent_category),
      is_available: row.is_available !== false,
      // Labels are matched trimmed (inventory_set_recipe trims size_label).
      sizes: [...(row.menu_item_variants ?? [])]
        .sort((a, b) => compare(a.sort_order ?? 0, b.sort_order ?? 0))
        .map((v) => ({ label: text(v.label).trim(), price_inr: v.price_inr })),
      addon_groups: (row.menu_item_addon_groups ?? [])
        .map((link) => link.addon_groups)
        .filter(Boolean)
        .sort(by((a, b) => compare(a.sort_order ?? 0, b.sort_order ?? 0), (a, b) => compare(a.name, b.name)))
        .map((g) => g.name),
      description: text(row.description),
    }));
}

function shapeAddonOptions(rows) {
  return rows
    .filter((row) => row.addon_groups)
    .sort(
      by(
        (a, b) => compare(a.addon_groups.sort_order ?? 0, b.addon_groups.sort_order ?? 0),
        // Keeps one group's options together when two groups share a sort_order.
        (a, b) => compare(a.addon_groups.name, b.addon_groups.name),
        (a, b) => compare(a.sort_order ?? 0, b.sort_order ?? 0),
      ),
    )
    .map((row) => ({
      id: row.id,
      group: row.addon_groups.name,
      group_label: row.addon_groups.display_name,
      option: row.name,
      price_inr: row.price_inr,
    }));
}

/** What changed since the last snapshot: the recipes to revisit. */
function describeChanges(before, after) {
  const named = (list, label) => new Map(list.map((x) => [x.id, label(x)]));
  const line = (what, a, b) => {
    const added = [...b].filter(([id]) => !a.has(id)).map(([, l]) => l);
    const removed = [...a].filter(([id]) => !b.has(id)).map(([, l]) => l);
    const renamed = [...b].filter(([id, l]) => a.has(id) && a.get(id) !== l).length;
    return `  ${what}: ${b.size} (+${added.length} new, -${removed.length} gone, ${renamed} renamed/resized)` +
      [...added.map((l) => `\n    + ${l}`), ...removed.map((l) => `\n    - ${l}`)].slice(0, 20).join('');
  };
  const itemLabel = (i) => `${i.name} [${i.category}; ${i.sizes.map((s) => s.label).join(', ')}]`;
  const optionLabel = (o) => `${o.group} › ${o.option}`;
  return [
    line('menu items', named(before.items ?? [], itemLabel), named(after.items, itemLabel)),
    line('add-on options', named(before.addon_options ?? [], optionLabel), named(after.addon_options, optionLabel)),
  ].join('\n');
}

const [itemRows, optionRows] = await Promise.all([
  fetchAll(
    'menu_items',
    'id,name,description,category,parent_category,is_available,sort_order,' +
      'menu_item_variants(label,price_inr,sort_order),menu_item_addon_groups(addon_groups(name,sort_order))',
  ),
  fetchAll('addon_options', 'id,name,price_inr,sort_order,addon_groups(name,display_name,sort_order)'),
]);

// Never replace a good snapshot with an empty one (a wrong key or RLS returns
// zero rows, not an error).
if (itemRows.length === 0) die('the menu came back empty — not overwriting the snapshot (is the key right?)');

// Key order matters: it is the file's layout.
const snapshot = {
  _comment: COMMENT,
  captured_at: new Date().toISOString(),
  items: shapeItems(itemRows),
  addon_options: shapeAddonOptions(optionRows),
};

let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(OUT, 'utf8'));
} catch {
  // no earlier snapshot (or unreadable): nothing to compare with
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const tmp = `${OUT}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
fs.renameSync(tmp, OUT);

process.stdout.write(`Wrote ${path.relative(ROOT, OUT)} (captured ${snapshot.captured_at})\n`);
process.stdout.write(
  previous
    ? `Changes since the last snapshot:\n${describeChanges(previous, snapshot)}\n`
    : `  menu items: ${snapshot.items.length}\n  add-on options: ${snapshot.addon_options.length}\n`,
);
process.stdout.write('Run `npm run inventory:check` — recipes for anything renamed or gone need updating.\n');
