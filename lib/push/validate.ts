import { createHash } from 'crypto';
import { normalizeOwnerPath } from './url';
import { PUSH_BODY_MAX, PUSH_TITLE_MAX } from './types';

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
export const ENDPOINT_MAX = 1000;

export interface ValidSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// The server later POSTs to whatever endpoint is stored, so only the browsers'
// own push services are accepted (otherwise a customer could aim the server at
// any address). https, default port, no userinfo, no IP literals.
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

export function isPushServiceUrl(u: URL): boolean {
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return false;
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return false;
  if (PUSH_HOSTS.includes(host)) return true;
  return PUSH_HOST_SUFFIXES.some((s) => host.length > s.length && host.endsWith(s));
}

/** Most devices one customer may have signed up. */
export const MAX_DEVICES_PER_USER = 10;

/** A PushSubscription.toJSON() body: https endpoint, both keys, sane lengths. */
export function parseSubscription(body: Record<string, unknown>): { ok: true; value: ValidSubscription } | { ok: false; error: string } {
  const endpoint = body.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > ENDPOINT_MAX) {
    return { ok: false, error: 'Invalid subscription endpoint.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, error: 'Invalid subscription endpoint.' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'Subscription endpoint must be https.' };
  if (!isPushServiceUrl(parsed)) return { ok: false, error: 'Subscription endpoint is not a known push service.' };
  const keys = body.keys as Record<string, unknown> | undefined;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof p256dh !== 'string' || p256dh.length < 20 || p256dh.length > 200 || !B64URL.test(p256dh)) {
    return { ok: false, error: 'Invalid subscription key.' };
  }
  if (typeof auth !== 'string' || auth.length < 8 || auth.length > 100 || !B64URL.test(auth)) {
    return { ok: false, error: 'Invalid subscription key.' };
  }
  return { ok: true, value: { endpoint, p256dh, auth } };
}

export const endpointHash = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex');

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
}

/** The owner's form: title, text and a hioc.in page, within the limits. */
export function parseMessage(body: Record<string, unknown>): { ok: true; value: PushMessage } | { ok: false; error: string } {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (title === '') return { ok: false, error: 'Write a title.' };
  if (title.length > PUSH_TITLE_MAX) return { ok: false, error: `The title can be up to ${PUSH_TITLE_MAX} characters.` };
  if (text === '') return { ok: false, error: 'Write the message text.' };
  if (text.length > PUSH_BODY_MAX) return { ok: false, error: `The text can be up to ${PUSH_BODY_MAX} characters.` };
  const url = normalizeOwnerPath(body.url);
  if (url === null) return { ok: false, error: 'Choose a page on hioc.in to open, for example /menu.' };
  return { ok: true, value: { title, body: text, url } };
}
