// BILL-3 follow-up — the pure half of the settings-page channel summary.
//
// GET /api/owner/notifications already decides what "configured" means (see
// lib/notifications/health.ts). Nothing here re-derives it: this module only
// turns that verdict into the one sentence an owner needs on a screen that is
// not the delivery log. It lives apart from the component so the judgement
// calls — which channel counts as dead, whether a warning still counts as
// "fine" — can be tested without rendering React.

import type { ChannelHealth } from '@/lib/notifications/health';

/**
 * One entry of the API's `health` array as it arrives over the wire. Identical
 * to ChannelHealth except that `channel` is widened to string: this is parsed
 * JSON, so a channel added on the server has to render (see channelLabel)
 * rather than be a type error on the client that nobody notices until build.
 */
export type ChannelHealthInput = Omit<ChannelHealth, 'channel'> & { channel: string };

export type HealthTone = 'ok' | 'attention';

export interface ChannelLine {
  channel: string;
  /** How the owner refers to it, not how the code does ('whatsapp' → 'WhatsApp'). */
  label: string;
  configured: boolean;
  /** One actionable sentence. When a channel is off it names the exact env vars. */
  detail: string;
  warnings: string[];
}

export interface HealthSummary {
  tone: HealthTone;
  headline: string;
  lines: ChannelLine[];
  providerWarning: string | null;
}

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

/** 'A' / 'A and B' / 'A, B and C' — the summary reads as a sentence, not a list. */
export function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function toChannelLine(health: ChannelHealthInput): ChannelLine {
  // A dormant channel spells out its own variables rather than reusing the
  // API's prose: the owner has to paste these into the deployment environment
  // character-for-character, so they must survive any later copy edit upstream.
  const detail = health.configured
    ? health.note
    : health.missing.length > 0
      ? `Nothing is sent. Set ${health.missing.join(', ')} in the deployment environment, then redeploy.`
      : health.note;

  return {
    channel: health.channel,
    label: channelLabel(health.channel),
    configured: health.configured,
    detail,
    warnings: health.warnings,
  };
}

/**
 * The headline answers one question — "will a customer get their bill?" — and
 * `tone` decides whether the card shouts. A configured channel carrying a
 * warning is deliberately NOT 'ok': the header-image warning is the difference
 * between a send and a Meta rejection, and quietly passing it would recreate
 * the silent failure this whole surface exists to kill.
 */
export function summarizeChannelHealth(
  health: ChannelHealthInput[],
  providerWarning: string | null = null,
): HealthSummary {
  const lines = health.map(toChannelLine);
  const off = lines.filter((l) => !l.configured);
  const warned = lines.some((l) => l.warnings.length > 0) || Boolean(providerWarning);

  let headline: string;
  if (lines.length === 0) {
    headline = 'Channel status is unavailable.';
  } else if (off.length === lines.length) {
    headline = 'No channel is configured — customers are not receiving their bill.';
  } else if (off.length > 0) {
    headline = `${joinNames(off.map((l) => l.label))} ${off.length === 1 ? 'is' : 'are'} off — those bills are never sent.`;
  } else if (warned) {
    headline = 'Bills are going out, but something below needs a look.';
  } else {
    headline = 'Every bill channel is configured.';
  }

  return {
    tone: lines.length > 0 && off.length === 0 && !warned ? 'ok' : 'attention',
    headline,
    lines,
    providerWarning,
  };
}
