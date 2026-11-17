import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Privacy Policy's words about the Ask Coffey wizard steps
// (docs/COFFEY-SPEC.md §10.7): said only while Ask Coffey is on, whichever way
// traffic tracking is set, with the retention the purge enforces and a "Last
// updated" date that moves with the wording. Server-rendered; there is no DOM
// in this suite.

const state = { suggest: true, trafficTracking: true, shop: false };

vi.mock('@/lib/flags', () => ({
  flags: {
    get suggest() {
      return state.suggest;
    },
    get trafficTracking() {
      return state.trafficTracking;
    },
    get shop() {
      return state.shop;
    },
  },
}));

const { default: PrivacyPage } = await import('@/app/privacy/page');
const { COFFEY_STEPS_POLICY_UPDATED, TRAFFIC_POLICY_UPDATED, SHOP_POLICY_UPDATED, BUSINESS } = await import('@/lib/legal');

function page(): string {
  return renderToStaticMarkup(createElement(PrivacyPage))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ');
}

beforeEach(() => {
  state.suggest = true;
  state.trafficTracking = true;
  state.shop = false;
});

describe('Privacy Policy · Ask Coffey wizard steps', () => {
  it('says what is noted, what a record holds, and that nothing is recorded for a browser that asks not to be tracked', () => {
    const text = page();
    expect(text).toContain('When you use Ask Coffey');
    expect(text).toContain('that you opened it, that you chose a feeling, and each time you asked for picks');
    expect(text).toContain('holds only the step, the time and a random id that your browser keeps between visits');
    expect(text).toContain('plus your account, if you are signed in');
    expect(text).toContain('It holds none of your answers');
    expect(text).toContain('We record no step if your browser sends a Global Privacy Control or Do Not Track signal.');
  });

  it('states the 13-month retention the weekly purge enforces', () => {
    expect(page()).toContain('The Ask Coffey step records described above are deleted after 13 months.');
  });

  it('says it with traffic tracking off too, beside the plain usage-data line', () => {
    state.trafficTracking = false;
    const text = page();
    expect(text).toContain('basic, privacy-friendly analytics about how the site is used. When you use Ask Coffey');
    expect(text).toContain('The Ask Coffey step records described above are deleted after 13 months.');
    expect(text).not.toContain('Usage data about visits to our ordering and shop pages');
  });

  it('says none of it while Ask Coffey is off', () => {
    state.suggest = false;
    const text = page();
    expect(text).not.toContain('Ask Coffey');
    expect(text).not.toContain('step records');
    // The traffic wording is untouched.
    expect(text).toContain('If your browser sends a Global Privacy Control or Do Not Track signal, we record nothing.');
  });

  it('dates the page by the newest wording that is showing', () => {
    expect(page()).toContain(COFFEY_STEPS_POLICY_UPDATED);

    state.suggest = false;
    expect(page()).toContain(TRAFFIC_POLICY_UPDATED);
    expect(page()).not.toContain(COFFEY_STEPS_POLICY_UPDATED);

    state.trafficTracking = false;
    state.shop = true;
    expect(page()).toContain(SHOP_POLICY_UPDATED);

    state.shop = false;
    expect(page()).toContain(BUSINESS.lastUpdated);
    expect(page()).not.toContain(COFFEY_STEPS_POLICY_UPDATED);
  });
});
