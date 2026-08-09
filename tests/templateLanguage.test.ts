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
