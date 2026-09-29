#!/usr/bin/env node
// ===========================================================================
// eval-suggest — SUG-11 offline relevance eval (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §6.2), brought up to Coffey v2 (docs/COFFEY-SPEC.md §2 inputs, §4 engine, §7
// rollout step 5). Runs every scenario in tests/fixtures/suggest-eval.json
// through the REAL engine (lib/suggest/engine.ts runSuggest) against the LIVE
// menu + traits, once in fallback (deterministic) mode and, when --llm is
// passed AND TYPESAFE_API_KEY is set, once more with the real Jev decider.
//
// Per mode it prints:
//   * the overall and per-mood top-3 hit rate (at least one of the top-3 picks
//     is in that scenario's barista-labelled `goodFit` list), over all of MOODS,
//     bucketed by the scenario's PRIMARY feeling;
//   * three diversity metrics, which catch the old failure where most scenarios
//     came back with the same popular trio:
//       (a) the % of scenarios whose picks span >= 2 distinct categories,
//       (b) distinct pick sets (unordered top-3) / scenarios that returned picks,
//       (c) the most repeated item and how many scenarios it appears in;
//   * the misses.
// and, once, a label audit: goodFit names that are not on the live menu, or that
// the hard rules (COFFEY-SPEC §4.1) exclude for that scenario, can never score
// a hit, so they are listed rather than silently capping the rate.
// It exits non-zero when the number that matters is below --min (default 0.9)
// or when a scenario could not be run.
//
// What it mirrors from the live route (app/api/suggest/route.ts) — keep in step:
//   * INPUTS: each scenario's `inputs` goes through validateSuggestInputs, the
//     route's own validator. It accepts v1 (upgraded, COFFEY-SPEC §2) and v2 and
//     always returns v2. A returned string is a scenario error: it is reported,
//     the scenario is skipped, and the run still finishes (then exits non-zero).
//   * MENU: loadMenuAndTraits() line for line — rows with is_available = true,
//     each shaped by shapeMenuItem and passed through applyMenuSwitches with the
//     switches from the store_settings singleton (hidden sizes, off add-ons),
//     then rows in a hidden category are dropped, then in-store-only items
//     (water bottles…) are dropped — the route never suggests them. Traits are
//     every menu_item_traits row. Both come from the same helpers the route
//     imports; store_settings falls back to FALLBACK_STORE_SETTINGS on an error
//     or a missing row, as getStoreSettings() does.
//   * REQUEST: runSuggest gets `request: { inputs }` with the validated inputs.
// Left out on purpose, so a run does not depend on order history: popularity
// (an empty map, so that term is 0 for everyone), recent items, and real taste
// profiles (a fixture's coarse `profile` stub is expanded into a plausible one).
//
// CLOCK: the deterministic daypart term depends on the time of day (IST), and
// from 17:00 it down-weights caffeinated picks unless the customer asked for
// caffeine outright (COFFEY-SPEC §4.2) — so the same fixture scores differently
// at noon and at midnight. The clock in use is printed; pass --now to pin it.
//
// Run via tsx (package.json's "eval:suggest" script) so this file — plain JS
// on purpose — can import the TypeScript engine directly, `@/` alias and all,
// with no build step and no new heavy deps beyond tsx itself.
//
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env.local
// or the environment) to reach the live DB. It only ever issues GET requests:
// there is no write path in this file. Same posture, and the same hand-rolled
// fetch-based PostgREST client, as scripts/verify-db.mjs (importing
// @supabase/supabase-js pulls in a realtime client that needs a browser
// WebSocket global).
//
// Usage:
//   npm run eval:suggest                       fallback mode only, real clock
//   npm run eval:suggest -- --llm              fallback + Jev (needs TYPESAFE_API_KEY)
//   npm run eval:suggest -- --min 0.85         a different bar than the default 0.9
//   npm run eval:suggest -- --only v1          just the pre-Coffey scenarios (or v2)
//   npm run eval:suggest -- --now 2026-09-29T15:00:00+05:30   pin the clock
// ===========================================================================

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function die(msg) {
  process.stdout.write(`\neval-suggest: ${msg}\n`);
  process.exit(2);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
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

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--llm', '--min', '--only', '--now']);
for (const a of args) {
  if (a.startsWith('--') && !KNOWN_FLAGS.has(a)) {
    die(`unknown option ${a} (known: ${[...KNOWN_FLAGS].join(', ')})`);
  }
}
function argValue(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) die(`${flag} needs a value`);
  return value;
}

const useLlm = args.includes('--llm');
const rawMin = argValue('--min');
const MIN_HIT_RATE = rawMin === undefined ? 0.9 : Number(rawMin);
if (!Number.isFinite(MIN_HIT_RATE) || MIN_HIT_RATE < 0 || MIN_HIT_RATE > 1) {
  die(`--min takes a fraction between 0 and 1, e.g. 0.85 (got "${rawMin}")`);
}

const only = argValue('--only') ?? 'all';
if (!['all', 'v1', 'v2'].includes(only)) die(`--only must be v1, v2 or all (got "${only}")`);

const rawNow = argValue('--now');
const now = rawNow !== undefined ? new Date(rawNow) : new Date();
if (Number.isNaN(now.getTime())) {
  die(`--now needs an ISO-8601 timestamp such as 2026-09-29T15:00:00+05:30 (got "${rawNow}")`);
}
const clockPinned = rawNow !== undefined;

// ---------------------------------------------------------------------------
// Env + a minimal fetch-based PostgREST client (mirrors scripts/verify-db.mjs)
// ---------------------------------------------------------------------------

const env = loadEnv(path.join(ROOT, '.env.local'));
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

const BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !SERVICE) {
  die('need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local or the environment — this eval reads the LIVE menu + traits.');
}
const REST = `${BASE}/rest/v1`;

/** GET only — this harness never writes to the database. */
async function rest(pathAndQuery) {
  const res = await fetch(`${REST}${pathAndQuery}`, {
    method: 'GET',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${pathAndQuery} -> HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Load the engine + fixtures (TypeScript, via tsx)
// ---------------------------------------------------------------------------

const { MENU_ITEM_SELECT, shapeMenuItem } = await import('../lib/orders/lines.ts');
const { applyMenuSwitches, isCategoryHidden, switchesFromSettings } = await import('../lib/menu/menuSwitches.ts');
const { isInStoreOnly } = await import('../lib/menu/inStore.ts');
const { FALLBACK_STORE_SETTINGS } = await import('../lib/store/hours.ts');
const { runSuggest } = await import('../lib/suggest/engine.ts');
const { passesHardConstraints, minPriceInr } = await import('../lib/suggest/filter.ts');
const { isLegacyInputsBody } = await import('../lib/suggest/inputs.ts');
const { validateSuggestInputs } = await import('../lib/suggest/validate.ts');
const { sweetnessLevel } = await import('../lib/suggest/sweetness.ts');
const { daypartFor } = await import('../lib/suggest/daypart.ts');
const { MOODS } = await import('../lib/suggest/types.ts');

const fixturePath = path.join(ROOT, 'tests/fixtures/suggest-eval.json');
if (!fs.existsSync(fixturePath)) die(`missing ${fixturePath}`);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const rawScenarios = fixture.scenarios ?? [];
if (rawScenarios.length < 60) {
  process.stdout.write(`eval-suggest: warning — only ${rawScenarios.length} scenarios (spec asks for >=60)\n`);
}

// ---------------------------------------------------------------------------
// Scenarios: every `inputs` goes through the route's own validator, so a v1
// scenario is upgraded exactly as a v1 request body is on the wire, and a v2
// one is checked as strictly as the route would check it.
// ---------------------------------------------------------------------------

function prepareScenarios(raw) {
  const ready = [];
  const errors = [];
  const seen = new Set();
  for (const [index, scenario] of raw.entries()) {
    const id = typeof scenario?.id === 'string' && scenario.id ? scenario.id : `#${index + 1}`;
    if (seen.has(id)) {
      errors.push({ id, message: 'duplicate scenario id' });
      continue;
    }
    seen.add(id);
    const rawInputs = scenario?.inputs;
    const era = rawInputs && typeof rawInputs === 'object' && !Array.isArray(rawInputs) && isLegacyInputsBody(rawInputs) ? 'v1' : 'v2';
    const inputs = validateSuggestInputs(rawInputs);
    if (typeof inputs === 'string') {
      errors.push({ id, message: inputs });
      continue;
    }
    ready.push({ ...scenario, id, era, inputs });
  }
  return { ready, errors };
}

const { ready: allScenarios, errors: scenarioErrors } = prepareScenarios(rawScenarios);
const scenarios = only === 'all' ? allScenarios : allScenarios.filter((s) => s.era === only);

// ---------------------------------------------------------------------------
// Live menu + traits (see the header: this mirrors the route's loadMenuAndTraits)
// ---------------------------------------------------------------------------

async function loadStoreSettings() {
  // getStoreSettings() never throws: on an error or a missing row it falls back
  // to FALLBACK_STORE_SETTINGS. Same here, with a printed warning.
  try {
    const rows = await rest('/store_settings?select=*&is_singleton=eq.true');
    if (Array.isArray(rows) && rows[0]) return rows[0];
    process.stdout.write('eval-suggest: warning — no store_settings row; using FALLBACK_STORE_SETTINGS, as the route does\n');
  } catch (err) {
    process.stdout.write(`eval-suggest: warning — store_settings read failed (${err.message}); using FALLBACK_STORE_SETTINGS, as the route does\n`);
  }
  return FALLBACK_STORE_SETTINGS;
}

async function loadMenu() {
  const select = encodeURIComponent(MENU_ITEM_SELECT.replace(/\s+/g, ''));
  const [menuRows, traitRows, settings] = await Promise.all([
    rest(`/menu_items?select=${select}&is_available=eq.true`),
    rest('/menu_item_traits?select=*'),
    loadStoreSettings(),
  ]);

  // === route: loadMenuAndTraits() =============================================
  const switched = menuRows.map((row) => applyMenuSwitches(shapeMenuItem(row), switchesFromSettings(settings)));
  const visible = switched.filter((item) => !isCategoryHidden(item.category, settings.hidden_categories));
  const items = visible.filter((item) => !isInStoreOnly(item));
  const traitsById = new Map(traitRows.map((t) => [t.menu_item_id, t]));
  // ===========================================================================

  return {
    items,
    traitsById,
    availableRows: menuRows.length,
    droppedHiddenCategory: switched.length - visible.length,
    droppedInStoreOnly: visible.length - items.length,
  };
}

// ---------------------------------------------------------------------------
// A fixture scenario's `profile` is the COARSE bands a decider is allowed to
// see (lib/suggest/types.ts ProfileSummary) — that's deliberately all the
// spec asks a hand-written eval fixture to carry (§5.4 "what the decider sees").
// The pure scorer (lib/suggest/score.ts) needs the fuller TasteProfile shape
// though, so this expands the stub into a plausible one for scoring purposes
// only — a labelled APPROXIMATION, not real customer data.
// ---------------------------------------------------------------------------

function expandProfileStub(stub) {
  if (!stub) return null;
  const icedShare = stub.icedLean === 'iced' ? 0.85 : stub.icedLean === 'hot' ? 0.15 : 0.5;
  const meanSweetness = stub.sweetLean === 'high' ? 2.5 : stub.sweetLean === 'low' ? 0.5 : 1.5;
  const ticket =
    stub.priceComfort === 'premium'
      ? { median: 500, p75: 600 }
      : stub.priceComfort === 'mid'
        ? { median: 300, p75: 360 }
        : { median: 150, p75: 180 };
  const categoryAffinity = {};
  for (const [i, cat] of (stub.topCategories ?? []).entries()) {
    categoryAffinity[cat] = Math.max(0.1, 0.6 - i * 0.2);
  }
  return {
    topItems: (stub.usualItemIds ?? []).map((menu_item_id) => ({
      menu_item_id,
      count: 5,
      lastOrderedAt: now.toISOString(),
    })),
    categoryAffinity,
    traitLean: { icedShare, meanSweetness, caffeineShare: 0.7, foodAttachRate: 0.2 },
    ticket,
    priceComfort: stub.priceComfort ?? 'mid',
    orderingMood: stub.orderingMood ?? 'routine',
    daypartHistogram: { morning: 0.25, afternoon: 0.25, evening: 0.25, late: 0.25 },
    favorites: [],
  };
}

// ---------------------------------------------------------------------------
// Diversity metrics. Self-contained on purpose (no outside dependencies), so the
// same block can be dropped into an older checkout's copy of this script for a
// like-for-like before/after.
//   rows: one entry per scenario run, { ids, names, categories } of its picks.
// ---------------------------------------------------------------------------

// ---- BEGIN diversity metrics ----
function diversityMetrics(rows) {
  const withPicks = rows.filter((r) => r.ids.length > 0);
  const multiCategory = withPicks.filter((r) => new Set(r.categories).size >= 2).length;
  const distinctSets = new Set(withPicks.map((r) => [...r.ids].sort().join('|'))).size;

  const appearances = new Map(); // item id -> { name, scenarios }
  for (const r of withPicks) {
    r.ids.forEach((id, i) => {
      const entry = appearances.get(id) ?? { name: r.names[i], scenarios: 0 };
      entry.scenarios += 1;
      appearances.set(id, entry);
    });
  }
  const topCount = Math.max(0, ...[...appearances.values()].map((e) => e.scenarios));
  const topItems = [...appearances.values()]
    .filter((e) => e.scenarios === topCount)
    .map((e) => e.name)
    .sort();

  return { total: rows.length, withPicks: withPicks.length, multiCategory, distinctSets, topCount, topItems };
}

function printDiversity(d) {
  const pct = (n, of) => (of > 0 ? `${((n / of) * 100).toFixed(1)}%` : 'n/a');
  const noPicks = d.total - d.withPicks;
  process.stdout.write(
    `  Diversity (over the ${d.withPicks} scenario(s) that returned picks${noPicks > 0 ? `; ${noPicks} returned none` : ''}):\n`,
  );
  process.stdout.write(`    (a) picks span >=2 categories:  ${pct(d.multiCategory, d.withPicks)} (${d.multiCategory}/${d.withPicks})\n`);
  process.stdout.write(
    `    (b) distinct pick sets:         ${d.withPicks > 0 ? (d.distinctSets / d.withPicks).toFixed(2) : 'n/a'} (${d.distinctSets} distinct / ${d.withPicks} scenarios)\n`,
  );
  process.stdout.write(
    d.topItems.length === 0
      ? '    (c) most repeated item:         n/a\n'
      : `    (c) most repeated item:         ${d.topItems.slice(0, 4).join(' / ')}${d.topItems.length > 4 ? ' / …' : ''}` +
          ` — in ${d.topCount}/${d.withPicks} scenarios (${pct(d.topCount, d.withPicks)})\n`,
  );
}
// ---- END diversity metrics ----

// ---------------------------------------------------------------------------
// Label audit: a goodFit item that is not on the live menu, or that the hard
// rules exclude for its scenario, can never be picked — so it can never score.
// Uses the engine's own passesHardConstraints, so it agrees with the run.
// ---------------------------------------------------------------------------

function normalize(name) {
  return name.trim().toLowerCase();
}

function describeItem(item, traits) {
  return [
    traits.kind,
    traits.temperature,
    `caffeine ${traits.caffeine}`,
    traits.is_coffee ? 'coffee' : 'not coffee',
    `sweetness ${sweetnessLevel(traits)}/10`,
    `from ₹${minPriceInr(item)}`,
  ].join(', ');
}

function auditLabels(list, { items, traitsById }) {
  const byName = new Map(items.map((i) => [normalize(i.name), i]));
  const unknown = [];
  const excluded = [];
  const unwinnable = [];
  const affected = new Set();
  for (const s of list) {
    const labels = s.goodFit ?? [];
    let reachable = 0;
    for (const name of labels) {
      const item = byName.get(normalize(name));
      if (!item) {
        unknown.push(`${s.id}: "${name}" is not on the live menu the route would suggest from`);
        affected.add(s.id);
      } else if (!passesHardConstraints(item, traitsById.get(item.id), s.inputs, [])) {
        const traits = traitsById.get(item.id);
        excluded.push(
          `${s.id}: ${item.name} is excluded by that scenario's hard rules (${traits ? describeItem(item, traits) : 'it has no traits row'})`,
        );
        affected.add(s.id);
      } else {
        reachable++;
      }
    }
    if (reachable === 0) unwinnable.push(s.id);
  }

  process.stdout.write('\nLABEL AUDIT (goodFit vs the live menu and the hard rules, COFFEY-SPEC §4.1)\n');
  if (unknown.length === 0 && excluded.length === 0) {
    process.stdout.write(`  every goodFit item in ${list.length} scenario(s) is on the menu and passes its scenario's hard rules\n`);
    return;
  }
  for (const line of [...unknown, ...excluded]) process.stdout.write(`  ${line}\n`);
  process.stdout.write(`  ${affected.size} of ${list.length} scenario(s) carry at least one label the engine cannot return\n`);
  process.stdout.write(
    unwinnable.length > 0
      ? `  can never hit (no reachable goodFit item): ${unwinnable.join(', ')}\n`
      : '  every scenario still has at least one reachable goodFit item\n',
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const moodLabel = (inputs) => (inputs.secondaryMood ? `${inputs.mood}+${inputs.secondaryMood}` : inputs.mood);
const rate = (hits, total) => `${((hits / total) * 100).toFixed(1)}% (${hits}/${total})`;

async function runMode(label, decider, { items, traitsById }) {
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const perMood = new Map(MOODS.map((m) => [m, { hits: 0, total: 0 }]));
  const perEra = new Map([['v1', { hits: 0, total: 0 }], ['v2', { hits: 0, total: 0 }]]);
  const diversityRows = [];
  const misses = [];
  const sources = { llm: 0, fallback: 0 };
  const fallbackReasons = new Map();
  let hits = 0;

  for (const scenario of scenarios) {
    const profile = expandProfileStub(scenario.profile);
    const result = await runSuggest({
      request: { inputs: scenario.inputs },
      menu: items,
      traitsById,
      profile,
      popularity: new Map(),
      recentItemIds: [],
      now,
      decider,
      fallbackReason: decider ? undefined : 'disabled',
    });

    const picked = result.picks.map((p) => itemsById.get(p.menuItemId)).filter(Boolean);
    const pickNames = picked.map((i) => i.name);
    const goodFit = new Set((scenario.goodFit ?? []).map(normalize));
    const hit = pickNames.some((n) => goodFit.has(normalize(n)));

    const moodBucket = perMood.get(scenario.inputs.mood);
    if (moodBucket) {
      moodBucket.total++;
      if (hit) moodBucket.hits++;
    }
    const eraBucket = perEra.get(scenario.era);
    eraBucket.total++;
    if (hit) eraBucket.hits++;
    if (hit) hits++;
    else misses.push({ id: scenario.id, mood: moodLabel(scenario.inputs), picks: pickNames, goodFit: [...goodFit] });

    diversityRows.push({ ids: picked.map((i) => i.id), names: pickNames, categories: picked.map((i) => i.category) });

    sources[result.source] = (sources[result.source] ?? 0) + 1;
    if (result.source === 'fallback' && result.fallbackReason) {
      fallbackReasons.set(result.fallbackReason, (fallbackReasons.get(result.fallbackReason) ?? 0) + 1);
    }
  }

  const overall = scenarios.length > 0 ? hits / scenarios.length : 0;

  process.stdout.write(`\n${label} — overall top-3 hit rate: ${rate(hits, scenarios.length)}\n`);
  process.stdout.write('  By mood (primary feeling):\n');
  for (const mood of MOODS) {
    const b = perMood.get(mood);
    process.stdout.write(`    ${mood.padEnd(10)} ${b.total > 0 ? rate(b.hits, b.total) : 'n/a (no scenarios)'}\n`);
  }
  process.stdout.write('  By fixture era:\n');
  for (const [era, name] of [['v1', 'v1 (upgraded)'], ['v2', 'v2']]) {
    const b = perEra.get(era);
    process.stdout.write(`    ${name.padEnd(13)} ${b.total > 0 ? rate(b.hits, b.total) : 'n/a (no scenarios)'}\n`);
  }
  printDiversity(diversityMetrics(diversityRows));

  if (decider) {
    const reasons = [...fallbackReasons.entries()].map(([r, n]) => `${r} x${n}`).join(', ');
    process.stdout.write(
      `  Jev answered ${sources.llm}/${scenarios.length} scenarios` +
        (sources.fallback > 0
          ? `; ${sources.fallback} fell back to the deterministic ranking (${reasons || 'no reason recorded'}) — those picks are counted above but are NOT Jev's\n`
          : '\n'),
    );
  }

  if (misses.length > 0) {
    process.stdout.write(`  Misses (${misses.length}):\n`);
    for (const m of misses) {
      process.stdout.write(
        `    ${m.id} [${m.mood}] picked [${m.picks.join(', ') || '(none)'}] — expected one of [${m.goodFit.join(', ')}]\n`,
      );
    }
  }

  return overall;
}

// ---------------------------------------------------------------------------
// --llm only: lib/suggest/jev.ts and jevDecider.ts start with `import
// 'server-only'`, a Next.js build-time marker with no runtime package behind it,
// so a bare tsx process cannot load them ("Cannot find module 'server-only'").
// Give that one specifier an empty in-memory module (nothing is written to
// disk) before importing the decider.
// ---------------------------------------------------------------------------

function stubServerOnly() {
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const stubPath = path.join(ROOT, 'node_modules', '__eval-suggest-server-only__.js');
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return request === 'server-only' ? stubPath : resolveFilename.call(this, request, ...rest);
  };
  const stub = new Module(stubPath);
  stub.filename = stubPath;
  stub.loaded = true;
  stub.exports = {};
  Module._cache[stubPath] = stub;
}

async function main() {
  process.stdout.write(
    `eval-suggest — ${scenarios.length} scenario(s) from tests/fixtures/suggest-eval.json` +
      (only === 'all' ? '' : ` (--only ${only}: ${allScenarios.length - scenarios.length} other scenario(s) not run)`) +
      '\n',
  );
  if (fixture.note) process.stdout.write(`note: ${fixture.note}\n`);

  if (scenarioErrors.length > 0) {
    process.stdout.write(`\nSCENARIO ERRORS (${scenarioErrors.length}) — skipped, and the run will exit non-zero:\n`);
    for (const e of scenarioErrors) process.stdout.write(`  ${e.id}: ${e.message}\n`);
  }

  const menuData = await loadMenu();
  const { items, traitsById } = menuData;
  process.stdout.write(
    `\nlive menu: ${menuData.availableRows} available row(s) -> ${items.length} the route would suggest from ` +
      `(dropped ${menuData.droppedInStoreOnly} in-store-only, ${menuData.droppedHiddenCategory} in hidden categories); ${traitsById.size} traits row(s)\n`,
  );
  if (items.length === 0) die('no available menu items came back — check the live DB / RLS / service-role key');

  const versions = new Map();
  for (const t of traitsById.values()) {
    const v = typeof t.traits_version === 'number' ? t.traits_version : 1;
    versions.set(v, (versions.get(v) ?? 0) + 1);
  }
  const versionText = [...versions.entries()].sort((a, b) => a[0] - b[0]).map(([v, n]) => `traits_version ${v} x${n}`).join(', ');
  process.stdout.write(`traits: ${versionText}${versions.size === 1 && versions.has(1) ? ' — every row is still pre-Coffey' : ''}\n`);

  const daypart = daypartFor(now);
  const istClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(now);
  process.stdout.write(`clock: ${istClock} IST, daypart "${daypart}" (${clockPinned ? 'pinned with --now' : 'the real clock'})\n`);
  if (daypart === 'evening' || daypart === 'late') {
    process.stdout.write(
      '  note: from 17:00 IST the scorer halves (evening) or zeroes (late) the daypart term of medium/high-caffeine items, unless\n' +
        '  the customer asked for caffeine outright (boost, coffee, or a strength) — pass --now <a daytime instant> to compare like with like\n',
    );
  }

  auditLabels(scenarios, menuData);

  const fallbackRate = await runMode('FALLBACK (deterministic)', null, menuData);

  let gateRate = fallbackRate;
  let gateLabel = 'fallback';

  if (useLlm) {
    if (!process.env.TYPESAFE_API_KEY) {
      process.stdout.write('\n--llm was passed but TYPESAFE_API_KEY is not set — skipping the Jev run.\n');
    } else {
      stubServerOnly();
      const { jevDecider } = await import('../lib/suggest/jevDecider.ts');
      const llmRate = await runMode('JEV (llm)', jevDecider, menuData);
      // §6.2: "the decider must reach >=90%; the fallback's number is the floor
      // we're protecting" — Jev is the bar this harness gates on once it has
      // actually run; fallback is reported for visibility, not required to
      // clear --min on its own.
      gateRate = llmRate;
      gateLabel = 'Jev';
    }
  }

  process.stdout.write(
    `\nGating on ${gateLabel}: ${(gateRate * 100).toFixed(1)}% vs --min ${(MIN_HIT_RATE * 100).toFixed(1)}%\n`,
  );
  if (scenarioErrors.length > 0) {
    process.stdout.write(`RESULT: FAIL (${scenarioErrors.length} scenario error(s) above — fix the fixture)\n`);
    process.exit(1);
  }
  if (gateRate < MIN_HIT_RATE) {
    process.stdout.write('RESULT: FAIL\n');
    process.exit(1);
  }
  process.stdout.write('RESULT: PASS\n');
}

main().catch((err) => die(`crashed: ${err?.stack || err}`));
