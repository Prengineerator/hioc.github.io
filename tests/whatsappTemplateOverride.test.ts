import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SendInput.templateName / templateLang (spec §4, F1): marketing sends a template the
// owner mapped in the dashboard, not one from the fixed event → env-var map. The
// override must not change a single byte of what event-based callers put on the wire
// (tests/templateLanguage.test.ts still pins that, unchanged).

const ORIGINAL = { ...process.env };

interface Call {
  url: string;
  body: Record<string, any>;
}

let calls: Call[];
let respond: (call: Call, index: number) => { ok: boolean; body: unknown };

beforeEach(() => {
  calls = [];
  respond = () => ({ ok: true, body: { messages: [{ id: 'wamid.OK' }] } });
  process.env.WHATSAPP_TOKEN = 't';
  process.env.WHATSAPP_PHONE_ID = 'p';
  delete process.env.WHATSAPP_TPL_LANG;
  delete process.env.WHATSAPP_TPL_BILL;
  delete process.env.WHATSAPP_TPL_BILL_LANG;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const call = { url, body: JSON.parse(init.body) as Record<string, any> };
    calls.push(call);
    const r = respond(call, calls.length - 1);
    return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => r.body };
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function send(input: Record<string, unknown>) {
  const { whatsappAdapter } = await import('@/lib/notifications/adapters');
  return whatsappAdapter.send({ to: '+919876543210', channel: 'whatsapp', body: 'fallback text', ...input } as never);
}

const template = (i = 0) => calls[i].body.template;

describe('templateName override', () => {
  it('sends the named template — as a template — even with NO event, as long as templateVars is present', async () => {
    const r = await send({ templateName: 'hioc_winback_1', templateVars: ['Asha', '10% off', 'WBK7M3QX', '15 Oct'] });

    expect(r).toEqual({ ok: true, providerRef: 'wamid.OK', error: '' });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'hioc_winback_1',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: ['Asha', '10% off', 'WBK7M3QX', '15 Oct'].map((text) => ({ type: 'text', text })) }],
      },
    });
  });

  it('uses templateLang; else WHATSAPP_TPL_LANG; else en', async () => {
    await send({ templateName: 'x', templateLang: 'en_US', templateVars: ['a'] });
    expect(template(0).language.code).toBe('en_US');

    process.env.WHATSAPP_TPL_LANG = 'en_GB';
    await send({ templateName: 'x', templateVars: ['a'] });
    expect(template(1).language.code).toBe('en_GB');

    // An explicit templateLang still beats the global.
    await send({ templateName: 'x', templateLang: 'en', templateVars: ['a'] });
    expect(template(2).language.code).toBe('en');

    delete process.env.WHATSAPP_TPL_LANG;
    await send({ templateName: 'x', templateVars: ['a'] });
    expect(template(3).language.code).toBe('en');
  });

  it('carries the URL button\'s dynamic suffix (the recipient\'s click token) at index 0', async () => {
    await send({ templateName: 'x', templateVars: ['a'], templateButtons: [{ index: 0, text: 'AbCdEf012-_x' }] });
    expect(template(0).components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'a' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'AbCdEf012-_x' }] },
    ]);
  });

  it('wins over the event map — the name AND the language — when both are given', async () => {
    process.env.WHATSAPP_TPL_BILL = 'order_bill_1';
    process.env.WHATSAPP_TPL_BILL_LANG = 'en_US';
    await send({ event: 'bill', templateName: 'hioc_offer_1', templateVars: ['a'] });
    expect(template(0).name).toBe('hioc_offer_1');
    // Not the bill's en_US: the override has its own language, which defaults to en.
    expect(template(0).language.code).toBe('en');
  });

  it('with a name but no templateVars and no event it is free text, exactly like before', async () => {
    await send({ templateName: 'x' });
    expect(calls[0].body).toEqual({ messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { preview_url: false, body: 'fallback text' } });
  });

  it('an empty templateName is no override at all', async () => {
    process.env.WHATSAPP_TPL_BILL = 'order_bill_1';
    await send({ event: 'bill', templateName: '', templateVars: ['a'] });
    expect(template(0).name).toBe('order_bill_1');
    calls.length = 0;
    await send({ templateName: '', templateVars: ['a'] });
    expect(calls[0].body.type).toBe('text');
  });

  it('still takes an image header when given one', async () => {
    await send({ templateName: 'x', templateVars: ['a'], headerImageUrl: 'https://hioc.in/logo.png' });
    expect(template(0).components[0]).toEqual({ type: 'header', parameters: [{ type: 'image', image: { link: 'https://hioc.in/logo.png' } }] });
  });

  it('never throws and reports missing credentials, without a request', async () => {
    delete process.env.WHATSAPP_TOKEN;
    expect(await send({ templateName: 'x', templateVars: ['a'] })).toEqual({ ok: false, providerRef: '', error: 'whatsapp credentials missing' });
    expect(calls).toEqual([]);
  });

  it('returns Meta\'s message verbatim on failure — the sender parses the (#code) out of it', async () => {
    respond = () => ({ ok: false, body: { error: { message: '(#131049) This message was not delivered to maintain healthy ecosystem engagement', code: 131049 } } });
    const r = await send({ templateName: 'x', templateVars: ['a'] });
    expect(r).toEqual({ ok: false, providerRef: '', error: '(#131049) This message was not delivered to maintain healthy ecosystem engagement' });
    expect(calls).toHaveLength(1); // no language hunting on an unrelated error
  });
});

describe('the #132001 language fallback still applies to an override', () => {
  const notInLang = (approved: string | null) => (call: Call) => {
    const lang = call.body.template?.language?.code;
    if (approved && lang === approved) return { ok: true, body: { messages: [{ id: 'wamid.FOUND' }] } };
    return { ok: false, body: { error: { message: '(#132001) Template name does not exist in the translation', code: 132001 } } };
  };

  it('finds the approved language, skips the one it already tried, and says how to stop retrying', async () => {
    respond = notInLang('en_GB');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await send({ templateName: 'hioc_offer_1', templateLang: 'en_US', templateVars: ['a'] });

    expect(r).toMatchObject({ ok: true, providerRef: 'wamid.FOUND' });
    const tried = calls.map((c) => c.body.template.language.code);
    expect(tried[0]).toBe('en_US');
    expect(tried.filter((l) => l === 'en_US')).toHaveLength(1);
    expect(tried).toContain('en_GB');
    // The marketing wording: the fix is in the dashboard, not an env var.
    expect(warn.mock.calls[0][0]).toContain("template 'hioc_offer_1' is not approved in 'en_US' but IS in 'en_GB'");
    expect(warn.mock.calls[0][0]).toContain('marketing settings');
    expect(warn.mock.calls[0][0]).not.toContain('WHATSAPP_TPL');
  });

  it('when nothing matches, names the languages tried and keeps Meta\'s own error', async () => {
    respond = (call) => (String(call.url).includes('graph.facebook.com') && call.body.template ? notInLang(null)(call) : { ok: false, body: {} });
    const r = await send({ templateName: 'hioc_offer_1', templateVars: ['a'] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tried languages: en, en_US, en_GB/);
    expect(r.error).toMatch(/#132001/);
  });

  it('does not hunt when the send was free text', async () => {
    respond = notInLang(null);
    await send({ templateName: 'x' });
    expect(calls).toHaveLength(1);
  });
});

describe('event-based sends are byte-for-byte what they always were', () => {
  it('a bill: the event\'s template name and its per-event language, exactly', async () => {
    process.env.WHATSAPP_TPL_BILL = 'order_bill_1';
    process.env.WHATSAPP_TPL_BILL_LANG = 'en_US';
    await send({ event: 'bill', templateVars: ['a', 'b'], headerImageUrl: 'https://hioc.in/logo.png' });
    expect(calls[0].body).toEqual({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'order_bill_1',
        language: { code: 'en_US' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: 'https://hioc.in/logo.png' } }] },
          { type: 'body', parameters: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        ],
      },
    });
  });

  it('feedback buttons (3 quick replies + a URL button) are untouched', async () => {
    await send({
      event: 'feedback',
      templateVars: ['Asha', '1042'],
      templateButtons: [{ index: 0, payload: 'fb:r1:5' }, { index: 1, payload: 'fb:r1:3' }, { index: 2, payload: 'fb:r1:1' }, { index: 3, text: 'tok' }],
    });
    expect(template(0).name).toBe('order_feedback_1');
    expect(template(0).components.slice(1)).toEqual([
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'fb:r1:5' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'fb:r1:3' }] },
      { type: 'button', sub_type: 'quick_reply', index: '2', parameters: [{ type: 'payload', payload: 'fb:r1:1' }] },
      { type: 'button', sub_type: 'url', index: '3', parameters: [{ type: 'text', text: 'tok' }] },
    ]);
  });

  it('an event with no templateVars is free text, and templateVars with no event is free text', async () => {
    await send({ event: 'ready' });
    await send({ templateVars: ['a'] });
    expect(calls.map((c) => c.body.type)).toEqual(['text', 'text']);
  });

  it('every event still resolves to its own template', async () => {
    for (const event of ['accepted', 'ready', 'rejected', 'cancelled', 'bill', 'feedback']) await send({ event, templateVars: ['a'] });
    expect(calls.map((c) => c.body.template.name)).toEqual(['order_accepted', 'order_ready_1', 'order_rejected', 'order_cancelled', 'order_bill_1', 'order_feedback_1']);
  });
});
