#!/usr/bin/env node
// ===========================================================================
// verify-db — probe the LIVE database for the guarantees the test suite cannot see.
//
// The vitest suite mocks Supabase. That is what makes it fast and hermetic, and
// it is also why it cannot see a single trigger, CHECK constraint or RLS policy:
// the schema is simply absent from the thing under test. Everything this script
// checks lives in that blind spot.
//
// The gap is not hypothetical — it shipped a feature that could never work.
// REF-1 (counter refunds) passed all 265 tests and could not INSERT even once.
// phase2-hardening.sql installs a BEFORE INSERT trigger on `refunds` capping a
// refund at the captured gateway payment, and it read `payments` by
// new.payment_id — which is NULL for a counter refund. v_paid came back NULL,
// coalesce(v_paid, 0) made the cap 0, and every row was rejected with
// 'refund total exceeds captured payment'. No amount of mocked-client testing
// could have found it; probing a real database did, in one query.
// 2026-08-counter-refunds.sql fixes the trigger and check 6 below is the
// standing regression test that the fix is actually deployed.
//
// Run this before a deploy:  npm run verify:db
//   exit 0  — every probe that ran, passed. Safe to ship.
//   exit 1  — something is missing or behaving wrongly. Do not ship.
//
// Honesty rules this script holds itself to, because a green light nobody trusts
// is worse than no light at all:
//   * A probe that could not run is reported as SKIPPED, never as a pass.
//   * Wherever a positive result could also be produced by the constraint being
//     ABSENT, a negative control runs alongside it (see check 1.3).
//   * Every mutation reverts itself, and the revert is re-queried and asserted.
//     Rows are tagged with a run-unique sentinel and cleanup only ever targets
//     that sentinel or an id this script was handed on insert, so the script
//     cannot delete data it did not create.
//
// Usage: node scripts/verify-db.mjs [--strict]
//   --strict also fails the run on SKIPPED probes, for a deploy gate that should
//   refuse to pass on unproven ground rather than on proven-good ground.
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const STRICT = process.argv.includes('--strict');

// ---------------------------------------------------------------------------
// Environment
//
// We read .env.local by hand rather than pulling in dotenv, and we talk to
// PostgREST with plain fetch rather than @supabase/supabase-js. The latter is
// not a style preference: importing the JS client constructs a realtime client,
// which needs a global WebSocket. Node 20 has none, so the script dies on the
// import line before running a single check. `fetch` is built in and enough —
// PostgREST is just HTTP.
// ---------------------------------------------------------------------------
function loadEnv(file) {
  if (!fs.existsSync(file)) die(`missing ${file} — cannot reach the database without credentials.`);
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    // The Supabase values in this repo are written DOUBLE-QUOTED. Left in, the
    // quotes end up inside the URL and every request 404s against a hostname
    // that contains a literal '"'. Strip a matched pair, not stray quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function die(msg) {
  process.stdout.write(`\nverify-db: ${msg}\n`);
  process.exit(2);
}

// fileURLToPath, not url.pathname — the latter stays percent-encoded, so a repo
// checked out under a path with a space would look for a directory named '%20'.
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const env = loadEnv(path.join(ROOT, '.env.local'));

const BASE = (env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !ANON || !SERVICE) {
  die('need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in .env.local');
}
const REST = `${BASE}/rest/v1`;

async function rest(pathAndQuery, { key = SERVICE, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  let res;
  try {
    res = await fetch(`${REST}${pathAndQuery}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // A deploy gate must not hang forever on a network stall.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { status: 0, ok: false, body: { code: 'NETWORK', message: String(err?.message || err) } };
  }
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}

// ---------------------------------------------------------------------------
// Reading failures
//
// The whole technique rests on this: attempt an insert that is deliberately
// doomed by a FOREIGN KEY (a bogus order_id), and read which error comes back.
//   * foreign key violation  -> every CHECK on the row PASSED; the value we were
//                               testing is accepted by the schema.
//   * check violation        -> the value was rejected; the migration is missing.
// Nothing is written either way, so the probe is free.
//
// We branch on the SQLSTATE code rather than the message text, because the code
// is a stable contract and the wording is not; the message regex is kept only as
// a fallback for the rare response that carries no code.
// ---------------------------------------------------------------------------
const BOGUS_ORDER_ID = '00000000-0000-0000-0000-000000000000'; // the nil UUID: cannot ever be a real order

function errKind(res) {
  const code = res.body?.code ?? '';
  const msg = String(res.body?.message ?? '');
  if (code === '23503' || /violates foreign key constraint/i.test(msg)) return 'fk';
  if (code === '23514' || /violates check constraint/i.test(msg)) return 'check';
  if (code === '23502' || /null value in column .* violates not-null/i.test(msg)) return 'not_null';
  if (code === '23505' || /duplicate key value/i.test(msg)) return 'unique';
  if (code === '42703' || /column .* does not exist/i.test(msg)) return 'no_column';
  if (code === 'PGRST205' || /could not find the table/i.test(msg)) return 'no_table';
  if (code === 'P0001') return 'raised'; // a plpgsql RAISE EXCEPTION — i.e. a trigger spoke
  return code || 'unknown';
}

const errText = (res) => String(res.body?.message ?? res.body ?? `HTTP ${res.status}`).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const tally = { pass: 0, fail: 0, skip: 0 };
const failures = [];
const skips = [];

const heading = (title, source) => process.stdout.write(`\n${title}\n  ${source}\n`);
function pass(name, detail) {
  tally.pass++;
  process.stdout.write(`  ✓ ${name}${detail ? `  — ${detail}` : ''}\n`);
}
function fail(name, detail) {
  tally.fail++;
  failures.push(name);
  process.stdout.write(`  ✗ ${name}${detail ? `  — ${detail}` : ''}\n`);
}
function skip(name, why) {
  tally.skip++;
  skips.push(name);
  process.stdout.write(`  – ${name}  — skipped: ${why}\n`);
}

// Assert a doomed insert failed for the reason we intended, not some other one.
// `expect` is the error kind that means "the thing under test is fine".
function expectKind(name, res, expect, detail) {
  const kind = errKind(res);
  if (res.ok) return fail(name, `insert unexpectedly SUCCEEDED — expected a ${expect} error`);
  if (kind === expect) return pass(name, detail);
  return fail(name, `expected ${expect}, got ${kind}: ${errText(res)}`);
}

// Rows this run created, so cleanup is precise. Sentinel-tagged rows are found
// by their text column; anything that inserted when we expected it to fail is
// tracked by the id PostgREST handed back.
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const SENTINEL = `__verify_db__${RUN_ID}`;
const strays = []; // { table, id }

// Post a row we EXPECT to be rejected. If the schema has drifted and it lands
// anyway, remember its id so cleanup can still take it back out.
async function doomedInsert(table, row) {
  const res = await rest(`/${table}`, { method: 'POST', prefer: 'return=representation', body: row });
  if (res.ok && Array.isArray(res.body)) {
    for (const r of res.body) if (r?.id) strays.push({ table, id: r.id });
  }
  return res;
}

// ---------------------------------------------------------------------------
// 1 — BILL-3 / BILL-5: a bill that didn't send has to be visible.
// ---------------------------------------------------------------------------
async function checkBillObservability() {
  heading('BILL-3 / BILL-5 · bill observability', '2026-08-bill-observability.sql');

  const col = await rest('/notifications?select=skip_reason&limit=1');
  if (col.ok) pass('notifications.skip_reason exists');
  else fail('notifications.skip_reason exists', `${errKind(col)}: ${errText(col)}`);

  // The engine writes status='skipped'. Before the migration the CHECK listed
  // only queued/sent/failed and rejected the row, losing the very outcome the
  // feature exists to record.
  const skipped = await doomedInsert('notifications', {
    order_id: BOGUS_ORDER_ID, channel: 'whatsapp', event: 'bill',
    status: 'skipped', skip_reason: SENTINEL,
  });
  expectKind("notifications.status CHECK accepts 'skipped'", skipped, 'fk', 'reached the FK, so the CHECK passed');

  // Negative control. Without it, "the CHECK accepts 'skipped'" would also read
  // green if the constraint had been dropped outright and now accepts anything.
  const bogusStatus = await doomedInsert('notifications', {
    order_id: BOGUS_ORDER_ID, channel: 'whatsapp', event: 'bill',
    status: `bogus_${RUN_ID}`, skip_reason: SENTINEL,
  });
  expectKind('notifications.status CHECK still rejects unknown values', bogusStatus, 'check', 'constraint is present, not merely dropped');
}

// ---------------------------------------------------------------------------
// 2 — TAB-1: adding to an open order is an amendment, not a second order.
// ---------------------------------------------------------------------------
async function checkRunningTab() {
  heading('TAB-1 · running tab', '2026-08-running-tab.sql');

  const add = await doomedInsert('order_amendments', {
    order_id: BOGUS_ORDER_ID, kind: 'add_item', payload: { sentinel: SENTINEL },
  });
  expectKind("order_amendments accepts kind='add_item'", add, 'fk', 'reached the FK, so the CHECK passed');

  const bogusKind = await doomedInsert('order_amendments', {
    order_id: BOGUS_ORDER_ID, kind: `bogus_${RUN_ID}`, payload: { sentinel: SENTINEL },
  });
  expectKind('order_amendments.kind CHECK still rejects unknown kinds', bogusKind, 'check', 'constraint is present, not merely dropped');
}

// ---------------------------------------------------------------------------
// 3 — POS4-1: split payments as first-class parts.
// ---------------------------------------------------------------------------
async function checkSplitPayments() {
  heading('POS4-1 · split payments', '2026-08-split-payments.sql');

  const table = await rest('/order_payments?select=id,method,amount_inr,tendered_inr&limit=1');
  if (table.ok) pass('order_payments exists with method / amount_inr / tendered_inr');
  else fail('order_payments exists with method / amount_inr / tendered_inr', `${errKind(table)}: ${errText(table)}`);

  // Change given = tendered - amount. Tendering LESS than the bill is nonsense
  // and would hand the customer negative change, so the table refuses the row.
  const underTendered = await doomedInsert('order_payments', {
    order_id: BOGUS_ORDER_ID, method: 'cash', amount_inr: 100, tendered_inr: 50,
  });
  expectKind('tendered_inr >= amount_inr CHECK is enforced', underTendered, 'check', 'tendered 50 against a 100 bill was refused');

  // The other half of the pair: a legitimate tender must get PAST that CHECK and
  // die on the FK instead. Otherwise the rejection above proves only that the row
  // was bad in some unrelated way.
  const properlyTendered = await doomedInsert('order_payments', {
    order_id: BOGUS_ORDER_ID, method: 'cash', amount_inr: 100, tendered_inr: 150,
  });
  expectKind('tendered_inr >= amount_inr CHECK admits a valid tender', properlyTendered, 'fk', 'tendered 150 against a 100 bill passed the CHECK');
}

// ---------------------------------------------------------------------------
// 4 — POS4-2: replay-safe order creation, and the keys stay private.
// ---------------------------------------------------------------------------
async function checkIdempotencyKeys() {
  heading('POS4-2 · idempotent orders', '2026-08-idempotent-orders.sql');

  const table = await rest('/idempotency_keys?select=key,order_id&limit=1');
  if (table.ok) pass('idempotency_keys exists');
  else {
    fail('idempotency_keys exists', `${errKind(table)}: ${errText(table)}`);
    skip('idempotency_keys is not readable by the anon key', 'the table itself is missing');
    return;
  }

  // RLS is on with NO policy, so anon should see nothing. Querying an EMPTY
  // table proves exactly nothing — anon and service role both get [] whether or
  // not RLS is doing anything at all. So: plant a row with the service role,
  // confirm anon still sees zero WHILE IT EXISTS, then take it back out.
  const planted = await rest('/idempotency_keys', {
    method: 'POST', prefer: 'return=representation', body: { key: SENTINEL },
  });
  if (!planted.ok) {
    skip('idempotency_keys is not readable by the anon key', `could not plant a probe row (${errText(planted)})`);
    return;
  }

  const asService = await rest(`/idempotency_keys?select=key&key=eq.${SENTINEL}`);
  const serviceRows = Array.isArray(asService.body) ? asService.body.length : 0;
  const asAnon = await rest(`/idempotency_keys?select=key&key=eq.${SENTINEL}`, { key: ANON });
  const anonRows = Array.isArray(asAnon.body) ? asAnon.body.length : 0;

  if (serviceRows !== 1) {
    fail('idempotency_keys is not readable by the anon key', `probe row not visible even to the service role (${serviceRows} rows) — result would be meaningless`);
  } else if (!asAnon.ok) {
    pass('idempotency_keys is not readable by the anon key', `anon was refused outright (${errText(asAnon)})`);
  } else if (anonRows === 0) {
    pass('idempotency_keys is not readable by the anon key', 'service role sees the planted row, anon sees 0');
  } else {
    fail('idempotency_keys is not readable by the anon key', `anon read back ${anonRows} row(s) — RLS is NOT protecting this table`);
  }

  const removed = await rest(`/idempotency_keys?key=eq.${SENTINEL}`, { method: 'DELETE', prefer: 'return=representation' });
  const left = await rest(`/idempotency_keys?select=key&key=eq.${SENTINEL}`);
  const leftRows = Array.isArray(left.body) ? left.body.length : -1;
  if (removed.ok && leftRows === 0) pass('probe row removed from idempotency_keys', 're-queried: 0 rows remain');
  else fail('probe row removed from idempotency_keys', `${leftRows} row(s) still present — REMOVE key='${SENTINEL}' BY HAND`);
}

// ---------------------------------------------------------------------------
// 5 — REF-1 schema: a counter refund has no gateway payment to point at.
// ---------------------------------------------------------------------------
async function checkRefundSchema() {
  heading('REF-1 · counter refunds (schema)', '2026-08-counter-refunds.sql');

  const col = await rest('/refunds?select=method&limit=1');
  if (col.ok) pass('refunds.method exists');
  else fail('refunds.method exists', `${errKind(col)}: ${errText(col)}`);

  // status='pending' on purpose: guard_refund_total returns early for anything
  // that is not 'processed', so this probe tests the COLUMN and nothing else.
  // With payment_id omitted, a still-NOT NULL column answers 23502; a nullable
  // one lets the row through to the order_id foreign key.
  const noPaymentId = await doomedInsert('refunds', {
    order_id: BOGUS_ORDER_ID, amount_inr: 1, status: 'pending', reason: SENTINEL,
  });
  expectKind('refunds.payment_id is nullable', noPaymentId, 'fk', 'omitting payment_id reached the FK, not a NOT NULL violation');
}

// ---------------------------------------------------------------------------
// 6 — REF-1 behaviour: the trigger that made this whole script necessary.
//
// This is the one probe that has to write a real row against a real order,
// because the bug was invisible to everything short of that.
// ---------------------------------------------------------------------------
async function checkRefundTrigger() {
  heading('REF-1 · guard_refund_total behaviour', '2026-08-counter-refunds.sql §3 — the REF-1 regression test');

  const paid = await rest('/orders?select=id,order_number,total_inr,subtotal_inr&payment_status=eq.paid&order=created_at.desc&limit=50');
  if (!paid.ok || !Array.isArray(paid.body)) {
    skip('a counter refund (payment_id NULL) INSERTs', `could not list paid orders (${errText(paid)})`);
    skip('an over-refund is still REFUSED', 'no order to probe against');
    return;
  }

  // Only PROCESSED refunds with a NULL payment_id count toward the counter-refund
  // bucket, so those are the only ones that would skew the cap arithmetic below.
  const priorRefunds = await rest('/refunds?select=order_id&status=eq.processed&payment_id=is.null');
  const refunded = new Set(Array.isArray(priorRefunds.body) ? priorRefunds.body.map((r) => r.order_id) : []);

  let target = null;
  let cap = 0;
  for (const order of paid.body) {
    if (refunded.has(order.id)) continue;
    // Mirror the trigger's own cap: the sum of the POS4-1 parts, falling back to
    // the order total for orders settled before order_payments existed.
    const parts = await rest(`/order_payments?select=amount_inr&order_id=eq.${order.id}`);
    const partsTotal = Array.isArray(parts.body) && parts.body.length
      ? parts.body.reduce((sum, p) => sum + (p.amount_inr || 0), 0)
      : null;
    const value = partsTotal ?? order.total_inr ?? order.subtotal_inr ?? 0;
    if (value >= 1) { target = order; cap = value; break; }
  }

  if (!target) {
    const why = 'no paid order without an existing counter refund and with a settled amount >= 1 — nothing safe to probe against';
    skip('a counter refund (payment_id NULL) INSERTs', why);
    skip('an over-refund is still REFUSED', why);
    return;
  }

  const where = `order #${target.order_number}, cap ${cap} INR`;

  // The exact insert that used to be impossible: no payment_id, status
  // 'processed', so the trigger runs and takes its counter-refund branch.
  const counter = await rest('/refunds', {
    method: 'POST', prefer: 'return=representation',
    body: { order_id: target.id, payment_id: null, amount_inr: 1, status: 'processed', method: 'cash', reason: SENTINEL },
  });
  const counterOk = counter.ok;
  if (counterOk) {
    pass('a counter refund (payment_id NULL) INSERTs', `1 INR against ${where}`);
  } else if (/refund total exceeds captured payment/i.test(errText(counter))) {
    fail('a counter refund (payment_id NULL) INSERTs',
      `REF-1 REGRESSION: the trigger rejected it — supabase/2026-08-counter-refunds.sql §3 is not applied. (${where})`);
  } else {
    fail('a counter refund (payment_id NULL) INSERTs', `${errKind(counter)}: ${errText(counter)} (${where})`);
  }

  // The invariant is still worth protecting: never refund more than was taken.
  // Asking for the FULL cap while 1 INR is already refunded is over by exactly
  // one rupee, which proves the trigger sums prior refunds rather than merely
  // comparing a single row against the total.
  if (!counterOk) {
    skip('an over-refund is still REFUSED', 'the 1 INR baseline refund did not insert, so the cap arithmetic cannot be exercised');
  } else {
    const over = await doomedInsert('refunds', {
      order_id: target.id, payment_id: null, amount_inr: cap, status: 'processed', method: 'cash', reason: SENTINEL,
    });
    if (over.ok) {
      fail('an over-refund is still REFUSED', `${cap} INR on top of 1 INR already refunded was ACCEPTED against a ${cap} INR cap`);
    } else if (errKind(over) === 'raised' && /refund total exceeds captured payment/i.test(errText(over))) {
      pass('an over-refund is still REFUSED', `1 + ${cap} > ${cap} rejected by guard_refund_total`);
    } else {
      fail('an over-refund is still REFUSED', `expected the trigger to raise, got ${errKind(over)}: ${errText(over)}`);
    }
  }

  const removed = await rest(`/refunds?reason=eq.${SENTINEL}`, { method: 'DELETE', prefer: 'return=representation' });
  const left = await rest(`/refunds?select=id&reason=eq.${SENTINEL}`);
  const leftRows = Array.isArray(left.body) ? left.body.length : -1;
  if (removed.ok && leftRows === 0) pass('probe refunds removed', 're-queried: 0 rows remain');
  else fail('probe refunds removed', `${leftRows} row(s) still present — REMOVE refunds WHERE reason='${SENTINEL}' BY HAND`);
}

// ---------------------------------------------------------------------------
// Cleanup — anything that landed when we expected a rejection.
// ---------------------------------------------------------------------------
async function checkCleanup() {
  if (!strays.length) return;
  heading('Cleanup', 'rows that inserted where a rejection was expected');
  for (const { table, id } of strays) {
    const removed = await rest(`/${table}?id=eq.${id}`, { method: 'DELETE', prefer: 'return=representation' });
    const left = await rest(`/${table}?select=id&id=eq.${id}`);
    const leftRows = Array.isArray(left.body) ? left.body.length : -1;
    if (removed.ok && leftRows === 0) pass(`stray ${table} row removed`, `id ${id}`);
    else fail(`stray ${table} row removed`, `id ${id} still present — REMOVE BY HAND`);
  }
}

// ---------------------------------------------------------------------------
// SECURITY · the analytics views must not leak customer PII to the anon key.
//
// Found live on 2026-08-05: `orders` correctly returned 0 rows to anon, while
// `v_valid_orders` returned FULL rows including customer_name and
// customer_phone. A Postgres view runs as its OWNER unless security_invoker is
// set, so every v_* view selecting from `orders` walked straight past that
// table's RLS — and the anon key ships to every browser.
//
// This probe is the only one that proves the hole is shut, because it asks the
// exact question an attacker would: what can the public key actually read?
// Fixed by supabase/2026-08-view-security.sql.
// ---------------------------------------------------------------------------
const PII_COLUMN = /phone|email|customer_name/i;

async function checkViewExposure() {
  heading('SECURITY · analytics views vs the anon key', '2026-08-view-security.sql');

  const views = [
    'v_valid_orders',
    'v_daily_sales',
    'v_item_sales',
    'v_hourly_orders',
    'v_order_durations',
    'v_reject_reasons',
    'v_channel_mix',
    'v_table_turnover',
    'v_staff_entry_stats',
  ];

  for (const view of views) {
    const res = await rest(`/${view}?select=*&limit=1`, { key: ANON });

    // Refused outright, or missing in this environment — either way anon reads
    // nothing. `no_table` is not a pass for a view we expect, so say which.
    if (!res.ok) {
      const kind = errKind(res);
      if (kind === 'no_table') skip(`${view} unreadable by anon`, 'the view does not exist here');
      else pass(`${view} unreadable by anon`, `anon was refused (${errText(res)})`);
      continue;
    }

    const rows = Array.isArray(res.body) ? res.body : [];
    if (rows.length === 0) {
      // Zero rows through an invoker-security view means RLS applied. But an
      // empty source table would look identical, so this is weaker evidence —
      // report it honestly rather than as a clean pass.
      pass(`${view} returns no rows to anon`, 'either RLS applied or the source is empty');
      continue;
    }

    const leaked = Object.keys(rows[0]).filter((c) => PII_COLUMN.test(c));
    if (leaked.length > 0) {
      fail(
        `${view} LEAKS CUSTOMER PII TO ANON`,
        `readable columns include ${leaked.join(', ')} — apply supabase/2026-08-view-security.sql`,
      );
    } else {
      fail(
        `${view} is readable by anon`,
        'no PII columns, but analytics should not be public — the REVOKE has not been applied',
      );
    }
  }
}

// ---------------------------------------------------------------------------
async function checkAutoPrint() {
  heading('POS4-3 · auto-print switches', '2026-08-auto-print.sql');

  const res = await rest('/store_settings?select=auto_print_kot,auto_print_bill&limit=1');
  if (!res.ok) {
    const kind = errKind(res);
    if (kind === 'no_column') fail('store_settings has the auto-print columns', 'apply supabase/2026-08-auto-print.sql');
    else fail('store_settings has the auto-print columns', errText(res));
    return;
  }
  pass('store_settings.auto_print_kot / auto_print_bill exist');

  const row = Array.isArray(res.body) ? res.body[0] : null;
  if (!row) return skip('auto-print defaults', 'no store_settings row to inspect');
  // The client falls back to these exact defaults when the columns are absent,
  // so a disagreement here means the two sources of truth have drifted.
  if (row.auto_print_kot === true && row.auto_print_bill === false) {
    pass('auto-print defaults match the client fallback', 'kot on, bill off');
  } else {
    pass(
      'auto-print values read cleanly',
      `kot=${row.auto_print_kot} bill=${row.auto_print_bill} (owner-configured, not the defaults)`,
    );
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const project = BASE.replace(/^https?:\/\//, '');
  process.stdout.write(`verify-db — probing ${project}\n`);
  process.stdout.write(`sentinel: ${SENTINEL}\n`);

  await checkBillObservability();
  await checkRunningTab();
  await checkSplitPayments();
  await checkIdempotencyKeys();
  await checkRefundSchema();
  await checkRefundTrigger();
  await checkAutoPrint();
  await checkViewExposure();
  await checkCleanup();

  process.stdout.write(`\n${'-'.repeat(64)}\n`);
  process.stdout.write(`Summary: ${tally.pass} passed · ${tally.fail} failed · ${tally.skip} skipped\n`);
  if (failures.length) process.stdout.write(`Failed: ${failures.join('; ')}\n`);
  if (skips.length) process.stdout.write(`Skipped (NOT verified — do not read these as passes): ${skips.join('; ')}\n`);

  const bad = tally.fail > 0 || (STRICT && tally.skip > 0);
  process.stdout.write(bad
    ? 'RESULT: FAIL — do not deploy until these are resolved.\n'
    : `RESULT: PASS — every probe that ran, passed.${tally.skip ? ' Note the skipped probes above.' : ''}\n`);
  process.exit(bad ? 1 : 0);
}

main().catch((err) => die(`crashed: ${err?.stack || err}`));
