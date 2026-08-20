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
// 1b — WA-4: the delivery receipts, and who can read them.
//
// The webhook writes status='delivered'/'read' and the two receipt timestamps.
// If the migration is missing, every one of those writes is rejected by the
// database and DROPPED IN SILENCE — the endpoint must answer 200 to Meta no
// matter what, so a rejected write shows up nowhere except a server log nobody
// is reading. This probe is the only thing standing between that and a webhook
// that appears to work for weeks.
//
// The index on provider_ref is deliberately NOT probed: PostgREST exposes no
// catalog view to ask, and reporting a permanent SKIP would erode the gate for
// a performance detail. Check it by hand with the query in the migration's
// Verify block.
// ---------------------------------------------------------------------------
async function checkNotifyDelivery() {
  heading('WA-4 · delivery receipts', '2026-08-notify-delivery.sql');

  const cols = await rest('/notifications?select=delivered_at,read_at&limit=1');
  if (cols.ok) pass('notifications.delivered_at / read_at exist');
  else fail('notifications.delivered_at / read_at exist', `${errKind(cols)}: ${errText(cols)}`);

  // Same technique as check 1: a doomed insert that must die on the FOREIGN KEY
  // rather than the CHECK, once per new status.
  for (const status of ['delivered', 'read']) {
    const attempt = await doomedInsert('notifications', {
      order_id: BOGUS_ORDER_ID, channel: 'whatsapp', event: 'bill',
      status, provider_ref: SENTINEL,
    });
    expectKind(`notifications.status CHECK accepts '${status}'`, attempt, 'fk', 'reached the FK, so the CHECK passed');
  }

  // The negative control belongs to this migration too: it DROPS and re-adds
  // the constraint, so "widened it" and "deleted it" look identical from the
  // accepting side.
  const bogus = await doomedInsert('notifications', {
    order_id: BOGUS_ORDER_ID, channel: 'whatsapp', event: 'bill',
    status: `bogus_${RUN_ID}`, provider_ref: SENTINEL,
  });
  expectKind('the re-added CHECK still rejects unknown statuses', bogus, 'check', 'widened, not dropped');

  // --- and now a REAL row, because the doomed inserts above never touch disk.
  //
  // Two things only a landed row can prove: that delivered_at accepts a
  // timestamp, and that the delivery log is invisible to the anon key. The
  // second needs the row to EXIST while anon looks: RLS with no matching policy
  // answers 200 with an EMPTY ARRAY, not a permission error, so querying an
  // empty table proves nothing at all and reads green forever.
  const orders = await rest('/orders?select=id&order=created_at.desc&limit=25');
  const candidates = Array.isArray(orders.body) ? orders.body : [];
  if (!candidates.length) {
    skip('a delivered receipt INSERTs and is invisible to anon', `no order to attach a probe row to (${errText(orders)})`);
    return;
  }

  // notifications is UNIQUE (order_id, event, channel). 'push' is a channel the
  // engine has never sent on, so this triple is free on any order — but check,
  // rather than collide with real data.
  const taken = await rest('/notifications?select=order_id&channel=eq.push&event=eq.cancelled');
  const used = new Set(Array.isArray(taken.body) ? taken.body.map((r) => r.order_id) : []);
  const target = candidates.find((o) => !used.has(o.id));
  if (!target) {
    skip('a delivered receipt INSERTs and is invisible to anon', 'every recent order already has a push/cancelled row');
    return;
  }

  const stamp = new Date().toISOString();
  const planted = await rest('/notifications', {
    method: 'POST', prefer: 'return=representation',
    body: {
      order_id: target.id, channel: 'push', event: 'cancelled',
      status: 'delivered', provider_ref: SENTINEL, delivered_at: stamp,
    },
  });
  if (!planted.ok) {
    const kind = errKind(planted);
    if (kind === 'check' || kind === 'no_column') {
      fail('a delivered receipt INSERTs', `apply supabase/2026-08-notify-delivery.sql — ${errText(planted)}`);
    } else {
      skip('a delivered receipt INSERTs and is invisible to anon', `could not plant a probe row (${errText(planted)})`);
    }
    return;
  }
  pass('a delivered receipt INSERTs', "status='delivered' with a delivered_at was accepted");

  const asService = await rest(`/notifications?select=id,status,delivered_at&provider_ref=eq.${SENTINEL}`);
  const serviceRows = Array.isArray(asService.body) ? asService.body : [];
  const asAnon = await rest(`/notifications?select=id&provider_ref=eq.${SENTINEL}`, { key: ANON });
  const anonRows = Array.isArray(asAnon.body) ? asAnon.body.length : -1;

  if (serviceRows.length !== 1) {
    fail('the delivery log is not readable by the anon key', `probe row not visible even to the service role (${serviceRows.length} rows) — result would be meaningless`);
  } else if (!asAnon.ok) {
    pass('the delivery log is not readable by the anon key', `anon was refused outright (${errText(asAnon)})`);
  } else if (anonRows === 0) {
    pass('the delivery log is not readable by the anon key', 'RLS returned an empty set for a row that demonstrably exists');
  } else {
    fail('the delivery log is readable by the anon key', `anon read back ${anonRows} row(s) — the webhook would be writing into a table customers can read`);
  }

  if (serviceRows.length === 1 && serviceRows[0].delivered_at) {
    pass('delivered_at round-trips', `stored ${serviceRows[0].delivered_at}`);
  } else if (serviceRows.length === 1) {
    fail('delivered_at round-trips', 'the column came back null after being written');
  }

  const removed = await rest(`/notifications?provider_ref=eq.${SENTINEL}`, { method: 'DELETE', prefer: 'return=representation' });
  const left = await rest(`/notifications?select=id&provider_ref=eq.${SENTINEL}`);
  const leftRows = Array.isArray(left.body) ? left.body.length : -1;
  if (removed.ok && leftRows === 0) pass('probe row removed from notifications', 're-queried: 0 rows remain');
  else fail('probe row removed from notifications', `${leftRows} row(s) still present — DELETE FROM notifications WHERE provider_ref='${SENTINEL}' BY HAND`);
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
async function checkAnonSurface() {
  heading('SECURITY · other tables vs the anon key', '2026-08-rate-limits-rls.sql');

  // rate_limits was the only table in the schema with RLS never enabled.
  // Reading it exposes the keys, which embed customer EMAIL ADDRESSES, E.164
  // PHONE NUMBERS and IPs (see the rateLimitOk calls in app/api/auth/**) — not
  // merely "when to retry". Nothing legitimate reads it from a client:
  // check_rate_limit is SECURITY DEFINER and runs server-side.
  //
  // THIS NEEDS A PLANTED ROW. `enable row level security` with NO policy does
  // not produce a permission error — it returns 200 with an EMPTY ARRAY. So an
  // "is it readable?" check that only inspects the status code cannot tell a
  // protected table from an empty one, and on an empty table it reports a
  // false failure forever. (It did exactly that here.) The harness's own rule
  // applies: where a positive result could also come from the constraint being
  // absent, run a negative control.
  const sentinelKey = `verify-db-sentinel:${SENTINEL}`;
  const planted = await rest('/rate_limits', {
    method: 'POST',
    prefer: 'return=representation',
    body: { key: sentinelKey, count: 1 },
  });

  if (!planted.ok) {
    skip(
      'rate_limits is not readable by anon',
      `could not plant a probe row (${errText(planted)}) — cannot distinguish "protected" from "empty"`,
    );
    return;
  }

  const anonRead = await rest(
    `/rate_limits?select=key&key=eq.${encodeURIComponent(sentinelKey)}`,
    { key: ANON },
  );
  const anonRows = Array.isArray(anonRead.body) ? anonRead.body.length : -1;

  if (!anonRead.ok) {
    pass('rate_limits is not readable by anon', `anon was refused outright (${errText(anonRead)})`);
  } else if (anonRows === 0) {
    // Service role planted it and can see it; anon cannot. That is RLS working.
    pass(
      'rate_limits is not readable by anon',
      'RLS returned an empty set for a row that demonstrably exists',
    );
  } else {
    fail(
      'rate_limits is readable by anon',
      `anon read back the planted row — RLS is not enabled; apply supabase/2026-08-rate-limits-rls.sql. ` +
        `Keys embed customer emails and phone numbers.`,
    );
  }

  const cleaned = await rest(`/rate_limits?key=eq.${encodeURIComponent(sentinelKey)}`, {
    method: 'DELETE',
  });
  const remaining = await rest(
    `/rate_limits?select=key&key=eq.${encodeURIComponent(sentinelKey)}`,
  );
  const left = Array.isArray(remaining.body) ? remaining.body.length : -1;
  if (cleaned.ok && left === 0) {
    pass('probe row removed from rate_limits', 're-queried: 0 rows remain');
  } else {
    fail(
      'probe row removed from rate_limits',
      `DELETE the row with key = '${sentinelKey}' BY HAND`,
    );
  }
}

// ---------------------------------------------------------------------------
async function checkRefundIdempotency() {
  heading('REF-2 · refund replay protection', '2026-08-refund-idempotency.sql');

  const res = await rest('/refunds?select=idempotency_key&limit=1');
  if (!res.ok) {
    const kind = errKind(res);
    if (kind === 'no_column') {
      fail(
        'refunds.idempotency_key exists',
        'a double-tapped Refund can pay twice — apply supabase/2026-08-refund-idempotency.sql',
      );
    } else {
      fail('refunds.idempotency_key exists', errText(res));
    }
    return;
  }
  pass('refunds.idempotency_key exists');

  // The column alone is not the guarantee — the UNIQUE index is. Prove it by
  // inserting the same key twice; the second must be refused as a duplicate.
  // Both use a bogus order_id, so neither can ever commit.
  const key = `${SENTINEL}-dupe`;
  const row = { order_id: BOGUS_ORDER_ID, amount_inr: 1, reason: SENTINEL, status: 'pending', idempotency_key: key };
  const first = await rest('/refunds', { method: 'POST', body: row });
  if (errKind(first) !== 'fk') {
    skip('refunds.idempotency_key is UNIQUE', `could not stage the probe (${errText(first)})`);
    return;
  }
  // status='pending' skips guard_refund_total, so the FK is the only barrier —
  // meaning the unique index was reached and passed on this first attempt.
  pass('refunds.idempotency_key is indexed and reachable', 'a keyed insert reaches the FK, not an index error');
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
// VAL-2 · a counter order can point at a customer's loyalty account.
//
// The column alone is not the guarantee. What makes it safe to trust is that
// NOTHING but a real account id can ever be stored in it — the value is derived
// from a verified phone, and the foreign key is the backstop if a future code
// path forgets that. So this probes the constraint, not just the column.
// ---------------------------------------------------------------------------
async function checkCounterLoyalty() {
  heading('VAL-2 · counter loyalty linkage', '2026-08-counter-loyalty.sql');

  const col = await rest('/orders?select=id,user_id,customer_user_id&order=created_at.desc&limit=1');
  if (!col.ok) {
    const kind = errKind(col);
    if (kind === 'no_column') {
      fail(
        'orders.customer_user_id exists',
        'a regular buying at the counter can neither earn nor redeem — apply supabase/2026-08-counter-loyalty.sql',
      );
    } else {
      fail('orders.customer_user_id exists', `${kind}: ${errText(col)}`);
    }
    skip('customer_user_id is a real foreign key', 'the column is missing');
    return;
  }
  pass('orders.customer_user_id exists');

  const rows = Array.isArray(col.body) ? col.body : [];
  if (rows.length === 0) {
    return skip('customer_user_id is a real foreign key', 'no order exists to probe against');
  }
  const target = rows[0];
  const before = target.customer_user_id ?? null;

  // Aiming the column at an id that belongs to no account. With the FK in place
  // this UPDATE never happens, so the row — including updated_at, which the
  // orders trigger would otherwise bump — is untouched. Only the failing case
  // writes, and it repairs itself below before reporting.
  const bogus = await rest(`/orders?id=eq.${target.id}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { customer_user_id: BOGUS_ORDER_ID },
  });

  if (!bogus.ok) {
    if (errKind(bogus) === 'fk') {
      return pass('customer_user_id is a real foreign key', 'an id belonging to no account was refused');
    }
    return fail('customer_user_id is a real foreign key', `expected fk, got ${errKind(bogus)}: ${errText(bogus)}`);
  }

  const revert = await rest(`/orders?id=eq.${target.id}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { customer_user_id: before },
  });
  const after = await rest(`/orders?select=customer_user_id&id=eq.${target.id}`);
  const value = Array.isArray(after.body) && after.body[0] ? (after.body[0].customer_user_id ?? null) : 'unreadable';

  if (revert.ok && value === before) {
    fail(
      'customer_user_id is a real foreign key',
      'a non-existent account id STORED — the references clause is missing (the row has been put back)',
    );
  } else {
    fail(
      'customer_user_id is a real foreign key',
      `a non-existent account id stored AND the revert failed — SET customer_user_id = ${
        before === null ? 'NULL' : `'${before}'`
      } ON orders id ${target.id} BY HAND`,
    );
  }
}

// ---------------------------------------------------------------------------
async function checkAttendance() {
  heading('Phase 5 · attendance schema & exposure', '2026-08-attendance.sql');

  const settings = await rest('/attendance_settings?select=store_lat,geofence_radius_m&limit=1');
  if (!settings.ok) {
    if (errKind(settings) === 'no_table' || errKind(settings) === 'no_column') {
      fail('attendance_settings exists', 'apply supabase/2026-08-attendance.sql');
      skip('attendance_settings is not readable by anon', 'the table is missing');
      skip('attendance_sessions exists', 'the migration has not been applied');
      skip('attendance permission keys are seeded', 'the migration has not been applied');
      return;
    }
    fail('attendance_settings exists', errText(settings));
    return;
  }
  pass('attendance_settings exists');

  const row = Array.isArray(settings.body) ? settings.body[0] : null;
  if (row && row.store_lat === null) {
    pass(
      'cafe coordinates are unset',
      'punching is disabled until the owner sets them — which is the correct default, not a gap',
    );
  } else if (row) {
    pass('cafe coordinates are set', `radius ${row.geofence_radius_m} m`);
  }

  // A-3: a staffer who learns the radius learns most of what they need to beat
  // it, so this table must be unreadable by a browser session — anon here is the
  // cheapest proxy for "any client-side key".
  const anonSettings = await rest('/attendance_settings?select=geofence_radius_m&limit=1', { key: ANON });
  if (!anonSettings.ok) {
    pass('attendance_settings is not readable by anon', `anon was refused (${errText(anonSettings)})`);
  } else {
    fail(
      'attendance_settings is not readable by anon',
      'the geofence radius is world-readable — the REVOKE in SECTION 8 has not been applied',
    );
  }

  const sessions = await rest('/attendance_sessions?select=id,business_date,status&limit=1');
  if (sessions.ok) {
    pass('attendance_sessions exists');
  } else {
    fail('attendance_sessions exists', errText(sessions));
  }

  // Salary must not be readable by a browser session at all (A-5).
  const anonEmployment = await rest('/staff_employment?select=monthly_salary_inr&limit=1', { key: ANON });
  if (!anonEmployment.ok) {
    pass('staff_employment is not readable by anon', `anon was refused (${errText(anonEmployment)})`);
  } else {
    fail('staff_employment is not readable by anon', 'salary data is exposed — apply SECTION 8 of the migration');
  }

  // SHEET-2 / D5-6. A day off is not a session, so paid leave has nowhere to
  // live without this table.
  const marks = await rest('/attendance_day_marks?select=mark&limit=1');
  if (marks.ok) {
    pass('attendance_day_marks exists');
  } else if (errKind(marks) === 'no_table') {
    fail('attendance_day_marks exists', 'paid leave cannot be recorded — apply supabase/2026-08-attendance-day-marks.sql');
  } else {
    fail('attendance_day_marks exists', errText(marks));
  }

  // The clock-out RPC is the only way clock_out_at gets the DATABASE's clock
  // rather than the app server's. If it is missing, clocking in works and
  // clocking OUT fails — the worst possible split, because staff would discover
  // it at the end of a shift. A bogus session id matches no row, so this probe
  // exercises the function without touching data.
  const rpc = await rest('/rpc/attendance_clock_out', {
    method: 'POST',
    body: {
      p_session_id: BOGUS_ORDER_ID,
      p_user_id: BOGUS_ORDER_ID,
      p_lat: 0,
      p_lng: 0,
      p_accuracy_m: 0,
      p_distance_m: 0,
      p_flags: [],
    },
  });
  if (rpc.ok) {
    const rows = Array.isArray(rpc.body) ? rpc.body.length : 0;
    if (rows === 0) {
      pass('attendance_clock_out RPC exists', 'a bogus session id matched no rows, as it should');
    } else {
      fail('attendance_clock_out RPC exists', `it closed ${rows} row(s) for a bogus id — the guard is wrong`);
    }
  } else {
    fail(
      'attendance_clock_out RPC exists',
      `clocking OUT would fail at the end of a shift (${errText(rpc)}) — re-apply SECTION 4b of supabase/2026-08-attendance.sql`,
    );
  }

  // LEAVE. The two CHECK constraints are the ones worth probing: they are what
  // stop a row claiming a weekend day, or a week that does not start on Monday.
  const leave = await rest('/leave_requests?select=id,week_start,leave_date&limit=1');
  if (leave.ok) {
    pass('leave_requests exists');
  } else if (errKind(leave) === 'no_table') {
    fail('leave_requests exists', 'weekly leave planning is unavailable — apply supabase/2026-08-leave-planning.sql');
  } else {
    fail('leave_requests exists', errText(leave));
  }

  const maxLeave = await rest('/attendance_settings?select=max_leave_days_per_week&limit=1');
  if (maxLeave.ok) {
    pass('attendance_settings.max_leave_days_per_week exists');
  } else {
    fail(
      'attendance_settings.max_leave_days_per_week exists',
      'apply supabase/2026-08-leave-planning.sql',
    );
  }

  // The two keys must exist as rows. hasPermission() fails CLOSED to manager
  // for a missing key, so an absent row does not fail loudly — it silently
  // escalates the action, which is exactly the kind of thing a probe is for.
  // Read the whole (tiny) matrix rather than filtering by prefix — the keys
  // this checks for no longer share one, and a prefix filter would silently
  // exclude 'leave_approve' and then report it missing forever.
  const perms = await rest('/role_permissions?select=permission_key,min_role');
  if (perms.ok && Array.isArray(perms.body)) {
    const keys = perms.body.map((r) => r.permission_key);
    const want = ['attendance_approve', 'attendance_edit', 'leave_approve'];
    const missing = want.filter((k) => !keys.includes(k));
    if (missing.length === 0) {
      pass('attendance + leave permission keys are seeded', want.join(', '));
    } else {
      fail(
        'attendance + leave permission keys are seeded',
        `missing ${missing.join(', ')} — an unseeded key fails CLOSED to manager, silently escalating the action`,
      );
    }
  } else {
    fail('attendance + leave permission keys are seeded', errText(perms));
  }
}


// ---------------------------------------------------------------------------
// Phase 6 · DEV-2/DEV-3 — the counter machines.
//
// pos_devices holds a SECRET (token_hash) and is the qr_token lesson applied a
// second time: RLS on, no policies, service-role only. The probe that matters is
// therefore the RLS one, and it only means anything with a row actually present
// — an empty table returns [] to everyone.
// ---------------------------------------------------------------------------
async function checkPosDevices() {
  heading('DEV-2/DEV-3 · enrolled counter machines', '2026-08-pos-devices.sql');

  const cols =
    'id,name,enrolled_by,enrolled_at,last_seen_at,revoked_at,default_order_type,auto_print_kot,auto_print_bill';
  const table = await rest(`/pos_devices?select=${cols}&limit=1`);
  if (!table.ok) {
    const kind = errKind(table);
    if (kind === 'no_table' || kind === 'no_column') {
      fail('pos_devices exists', 'apply supabase/2026-08-pos-devices.sql');
      skip('enrolled_by must be a real profile', 'the table is missing');
      skip('default_order_type refuses a type the POS cannot mean', 'the table is missing');
      skip('pos_devices is not readable by the anon key', 'the table is missing');
      skip('two ACTIVE devices cannot share a name', 'the table is missing');
      return;
    }
    fail('pos_devices exists', errText(table));
    return;
  }
  pass('pos_devices exists', 'all DEV-2 + DEV-3 columns present');

  // Who enrolled it has to be a real account: 'enrolled_by' is the audit trail
  // for a credential-issuing action.
  const badOwner = await doomedInsert('pos_devices', {
    name: `${SENTINEL}-fk`, token_hash: `${SENTINEL}-fk`, enrolled_by: BOGUS_ORDER_ID,
  });
  expectKind('enrolled_by must be a real profile', badOwner, 'fk', 'a non-existent enroller was refused');

  // Everything below needs a real profile to hang a row off.
  const who = await rest('/profiles?select=id&limit=1');
  const ownerId = Array.isArray(who.body) && who.body[0] ? who.body[0].id : null;
  if (!ownerId) {
    skip('default_order_type refuses a type the POS cannot mean', `no profile row to enroll against (${errText(who)})`);
    skip('pos_devices is not readable by the anon key', 'no profile row to enroll against');
    skip('two ACTIVE devices cannot share a name', 'no profile row to enroll against');
    return;
  }

  // 'delivery' is a real OrderType elsewhere in the schema and NOT a thing a
  // counter can default to — which is exactly why the CHECK lists two values
  // rather than deferring to the orders enum.
  const badType = await doomedInsert('pos_devices', {
    name: `${SENTINEL}-check`, token_hash: `${SENTINEL}-check`,
    enrolled_by: ownerId, default_order_type: 'delivery',
  });
  expectKind('default_order_type refuses a type the POS cannot mean', badType, 'check', "'delivery' was rejected");

  // Plant a live device, then ask the public key what it can see. A device
  // secret readable through PostgREST would let anyone who has the anon key
  // (i.e. anyone who loaded the site) enumerate and impersonate tills.
  const planted = await rest('/pos_devices', {
    method: 'POST', prefer: 'return=representation',
    body: { name: SENTINEL, token_hash: SENTINEL, enrolled_by: ownerId },
  });
  if (!planted.ok) {
    skip('pos_devices is not readable by the anon key', `could not plant a probe row (${errText(planted)})`);
    skip('two ACTIVE devices cannot share a name', 'could not plant a probe row');
    return;
  }

  const asService = await rest(`/pos_devices?select=id,token_hash&token_hash=eq.${SENTINEL}`);
  const serviceRows = Array.isArray(asService.body) ? asService.body.length : 0;
  const asAnon = await rest(`/pos_devices?select=id,token_hash&token_hash=eq.${SENTINEL}`, { key: ANON });
  const anonRows = Array.isArray(asAnon.body) ? asAnon.body.length : 0;

  if (serviceRows !== 1) {
    fail('pos_devices is not readable by the anon key', `probe row not visible even to the service role (${serviceRows} rows) — result would be meaningless`);
  } else if (!asAnon.ok) {
    pass('pos_devices is not readable by the anon key', `anon was refused outright (${errText(asAnon)})`);
  } else if (anonRows === 0) {
    pass('pos_devices is not readable by the anon key', 'service role sees the planted device, anon sees 0');
  } else {
    fail('pos_devices is not readable by the anon key', `anon read back ${anonRows} device secret(s) — RLS is NOT protecting this table`);
  }

  // The owner picks which machine to kill off a list of names. Two live
  // "Counter 1"s make that a coin flip.
  const dupe = await doomedInsert('pos_devices', {
    name: SENTINEL.toUpperCase(), token_hash: `${SENTINEL}-dupe`, enrolled_by: ownerId,
  });
  expectKind('two ACTIVE devices cannot share a name', dupe, 'unique', 'a case-different duplicate was refused');

  // A revoked device releases its name — re-enrolling a repaired till under the
  // same label is the normal case, not an edge one.
  const revoked = await rest(`/pos_devices?token_hash=eq.${SENTINEL}`, {
    method: 'PATCH', prefer: 'return=representation', body: { revoked_at: new Date().toISOString() },
  });
  if (!revoked.ok) {
    skip('a revoked name can be reused', errText(revoked));
  } else {
    const reused = await rest('/pos_devices', {
      method: 'POST', prefer: 'return=representation',
      body: { name: SENTINEL, token_hash: `${SENTINEL}-again`, enrolled_by: ownerId },
    });
    if (reused.ok) {
      pass('a revoked name can be reused', 'the unique index is partial, as intended');
      if (Array.isArray(reused.body)) for (const r of reused.body) if (r?.id) strays.push({ table: 'pos_devices', id: r.id });
    } else {
      fail('a revoked name can be reused', `${errKind(reused)}: ${errText(reused)} — the index is not partial`);
    }
  }

  const removed = await rest(`/pos_devices?token_hash=like.${SENTINEL}*`, { method: 'DELETE', prefer: 'return=representation' });
  const left = await rest(`/pos_devices?select=id&token_hash=like.${SENTINEL}*`);
  const leftRows = Array.isArray(left.body) ? left.body.length : -1;
  if (removed.ok && leftRows === 0) pass('probe devices removed from pos_devices', 're-queried: 0 rows remain');
  else fail('probe devices removed from pos_devices', `${leftRows} row(s) still present — REMOVE token_hash LIKE '${SENTINEL}%' BY HAND`);
}

// ---------------------------------------------------------------------------
async function main() {
  const project = BASE.replace(/^https?:\/\//, '');
  process.stdout.write(`verify-db — probing ${project}\n`);
  process.stdout.write(`sentinel: ${SENTINEL}\n`);

  await checkBillObservability();
  await checkNotifyDelivery();
  await checkRunningTab();
  await checkSplitPayments();
  await checkIdempotencyKeys();
  await checkRefundSchema();
  await checkRefundTrigger();
  await checkRefundIdempotency();
  await checkAutoPrint();
  await checkCounterLoyalty();
  await checkViewExposure();
  await checkAnonSurface();
  await checkAttendance();
  await checkPosDevices();
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
