// Notification transport adapters (F4). The engine is provider-agnostic: it
// renders a message, then hands it to whatever adapter `getAdapter()` returns.
// Selection is env-driven (NOTIFY_PROVIDER) and falls back to the no-op logger
// whenever a provider's credentials are missing, so a half-configured deploy
// still records deliveries instead of throwing.
//
// Env to go live:
//   NOTIFY_PROVIDER=whatsapp | sms | log        (default: log)
//   WhatsApp (Meta Cloud API): WHATSAPP_TOKEN, WHATSAPP_PHONE_ID [, WHATSAPP_API_VERSION]
//     bill template: WHATSAPP_TPL_BILL (approved name) [, WHATSAPP_TPL_BILL_HEADER_IMAGE
//     = public HTTPS logo URL, only if the approved template has an image header]
//   SMS (Twilio):              TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM

import type { NotificationChannel, NotificationEvent } from '@/lib/types';

export interface SendInput {
  to: string; // destination: E.164 phone for whatsapp/sms, email address for email
  channel: NotificationChannel;
  body: string; // rendered plain text (log/SMS + WhatsApp free-text fallback)
  event?: NotificationEvent; // for template-based providers (WhatsApp)
  templateVars?: string[]; // ordered {{1}},{{2}},… for the event's approved template
  // Optional image for a WhatsApp template's IMAGE header (e.g. the brand logo on
  // the bill). Only takes effect if the APPROVED template was designed with an
  // image header — Meta rejects a header component the template doesn't declare.
  // Must be a public HTTPS URL Meta's servers can fetch.
  headerImageUrl?: string;
  subject?: string; // email only
  html?: string; // email only (falls back to <pre>body</pre>)
}

// event → approved WhatsApp template name (override per event via env).
function whatsappTemplateName(event: NotificationEvent): string {
  const map: Record<NotificationEvent, string> = {
    accepted: process.env.WHATSAPP_TPL_ACCEPTED || 'order_accepted',
    // Approved as 'order_ready_1' (the name 'order_ready' was taken by the
    // earlier rejected version). Override with WHATSAPP_TPL_READY if renamed.
    ready: process.env.WHATSAPP_TPL_READY || 'order_ready_1',
    rejected: process.env.WHATSAPP_TPL_REJECTED || 'order_rejected',
    cancelled: process.env.WHATSAPP_TPL_CANCELLED || 'order_cancelled',
    // E-bill (RCT-1): 6-var template `order_bill_1` (submitted for Meta approval
    // in Sprint 1, input I3). The WhatsApp channel stays dormant until an approved
    // name is set in WHATSAPP_TPL_BILL (see sendBillNotification); this is the
    // default name once approved.
    bill: process.env.WHATSAPP_TPL_BILL || 'order_bill_1',
  };
  return map[event];
}

/**
 * The language code for one event's template.
 *
 * Meta identifies a template by NAME **plus** LANGUAGE, and rejects any
 * mismatch with `(#132001) Template name does not exist in the translation` —
 * which reads like the name is wrong when the name is fine. Templates are
 * created one at a time, often months apart, so their languages drift: picking
 * "English" in the UI yields `en` and "English (US)" yields `en_US`.
 *
 * A single global was therefore the wrong shape. Production had `order_ready_1`
 * on `en` (working) and `order_bill_1` on another code (every bill rejected),
 * and no value of one variable could satisfy both — setting the global to fix
 * the bill would have broken every status message.
 */
function whatsappTemplateLang(event: NotificationEvent): string {
  const perEvent: Partial<Record<NotificationEvent, string | undefined>> = {
    accepted: process.env.WHATSAPP_TPL_ACCEPTED_LANG,
    ready: process.env.WHATSAPP_TPL_READY_LANG,
    rejected: process.env.WHATSAPP_TPL_REJECTED_LANG,
    cancelled: process.env.WHATSAPP_TPL_CANCELLED_LANG,
    bill: process.env.WHATSAPP_TPL_BILL_LANG,
  };
  return perEvent[event] || process.env.WHATSAPP_TPL_LANG || 'en';
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
/**
 * The development stub. It writes the message to the console and reports
 * success — which is correct for local work and catastrophic if it is ever
 * mistaken for a real send.
 *
 * WA-1: the ref is branded `stub_` precisely so that "did this actually go to a
 * phone?" is answerable from the log row alone, forever, without consulting the
 * environment the row was written in. The legacy prefix was `log_`; the owner
 * UI matches both so historic rows are branded retroactively rather than
 * silently counted as real sends.
 */
export const STUB_REF_PREFIX = 'stub_';
/** Rows written before WA-1 branded the stub. Recognised, never rewritten. */
export const LEGACY_STUB_REF_PREFIX = 'log_';

/** True when a provider_ref came from the stub rather than a real provider. */
export function isStubRef(providerRef: string | null | undefined): boolean {
  const ref = providerRef ?? '';
  return ref.startsWith(STUB_REF_PREFIX) || ref.startsWith(LEGACY_STUB_REF_PREFIX);
}

export const logAdapter: NotificationAdapter = {
  name: 'stub',
  channel: 'whatsapp',
  async send({ to, body }: SendInput): Promise<SendResult> {
    const ref = `${STUB_REF_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.info(`[notify:stub] NOT REALLY SENT → ${to}\n${body}\n(ref ${ref})`);
    return { ok: true, providerRef: ref, error: '' };
  },
};

/**
 * Answers "then what templates DOES this number's account have?".
 *
 * Meta's #132001 reports a missing template identically whether the name is
 * wrong, the language is wrong, or the template is perfectly fine but sitting
 * in a different WhatsApp Business Account. Those have completely different
 * remedies and the error distinguishes none of them, which is exactly how a
 * bill outage survives several rounds of confident fixes.
 *
 * So on total failure we resolve the WABA behind the phone id and list what is
 * actually approved there. Never throws — a diagnostic that can break the
 * caller is worse than no diagnostic.
 */
async function describeAvailableTemplates(
  version: string,
  phoneId: string,
  token: string,
): Promise<string> {
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const wabaRes = await fetch(
      `https://graph.facebook.com/${version}/${phoneId}?fields=whatsapp_business_account{id,name}`,
      { headers: auth },
    );
    const wabaJson = (await wabaRes.json().catch(() => ({}))) as {
      whatsapp_business_account?: { id?: string; name?: string };
      error?: { message?: string };
    };
    const waba = wabaJson.whatsapp_business_account?.id;
    if (!waba) {
      return `Could not read the WhatsApp Business Account behind WHATSAPP_PHONE_ID (${
        wabaJson.error?.message ?? 'no account returned'
      }) — the token may lack whatsapp_business_management.`;
    }

    const tplRes = await fetch(
      `https://graph.facebook.com/${version}/${waba}/message_templates?limit=100&fields=name,language,status`,
      { headers: auth },
    );
    const tplJson = (await tplRes.json().catch(() => ({}))) as {
      data?: { name?: string; language?: string; status?: string }[];
      error?: { message?: string };
    };
    if (!Array.isArray(tplJson.data)) {
      return `Could not list templates for account ${waba} (${tplJson.error?.message ?? 'no data'}).`;
    }

    const approved = tplJson.data
      .filter((t) => (t.status ?? '').toUpperCase() === 'APPROVED')
      .map((t) => `${t.name}/${t.language}`);
    return `Account ${waba} (${wabaJson.whatsapp_business_account?.name ?? 'unnamed'}) has ${
      approved.length
    } approved template(s): ${approved.join(', ') || '(none)'}.`;
  } catch (err) {
    return `Template inventory lookup failed: ${err instanceof Error ? err.message : 'unknown'}.`;
  }
}

/**
 * WhatsApp via the Meta Cloud API. Order notifications are proactive (outside any
 * 24h customer-service window), so Meta REQUIRES an approved message *template*:
 * when `event` + `templateVars` are provided we send `type: 'template'`; without
 * them (e.g. a reply inside the 24h window) we fall back to free text. Never
 * throws. Language via WHATSAPP_TPL_LANG (default 'en').
 */
export const whatsappAdapter: NotificationAdapter = {
  name: 'whatsapp',
  channel: 'whatsapp',
  async send({ to, body, event, templateVars, headerImageUrl }: SendInput): Promise<SendResult> {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const version = process.env.WHATSAPP_API_VERSION ?? 'v21.0';
    if (!token || !phoneId) {
      return { ok: false, providerRef: '', error: 'whatsapp credentials missing' };
    }
    const digits = to.replace(/^\+/, ''); // Cloud API expects digits without '+'
    let payload: Record<string, unknown>;
    if (event && templateVars) {
      // Build the template components. An image header (e.g. the bill logo) is
      // included only when a URL is supplied AND the approved template declares
      // an image header — otherwise Meta rejects the send.
      const components: Record<string, unknown>[] = [];
      if (headerImageUrl) {
        components.push({
          type: 'header',
          parameters: [{ type: 'image', image: { link: headerImageUrl } }],
        });
      }
      components.push({
        type: 'body',
        parameters: templateVars.map((t) => ({ type: 'text', text: t })),
      });
      payload = {
        messaging_product: 'whatsapp',
        to: digits,
        type: 'template',
        template: {
          name: whatsappTemplateName(event),
          language: { code: whatsappTemplateLang(event) },
          components,
        },
      };
    } else {
      payload = { messaging_product: 'whatsapp', to: digits, type: 'text', text: { preview_url: false, body } };
    }
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        messages?: { id: string }[];
        error?: { message?: string; code?: number };
      };
      return { res, data };
    };

    try {
      const { res, data } = await post(payload);
      if (res.ok) {
        return { ok: true, providerRef: data.messages?.[0]?.id ?? '', error: '' };
      }

      // #132001 — "Template name does not exist in the translation". Meta
      // identifies a template by NAME + LANGUAGE and this error does not say
      // which half is wrong, nor what the right language would be. There is no
      // send-side way to ask.
      //
      // So rather than have a human guess a language code, redeploy, place a
      // real order and read the log — a loop this cafe went round twice, losing
      // a live bill each time — try the handful of codes a template is
      // realistically approved under, and SAY which one worked. The candidate
      // list is tiny and only ever runs after a failure that was already fatal,
      // so the cost is bounded and the alternative is a message nobody gets.
      const isTemplateSend = Boolean(event && templateVars);
      if (isTemplateSend && data.error?.code === 132001) {
        const tried = whatsappTemplateLang(event!);
        const candidates = ['en', 'en_US', 'en_GB'].filter((c) => c !== tried);

        for (const code of candidates) {
          const retry = {
            ...payload,
            template: { ...(payload.template as object), language: { code } },
          };
          const attempt = await post(retry);
          if (attempt.res.ok) {
            // Loud on purpose: this is a working send AND a configuration bug.
            // Without this line the next deploy silently pays the retry cost
            // forever and nobody learns the real value.
            console.warn(
              `[notify] template '${whatsappTemplateName(event!)}' is not approved in '${tried}' but IS in '${code}'. ` +
                `Set ${event === 'bill' ? 'WHATSAPP_TPL_BILL_LANG' : `WHATSAPP_TPL_${String(event).toUpperCase()}_LANG`}=${code} to stop retrying.`,
            );
            return { ok: true, providerRef: attempt.data.messages?.[0]?.id ?? '', error: '' };
          }
        }

        // Every candidate refused, so the language is not the problem. Meta has
        // now said "does not exist" four times without once saying what DOES
        // exist — and that gap is what turned this into days of guessing names
        // and codes against a live counter.
        //
        // The account can be asked directly, with the token already in hand, so
        // ask it: resolve the WABA that owns this phone id and list its
        // templates. "order_bill_1 is not here; these are" ends the guessing in
        // one line. Bounded — only reached after a send that has already failed
        // outright, and read-only.
        const inventory = await describeAvailableTemplates(version, phoneId, token);
        return {
          ok: false,
          providerRef: '',
          error: `${data.error?.message ?? 'template not found'} — tried languages: ${[tried, ...candidates].join(', ')}. ${inventory}`,
        };
      }

      return { ok: false, providerRef: '', error: data.error?.message ?? `HTTP ${res.status}` };
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
 * Email via Resend (REST API, no SDK — same raw-fetch pattern as WhatsApp/SMS).
 * Used by the e-bill send (channel 'email'); `to` is the address, `subject`+`html`
 * carry the message (plain `body` is the fallback). Never throws. Returns a
 * clear error when RESEND_API_KEY / RESEND_FROM aren't configured.
 */
export const emailAdapter: NotificationAdapter = {
  name: 'email',
  channel: 'email',
  async send({ to, subject, html, body }: SendInput): Promise<SendResult> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM; // e.g. "HIOC <bills@hioc.in>"
    if (!apiKey || !from) {
      return { ok: false, providerRef: '', error: 'resend credentials missing' };
    }
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [to],
          subject: subject || 'Your bill',
          html: html || `<pre>${body}</pre>`,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!res.ok) {
        return { ok: false, providerRef: '', error: data.message ?? data.name ?? `HTTP ${res.status}` };
      }
      return { ok: true, providerRef: data.id ?? '', error: '' };
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
