// BILL-3 — configuration health for the bill channels.
//
// The failure this exists to kill: `sendBillNotification` gates the WhatsApp
// channel on FOUR conditions, and a missing one was a silent no-op — no send, no
// log row, no error, nothing in the UI. A cafe could run for weeks believing
// bills were going out. Worse, `getAdapter()` only checks token + phone-id, so
// order-status messages can be live while the bill is dead purely because
// WHATSAPP_TPL_BILL is unset.
//
// Pure and dependency-free (reads process.env only) so the engine, the owner
// health API and tests can all share one definition of "configured".

export type BillChannel = 'whatsapp' | 'email';

export interface ChannelHealth {
  channel: BillChannel;
  /** True when every REQUIRED variable is present — i.e. a send will be attempted. */
  configured: boolean;
  /** Required env vars that are absent. Non-empty ⇒ the channel is dormant. */
  missing: string[];
  /** Present but likely-wrong config: won't stop a send, may make Meta reject it. */
  warnings: string[];
  /** One line an owner can act on. */
  note: string;
}

function isSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

function missingFrom(names: string[]): string[] {
  return names.filter((n) => !isSet(n));
}

/**
 * WhatsApp bill channel. Required: the Cloud API credentials plus the approved
 * template NAME — the engine refuses to send without it, because a template-less
 * proactive message is rejected by Meta anyway.
 */
export function whatsappBillHealth(): ChannelHealth {
  const missing = missingFrom(['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TPL_BILL']);
  const warnings: string[] = [];

  // A template APPROVED WITH AN IMAGE HEADER requires the header parameter on
  // every send — omit it and Meta rejects the message. We can't introspect the
  // approved template from here, so this is a warning rather than a hard gate:
  // it's wrong for a text-header template and fatal for an image-header one.
  if (missing.length === 0 && !isSet('WHATSAPP_TPL_BILL_HEADER_IMAGE')) {
    warnings.push(
      'WHATSAPP_TPL_BILL_HEADER_IMAGE is unset — required if the approved template has an IMAGE header (Meta rejects the send without it).',
    );
  }
  // {{6}} is an absolute receipt link; without a site URL it renders as a path.
  if (!isSet('NEXT_PUBLIC_SITE_URL') && !isSet('VERCEL_PROJECT_PRODUCTION_URL')) {
    warnings.push('NEXT_PUBLIC_SITE_URL is unset — the receipt link in the bill will be a broken relative path.');
  }

  return {
    channel: 'whatsapp',
    configured: missing.length === 0,
    missing,
    warnings,
    note:
      missing.length === 0
        ? 'WhatsApp bills are configured.'
        : `WhatsApp bills are OFF — set ${missing.join(', ')}.`,
  };
}

/** Email bill channel (Resend). */
export function emailBillHealth(): ChannelHealth {
  const missing = missingFrom(['RESEND_API_KEY', 'RESEND_FROM']);
  return {
    channel: 'email',
    configured: missing.length === 0,
    missing,
    warnings: [],
    note: missing.length === 0 ? 'Email bills are configured.' : `Email bills are OFF — set ${missing.join(', ')}.`,
  };
}

export function billChannelHealth(): ChannelHealth[] {
  return [whatsappBillHealth(), emailBillHealth()];
}

/**
 * The specific trap `getAdapter()` hides: NOTIFY_PROVIDER=whatsapp with the
 * credentials present silently falls back to the log stub when they're not, and
 * order-status messages can succeed while bills fail on the template var alone.
 */
export function providerMismatch(): string | null {
  const provider = (process.env.NOTIFY_PROVIDER ?? 'log').toLowerCase();
  if (provider !== 'whatsapp') {
    return `NOTIFY_PROVIDER is '${provider}' — order-status messages are not being sent over WhatsApp.`;
  }
  if (!isSet('WHATSAPP_TOKEN') || !isSet('WHATSAPP_PHONE_ID')) {
    return 'NOTIFY_PROVIDER=whatsapp but the credentials are missing — every notification is silently going to the log stub.';
  }
  return null;
}

// Warn once per process, not per request — a busy counter would otherwise flood
// the logs with the same line.
let warned = false;

/** Logs a single startup-time warning naming exactly what's missing. */
export function warnIfMisconfigured(): void {
  if (warned) return;
  warned = true;

  const lines: string[] = [];
  const mismatch = providerMismatch();
  if (mismatch) lines.push(mismatch);
  for (const h of billChannelHealth()) {
    if (!h.configured) lines.push(h.note);
    for (const w of h.warnings) lines.push(`${h.channel}: ${w}`);
  }
  if (lines.length > 0) {
    console.warn(`[notifications] configuration issues:\n  - ${lines.join('\n  - ')}`);
  }
}

/** Test seam — resets the warn-once latch. */
export function resetWarnOnceForTests(): void {
  warned = false;
}
