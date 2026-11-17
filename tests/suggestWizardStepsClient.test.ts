import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Coffey wizard step tracking, browser side (components/suggest/api.ts,
// docs/COFFEY-SPEC.md §10.7): what the wizard sends as a customer moves through
// it, that 'opened' and 'feeling_chosen' go once per visit and
// 'picks_requested' on every press, that a browser asking not to be tracked
// sends nothing, and that none of it can throw into the page. The browser
// globals are stubbed by hand, as in trafficClient.test.ts.

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

type Sent = { via: 'beacon' | 'fetch'; url: string; body: Record<string, unknown>; init?: RequestInit };
let sent: Sent[] = [];
let beaconAccepts = true;
let local = storage();

function stubNavigator(extra: Record<string, unknown> = {}) {
  vi.stubGlobal('navigator', {
    doNotTrack: null,
    sendBeacon: (url: string, blob: Blob) => {
      if (!beaconAccepts) return false;
      // Blob.text() is async; the body is read back synchronously from the source string.
      sent.push({ via: 'beacon', url, body: JSON.parse((blob as unknown as { __text: string }).__text) });
      return true;
    },
    ...extra,
  });
}

async function freshApi() {
  vi.resetModules();
  return import('@/components/suggest/api');
}

beforeEach(() => {
  sent = [];
  beaconAccepts = true;
  local = storage();
  vi.stubGlobal('window', { localStorage: local });
  stubNavigator();
  vi.stubGlobal(
    'Blob',
    class {
      __text: string;
      type: string;
      constructor(parts: string[], opts: { type?: string } = {}) {
        this.__text = parts.join('');
        this.type = opts.type ?? '';
      }
    },
  );
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push({ via: 'fetch', url, body: JSON.parse(String(init.body)), init });
    return Promise.resolve(new Response(null, { status: 204 }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postWizardStep', () => {
  it('sends the guest id and the step to /api/suggest/steps by beacon, and nothing else', async () => {
    const api = await freshApi();
    api.postWizardStep('guest-id-1234', 'opened');
    expect(sent).toEqual([{ via: 'beacon', url: '/api/suggest/steps', body: { anonId: 'guest-id-1234', step: 'opened' } }]);
  });

  it('falls back to a keepalive fetch when the beacon is refused or missing', async () => {
    const api = await freshApi();
    beaconAccepts = false;
    api.postWizardStep('guest-id-1234', 'feeling_chosen');
    stubNavigator({ sendBeacon: undefined });
    api.postWizardStep('guest-id-1234', 'picks_requested');

    expect(sent.map((s) => [s.via, s.url, s.body.step])).toEqual([
      ['fetch', '/api/suggest/steps', 'feeling_chosen'],
      ['fetch', '/api/suggest/steps', 'picks_requested'],
    ]);
    expect(sent[0].init).toMatchObject({ method: 'POST', keepalive: true });
  });

  it('sends nothing for a browser that asks not to be tracked', async () => {
    const api = await freshApi();
    stubNavigator({ globalPrivacyControl: true });
    api.postWizardStep('guest-id-1234', 'opened');
    stubNavigator({ doNotTrack: '1' });
    api.postWizardStep('guest-id-1234', 'opened');
    expect(sent).toEqual([]);
  });

  it('never throws, whatever the browser does', async () => {
    const api = await freshApi();
    stubNavigator({
      sendBeacon: () => {
        throw new Error('beacon blocked');
      },
    });
    expect(() => api.postWizardStep('guest-id-1234', 'opened')).not.toThrow();

    stubNavigator({ sendBeacon: undefined });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    expect(() => api.postWizardStep('guest-id-1234', 'opened')).not.toThrow();
    vi.stubGlobal('fetch', () => {
      throw new Error('fetch is not a function here');
    });
    expect(() => api.postWizardStep('guest-id-1234', 'opened')).not.toThrow();
  });
});

describe('createWizardStepReporter', () => {
  it('a customer who goes straight through sends opened, feeling_chosen, picks_requested — in that order', async () => {
    const api = await freshApi();
    const steps = api.createWizardStepReporter();
    steps.opened();
    steps.feelingChosen();
    steps.picksRequested();
    expect(sent.map((s) => s.body.step)).toEqual(['opened', 'feeling_chosen', 'picks_requested']);
  });

  it("sends 'opened' once, however often the page asks (React runs effects twice in development)", async () => {
    const api = await freshApi();
    const steps = api.createWizardStepReporter();
    steps.opened();
    steps.opened();
    steps.opened();
    expect(sent.map((s) => s.body.step)).toEqual(['opened']);
  });

  it("sends 'feeling_chosen' once per visit: going Back and tapping another feeling is the same visit", async () => {
    const api = await freshApi();
    const steps = api.createWizardStepReporter();
    steps.opened();
    steps.feelingChosen();
    steps.feelingChosen();
    steps.feelingChosen();
    expect(sent.map((s) => s.body.step)).toEqual(['opened', 'feeling_chosen']);
  });

  it("sends 'picks_requested' on every press of Show my picks", async () => {
    const api = await freshApi();
    const steps = api.createWizardStepReporter();
    steps.opened();
    steps.feelingChosen();
    steps.picksRequested();
    steps.picksRequested();
    steps.picksRequested();
    expect(sent.map((s) => s.body.step)).toEqual([
      'opened',
      'feeling_chosen',
      'picks_requested',
      'picks_requested',
      'picks_requested',
    ]);
  });

  it('a new visit (the wizard coming on screen again) sends opened and feeling_chosen afresh', async () => {
    const api = await freshApi();
    const first = api.createWizardStepReporter();
    first.opened();
    first.feelingChosen();
    const second = api.createWizardStepReporter();
    second.opened();
    second.feelingChosen();
    expect(sent.map((s) => s.body.step)).toEqual(['opened', 'feeling_chosen', 'opened', 'feeling_chosen']);
  });

  it("uses the browser's stored guest id — the one a request for picks carries — across visits", async () => {
    const api = await freshApi();
    const first = api.createWizardStepReporter();
    first.opened();
    first.picksRequested();
    const second = api.createWizardStepReporter();
    second.opened();

    const stored = local.getItem('hioc.suggest.anon');
    expect(stored).toBeTruthy();
    expect(api.getAnonId()).toBe(stored);
    expect(sent.map((s) => s.body.anonId)).toEqual([stored, stored, stored]);
  });

  it('keeps one guest id for the whole visit even when storage is blocked', async () => {
    vi.stubGlobal('window', {
      get localStorage(): never {
        throw new Error('storage is blocked');
      },
    });
    const api = await freshApi();
    // The ground this stands on: with storage blocked, every getAnonId() call is a new id.
    expect(api.getAnonId()).not.toBe(api.getAnonId());

    const steps = api.createWizardStepReporter();
    steps.opened();
    steps.feelingChosen();
    steps.picksRequested();
    steps.picksRequested();
    const ids = new Set(sent.map((s) => s.body.anonId));
    expect(sent).toHaveLength(4);
    expect(ids.size).toBe(1);
  });

  it('sends a guest id the route accepts', async () => {
    const { isWizardAnonId } = await import('@/lib/suggest/wizardSteps');
    const api = await freshApi();
    api.createWizardStepReporter().opened();
    expect(isWizardAnonId(sent[0].body.anonId)).toBe(true);

    // …including the fallback made where crypto.randomUUID is unavailable.
    vi.stubGlobal('crypto', {});
    local = storage();
    vi.stubGlobal('window', { localStorage: local });
    const apiNoCrypto = await freshApi();
    apiNoCrypto.createWizardStepReporter().opened();
    expect(String(sent[1].body.anonId)).toMatch(/^anon-/);
    expect(isWizardAnonId(sent[1].body.anonId)).toBe(true);
  });

  it('sends nothing at all for a browser that asks not to be tracked', async () => {
    stubNavigator({ globalPrivacyControl: true });
    const api = await freshApi();
    const steps = api.createWizardStepReporter();
    steps.opened();
    steps.feelingChosen();
    steps.picksRequested();
    expect(sent).toEqual([]);
  });

  it('never throws into the wizard', async () => {
    const api = await freshApi();
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('fetch', () => {
      throw new Error('no network');
    });
    const steps = api.createWizardStepReporter();
    expect(() => {
      steps.opened();
      steps.feelingChosen();
      steps.picksRequested();
    }).not.toThrow();
  });

  it('leaves the session events alone: postSuggestEvent still posts to /api/suggest/events', async () => {
    const api = await freshApi();
    api.postSuggestEvent('11111111-1111-4111-8111-111111111111', 'dismissed');
    api.postSuggestEvent('11111111-1111-4111-8111-111111111111', 'added_to_cart', '22222222-2222-4222-8222-222222222222');
    expect(sent.map((s) => [s.via, s.url, s.body.event])).toEqual([
      ['beacon', '/api/suggest/events', 'dismissed'],
      ['fetch', '/api/suggest/events', 'added_to_cart'],
    ]);
  });
});
