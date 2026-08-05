import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  billChannelHealth,
  emailBillHealth,
  providerMismatch,
  resetWarnOnceForTests,
  warnIfMisconfigured,
  whatsappBillHealth,
} from '@/lib/notifications/health';
import { describeBillOutcome, describeSkipReason } from '@/lib/notifications/reasons';

// BILL-3 — the configuration checks that turn a silent no-op into a stated
// cause. The bug being locked down: WHATSAPP_TPL_BILL could be unset while
// order-status messages kept working, so the cafe believed bills were going out.

const ENV_KEYS = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_ID',
  'WHATSAPP_TPL_BILL',
  'WHATSAPP_TPL_BILL_HEADER_IMAGE',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'NOTIFY_PROVIDER',
  'NEXT_PUBLIC_SITE_URL',
  'VERCEL_PROJECT_PRODUCTION_URL',
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetWarnOnceForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function configureWhatsapp() {
  process.env.WHATSAPP_TOKEN = 't';
  process.env.WHATSAPP_PHONE_ID = 'p';
  process.env.WHATSAPP_TPL_BILL = 'order_bill_1';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://hioc.in';
}

describe('whatsappBillHealth', () => {
  it('reports every missing variable, not just the first', () => {
    const h = whatsappBillHealth();
    expect(h.configured).toBe(false);
    expect(h.missing).toEqual(['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TPL_BILL']);
  });

  it('is NOT configured when only the template name is missing', () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';

    const h = whatsappBillHealth();
    // This is the exact trap: getAdapter() would happily send order-status
    // messages here, while every bill silently no-ops.
    expect(h.configured).toBe(false);
    expect(h.missing).toEqual(['WHATSAPP_TPL_BILL']);
  });

  it('warns about a missing header image once otherwise configured', () => {
    configureWhatsapp();

    const h = whatsappBillHealth();
    expect(h.configured).toBe(true);
    // A template approved WITH an image header rejects any send that omits it.
    expect(h.warnings.join(' ')).toContain('WHATSAPP_TPL_BILL_HEADER_IMAGE');
  });

  it('has no warnings when the header image and site URL are set', () => {
    configureWhatsapp();
    process.env.WHATSAPP_TPL_BILL_HEADER_IMAGE = 'https://hioc.in/images/whatsapp-bill-header.png';

    expect(whatsappBillHealth().warnings).toEqual([]);
  });

  it('warns when no site URL is set — the receipt link would be relative', () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    process.env.WHATSAPP_TPL_BILL = 'order_bill_1';

    expect(whatsappBillHealth().warnings.join(' ')).toContain('NEXT_PUBLIC_SITE_URL');
  });

  it('treats a whitespace-only value as unset', () => {
    process.env.WHATSAPP_TOKEN = '   ';
    expect(whatsappBillHealth().missing).toContain('WHATSAPP_TOKEN');
  });
});

describe('emailBillHealth', () => {
  it('is off without Resend credentials', () => {
    expect(emailBillHealth().configured).toBe(false);
    expect(emailBillHealth().missing).toEqual(['RESEND_API_KEY', 'RESEND_FROM']);
  });

  it('is configured with both set', () => {
    process.env.RESEND_API_KEY = 'k';
    process.env.RESEND_FROM = 'HIOC <bills@hioc.in>';
    expect(emailBillHealth().configured).toBe(true);
  });
});

describe('providerMismatch', () => {
  it('flags the default log stub', () => {
    expect(providerMismatch()).toContain('log');
  });

  it('flags whatsapp selected without credentials', () => {
    process.env.NOTIFY_PROVIDER = 'whatsapp';
    expect(providerMismatch()).toContain('silently going to the log stub');
  });

  it('is silent when whatsapp is properly configured', () => {
    process.env.NOTIFY_PROVIDER = 'whatsapp';
    configureWhatsapp();
    expect(providerMismatch()).toBeNull();
  });
});

describe('warnIfMisconfigured', () => {
  it('warns once per process, not per call', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnIfMisconfigured();
    warnIfMisconfigured();
    warnIfMisconfigured();

    // A busy counter calls this on every settle; it must not flood the logs.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('WHATSAPP_TPL_BILL');
    spy.mockRestore();
  });

  it('stays silent when everything is configured', () => {
    process.env.NOTIFY_PROVIDER = 'whatsapp';
    configureWhatsapp();
    process.env.WHATSAPP_TPL_BILL_HEADER_IMAGE = 'https://hioc.in/x.png';
    process.env.RESEND_API_KEY = 'k';
    process.env.RESEND_FROM = 'f';
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnIfMisconfigured();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('reason wording (BILL-4/5)', () => {
  it('names the missing variables an owner has to set', () => {
    expect(describeSkipReason('not_configured:WHATSAPP_TPL_BILL')).toBe(
      'Channel not configured (missing WHATSAPP_TPL_BILL)',
    );
  });

  it('translates the customer-side causes', () => {
    expect(describeSkipReason('no_phone')).toBe('No phone number on this order');
    expect(describeSkipReason('')).toBe('');
  });

  it('passes an unknown code through rather than inventing wording', () => {
    expect(describeSkipReason('some_new_reason')).toBe('some_new_reason');
  });

  it('reports a real send as delivered', () => {
    expect(
      describeBillOutcome({ whatsapp: true, email: false }, { whatsapp: '', email: 'no_email' }),
    ).toBe('Bill sent on WhatsApp.');
  });

  it('reports "nothing sent" as a failure WITH its cause', () => {
    // The regression: the resend route used to return a bare ok:true here, so
    // the UI showed success while the customer got nothing.
    expect(
      describeBillOutcome({ whatsapp: false, email: false }, { whatsapp: 'no_phone', email: 'no_email' }),
    ).toBe('Bill not sent — no phone number on this order.');
  });
});

describe('billChannelHealth', () => {
  it('covers both channels', () => {
    expect(billChannelHealth().map((h) => h.channel)).toEqual(['whatsapp', 'email']);
  });
});
