import { describe, expect, it } from 'vitest';
import {
  BILL_EMAIL_VARS,
  BILL_WHATSAPP_VARS,
  EXPECTED_BILL_VARS,
  isE164,
  parseEnvBody,
  placeholdersIn,
  resolveAdapter,
  resolveWabaId,
  verdictFor,
  // A plain ESM helper, shared verbatim with scripts/verify-notifications.mjs —
  // importing the same file the script runs is the entire point, since a
  // re-implementation here would test a copy rather than the mirror.
} from '../scripts/lib/notifyVerify.mjs';
import { templateVarsFor } from '@/lib/notifications/templates';
import { blockedProviderVars, whatsappBillHealth, emailBillHealth } from '@/lib/notifications/health';
import type { Order } from '@/lib/types';

// WA-2 — the audit script's mirrors, bound to the modules they mirror.
//
// scripts/verify-notifications.mjs restates invariants that live in TypeScript:
// how many parameters a bill template takes, which env vars each channel needs,
// how getAdapter() chooses. It has to — a .mjs cannot import a .ts module — but
// a mirror with nothing holding it against its source silently becomes a liar,
// which is the same failure mode as the stub adapter the whole epic exists to
// expose. When the bill template gains a 7th variable, templateVarsFor and its
// own test move together and the script would keep asserting 6, then FAIL a
// correct template during an incident.
//
// These tests are that binding. They fail when the mirror drifts.

const order = {
  id: 'order-1',
  order_number: 1042,
  customer_name: 'Ayush Garg',
  customer_phone: '+919876543210',
  customer_email: null,
  total_inr: 480,
  subtotal_inr: 450,
  payment_method: 'cash',
  promised_ready_at: null,
  reject_reason: '',
  items: [{ id: 'i1' }, { id: 'i2' }],
} as unknown as Order;

describe('the script mirrors lib/notifications faithfully', () => {
  it('EXPECTED_BILL_VARS equals what templateVarsFor actually sends', () => {
    // The load-bearing one. If this fails, scripts/verify-notifications.mjs is
    // about to fail a correct template — or pass a wrong one.
    expect(EXPECTED_BILL_VARS).toBe(templateVarsFor(order, 'bill').length);
  });

  it('mirrors the WhatsApp bill channel’s required variables', () => {
    const saved = { ...process.env };
    for (const v of BILL_WHATSAPP_VARS) delete process.env[v];
    try {
      expect(whatsappBillHealth().missing.sort()).toEqual([...BILL_WHATSAPP_VARS].sort());
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it('mirrors the email bill channel’s required variables', () => {
    const saved = { ...process.env };
    for (const v of BILL_EMAIL_VARS) delete process.env[v];
    try {
      expect(emailBillHealth().missing.sort()).toEqual([...BILL_EMAIL_VARS].sort());
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it('mirrors the variables a blocked whatsapp provider reports', () => {
    const saved = { ...process.env };
    process.env.NOTIFY_PROVIDER = 'whatsapp';
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_ID;
    try {
      // resolveAdapter must name the same variables the engine's own guard does.
      const { missing } = resolveAdapter('whatsapp', (n: string) => Boolean(process.env[n]));
      expect([...missing].sort()).toEqual([...blockedProviderVars()].sort());
    } finally {
      Object.assign(process.env, saved);
    }
  });
});

describe('resolveAdapter', () => {
  const present = (set: string[]) => (name: string) => set.includes(name);

  it('picks the stub whenever NOTIFY_PROVIDER is unset or log', () => {
    expect(resolveAdapter(undefined, present([])).adapter).toBe('stub');
    expect(resolveAdapter('log', present([])).adapter).toBe('stub');
    expect(resolveAdapter('LOG', present([])).adapter).toBe('stub');
  });

  it('picks whatsapp only when BOTH credentials are present', () => {
    expect(resolveAdapter('whatsapp', present(['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'])).adapter).toBe('whatsapp');
    expect(resolveAdapter('whatsapp', present(['WHATSAPP_TOKEN'])).adapter).toBe('stub');
    expect(resolveAdapter('whatsapp', present(['WHATSAPP_TOKEN'])).missing).toEqual(['WHATSAPP_PHONE_ID']);
  });

  it('needs all three Twilio variables for sms', () => {
    expect(resolveAdapter('sms', present(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'])).adapter).toBe('sms');
    expect(resolveAdapter('sms', present(['TWILIO_ACCOUNT_SID'])).adapter).toBe('stub');
  });
});

describe('placeholdersIn', () => {
  it('reads positional parameters in order', () => {
    expect(placeholdersIn('Hi {{1}}, order {{2}} is ₹{{3}}')).toEqual(['1', '2', '3']);
  });

  it('reports named parameters, which Meta refuses for a positional send', () => {
    expect(placeholdersIn('Hi {{name}}, order {{order_id}}')).toEqual(['name', 'order_id']);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(placeholdersIn('{{ 1 }} and {{2}}')).toEqual(['1', '2']);
  });

  it('counts a repeated placeholder once when de-duplicated by the caller', () => {
    // A body that repeats {{1}} still takes one parameter for it, so the script
    // de-dupes before comparing against EXPECTED_BILL_VARS.
    expect([...new Set(placeholdersIn('{{1}} x {{1}} y {{2}}'))]).toEqual(['1', '2']);
  });

  it('returns nothing for a body with no parameters at all', () => {
    expect(placeholdersIn('Your bill is ready.')).toEqual([]);
    expect(placeholdersIn(null)).toEqual([]);
  });
});

describe('resolveWabaId', () => {
  const scopes = (targets: string[]) => ({
    granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: targets }],
  });

  it('prefers the explicit variable and never guesses', () => {
    const r = resolveWabaId('123456', scopes(['999', '888']));
    expect(r.id).toBe('123456');
    expect(r.ambiguous).toBe(false);
  });

  it('falls back to the token’s own scopes', () => {
    const r = resolveWabaId('', scopes(['999']));
    expect(r.id).toBe('999');
    expect(r.ambiguous).toBe(false);
  });

  // A System User with a second brand or a test WABA gets an arbitrary pick, and
  // the script would then report "no template by that name on this WABA" for a
  // template that is approved and healthy on the other one — a false panic
  // during exactly the incident this script gets run for.
  it('admits when it guessed between several WABAs', () => {
    const r = resolveWabaId('', scopes(['999', '888']));
    expect(r.id).toBe('999');
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toEqual(['999', '888']);
  });

  it('returns nothing rather than a wrong id when the token reveals none', () => {
    expect(resolveWabaId('', {}).id).toBe('');
    expect(resolveWabaId('', undefined).id).toBe('');
    expect(resolveWabaId('', { granular_scopes: 'nonsense' }).id).toBe('');
  });
});

describe('parseEnvBody', () => {
  it('strips a matched quote pair but not stray quotes', () => {
    const env = parseEnvBody('A="quoted"\nB=\'single\'\nC=bare\nD="unbalanced');
    expect(env.A).toBe('quoted');
    expect(env.B).toBe('single');
    expect(env.C).toBe('bare');
    expect(env.D).toBe('"unbalanced');
  });

  it('ignores comments and blank lines', () => {
    const env = parseEnvBody('# WHATSAPP_TOKEN=commented\n\nWHATSAPP_TOKEN=real\n');
    expect(env.WHATSAPP_TOKEN).toBe('real');
  });

  it('keeps an = inside a value', () => {
    expect(parseEnvBody('K=a=b=c').K).toBe('a=b=c');
  });
});

describe('isE164', () => {
  it('accepts a full international number', () => {
    expect(isE164('+919876543210')).toBe(true);
  });

  it('rejects anything the Cloud API would not route', () => {
    for (const bad of ['9876543210', '+0119876543210', '+91 98765 43210', '', '+91', null]) {
      expect(isE164(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The verdict. This is the only level anyone acts on.
// ---------------------------------------------------------------------------
describe('verdictFor', () => {
  const clean = { fail: 0, warn: 0, skip: 0, blocked: 0 };
  const live = { wantsWhatsapp: true, adapter: 'whatsapp', billConfigured: true };

  it('passes a clean, coherent run', () => {
    expect(verdictFor({ ...clean, intent: live })).toMatchObject({ result: 'PASS', exit: 0 });
  });

  it('fails on any ✗', () => {
    expect(verdictFor({ ...clean, fail: 1, intent: live })).toMatchObject({ result: 'FAIL', exit: 1 });
  });

  // Reproduction (E): NOTIFY_PROVIDER=whatsapp with WHATSAPP_PHONE_ID missing.
  // getAdapter() returns the stub and every notification records `sent` with
  // nothing delivered. The script printed that diagnosis as a WARN and then
  // rated the run PASS on the next line.
  it('fails when WhatsApp was asked for and the stub answered', () => {
    const v = verdictFor({ ...clean, warn: 1, intent: { ...live, adapter: 'stub' } });
    expect(v).toMatchObject({ result: 'FAIL', exit: 1 });
    expect(v.reason).toMatch(/stub/);
  });

  // Reproduction (A): NOTIFY_PROVIDER=whatsapp, token and phone id set,
  // WHATSAPP_TPL_BILL unset. sendBillNotification never sends a single bill,
  // and the run exited 0 with RESULT: PASS.
  it('fails when WhatsApp was asked for and no bill can ever be sent', () => {
    const v = verdictFor({ ...clean, skip: 1, intent: { ...live, billConfigured: false } });
    expect(v).toMatchObject({ result: 'FAIL', exit: 1 });
    expect(v.reason).toMatch(/bill channel/);
  });

  it('leaves a laptop alone — an unconfigured checkout is not a broken one', () => {
    const v = verdictFor({
      ...clean,
      skip: 4,
      intent: { wantsWhatsapp: false, adapter: 'stub', billConfigured: false },
    });
    expect(v).toMatchObject({ result: 'PASS', exit: 0 });
  });

  // Reproduction (B): WHATSAPP_WABA_ID unresolvable, so the MARKETING-vs-UTILITY
  // probe — this ticket's entire reason for existing — never ran, and the script
  // said "6 passed · 0 failed / RESULT: PASS", exit 0.
  it('reports INCOMPLETE, not PASS, when the Meta-side probes could not run', () => {
    const v = verdictFor({ ...clean, blocked: 2, intent: live });
    expect(v).toMatchObject({ result: 'INCOMPLETE' });
    // Non-zero: a deploy gate reading exit 0 as "proven" must not be given one.
    expect(v.exit).not.toBe(0);
  });

  it('ranks a real failure above an unverifiable probe', () => {
    expect(verdictFor({ ...clean, fail: 1, blocked: 2, intent: live })).toMatchObject({ result: 'FAIL', exit: 1 });
  });

  it('--strict also fails on warnings, skips and blocks', () => {
    expect(verdictFor({ ...clean, warn: 1, strict: true, intent: live })).toMatchObject({ result: 'FAIL' });
    expect(verdictFor({ ...clean, skip: 1, strict: true, intent: live })).toMatchObject({ result: 'FAIL' });
    expect(verdictFor({ ...clean, blocked: 1, strict: true, intent: live })).toMatchObject({ result: 'FAIL' });
  });
});
