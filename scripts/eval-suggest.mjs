#!/usr/bin/env node
// ===========================================================================
// eval-suggest — SUG-11 offline relevance eval (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §6.2). Runs every scenario in tests/fixtures/suggest-eval.json through the
// REAL engine (lib/suggest/engine.ts) against the LIVE menu + traits, once in
// fallback (deterministic) mode and, when ANTHROPIC_API_KEY is set AND --llm
// is passed, once more with the real Opus decider. Prints the overall and
// per-mood top-3 hit rate (at least one of the top-3 picks is in that
// scenario's barista-labelled `goodFit` list) and the misses, and exits
// non-zero when the number that matters is below --min (default 0.9).
//
// Run via tsx (package.json's "eval:suggest" script) so this file — plain JS
// on purpose — can import the TypeScript engine directly, `@/` alias and all,
// with no build step and no new heavy deps beyond tsx itself.
//
// Needs .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) to
// reach the live DB — same posture, and the same hand-rolled fetch-based
// PostgREST client, as scripts/verify-db.mjs (importing @supabase/supabase-js
// pulls in a realtime client that needs a browser WebSocket global).
//
// Usage:
//   npm run eval:suggest                  fallback mode only
//   npm run eval:suggest -- --llm         fallback + Opus (needs ANTHROPIC_API_KEY)
//   npm run eval:suggest -- --min 0.85    a different bar than the default 0.9
// ===========================================================================

import fs from 'node:fs';
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
const useLlm = args.includes('--llm');
const minIdx = args.indexOf('--min');
const rawMin = minIdx !== -1 ? args[minIdx + 1] : undefined;
const MIN_HIT_RATE = rawMin !== undefined && Number.isFinite(Number(rawMin)) ? Number(rawMin) : 0.9;

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
  die('need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local — this eval reads the LIVE menu + traits.');
}
const REST = `${BASE}/rest/v1`;

async function rest(pathAndQuery) {
  const res = await fetch(`${REST}${pathAndQuery}`, {
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
const { runSuggest } = await import('../lib/suggest/engine.ts');
const { MOODS, SUGGEST_LIMITS } = await import('../lib/suggest/types.ts');

const fixturePath = path.join(ROOT, 'tests/fixtures/suggest-eval.json');
if (!fs.existsSync(fixturePath)) die(`missing ${fixturePath}`);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const scenarios = fixture.scenarios ?? [];
if (scenarios.length < 60) {
  process.stdout.write(`eval-suggest: warning — only ${scenarios.length} scenarios (spec asks for >=60)\n`);
}

// ---------------------------------------------------------------------------
// Live menu + traits + popularity
// ---------------------------------------------------------------------------

async function loadMenu() {
  const select = encodeURIComponent(MENU_ITEM_SELECT.replace(/\s+/g, ''));
  const [menuRows, traitRows] = await Promise.all([
    rest(`/menu_items?select=${select}&is_available=eq.true`),
    rest('/menu_item_traits?select=*'),
  ]);
  const items = menuRows.map((row) => shapeMenuItem(row));
  const traitsById = new Map(traitRows.map((t) => [t.menu_item_id, t]));
  return { items, traitsById };
}

// ---------------------------------------------------------------------------
// A fixture scenario's `profile` is the COARSE bands a decider is allowed to
// see (lib/suggest/types.ts ProfileSummary) — that's deliberately all the
// spec asks a hand-written eval fixture to carry (§5.4 "what Opus sees").
// The pure scorer (lib/suggest/score.ts) needs the fuller TasteProfile shape
// though, so this expands the stub into a plausible one for scoring purposes
// only — a labelled APPROXIMATION, not real customer data.
// ---------------------------------------------------------------------------

function expandProfileStub(stub, now) {
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
// Run
// ---------------------------------------------------------------------------

function normalize(name) {
  return name.trim().toLowerCase();
}

async function runMode(label, decider, { items, traitsById }, now) {
  const perMood = new Map(MOODS.map((m) => [m, { hits: 0, total: 0 }]));
  const misses = [];
  let hits = 0;

  for (const scenario of scenarios) {
    const profile = expandProfileStub(scenario.profile, now);
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

    const pickNames = result.picks
      .map((p) => items.find((i) => i.id === p.menuItemId)?.name)
      .filter(Boolean);
    const goodFit = new Set((scenario.goodFit ?? []).map(normalize));
    const hit = pickNames.some((n) => goodFit.has(normalize(n)));

    const bucket = perMood.get(scenario.inputs.mood);
    if (bucket) {
      bucket.total++;
      if (hit) bucket.hits++;
    }
    if (hit) hits++;
    else misses.push({ id: scenario.id, mood: scenario.inputs.mood, picks: pickNames, goodFit: [...goodFit] });
  }

  const overall = scenarios.length > 0 ? hits / scenarios.length : 0;

  process.stdout.write(`\n${label} — overall top-3 hit rate: ${(overall * 100).toFixed(1)}% (${hits}/${scenarios.length})\n`);
  for (const mood of MOODS) {
    const b = perMood.get(mood);
    if (!b || b.total === 0) continue;
    process.stdout.write(`  ${mood.padEnd(10)} ${((b.hits / b.total) * 100).toFixed(1)}% (${b.hits}/${b.total})\n`);
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

async function main() {
  process.stdout.write(`eval-suggest — ${scenarios.length} scenarios from tests/fixtures/suggest-eval.json\n`);
  if (fixture.note) process.stdout.write(`note: ${fixture.note}\n`);

  const menuData = await loadMenu();
  process.stdout.write(`live menu: ${menuData.items.length} available item(s), ${menuData.traitsById.size} traits row(s)\n`);
  if (menuData.items.length === 0) die('no available menu items came back — check the live DB / RLS / service-role key');

  const now = new Date();

  const fallbackRate = await runMode('FALLBACK (deterministic)', null, menuData, now);

  let gateRate = fallbackRate;
  let gateLabel = 'fallback';

  if (useLlm) {
    if (!process.env.ANTHROPIC_API_KEY) {
      process.stdout.write('\n--llm was passed but ANTHROPIC_API_KEY is not set — skipping the Opus run.\n');
    } else {
      const { opusDecider } = await import('../lib/suggest/llm.ts');
      const llmRate = await runMode('OPUS (llm)', opusDecider, menuData, now);
      // §6.2: "Opus must reach >=90%; the fallback's number is the floor
      // we're protecting" — Opus is the bar this harness gates on once it has
      // actually run; fallback is reported for visibility, not required to
      // clear --min on its own.
      gateRate = llmRate;
      gateLabel = 'Opus';
    }
  }

  process.stdout.write(
    `\nGating on ${gateLabel}: ${(gateRate * 100).toFixed(1)}% vs --min ${(MIN_HIT_RATE * 100).toFixed(1)}%\n`,
  );
  if (gateRate < MIN_HIT_RATE) {
    process.stdout.write('RESULT: FAIL\n');
    process.exit(1);
  }
  process.stdout.write('RESULT: PASS\n');
}

main().catch((err) => die(`crashed: ${err?.stack || err}`));
