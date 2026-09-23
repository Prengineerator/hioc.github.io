// The pure, testable half of scripts/verify-notifications.mjs.
//
// WHY THIS FILE EXISTS: the audit script mirrors invariants that other modules
// own — how many parameters the bill template takes, which variables each
// channel needs, how getAdapter() picks an adapter. A mirror with nothing
// binding it to its source silently becomes a liar, which is precisely the
// failure mode (a surface confidently reporting something untrue) that the whole
// WA epic exists to remove. A 900-line diagnostic asserting `6` from memory
// would, the day the template gains a 7th variable, start FAILING a correct
// template — or, worse, passing a wrong one.
//
// So everything with a decision in it lives here, with no I/O and no process
// state, and tests/verifyNotifications.test.ts asserts it against the TypeScript
// modules it mirrors. The script keeps the parts that genuinely cannot be
// unit-tested: fetch, stdout, process.exit.

/**
 * Number of positional body parameters the engine sends for a bill.
 *
 * Bound to templateVarsFor(order, 'bill') in lib/notifications/templates.ts by
 * tests/verifyNotifications.test.ts — if that function's output length changes,
 * that test fails and this constant has to move with it.
 */
export const EXPECTED_BILL_VARS = 6;

/** Variables lib/notifications/health.ts requires for the WhatsApp bill channel. */
export const BILL_WHATSAPP_VARS = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TPL_BILL'];

/** Variables lib/notifications/health.ts requires for the email bill channel. */
export const BILL_EMAIL_VARS = ['RESEND_API_KEY', 'RESEND_FROM'];

/** Variables getAdapter() tests before selecting each real provider. */
export const PROVIDER_VARS = {
  whatsapp: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'],
  sms: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'],
};

/**
 * Parses a .env-style file body. Values in this repo are written double-quoted;
 * left in, the quotes end up inside the URL/token and every request fails
 * against a value containing a literal '"'. Strips a MATCHED pair only.
 */
export function parseEnvBody(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Which adapter getAdapter() (lib/notifications/adapters.ts) will return.
 *
 * `present` is a predicate rather than an env read so the caller decides the
 * source. NOTE the deliberate asymmetry with the script's own `get()`: the real
 * getAdapter() tests RAW truthiness of process.env, so a whitespace-only
 * WHATSAPP_TOKEN selects the live adapter and then fails at Meta with an auth
 * error. Callers pass a raw-truthiness predicate here so the mirror agrees with
 * the code rather than with the tidier thing the code could have done.
 */
export function resolveAdapter(provider, present) {
  const name = String(provider ?? 'log').toLowerCase();
  if (name === 'whatsapp' || name === 'sms') {
    const missing = PROVIDER_VARS[name].filter((v) => !present(v));
    if (missing.length === 0) {
      return {
        adapter: name,
        missing,
        why: `NOTIFY_PROVIDER=${name} and ${
          name === 'whatsapp' ? 'both WHATSAPP_TOKEN and WHATSAPP_PHONE_ID are' : 'all three Twilio variables are'
        } set.`,
      };
    }
    return {
      adapter: 'stub',
      missing,
      why:
        `NOTIFY_PROVIDER=${name} but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing, ` +
        'so getAdapter() falls back to the log stub — which reports SUCCESS.',
    };
  }
  return {
    adapter: 'stub',
    missing: [],
    why: `NOTIFY_PROVIDER is '${name}' — the log stub is the deliberate default; nothing is sent anywhere.`,
  };
}

/** Every {{…}} in a template body, in order of first appearance. */
export function placeholdersIn(text) {
  return [...String(text ?? '').matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1]);
}

/**
 * The WABA id owning the templates: the explicit env value first, else whatever
 * the token's own granular scopes reveal.
 *
 * `ambiguous` is set when the token's scopes name MORE than one WhatsApp
 * Business Account — common once a second brand or a test WABA exists. The
 * first one is still returned (it is the only guess available), but the caller
 * must say it guessed: reporting "no template by that name on this WABA" for a
 * template that is approved and healthy on the OTHER one manufactures a false
 * panic during exactly the incident this script gets run for.
 */
export function resolveWabaId(explicit, debugData) {
  if (explicit) return { id: explicit, from: 'WHATSAPP_WABA_ID', ambiguous: false, candidates: [explicit] };
  const granular = Array.isArray(debugData?.granular_scopes) ? debugData.granular_scopes : [];
  for (const scope of ['whatsapp_business_management', 'whatsapp_business_messaging']) {
    const entry = granular.find((g) => g.scope === scope && Array.isArray(g.target_ids) && g.target_ids.length > 0);
    if (entry) {
      return {
        id: entry.target_ids[0],
        from: `debug_token granular_scopes.${scope}`,
        ambiguous: entry.target_ids.length > 1,
        candidates: [...entry.target_ids],
      };
    }
  }
  return { id: '', from: '', ambiguous: false, candidates: [] };
}

/** Full E.164: '+', a non-zero country digit, 8–15 digits total. */
export function isE164(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(value ?? ''));
}

/**
 * The verdict.
 *
 * Split out from the reporting because it is the ONLY level anyone acts on: a
 * run whose every line is honest but whose last line says PASS has told the
 * owner the channel is proven. Three rules, in order:
 *
 *  1. Any ✗ is a FAIL.
 *  2. INTENT VS REALITY. An environment that ASKED for WhatsApp
 *     (NOTIFY_PROVIDER=whatsapp) and cannot deliver a bill is broken, however
 *     that came out at the line level. It previously did not fail: a missing
 *     WHATSAPP_TPL_BILL made the bill probe SKIP, a missing WHATSAPP_PHONE_ID
 *     made the adapter probe WARN, and both landed in the PASS branch — the
 *     script diagnosed the bug in one line and rated the run green in the next.
 *  3. UNPROVEN ≠ PROVEN. If the Meta-side probes — the whole reason this script
 *     exists — could not run, the answer is INCOMPLETE, not PASS. Folding that
 *     into PASS meant one flaky debug_token response could turn the entire
 *     MARKETING-vs-UTILITY audit into a green no-op.
 */
export function verdictFor({ fail = 0, warn = 0, skip = 0, blocked = 0, strict = false, intent = {} }) {
  const { wantsWhatsapp = false, adapter = 'stub', billConfigured = false } = intent;

  if (fail > 0) return { result: 'FAIL', exit: 1 };

  if (wantsWhatsapp && adapter !== 'whatsapp') {
    return {
      result: 'FAIL',
      exit: 1,
      reason:
        'NOTIFY_PROVIDER=whatsapp but getAdapter() resolves to the stub — every notification will record `sent` while nothing reaches a phone.',
    };
  }
  if (wantsWhatsapp && !billConfigured) {
    return {
      result: 'FAIL',
      exit: 1,
      reason:
        'NOTIFY_PROVIDER=whatsapp but the bill channel is not configured — sendBillNotification will never attempt a single bill.',
    };
  }

  if (strict && (warn > 0 || skip > 0 || blocked > 0)) return { result: 'FAIL', exit: 1 };
  if (blocked > 0) return { result: 'INCOMPLETE', exit: 3 };
  return { result: 'PASS', exit: 0 };
}
