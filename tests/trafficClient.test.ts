import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// First-party traffic tracking, browser side (lib/traffic/client.ts): when a
// visit starts and ends, what an order carries, and that a browser asking not
// to be tracked sends nothing. The browser globals are stubbed by hand.

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

let sent: { url: string; body: Record<string, unknown> }[] = [];
let session = storage();

function load(url: string, referrer = '') {
  const u = new URL(url);
  vi.stubGlobal('window', { sessionStorage: session, location: { search: u.search, hostname: u.hostname } });
  vi.stubGlobal('document', { referrer });
}

async function freshModule() {
  vi.resetModules();
  return import('@/lib/traffic/client');
}

beforeEach(() => {
  sent = [];
  session = storage();
  vi.stubGlobal('navigator', {
    doNotTrack: null,
    sendBeacon: (url: string, blob: Blob) => {
      // Blob.text() is async; the body is read back synchronously from the source string.
      sent.push({ url, body: JSON.parse((blob as unknown as { __text: string }).__text) });
      return true;
    },
  });
  vi.stubGlobal(
    'Blob',
    class {
      __text: string;
      constructor(parts: string[]) {
        this.__text = parts.join('');
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a visit', () => {
  it('starts on the first page load with the outside site and tags of that load', async () => {
    const c = await freshModule();
    load('https://hioc.in/shop?utm_source=Instagram&utm_medium=bio', 'https://l.instagram.com/');
    const v = c.beginPageLoad();
    expect(v).toMatchObject({ referrer: 'l.instagram.com', utm: { utm_source: 'instagram', utm_medium: 'bio' }, views: 0 });
    c.sendTrafficView('/shop');
    c.sendTrafficView('/checkout' as never);
    expect(sent.map((s) => [s.url, s.body.route, s.body.landing, s.body.sid === v.sid])).toEqual([
      ['/api/traffic', '/shop', true, true],
      ['/api/traffic', '/checkout', false, true],
    ]);
    expect(sent[0].body).toMatchObject({ referrer: 'l.instagram.com', utm_source: 'instagram' });
  });

  it('carries on through a reload and a hard link from our own site', async () => {
    const c = await freshModule();
    load('https://hioc.in/', 'https://www.google.com/');
    const first = c.beginPageLoad(1_000);
    load('https://hioc.in/menu', 'https://hioc.in/');
    const second = c.beginPageLoad(2_000);
    expect(second.sid).toBe(first.sid);
    expect(second.referrer).toBe('google.com');
  });

  it('starts again after 30 idle minutes, a new tagged link, or a new outside site', async () => {
    const c = await freshModule();
    load('https://hioc.in/menu', 'https://www.google.com/');
    const a = c.beginPageLoad(0);
    load('https://hioc.in/menu', 'https://www.google.com/');
    const idle = c.beginPageLoad(31 * 60_000);
    expect(idle.sid).not.toBe(a.sid);

    load('https://hioc.in/menu?utm_source=whatsapp&utm_medium=offer');
    const tagged = c.beginPageLoad(32 * 60_000);
    expect(tagged.sid).not.toBe(idle.sid);
    expect(tagged.utm.utm_source).toBe('whatsapp');

    load('https://hioc.in/shop', 'https://m.facebook.com/');
    const fb = c.beginPageLoad(33 * 60_000);
    expect(fb.sid).not.toBe(tagged.sid);
    expect(fb.referrer).toBe('m.facebook.com');
  });

  it('gives an order the visit it came from, or nothing when tracking is off', async () => {
    const c = await freshModule();
    load('https://hioc.in/menu?utm_source=qr', '');
    const v = c.beginPageLoad();
    expect(c.getTrafficAttribution(true)).toMatchObject({ sid: v.sid, referrer: null, utm_source: 'qr' });
    expect(c.getTrafficAttribution(false)).toBeUndefined();
  });
});

describe('a browser that asks not to be tracked', () => {
  it('sends no page view and gives an order no visit', async () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: true, sendBeacon: () => { throw new Error('must not send'); } });
    const c = await freshModule();
    load('https://hioc.in/menu', 'https://www.google.com/');
    expect(c.trackingDeclined()).toBe(true);
    c.sendTrafficView('/menu');
    expect(c.getTrafficAttribution(true)).toBeUndefined();
  });

  it('honours Do Not Track as well', async () => {
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    const c = await freshModule();
    load('https://hioc.in/menu');
    expect(c.trackingDeclined()).toBe(true);
  });
});
