import { describe, expect, it } from 'vitest';
import { isSessionId, parseTrafficAttribution, validateTrafficView } from '@/lib/traffic/validate';
import { EMPTY_UTM } from '@/lib/traffic/types';

// First-party traffic tracking: what POST /api/traffic and the checkout
// routes accept from the browser.

const SID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('isSessionId', () => {
  it('accepts 8–64 URL-safe characters only', () => {
    expect(isSessionId(SID)).toBe(true);
    expect(isSessionId('abc_DEF-12')).toBe(true);
    expect(isSessionId('short')).toBe(false);
    expect(isSessionId('x'.repeat(65))).toBe(false);
    expect(isSessionId('has space here')).toBe(false);
    expect(isSessionId(12345678)).toBe(false);
  });
});

describe('validateTrafficView', () => {
  it('cleans a full view', () => {
    const v = validateTrafficView({
      sid: SID,
      route: '/shop',
      landing: true,
      referrer: 'https://l.instagram.com/x',
      utm_source: 'Instagram',
      utm_medium: 'Bio',
      utm_campaign: null,
    });
    expect(v).toEqual({
      sid: SID,
      route: '/shop',
      landing: true,
      referrer: 'l.instagram.com',
      utm: { ...EMPTY_UTM, utm_source: 'instagram', utm_medium: 'bio' },
    });
  });

  it('defaults landing to false and an unusable referrer to null', () => {
    const v = validateTrafficView({ sid: SID, route: '/menu', referrer: '!!' });
    expect(v).toMatchObject({ landing: false, referrer: null });
  });

  it('refuses a bad id, an untracked route or a non-boolean landing', () => {
    expect(validateTrafficView({ sid: 'x', route: '/menu' })).toMatch(/sid/);
    expect(validateTrafficView({ sid: SID, route: '/order/7a1f0c3e' })).toMatch(/route/);
    expect(validateTrafficView({ sid: SID, route: '/staff' })).toMatch(/route/);
    expect(validateTrafficView({ sid: SID, route: '/menu', landing: 'yes' })).toMatch(/landing/);
  });
});

describe('parseTrafficAttribution (orders)', () => {
  it('reads the visit an order carries', () => {
    expect(parseTrafficAttribution({ sid: SID, referrer: 'google.com', utm_source: 'gbp' })).toEqual({
      sid: SID,
      referrer: 'google.com',
      utm: { ...EMPTY_UTM, utm_source: 'gbp' },
    });
  });

  it('is null, never an error, for anything unusable', () => {
    expect(parseTrafficAttribution(undefined)).toBeNull();
    expect(parseTrafficAttribution('sid')).toBeNull();
    expect(parseTrafficAttribution([SID])).toBeNull();
    expect(parseTrafficAttribution({ sid: 'bad' })).toBeNull();
  });
});
