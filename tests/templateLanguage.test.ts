import { afterEach, describe, expect, it, vi } from 'vitest';

// Meta identifies a template by NAME + LANGUAGE. A mismatch returns
// `(#132001) Template name does not exist in the translation`, which reads like
// a wrong name when the name is correct — production hit exactly that: every
// bill rejected while every status message sent, because the two templates were
// created with different language codes and the code had ONE global for both.

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

/** The language code the adapter puts on the wire for one event. */
async function langFor(event: string): Promise<string> {
  let captured = '';
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body).template.language.code;
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) };
  });
  const { whatsappAdapter } = await import('@/lib/notifications/adapters');
  await whatsappAdapter.send({
    to: '+919876543210',
    channel: 'whatsapp',
    body: 'x',
    event: event as never,
    templateVars: ['a'],
  });
  return captured;
}

describe('per-template language codes', () => {
  it('defaults to en when nothing is configured', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    expect(await langFor('bill')).toBe('en');
  });

  it('honours the global override', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    process.env.WHATSAPP_TPL_LANG = 'en_GB';
    expect(await langFor('bill')).toBe('en_GB');
  });

  it('lets the bill use a different language WITHOUT moving the status templates', async () => {
    // The production case: order_bill_1 is en_US, order_ready_1 is en. No single
    // global can satisfy both — fixing one would have broken the other.
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    process.env.WHATSAPP_TPL_BILL_LANG = 'en_US';
    expect(await langFor('bill')).toBe('en_US');
    expect(await langFor('ready')).toBe('en');
  });

  it('per-event beats the global', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    process.env.WHATSAPP_TPL_LANG = 'en';
    process.env.WHATSAPP_TPL_BILL_LANG = 'en_US';
    expect(await langFor('bill')).toBe('en_US');
  });

  it('ignores an empty per-event value rather than sending a blank language', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    process.env.WHATSAPP_TPL_BILL_LANG = '';
    expect(await langFor('bill')).toBe('en');
  });
});

describe('#132001 language discovery', () => {
  /** Returns [languages tried in order, final result]. */
  async function sendAgainst(approvedLang: string | null) {
    const tried: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      const lang = JSON.parse(init.body).template.language.code;
      tried.push(lang);
      if (approvedLang && lang === approvedLang) {
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OK' }] }) };
      }
      return {
        ok: false,
        json: async () => ({
          error: { message: '(#132001) Template name does not exist in the translation', code: 132001 },
        }),
      };
    });
    const { whatsappAdapter } = await import('@/lib/notifications/adapters');
    const result = await whatsappAdapter.send({
      to: '+919876543210',
      channel: 'whatsapp',
      body: 'x',
      event: 'bill' as never,
      templateVars: ['a'],
    });
    return { tried, result };
  }

  it('finds the approved language and reports success', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    process.env.WHATSAPP_TPL_BILL_LANG = 'en_US';
    const { tried, result } = await sendAgainst('en_GB');
    expect(result.ok).toBe(true);
    expect(tried[0]).toBe('en_US'); // configured value first
    expect(tried).toContain('en_GB');
  });

  it('does not retry a language it already tried', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    process.env.WHATSAPP_TPL_BILL_LANG = 'en';
    const { tried } = await sendAgainst('en_GB');
    expect(tried.filter((l) => l === 'en')).toHaveLength(1);
  });

  it('when every language fails, names the languages tried and still returns a usable error', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    const { result } = await sendAgainst(null);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tried languages/);
    // The inventory lookup runs against this test's minimal stub and cannot
    // succeed — what matters is that a failing DIAGNOSTIC never swallows or
    // replaces the real error, and never throws out of the adapter.
    expect(result.error).toMatch(/#132001/);
  });

  it('does not language-hunt on unrelated errors', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    const tried: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      tried.push(JSON.parse(init.body).template.language.code);
      return { ok: false, json: async () => ({ error: { message: 'Invalid OAuth token', code: 190 } }) };
    });
    const { whatsappAdapter } = await import('@/lib/notifications/adapters');
    const r = await whatsappAdapter.send({
      to: '+919876543210', channel: 'whatsapp', body: 'x',
      event: 'bill' as never, templateVars: ['a'],
    });
    expect(r.ok).toBe(false);
    expect(tried).toHaveLength(1); // one attempt only — an auth error is not a language problem
  });
});

describe('template inventory on total failure', () => {
  it('reports what the account actually has when every language fails', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    delete process.env.WHATSAPP_TPL_BILL_LANG;

    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('whatsapp_business_account')) {
        return { ok: true, json: async () => ({ whatsapp_business_account: { id: '999', name: 'HIOC' } }) };
      }
      if (String(url).includes('message_templates')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { name: 'order_ready_1', language: 'en', status: 'APPROVED' },
              { name: 'order_accepted', language: 'en', status: 'APPROVED' },
              { name: 'order_bill', language: 'en', status: 'PENDING' },
            ],
          }),
        };
      }
      return {
        ok: false,
        json: async () => ({ error: { message: '(#132001) Template name does not exist', code: 132001 } }),
      };
    });

    const { whatsappAdapter } = await import('@/lib/notifications/adapters');
    const r = await whatsappAdapter.send({
      to: '+919876543210', channel: 'whatsapp', body: 'x',
      event: 'bill' as never, templateVars: ['a'],
    });

    expect(r.ok).toBe(false);
    // The whole point: name what IS there, so "not found" becomes actionable.
    expect(r.error).toContain('order_ready_1/en');
    expect(r.error).toContain('999');
    // Only APPROVED templates are listed — a PENDING one cannot be sent.
    expect(r.error).not.toContain('order_bill/en');
  });

  it('says so plainly when the token cannot read the account', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('whatsapp_business_account')) {
        return { ok: false, json: async () => ({ error: { message: 'missing permission' } }) };
      }
      return {
        ok: false,
        json: async () => ({ error: { message: '(#132001) nope', code: 132001 } }),
      };
    });
    const { whatsappAdapter } = await import('@/lib/notifications/adapters');
    const r = await whatsappAdapter.send({
      to: '+919876543210', channel: 'whatsapp', body: 'x',
      event: 'bill' as never, templateVars: ['a'],
    });
    expect(r.error).toMatch(/whatsapp_business_management/);
  });
});
