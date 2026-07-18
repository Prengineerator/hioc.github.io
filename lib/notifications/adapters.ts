// Notification transport adapters (F4). The engine is provider-agnostic: it
// renders a message, then hands it to whatever adapter `getAdapter()` returns.
// Selection is env-driven (NOTIFY_PROVIDER) and falls back to the no-op logger
// whenever a provider's credentials are missing, so a half-configured deploy
// still records deliveries instead of throwing.
//
// Env to go live:
//   NOTIFY_PROVIDER=whatsapp | sms | log        (default: log)
//   WhatsApp (Meta Cloud API): WHATSAPP_TOKEN, WHATSAPP_PHONE_ID [, WHATSAPP_API_VERSION]
//   SMS (Twilio):              TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM

import type { NotificationChannel } from '@/lib/types';

export interface SendInput {
  to: string; // E.164 phone (customer_phone), e.g. +919999999999
  channel: NotificationChannel;
  body: string;
}

export interface SendResult {
  ok: boolean;
  providerRef: string; // gateway message id ('' when none)
  error: string; // '' on success
}

export interface NotificationAdapter {
  readonly name: string;
  readonly channel: NotificationChannel;
  send(input: SendInput): Promise<SendResult>;
}

/**
 * Stub adapter: contacts no external service, "succeeds", and returns a
 * synthetic ref so the delivery logs as `sent`. Closes the loop end-to-end
 * before a paid provider is wired, and logs to the server console for dev.
 */
export const logAdapter: NotificationAdapter = {
  name: 'log',
  channel: 'whatsapp',
  async send({ to, body }: SendInput): Promise<SendResult> {
    const ref = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.info(`[notify:log] → ${to}\n${body}\n(ref ${ref})`);
    return { ok: true, providerRef: ref, error: '' };
  },
};

/**
 * WhatsApp via the Meta Cloud API. Sends a plain text message — valid inside the
 * 24-hour customer service window; for proactive sends outside it, Meta requires
 * a pre-approved message *template* (swap the payload `type` to 'template' once
 * templates are approved). Never throws.
 */
export const whatsappAdapter: NotificationAdapter = {
  name: 'whatsapp',
  channel: 'whatsapp',
  async send({ to, body }: SendInput): Promise<SendResult> {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const version = process.env.WHATSAPP_API_VERSION ?? 'v21.0';
    if (!token || !phoneId) {
      return { ok: false, providerRef: '', error: 'whatsapp credentials missing' };
    }
    try {
      const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/^\+/, ''), // Cloud API expects digits without '+'
          type: 'text',
          text: { preview_url: false, body },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        messages?: { id: string }[];
        error?: { message?: string };
      };
      if (!res.ok) {
        return { ok: false, providerRef: '', error: data.error?.message ?? `HTTP ${res.status}` };
      }
      return { ok: true, providerRef: data.messages?.[0]?.id ?? '', error: '' };
    } catch (err) {
      return { ok: false, providerRef: '', error: err instanceof Error ? err.message : 'send failed' };
    }
  },
};

/** SMS via Twilio. Never throws. */
export const smsAdapter: NotificationAdapter = {
  name: 'sms',
  channel: 'sms',
  async send({ to, body }: SendInput): Promise<SendResult> {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) {
      return { ok: false, providerRef: '', error: 'twilio credentials missing' };
    }
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      });
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!res.ok) {
        return { ok: false, providerRef: '', error: data.message ?? `HTTP ${res.status}` };
      }
      return { ok: true, providerRef: data.sid ?? '', error: '' };
    } catch (err) {
      return { ok: false, providerRef: '', error: err instanceof Error ? err.message : 'send failed' };
    }
  },
};

/**
 * Returns the active adapter based on NOTIFY_PROVIDER, falling back to the log
 * stub whenever the selected provider's credentials aren't configured — so the
 * loop keeps recording deliveries instead of failing on a partial setup.
 */
export function getAdapter(): NotificationAdapter {
  switch ((process.env.NOTIFY_PROVIDER ?? 'log').toLowerCase()) {
    case 'whatsapp':
      return process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID ? whatsappAdapter : logAdapter;
    case 'sms':
      return process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM
        ? smsAdapter
        : logAdapter;
    default:
      return logAdapter;
  }
}
