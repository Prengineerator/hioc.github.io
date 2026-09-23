#!/usr/bin/env node
// ===========================================================================
// verify-notifications — audit the bill-delivery chain, including the half of
// it that lives inside Meta and that nothing in this repo can see.
//
// The owner's report is "the WhatsApp bill never arrives". Everything the
// application can observe about that says success:
//   * getAdapter() falls back to the log stub when credentials are missing, and
//     the stub RETURNS ok — so the delivery log reads `sent` while nothing left
//     the building (WA-1 brands those refs `stub_`, but only from now on).
//   * even with real credentials, the Cloud API answers 200 with a message id
//     for a send that Meta will then throttle or drop. Category, template state
//     and token longevity are all invisible to the sending code.
//
// So the truth lives in two places this script goes and looks:
//   1. the environment, resolved exactly the way lib/notifications/adapters.ts
//      resolves it — which adapter will actually run, and WHY that one;
//   2. the Meta Graph API — is the token real and permanent, is the template
//      APPROVED, and is it categorised UTILITY.
//
// That last one is the headline. A bill template categorised MARKETING is
// throttled PER RECIPIENT by Meta: the send is accepted, a message id comes
// back, the row logs `sent`, and the phone never rings. It is the single most
// likely explanation for "never arrives" with a green-looking log, and no
// amount of reading our own code can detect it.
//
// Run:  npm run verify:notifications
//       npm run verify:notifications -- --strict
//       npm run verify:notifications -- --send-test +919876543210
//
// Exit codes:
//   0 — nothing is broken AND the environment's intent matches its reality.
//       An unconfigured local checkout exits 0 as NOT CONFIGURED.
//   1 — genuine misconfiguration: invalid/expired token, template missing, not
//       APPROVED, not UTILITY, wrong variable shape, unreachable header image,
//       a --send-test that could not be performed or that Meta refused, or —
//       the check that matters most — an environment that asked for WhatsApp
//       (NOTIFY_PROVIDER=whatsapp) and cannot actually deliver a bill.
//   2 — the script itself could not run (bad arguments, crash).
//   3 — INCOMPLETE. Nothing that ran failed, but the Meta-side probes could not
//       run, so the MARKETING-vs-UTILITY question this script exists to answer
//       is still open. Explicitly NOT 0: unproven is not proven.
//   --strict also fails on SKIPPED and WARN, for a pre-deploy gate that should
//   refuse to pass on unproven ground rather than on proven-good ground.
//
// A SKIP IS NEVER A PASS — at the line level AND at the verdict level. The
// second half is the one that matters: a run whose every line is honest but
// whose last line says PASS has told the owner the channel is proven.
//
// Conventions are lifted wholesale from scripts/verify-db.mjs: hand-rolled
// .env.local parsing (no dotenv), plain fetch (no SDK), pass/fail/skip that
// never dresses a skip up as a pass.
//
// SECRETS: no token value is ever printed. Secrets are reported as length +
// last 4 characters, and every line written by this script is scrubbed of any
// known secret value on the way out (see `out`) — belt and braces, because a
// Graph error message can echo what you sent it.
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
// Everything with a DECISION in it lives here, unit-tested against the
// TypeScript modules it mirrors (tests/verifyNotifications.test.ts). This file
// keeps only what cannot be tested without fetch/stdout/process.exit.
import {
  BILL_EMAIL_VARS,
  BILL_WHATSAPP_VARS,
  EXPECTED_BILL_VARS,
  isE164,
  parseEnvBody,
  placeholdersIn,
  resolveAdapter as resolveAdapterFor,
  resolveWabaId as resolveWabaIdFrom,
  verdictFor,
} from './lib/notifyVerify.mjs';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const ARGV = process.argv.slice(2);
const STRICT = ARGV.includes('--strict');

if (ARGV.includes('--help') || ARGV.includes('-h')) {
  process.stdout.write(
    'verify-notifications — audit the notification channels, env-side and Meta-side.\n\n' +
      '  node scripts/verify-notifications.mjs [--strict] [--send-test <+E164>]\n\n' +
      '  --strict              also fail on SKIPPED and WARN probes (pre-deploy gate)\n' +
      '  --send-test <+E164>   perform ONE real template send to that number and\n' +
      "                        print Meta's raw response. Costs a conversation.\n\n" +
      'Exit: 0 clean · 1 misconfigured · 2 could not run.\n',
  );
  process.exit(0);
}

// Writes through out() — i.e. through redact() — because this is the crash path
// and a stack trace is the single most likely place for a raw secret to appear.
// `out` is defined below; this only ever runs after module evaluation.
function die(msg) {
  out(`\nverify-notifications: ${msg}\n`);
  process.exit(2);
}

// Accept both `--send-test +91…` and `--send-test=+91…`.
function sendTestTarget() {
  const joined = ARGV.find((a) => a.startsWith('--send-test='));
  if (joined) return joined.slice('--send-test='.length);
  const i = ARGV.indexOf('--send-test');
  if (i === -1) return null;
  const next = ARGV[i + 1];
  if (!next || next.startsWith('-')) {
    die('--send-test needs a phone number in full E.164 form, e.g. --send-test +919876543210');
  }
  return next;
}
const SEND_TEST = sendTestTarget();

// ---------------------------------------------------------------------------
// Environment
//
// Read .env.local by hand rather than pulling in dotenv, same as verify-db.
// Unlike verify-db, a MISSING .env.local is not fatal: the interesting way to
// run this script is against production credentials pulled into the shell
// (`vercel env pull` / `export WHATSAPP_TOKEN=…`), and refusing to start
// without a local file would block exactly that.
//
// Precedence matches Next.js: a variable already present in the shell wins over
// the file, and the report says which source a value came from — "it works on
// my machine" is usually a disagreement about that.
// ---------------------------------------------------------------------------
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return parseEnvBody(fs.readFileSync(file, 'utf8'));
}

// fileURLToPath, not url.pathname — the latter stays percent-encoded, so a repo
// checked out under a path with a space would look for a directory named '%20'.
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_FILE = path.join(ROOT, '.env.local');
const fileEnv = loadEnvFile(ENV_FILE);

function get(name) {
  const shell = process.env[name];
  if (typeof shell === 'string' && shell.trim().length > 0) return shell.trim();
  const file = fileEnv[name];
  if (typeof file === 'string' && file.trim().length > 0) return file.trim();
  return '';
}
const isSet = (name) => get(name).length > 0;

/**
 * `vercel env pull` cannot read back a variable marked "Sensitive" in the Vercel
 * dashboard — it writes the literal string `[SENSITIVE]` into the file instead.
 *
 * Without this check the run is actively misleading: an eleven-character value
 * is handed to Meta, Meta answers `Cannot parse access token`, and the script
 * reports the production token as INVALID when it is real and working. That
 * mis-diagnosis cost a round trip once already — the giveaway was that order
 * status messages kept arriving on WhatsApp with the "invalid" token.
 */
const REDACTED_MARKERS = ['[SENSITIVE]', '[REDACTED]', '[ENCRYPTED]'];
const isRedacted = (name) => REDACTED_MARKERS.includes(get(name));
const sourceOf = (name) => {
  const shell = process.env[name];
  if (typeof shell === 'string' && shell.trim().length > 0) return 'shell';
  return fileEnv[name] ? '.env.local' : '';
};

// Anything whose VALUE must never reach the terminal. Reported as length +
// last 4 only, and scrubbed from every line this script writes.
const SECRET_VARS = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'TWILIO_AUTH_TOKEN',
  'RESEND_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'RAZORPAY_KEY_SECRET',
];

// Short values (a language code, a 'true') would match half the output, so only
// things long enough to be a real credential are scrubbed.
const secrets = SECRET_VARS.map((name) => ({ name, value: get(name) })).filter((s) => s.value.length >= 8);

function redact(text) {
  let scrubbed = text;
  for (const { name, value } of secrets) {
    if (scrubbed.includes(value)) scrubbed = scrubbed.split(value).join(`[redacted:${name}]`);
  }
  return scrubbed;
}

/** The ONLY way anything reaches stdout, so the scrub cannot be forgotten. */
function out(text) {
  process.stdout.write(redact(text));
}

/** A secret's shape, never its value: enough to tell two tokens apart. */
function shape(name) {
  const v = get(name);
  if (!v) return 'MISSING';
  if (isRedacted(name)) {
    return `REDACTED by \`vercel env pull\` (marked Sensitive in Vercel) — the real value is set in the deployment, but this run cannot use it`;
  }
  return `set (${v.length} chars, ends …${v.slice(-4)}) from ${sourceOf(name)}`;
}

/** A non-secret's value, which is the whole point of printing it. */
function plain(name, fallback = '') {
  const v = get(name);
  if (!v) return fallback ? `unset (defaults to '${fallback}')` : 'MISSING';
  return `'${v}' from ${sourceOf(name)}`;
}

// ---------------------------------------------------------------------------
// Reporting — verify-db's vocabulary, plus WARN.
//
// WARN exists because this script has a third answer beyond pass/fail: "this
// works today and will stop working". A user token with 41 days left sends
// perfectly right now and is still the top suspect for the next outage. Calling
// that a failure would make the script cry wolf on a healthy channel; calling it
// a pass would hide the time bomb. --strict promotes warnings to failures.
// ---------------------------------------------------------------------------
const tally = { pass: 0, fail: 0, warn: 0, skip: 0, blocked: 0 };
const failures = [];
const warnings = [];
const skips = [];
const blockers = [];

const heading = (title, source) => out(`\n${title}\n  ${source}\n`);
function pass(name, detail) {
  tally.pass++;
  out(`  ✓ ${name}${detail ? `  — ${detail}` : ''}\n`);
}
function fail(name, detail) {
  tally.fail++;
  failures.push(name);
  out(`  ✗ ${name}${detail ? `  — ${detail}` : ''}\n`);
}
function warn(name, detail) {
  tally.warn++;
  warnings.push(name);
  out(`  ! ${name}${detail ? `  — ${detail}` : ''}\n`);
}
function skip(name, why) {
  tally.skip++;
  skips.push(name);
  out(`  – ${name}  — skipped: ${why}\n`);
}
/**
 * A probe that was REQUIRED in this environment and could not run.
 *
 * Distinct from skip(): a skip is "there is nothing to check here" (no
 * credentials on a laptop), which is a fine reason to exit 0. A block is "the
 * thing this script exists to check could not be checked", which is not — it is
 * unproven ground, and the run says INCOMPLETE rather than PASS. See verdictFor.
 */
function blocked(name, why) {
  tally.blocked++;
  blockers.push(name);
  out(`  ? ${name}  — COULD NOT VERIFY: ${why}\n`);
}
const info = (line) => out(`    ${line}\n`);

// ---------------------------------------------------------------------------
// Meta Graph API
// ---------------------------------------------------------------------------
const API_VERSION = get('WHATSAPP_API_VERSION') || 'v21.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

async function graph(pathAndQuery, { token = get('WHATSAPP_TOKEN'), method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${GRAPH}${pathAndQuery}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // An audit must not hang forever on a network stall.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { status: 0, ok: false, body: { error: { message: String(err?.message || err), type: 'NETWORK' } } };
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: { message: text, type: 'NON_JSON' } };
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

/** Meta's own words, verbatim — the AC asks for the Graph error, not a paraphrase. */
function graphError(res) {
  const e = res.body?.error;
  if (!e) return `HTTP ${res.status}`;
  const bits = [e.message ?? `HTTP ${res.status}`];
  if (e.type) bits.push(`type ${e.type}`);
  if (e.code !== undefined) bits.push(`code ${e.code}`);
  if (e.error_subcode) bits.push(`subcode ${e.error_subcode}`);
  if (e.error_user_msg) bits.push(e.error_user_msg);
  return bits.join(' · ');
}

/** OAuthException 190 is Meta's "this token is dead" — expired, revoked or bogus. */
const isAuthError = (res) => res.body?.error?.code === 190 || res.body?.error?.type === 'OAuthException';

// ---------------------------------------------------------------------------
// 1 — Environment: what is set, what is missing, where it came from.
// ---------------------------------------------------------------------------
function reportEnvironment() {
  heading('Environment', `${fs.existsSync(ENV_FILE) ? '.env.local' : '(no .env.local)'} + shell, shell wins`);

  const rows = [
    ['NOTIFY_PROVIDER', plain('NOTIFY_PROVIDER', 'log')],
    ['WHATSAPP_TOKEN', shape('WHATSAPP_TOKEN')],
    ['WHATSAPP_PHONE_ID', plain('WHATSAPP_PHONE_ID')],
    ['WHATSAPP_API_VERSION', plain('WHATSAPP_API_VERSION', 'v21.0')],
    ['WHATSAPP_TPL_BILL', plain('WHATSAPP_TPL_BILL', 'order_bill_1')],
    ['WHATSAPP_TPL_LANG', plain('WHATSAPP_TPL_LANG', 'en')],
    ['WHATSAPP_TPL_BILL_HEADER_IMAGE', plain('WHATSAPP_TPL_BILL_HEADER_IMAGE')],
    ['NEXT_PUBLIC_SITE_URL', plain('NEXT_PUBLIC_SITE_URL')],
    ['WHATSAPP_WABA_ID', plain('WHATSAPP_WABA_ID')],
    ['WHATSAPP_APP_ID', plain('WHATSAPP_APP_ID')],
    ['WHATSAPP_APP_SECRET', shape('WHATSAPP_APP_SECRET')],
    ['WHATSAPP_WEBHOOK_VERIFY_TOKEN', shape('WHATSAPP_WEBHOOK_VERIFY_TOKEN')],
    ['RESEND_API_KEY', shape('RESEND_API_KEY')],
    ['RESEND_FROM', plain('RESEND_FROM')],
    ['TWILIO_ACCOUNT_SID', plain('TWILIO_ACCOUNT_SID')],
    ['TWILIO_AUTH_TOKEN', shape('TWILIO_AUTH_TOKEN')],
    ['TWILIO_FROM', plain('TWILIO_FROM')],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) info(`${k.padEnd(width)}  ${v}`);
}

// ---------------------------------------------------------------------------
// 2 — Which adapter actually runs, and why.
//
// This MIRRORS getAdapter() in lib/notifications/adapters.ts. A .mjs script
// cannot import the TypeScript module, so the resolution is restated here — and
// if that function's rules ever change, this must change with it, exactly as
// verify-db restates the SQL it probes. The mirroring is the point: the script
// answers "which adapter will run in THIS environment" without booting Next.
// ---------------------------------------------------------------------------
function resolveAdapter() {
  // RAW truthiness, matching getAdapter() exactly. The script's own get()/isSet()
  // trim first; getAdapter() does not, so a whitespace-only WHATSAPP_TOKEN makes
  // the real code select whatsappAdapter and fail at Meta with an auth error
  // while a trimming mirror would cheerfully report 'stub'. Where the two
  // disagree the mirror must follow the code, or it sends the reader to the
  // wrong half of the system.
  const presentRaw = (name) => Boolean(process.env[name] ?? fileEnv[name]);
  return resolveAdapterFor(get('NOTIFY_PROVIDER') || 'log', presentRaw);
}

/**
 * Did the operator ASK for WhatsApp? This is the intent half of the intent-vs-
 * reality check in the verdict: every "the bill never arrives" report starts
 * with someone believing this environment sends WhatsApp.
 */
const wantsWhatsapp = () => (get('NOTIFY_PROVIDER') || 'log').toLowerCase() === 'whatsapp';

/** Mirrors whatsappBillHealth().configured (lib/notifications/health.ts). */
const billWhatsappMissing = () => BILL_WHATSAPP_VARS.filter((n) => !isSet(n));

function checkOrderStatusChannel() {
  heading('Channel · order status (accepted / ready / rejected / cancelled)', 'lib/notifications/adapters.ts getAdapter()');

  const { adapter, why, missing } = resolveAdapter();
  info(`resolved adapter: ${adapter}`);
  info(`why: ${why}`);

  if (adapter === 'whatsapp' || adapter === 'sms') {
    pass('a real provider is selected', `${adapter} adapter`);
    return;
  }

  const provider = (get('NOTIFY_PROVIDER') || 'log').toLowerCase();
  if (provider === 'log' || !isSet('NOTIFY_PROVIDER')) {
    // Being on the stub deliberately is a valid state — the test suite depends
    // on it and it must not require network. Not a failure, not a pass either.
    skip('a real provider is selected', "NOTIFY_PROVIDER is unset or 'log' — the stub is intended here, so there is nothing to verify");
    return;
  }

  // Asking for a real provider and silently getting the stub is the WA-1 lie,
  // and it is a FAILURE, not a warning.
  //
  // It used to warn, on the grounds that a laptop can look like this too. A
  // laptop cannot: a laptop leaves NOTIFY_PROVIDER unset or 'log' and takes the
  // skip() branch above. Reaching here means someone explicitly asked for a real
  // provider and did not get one — which the script would then describe, in the
  // very next line, as a passing run.
  fail(
    'a real provider is selected',
    `NOTIFY_PROVIDER=${provider} but ${missing.join(', ')} missing → getAdapter() returns the stub, so every ` +
      'notification records `sent` with a stub_ ref and NOTHING reaches a phone.',
  );
}

// ---------------------------------------------------------------------------
// 3 — The bill over WhatsApp: the env half.
// ---------------------------------------------------------------------------
function checkWhatsappBillEnv() {
  heading('Channel · bill over WhatsApp', 'lib/notifications/health.ts whatsappBillHealth()');

  // Mirrors whatsappBillHealth(): the template NAME is required on top of the
  // credentials, because a proactive message without an approved template is
  // rejected by Meta anyway — so order-status messages can be live while the
  // bill is dead on the template variable alone.
  const missing = billWhatsappMissing();
  if (missing.length === 0) {
    pass('bill channel is configured', `template '${get('WHATSAPP_TPL_BILL')}', language '${get('WHATSAPP_TPL_LANG') || 'en'}'`);
  } else if (wantsWhatsapp()) {
    // The reproduction this used to pass on: NOTIFY_PROVIDER=whatsapp with token
    // and phone id set but WHATSAPP_TPL_BILL unset. whatsappBillHealth() reports
    // configured:false, sendBillNotification logs not_configured and never sends
    // a single bill — and the old skip() landed in the PASS branch, under a
    // green tick for the fallback template name 'order_bill_1' that the engine
    // will never reach.
    fail(
      'bill channel is configured',
      `NOTIFY_PROVIDER=whatsapp but ${missing.join(', ')} not set — sendBillNotification skips the WhatsApp channel ` +
        'on EVERY order. No bill can ever be delivered in this environment.',
    );
  } else {
    skip('bill channel is configured', `${missing.join(', ')} not set — WhatsApp bills are dormant, no send is attempted`);
  }

  // {{6}} is an absolute receipt link; without a site URL it renders as a path,
  // and a bill whose "itemised receipt" link is broken is a support call.
  if (!isSet('NEXT_PUBLIC_SITE_URL') && !isSet('VERCEL_PROJECT_PRODUCTION_URL')) {
    warn('receipt link is absolute', 'NEXT_PUBLIC_SITE_URL is unset — {{6}} renders as a relative path the customer cannot open');
  } else {
    pass('receipt link is absolute', get('NEXT_PUBLIC_SITE_URL') || 'from VERCEL_PROJECT_PRODUCTION_URL');
  }
}

// ---------------------------------------------------------------------------
// 4 — The header image, checked the way Meta checks it: from the public
// internet, with no credentials.
//
// Meta's servers fetch this URL at SEND time. A URL that resolves on the
// developer's laptop, or behind Vercel's preview protection, or that 404s
// because the asset never shipped, fails the send with a message about the
// header rather than about the URL — which is why this is worth its own probe.
// ---------------------------------------------------------------------------
async function checkHeaderImage() {
  const url = get('WHATSAPP_TPL_BILL_HEADER_IMAGE');
  if (!url) {
    skip('header image is publicly fetchable', 'WHATSAPP_TPL_BILL_HEADER_IMAGE is unset (only required if the approved template has an IMAGE header — see the template probe below)');
    return;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return fail('header image is publicly fetchable', `WHATSAPP_TPL_BILL_HEADER_IMAGE is not a URL: '${url}'`);
  }
  if (parsed.protocol !== 'https:') {
    return fail('header image is publicly fetchable', `must be https, got '${parsed.protocol}' — Meta refuses plain http`);
  }
  if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|\[?::1)/i.test(parsed.hostname)) {
    return fail('header image is publicly fetchable', `'${parsed.hostname}' is not reachable from the internet — Meta's crawler cannot fetch it`);
  }

  // HEAD first; some static handlers answer 405 to HEAD, so fall back to a
  // 1-byte ranged GET rather than reporting a false failure.
  let res;
  try {
    res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    }
  } catch (err) {
    return fail('header image is publicly fetchable', `request failed: ${String(err?.message || err)}`);
  }

  if (!res.ok && res.status !== 206) {
    return fail('header image is publicly fetchable', `HTTP ${res.status} at ${url} — every bill send will be rejected for the missing header`);
  }
  const type = res.headers.get('content-type') || '';
  const length = Number(res.headers.get('content-length') || 0);
  if (!/^image\//i.test(type)) {
    // A login/consent page answers 200 with text/html — which is exactly what a
    // protected preview deployment does, and it looks fine until Meta tries.
    return fail('header image is publicly fetchable', `content-type is '${type || 'unknown'}', not an image — is the URL behind auth or a redirect to a login page?`);
  }
  if (length > 5 * 1024 * 1024) {
    warn('header image is publicly fetchable', `${(length / 1048576).toFixed(1)} MB exceeds Meta's 5 MB header limit`);
    return;
  }
  pass('header image is publicly fetchable', `HTTP ${res.status}, ${type}${length ? `, ${(length / 1024).toFixed(0)} KB` : ''}`);
}

// ---------------------------------------------------------------------------
// 5 — The bill over email (Resend). Independent of WhatsApp by design: a cafe
// can be live on one and dormant on the other.
// ---------------------------------------------------------------------------
function checkEmailBill() {
  heading('Channel · bill over email', 'lib/notifications/health.ts emailBillHealth()');

  const missing = BILL_EMAIL_VARS.filter((n) => !isSet(n));
  if (missing.length === 0) {
    info('resolved adapter: email (Resend)');
    pass('email bill channel is configured', `from ${get('RESEND_FROM')}`);
  } else {
    info('resolved adapter: none — the engine records a skip, it does not fall back');
    skip('email bill channel is configured', `${missing.join(', ')} not set — email bills are dormant (a deliberate state, not a fault)`);
  }
}

// ---------------------------------------------------------------------------
// 6 — The token: is it real, and does it expire?
//
// This is audit item 1. A token created by clicking around the Meta dashboard
// is a USER token: it expires in 24 hours, or 60 days for the extended kind.
// When it dies, every send fails — and until WA-4's webhook, nothing in the
// product says so. `expires_at: 0` is the signature of the permanent System
// User token, and it is the only acceptable answer in production.
// ---------------------------------------------------------------------------
async function checkToken() {
  heading('Meta · access token', `GET ${GRAPH}/debug_token`);

  if (!isSet('WHATSAPP_TOKEN')) {
    skip('token is valid', 'WHATSAPP_TOKEN is not set — there is nothing to ask Meta with. Expected on a local checkout; run this with the deployed env to audit the live channel');
    skip('token does not expire', 'WHATSAPP_TOKEN is not set');
    return null;
  }

  // A redacted value would be sent to Meta verbatim and come back
  // "Cannot parse access token", which reads as a broken production token. It
  // is not — it is a token this process was never given. Unverifiable, not
  // failed: the difference matters because the two have opposite remedies.
  if (isRedacted('WHATSAPP_TOKEN')) {
    blocked(
      'token is valid',
      'WHATSAPP_TOKEN came back REDACTED from `vercel env pull` (it is marked Sensitive in Vercel), so nothing Meta-side can be checked. ' +
        'Supply the real token for one run: copy it from Meta Business Suite → System Users → Generate token, then ' +
        'WHATSAPP_TOKEN=\'EAAG…\' npm run verify:notifications',
    );
    blocked('token does not expire', 'the token was redacted, not read');
    return null;
  }

  // debug_token wants an APP access token. `APP_ID|APP_SECRET` is the reliable
  // form; inspecting a token with itself works for most System User tokens but
  // not all, so the app pair is preferred when present and the fallback is
  // reported as a skip rather than a failure if Meta refuses the inspector.
  const appId = get('WHATSAPP_APP_ID');
  const appSecret = get('WHATSAPP_APP_SECRET');
  const inspector = appId && appSecret ? `${appId}|${appSecret}` : get('WHATSAPP_TOKEN');
  const usingAppToken = Boolean(appId && appSecret);
  info(`inspecting with ${usingAppToken ? 'the app access token (WHATSAPP_APP_ID|WHATSAPP_APP_SECRET)' : 'the token itself — set WHATSAPP_APP_ID + WHATSAPP_APP_SECRET for a more reliable inspection'}`);

  const res = await graph(
    `/debug_token?input_token=${encodeURIComponent(get('WHATSAPP_TOKEN'))}`,
    { token: inspector },
  );

  if (!res.ok || !res.body?.data) {
    if (isAuthError(res)) {
      // The AC: print Meta's error verbatim and exit non-zero.
      fail('token is valid', `Meta says: ${graphError(res)}`);
      skip('token does not expire', 'the token did not survive inspection');
      return null;
    }
    skip('token is valid', `debug_token could not run (${graphError(res)}) — the phone-number probe below is the fallback proof`);
    skip('token does not expire', 'debug_token could not run');
    return null;
  }

  const d = res.body.data;
  if (d.is_valid === false) {
    fail('token is valid', `Meta reports is_valid=false${d.error?.message ? `: ${d.error.message}` : ''} — every send is failing right now`);
    skip('token does not expire', 'the token is already invalid');
    return d;
  }
  pass('token is valid', `type ${d.type ?? 'unknown'}, app ${d.application ?? d.app_id ?? 'unknown'}`);

  // expires_at === 0 means "never". Anything else is a countdown to an outage
  // whose only symptom is silence.
  const expires = Number(d.expires_at ?? 0);
  if (expires === 0) {
    pass('token does not expire', 'expires_at=0 — a permanent System User token, which is the only supported kind in production');
  } else {
    const when = new Date(expires * 1000);
    const days = Math.round((when.getTime() - Date.now()) / 86_400_000);
    const detail = `expires_at=${expires} (${when.toISOString()}, ${days} day(s) away). This is a DASHBOARD USER TOKEN, not a System User token — when it dies every send fails and nothing in the product says so. See docs/WHATSAPP-BILL-TEMPLATE.md §12.`;
    if (days <= 7) fail('token does not expire', detail);
    else warn('token does not expire', detail);
  }

  const scopes = Array.isArray(d.scopes) ? d.scopes : [];
  if (scopes.length) info(`scopes: ${scopes.join(', ')}`);
  if (!scopes.includes('whatsapp_business_messaging')) {
    warn('token can send WhatsApp messages', "the 'whatsapp_business_messaging' scope is not on this token — sends will be refused");
  }
  return d;
}

/**
 * Audit item 4: does WHATSAPP_PHONE_ID belong to the number the business
 * actually verified? A WABA id or App id pasted here fails with a message about
 * the object, not about the number, which sends people looking in the wrong
 * place. This doubles as an independent token check when debug_token is unusable.
 */
async function checkPhoneNumber() {
  heading('Meta · sending number', `GET ${GRAPH}/{WHATSAPP_PHONE_ID}`);

  if (!isSet('WHATSAPP_TOKEN') || !isSet('WHATSAPP_PHONE_ID')) {
    skip('phone id is a real WhatsApp sender', 'WHATSAPP_TOKEN and/or WHATSAPP_PHONE_ID are not set');
    return;
  }

  const res = await graph(
    `/${encodeURIComponent(get('WHATSAPP_PHONE_ID'))}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`,
  );
  if (!res.ok) {
    if (isAuthError(res)) {
      return fail('phone id is a real WhatsApp sender', `Meta says: ${graphError(res)} — an invalid/expired token or a phone id that is really the WABA/App id`);
    }
    return fail('phone id is a real WhatsApp sender', `Meta says: ${graphError(res)}`);
  }

  const b = res.body ?? {};
  pass('phone id is a real WhatsApp sender', `${b.display_phone_number ?? 'unknown number'} — "${b.verified_name ?? 'unnamed'}"`);
  info('confirm that number is the one the cafe verified; a bill from an unexpected number is a bill customers ignore');

  // Quality is Meta's per-number reputation. RED comes with hard messaging
  // limits, which look exactly like "accepted but never arrives".
  const quality = String(b.quality_rating ?? '').toUpperCase();
  if (quality === 'RED') {
    fail('number quality is healthy', 'quality_rating=RED — Meta is rate-limiting this number; sends are accepted and dropped');
  } else if (quality === 'YELLOW') {
    warn('number quality is healthy', 'quality_rating=YELLOW — one step from messaging limits');
  } else if (quality) {
    pass('number quality is healthy', `quality_rating=${quality}`);
  } else {
    skip('number quality is healthy', 'Meta returned no quality_rating for this number');
  }
}

// ---------------------------------------------------------------------------
// 7 — The template: the headline probe.
//
// status must be APPROVED and category must be UTILITY. The category is the one
// that gets missed, because nothing about it fails loudly: a MARKETING-
// categorised bill is throttled PER RECIPIENT by Meta. The API accepts the
// send, hands back a message id, the row logs `sent` — and the phone never
// rings. That is precisely the reported symptom.
// ---------------------------------------------------------------------------

const resolveWabaId = (debugData) => resolveWabaIdFrom(get('WHATSAPP_WABA_ID'), debugData);

async function fetchTemplates(wabaId) {
  // Listed and matched on EXACT name here rather than filtered server-side: the
  // `name` query filter is not honoured identically across API versions, and one
  // that quietly behaves as a prefix search would report a near-miss name
  // ('order_bill_10') as the template we asked for. Paging is followed by cursor
  // rather than by Meta's `paging.next` URL, which carries the token in a query
  // string we would rather never hold.
  const fields = 'name,language,status,category,components,rejected_reason';
  const list = [];
  let after = '';
  for (let page = 0; page < 5; page++) {
    const cursor = after ? `&after=${encodeURIComponent(after)}` : '';
    const res = await graph(`/${encodeURIComponent(wabaId)}/message_templates?fields=${fields}&limit=100${cursor}`);
    if (!res.ok) return { ok: false, res, list };
    list.push(...(Array.isArray(res.body?.data) ? res.body.data : []));
    after = res.body?.paging?.cursors?.after ?? '';
    if (!after || !res.body?.paging?.next) return { ok: true, res, list };
  }
  return { ok: true, res: null, list };
}

async function checkTemplates(debugData) {
  const tplName = get('WHATSAPP_TPL_BILL') || 'order_bill_1';
  const lang = get('WHATSAPP_TPL_LANG') || 'en';
  heading('Meta · bill template', `GET ${GRAPH}/{WABA_ID}/message_templates — name '${tplName}', language '${lang}'`);

  if (!isSet('WHATSAPP_TOKEN')) {
    skip(`template '${tplName}' is APPROVED`, 'WHATSAPP_TOKEN is not set — the template state lives at Meta and cannot be read without it');
    skip(`template '${tplName}' is categorised UTILITY`, 'WHATSAPP_TOKEN is not set');
    return null;
  }

  const { id: wabaId, from, ambiguous, candidates } = resolveWabaId(debugData);
  if (!wabaId) {
    // BLOCKED, not skipped. This is the probe the whole ticket exists for — is
    // the bill template MARKETING or UTILITY — and it is the DEFAULT state of a
    // production run, because WHATSAPP_WABA_ID is a new variable and the only
    // fallback (debug_token granular_scopes) dies on any debug_token hiccup,
    // which is the expected response when a System User token inspects itself.
    // Reported as a skip it landed in the PASS branch, so one flaky Graph call
    // turned the entire Meta-side audit into a green no-op.
    const why =
      'no WABA id — set WHATSAPP_WABA_ID (WhatsApp Manager → Account tools → the "WhatsApp Business Account ID"). ' +
      'It could not be derived from the token either, which usually means the token lacks whatsapp_business_management. ' +
      'The MARKETING-vs-UTILITY question — the most likely cause of "the bill never arrives" — is UNANSWERED.';
    blocked(`template '${tplName}' is APPROVED`, why);
    blocked(`template '${tplName}' is categorised UTILITY`, why);
    return null;
  }
  info(`WABA ${wabaId} (from ${from})`);
  if (ambiguous) {
    // A System User with two WABAs (a second brand, a test account) gets an
    // arbitrary pick. Saying so matters: "no template by that name on this WABA"
    // for a template that is approved and healthy on the OTHER one manufactures
    // a false panic during exactly the incident this script is run for.
    warn(
      'the WABA was guessed',
      `the token's scopes name ${candidates.length} WhatsApp Business Accounts (${candidates.join(', ')}); ` +
        `this run audited ${wabaId}. Set WHATSAPP_WABA_ID to remove the guess.`,
    );
  }

  const { ok, res, list } = await fetchTemplates(wabaId);
  if (!ok) {
    const detail = `Meta says: ${graphError(res)}`;
    fail(`template '${tplName}' is APPROVED`, detail);
    blocked(`template '${tplName}' is categorised UTILITY`, 'the template list could not be read');
    return null;
  }

  const sameName = list.filter((t) => t.name === tplName);
  const tpl = sameName.find((t) => t.language === lang) ?? sameName[0];

  if (!tpl) {
    const names = [...new Set(list.map((t) => t.name))].sort();
    fail(
      `template '${tplName}' exists`,
      `no template by that name on this WABA. Existing: ${names.length ? names.join(', ') : '(none)'} — ` +
        'a name mismatch fails at Meta on every send, and WHATSAPP_TPL_BILL must match EXACTLY.',
    );
    blocked(`template '${tplName}' is categorised UTILITY`, 'the template does not exist');
    return null;
  }

  // Language: 'en' and 'en_US' are different templates to Meta. Picking
  // "English (US)" in the UI while the env says 'en' fails every send.
  if (tpl.language !== lang) {
    fail(
      'template language matches WHATSAPP_TPL_LANG',
      `approved as '${tpl.language}' but we send '${lang}' — Meta treats them as different templates and rejects every send`,
    );
  } else {
    pass('template language matches WHATSAPP_TPL_LANG', `'${lang}'`);
  }

  // --- status -------------------------------------------------------------
  const status = String(tpl.status ?? '').toUpperCase();
  if (status === 'APPROVED') {
    pass(`template '${tplName}' is APPROVED`, `live status from Meta: ${status}`);
  } else {
    fail(
      `template '${tplName}' is APPROVED`,
      `live status from Meta: ${status || 'unknown'}${tpl.rejected_reason ? ` (${tpl.rejected_reason})` : ''} — ` +
        'PENDING means wait; REJECTED/PAUSED/DISABLED means no bill can be delivered until it is fixed and re-approved.',
    );
  }

  // --- category — the headline -------------------------------------------
  const category = String(tpl.category ?? '').toUpperCase();
  if (category === 'UTILITY') {
    pass(`template '${tplName}' is categorised UTILITY`, 'live category from Meta: UTILITY');
  } else {
    fail(
      `template '${tplName}' is categorised UTILITY`,
      `live category from Meta: ${category || 'unknown'}. A bill categorised ${category || 'anything but UTILITY'} is THROTTLED PER RECIPIENT — ` +
        'Meta accepts the send, returns a message id, our log says `sent`, and the phone never rings. ' +
        'Resubmit as UTILITY today (docs/WHATSAPP-BILL-TEMPLATE.md §13); approval takes minutes to ~24 h and nothing else in the phase waits on it.',
    );
  }

  // --- shape: header, parameters ------------------------------------------
  const components = Array.isArray(tpl.components) ? tpl.components : [];
  const header = components.find((c) => String(c.type).toUpperCase() === 'HEADER');
  const headerFormat = String(header?.format ?? '').toUpperCase();
  const headerImageSet = isSet('WHATSAPP_TPL_BILL_HEADER_IMAGE');

  if (headerFormat === 'IMAGE' && !headerImageSet) {
    fail(
      'header parameter matches the approved template',
      'the approved template declares an IMAGE header, so WHATSAPP_TPL_BILL_HEADER_IMAGE is MANDATORY — without it Meta rejects every send (docs/WHATSAPP-BILL-TEMPLATE.md §14)',
    );
  } else if (headerFormat !== 'IMAGE' && headerImageSet) {
    fail(
      'header parameter matches the approved template',
      `the approved template's header is ${headerFormat || 'absent'}, but WHATSAPP_TPL_BILL_HEADER_IMAGE is set — ` +
        'the adapter will attach an image header the template does not declare, and Meta rejects that too. Unset the variable.',
    );
  } else {
    pass('header parameter matches the approved template', headerFormat === 'IMAGE' ? 'IMAGE header declared and the URL is configured' : `header is ${headerFormat || 'absent'} and no image is configured`);
  }

  // The engine sends exactly 6 positional body params for 'bill'
  // (templateVarsFor in lib/notifications/templates.ts, pinned by
  // tests/billTemplate.test.ts). A template that expects a different number — or
  // NAMED parameters, which is the default for newly created templates — fails
  // every send with a parameter-mismatch error.
  const EXPECTED_BILL_VARS = 6;
  const body = components.find((c) => String(c.type).toUpperCase() === 'BODY');
  // DISTINCT placeholders: a body that repeats {{1}} still takes one parameter
  // for it, so counting occurrences would invent a mismatch that isn't there.
  const vars = [...new Set(placeholdersIn(body?.text))];
  const named = vars.filter((v) => !/^\d+$/.test(v));

  if (named.length > 0) {
    fail(
      'template takes 6 positional parameters',
      `the body uses NAMED parameters (${named.join(', ')}) — the adapter sends positional {type:'text'} params, which Meta refuses. ` +
        'Recreate the template with positional {{1}}…{{6}} parameters.',
    );
  } else if (vars.length !== EXPECTED_BILL_VARS) {
    fail(
      'template takes 6 positional parameters',
      `the approved body has ${vars.length} placeholder(s); templateVarsFor(order, 'bill') always sends ${EXPECTED_BILL_VARS}. ` +
        'A count mismatch fails every send at Meta.',
    );
  } else {
    pass('template takes 6 positional parameters', '{{1}}…{{6}}, matching templateVarsFor(order, \'bill\')');
  }

  // Buttons: the adapter sends header+body only. A dynamic URL button needs a
  // parameter on every send, so its presence breaks the channel outright.
  const buttons = components.find((c) => String(c.type).toUpperCase() === 'BUTTONS');
  const dynamicButton = (buttons?.buttons ?? []).some((b) => String(b.type).toUpperCase() === 'URL' && /\{\{\d+\}\}/.test(String(b.url ?? '')));
  if (dynamicButton) {
    fail('template has no dynamic button', 'a URL button with a variable requires a button parameter on every send, which the adapter does not send — every bill fails');
  }

  // --- the status templates ------------------------------------------------
  // Spec WA-2 item 2: "confirm order_bill_1 (AND THE STATUS TEMPLATES) are
  // APPROVED and categorised UTILITY". A missing or MARKETING 'order_ready_1'
  // means "your order is ready" silently never arrives — a customer-facing
  // failure of exactly the same shape as the bill, and one the default audit
  // used to pass straight over because these only warned.
  //
  // They fail only when the order-status channel is actually live: on a
  // bill-only deployment (NOTIFY_PROVIDER unset) they are genuinely not in use,
  // and failing there would be crying wolf.
  const statusTemplates = [
    ['accepted', get('WHATSAPP_TPL_ACCEPTED') || 'order_accepted'],
    ['ready', get('WHATSAPP_TPL_READY') || 'order_ready_1'],
    ['rejected', get('WHATSAPP_TPL_REJECTED') || 'order_rejected'],
    ['cancelled', get('WHATSAPP_TPL_CANCELLED') || 'order_cancelled'],
  ];
  const statusChannelLive = resolveAdapter().adapter === 'whatsapp';
  const reportStatusTemplate = statusChannelLive ? fail : warn;
  for (const [event, name] of statusTemplates) {
    const t = list.find((x) => x.name === name && x.language === lang) ?? list.find((x) => x.name === name);
    if (!t) {
      reportStatusTemplate(
        `status template '${name}' (${event})`,
        'not found on this WABA — order-status messages for this event fail at Meta',
      );
      continue;
    }
    const st = String(t.status ?? '').toUpperCase();
    const cat = String(t.category ?? '').toUpperCase();
    if (st === 'APPROVED' && cat === 'UTILITY') pass(`status template '${name}' (${event})`, `${st} · ${cat}`);
    else
      reportStatusTemplate(
        `status template '${name}' (${event})`,
        `${st || 'unknown'} · ${cat || 'unknown'} — "${event}" messages are throttled or refused by Meta`,
      );
  }

  return { tpl, headerFormat, varCount: vars.length };
}

// ---------------------------------------------------------------------------
// 8 — The real send.
//
// Everything above is introspection; this is the only probe that proves the
// whole chain end to end, and it costs a real conversation, so it happens only
// when explicitly asked for.
//
// IT MIRRORS whatsappAdapter.send() EXACTLY — same endpoint, same fixed SIX
// positional parameters, and the header attached on the adapter's own rule
// (`if (headerImageUrl)`), never on what the live template happens to declare.
//
// It used to reshape itself to fit the template: sizing the parameter list from
// introspection.varCount and taking the header from introspection.headerFormat.
// That inverts the entire purpose. Against a template declaring only {{1}}..{{4}}
// it sent four parameters, Meta accepted them, a message physically landed on
// the owner's handset — and every real bill, which always sends six, was being
// refused. "The test message arrived" was compatible with 100% of production
// bills failing, and the handset is the evidence a human trusts most.
//
// So the send is deliberately rigid. If it fails because the template expects a
// different shape, that IS the finding.
// ---------------------------------------------------------------------------
async function sendTest(to) {
  heading('Meta · test send', `POST ${GRAPH}/{WHATSAPP_PHONE_ID}/messages — ONE real message`);

  if (!isE164(to)) {
    return fail('test send', `'${to}' is not E.164 — it must start with '+' and the country code, e.g. +919876543210 for an Indian mobile`);
  }
  // FAIL, not skip. An explicitly requested action that provably cannot happen
  // must fail closed: a skip exits 0, and anything scripting this — a deploy
  // gate, a runbook step, CI — reads exit 0 as "the send worked". No message
  // arrived and no message id was printed, so this is not a clean run.
  const missing = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'].filter((n) => !isSet(n));
  if (missing.length > 0) {
    return fail('test send', `${missing.join(', ')} not set — a real send was asked for and cannot be performed`);
  }

  const tplName = get('WHATSAPP_TPL_BILL') || 'order_bill_1';
  const lang = get('WHATSAPP_TPL_LANG') || 'en';
  const headerUrl = get('WHATSAPP_TPL_BILL_HEADER_IMAGE');
  const site = get('NEXT_PUBLIC_SITE_URL') || 'https://hioc.in';

  // The same six facts templateVarsFor(order, 'bill') sends, marked TEST in the
  // text so a real customer who somehow receives one is not misled. Fixed at
  // six: EXPECTED_BILL_VARS is bound to templateVarsFor by
  // tests/verifyNotifications.test.ts.
  const templateVars = [
    'TEST',
    'HIOC-TEST01',
    '1',
    '1',
    'TEST',
    `${site.replace(/\/+$/, '')}/order/verify-notifications-test/receipt`,
  ];
  if (templateVars.length !== EXPECTED_BILL_VARS) {
    return fail('test send', `internal: built ${templateVars.length} parameters, expected ${EXPECTED_BILL_VARS}`);
  }

  const components = [];
  // The adapter's rule verbatim (adapters.ts:121): attach the header if and only
  // if a URL is configured. Not "if the template declares one" — that is what
  // made the probe lie.
  if (headerUrl) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerUrl } }] });
  }
  components.push({ type: 'body', parameters: templateVars.map((t) => ({ type: 'text', text: t })) });

  const payload = {
    messaging_product: 'whatsapp',
    to: to.replace(/^\+/, ''), // the Cloud API wants digits without '+'
    type: 'template',
    template: { name: tplName, language: { code: lang }, components },
  };

  info(`sending template '${tplName}' (${lang}) to ${to} — this is a real, billable message`);
  const res = await graph(`/${encodeURIComponent(get('WHATSAPP_PHONE_ID'))}/messages`, { method: 'POST', body: payload });

  out(`\n  Meta's raw response (HTTP ${res.status}):\n`);
  out(`${JSON.stringify(res.body, null, 2).split('\n').map((l) => `    ${l}`).join('\n')}\n\n`);

  if (!res.ok) {
    return fail('test send', `Meta refused it: ${graphError(res)}`);
  }
  const id = res.body?.messages?.[0]?.id ?? '';
  if (!id) {
    return fail('test send', 'Meta answered 200 with no message id — nothing to correlate a delivery receipt against');
  }
  pass('test send', `message id ${id}`);
  info('accepted ≠ delivered. Watch /owner/notifications (or the notifications row for this ref) for the webhook status,');
  info('and check the handset — an accepted-but-never-delivered message is the exact signature of the category problem above.');
}

// ---------------------------------------------------------------------------
async function main() {
  out(`verify-notifications — auditing the bill channel (Graph ${API_VERSION})\n`);
  if (STRICT) out('mode: --strict (SKIPPED and WARN also fail the run)\n');

  reportEnvironment();
  checkOrderStatusChannel();
  checkWhatsappBillEnv();
  await checkHeaderImage();
  checkEmailBill();

  const debugData = await checkToken();
  await checkPhoneNumber();
  await checkTemplates(debugData);

  if (SEND_TEST) await sendTest(SEND_TEST);

  out(`\n${'-'.repeat(64)}\n`);
  out(
    `Summary: ${tally.pass} passed · ${tally.fail} failed · ${tally.warn} warned · ` +
      `${tally.skip} skipped · ${tally.blocked} unverifiable\n`,
  );
  if (failures.length) out(`Failed: ${failures.join('; ')}\n`);
  if (warnings.length) out(`Warned (works now, will break later): ${warnings.join('; ')}\n`);
  if (skips.length) out(`Skipped (nothing to check here): ${skips.join('; ')}\n`);
  if (blockers.length) out(`COULD NOT VERIFY (unproven — do NOT read as passes): ${blockers.join('; ')}\n`);

  // The verdict is computed in scripts/lib/notifyVerify.mjs, where it is
  // unit-tested. It is the only line anyone acts on, so it correlates INTENT
  // ("this environment asked for WhatsApp") against REALITY ("a bill can
  // actually be delivered") rather than just counting ✗ marks.
  const { adapter } = resolveAdapter();
  const { result, exit, reason } = verdictFor({
    ...tally,
    strict: STRICT,
    intent: {
      wantsWhatsapp: wantsWhatsapp(),
      adapter,
      billConfigured: billWhatsappMissing().length === 0,
    },
  });

  if (result === 'FAIL') {
    if (reason) out(`\n  ✗ ${reason}\n`);
    out('RESULT: FAIL — the channel is misconfigured; fix the ✗ lines before trusting any `sent` row.\n');
  } else if (result === 'INCOMPLETE') {
    out('RESULT: INCOMPLETE — nothing that RAN failed, but the Meta-side checks could not run.\n');
    out('        The template category (UTILITY vs MARKETING) is the most likely cause of "the bill\n');
    out('        never arrives", and this run did not establish it. Set WHATSAPP_WABA_ID and re-run.\n');
  } else if (!isSet('WHATSAPP_TOKEN')) {
    // Nothing was asked of Meta, so the Meta-side causes — the likely ones —
    // remain entirely unexamined. Saying PASS here would be the same lie the
    // stub tells.
    out('RESULT: NOT CONFIGURED — nothing here is broken, but nothing Meta-side was proven either.\n');
    out('        Re-run with the deployed credentials (`vercel env pull`, or export WHATSAPP_TOKEN/WHATSAPP_PHONE_ID) to audit the live channel.\n');
  } else {
    out(`RESULT: PASS — every probe that ran, passed.${tally.skip ? ' Note the skipped probes above.' : ''}\n`);
  }
  process.exit(exit);
}

// die() writes through out() so the redaction guarantee has no hole in it: the
// crash path is where an unexpected string carrying raw internal state is most
// likely to appear.
main().catch((err) => die(`crashed: ${err?.stack || err}`));
