import { describe, expect, it } from 'vitest';
import {
  channelLabel,
  joinNames,
  summarizeChannelHealth,
  toChannelLine,
} from '@/components/owner/channelHealth';
import type { ChannelHealthInput } from '@/components/owner/channelHealth';

// BILL-3 follow-up — the settings-page summary of channel health. The bug class
// being locked down is the one the whole notifications phase existed to kill: a
// cafe believing bills go out while the credentials were never set. So the
// assertions that matter are (a) an unconfigured channel can never read as OK,
// and (b) the copy names the exact env vars to set.

function health(over: Partial<ChannelHealthInput> = {}): ChannelHealthInput {
  return {
    channel: 'whatsapp',
    configured: true,
    missing: [],
    warnings: [],
    note: 'WhatsApp bills are configured.',
    ...over,
  };
}

const CONFIGURED_EMAIL = health({
  channel: 'email',
  note: 'Email bills are configured.',
});

const DEAD_WHATSAPP = health({
  configured: false,
  missing: ['WHATSAPP_TOKEN', 'WHATSAPP_TPL_BILL'],
  note: 'WhatsApp bills are OFF — set WHATSAPP_TOKEN, WHATSAPP_TPL_BILL.',
});

describe('channelLabel', () => {
  it('uses the owner-facing name, not the code one', () => {
    expect(channelLabel('whatsapp')).toBe('WhatsApp');
    expect(channelLabel('email')).toBe('Email');
  });

  it('capitalizes an unknown channel rather than showing it raw', () => {
    expect(channelLabel('sms')).toBe('Sms');
    expect(channelLabel('')).toBe('');
  });
});

describe('joinNames', () => {
  it('reads as a sentence', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['WhatsApp'])).toBe('WhatsApp');
    expect(joinNames(['WhatsApp', 'Email'])).toBe('WhatsApp and Email');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('toChannelLine', () => {
  it('names every missing env var when the channel is off', () => {
    const line = toChannelLine(DEAD_WHATSAPP);
    expect(line.configured).toBe(false);
    expect(line.label).toBe('WhatsApp');
    expect(line.detail).toContain('WHATSAPP_TOKEN');
    expect(line.detail).toContain('WHATSAPP_TPL_BILL');
    expect(line.detail).toContain('redeploy');
  });

  it('falls back to the API note when a channel is off without a var list', () => {
    const line = toChannelLine(health({ configured: false, note: 'Something else is wrong.' }));
    expect(line.detail).toBe('Something else is wrong.');
  });

  it('passes the API note through for a healthy channel', () => {
    expect(toChannelLine(health()).detail).toBe('WhatsApp bills are configured.');
  });

  it('carries warnings through untouched', () => {
    const line = toChannelLine(health({ warnings: ['header image unset'] }));
    expect(line.warnings).toEqual(['header image unset']);
  });
});

describe('summarizeChannelHealth', () => {
  it('is OK only when every channel is configured and nothing is warned about', () => {
    const summary = summarizeChannelHealth([health(), CONFIGURED_EMAIL], null);
    expect(summary.tone).toBe('ok');
    expect(summary.headline).toBe('Every bill channel is configured.');
  });

  it('flags the one dead channel by name', () => {
    const summary = summarizeChannelHealth([DEAD_WHATSAPP, CONFIGURED_EMAIL], null);
    expect(summary.tone).toBe('attention');
    expect(summary.headline).toContain('WhatsApp is off');
    expect(summary.lines[0].detail).toContain('WHATSAPP_TOKEN');
  });

  it('says plainly when nothing is configured at all', () => {
    const summary = summarizeChannelHealth(
      [DEAD_WHATSAPP, health({ channel: 'email', configured: false, missing: ['RESEND_API_KEY'] })],
      null,
    );
    expect(summary.tone).toBe('attention');
    expect(summary.headline).toBe('No channel is configured — customers are not receiving their bill.');
  });

  // Unreachable with today's two channels, but the branch exists so a third one
  // added server-side can't produce "WhatsApp, Email is off".
  it('pluralizes when more than one channel is off but not all', () => {
    const summary = summarizeChannelHealth(
      [DEAD_WHATSAPP, health({ channel: 'email', configured: false }), health({ channel: 'sms' })],
      null,
    );
    expect(summary.headline).toContain('WhatsApp and Email are off');
  });

  // A configured channel with a warning is NOT 'ok': the header-image warning is
  // the difference between a delivered bill and a Meta rejection.
  it('will not report OK while a configured channel carries a warning', () => {
    const summary = summarizeChannelHealth(
      [health({ warnings: ['WHATSAPP_TPL_BILL_HEADER_IMAGE is unset'] }), CONFIGURED_EMAIL],
      null,
    );
    expect(summary.tone).toBe('attention');
    expect(summary.headline).toBe('Bills are going out, but something below needs a look.');
  });

  it('will not report OK while the provider itself is mismatched', () => {
    const summary = summarizeChannelHealth(
      [health(), CONFIGURED_EMAIL],
      'NOTIFY_PROVIDER is \'log\' — order-status messages are not being sent over WhatsApp.',
    );
    expect(summary.tone).toBe('attention');
    expect(summary.providerWarning).toContain('NOTIFY_PROVIDER');
  });

  it('does not claim health when the API returned nothing', () => {
    const summary = summarizeChannelHealth([], null);
    expect(summary.tone).toBe('attention');
    expect(summary.headline).toBe('Channel status is unavailable.');
    expect(summary.lines).toEqual([]);
  });
});
