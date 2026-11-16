import { describe, expect, it } from 'vitest';
import {
  classifySource,
  cleanUtm,
  cleanUtmValue,
  deviceFromUserAgent,
  isBotUserAgent,
  isOwnHost,
  normalizeHost,
  routeForPath,
} from '@/lib/traffic/classify';
import { EMPTY_UTM, type Utm } from '@/lib/traffic/types';

// First-party traffic tracking (docs/TRAFFIC-TRACKING.md): which pages are
// tracked, and how a linking site or a utm tag becomes a source.

const utm = (over: Partial<Utm>): Utm => ({ ...EMPTY_UTM, ...over });

describe('routeForPath', () => {
  it.each([
    ['/menu', '/menu', 'orders'],
    ['/menu/', '/menu', 'orders'],
    ['/checkout', '/checkout', 'orders'],
    ['/t/abcDEF123', '/t/[token]', 'orders'],
    ['/order/7a1f0c3e-1111-4111-8111-111111111111', '/order/[id]', 'orders'],
    ['/order/7a1f0c3e/receipt', '/order/[id]/receipt', 'orders'],
    ['/order/7a1f0c3e/review', '/order/[id]/review', 'orders'],
    ['/order-confirmation/abc', '/order-confirmation/[orderId]', 'orders'],
    ['/account/orders', '/account/orders', 'orders'],
    ['/shop', '/shop', 'shop'],
    ['/shop/order/abc', '/shop/order/[id]', 'shop'],
  ])('%s → %s', (path, route, group) => {
    expect(routeForPath(path)).toEqual({ route, group });
  });

  it.each(['/', '/about', '/staff', '/staff/orders', '/orders', '/owner/traffic', '/order', '/shop/order', '/account', '/t'])(
    'does not track %s',
    (path) => {
      expect(routeForPath(path)).toBeNull();
    },
  );

  it('never lets an id or a QR token through: only the pattern comes back', () => {
    const r = routeForPath('/t/SECRET-QR-TOKEN');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});

describe('normalizeHost', () => {
  it.each([
    ['https://l.instagram.com/?u=https%3A%2F%2Fhioc.in', 'l.instagram.com'],
    ['https://www.google.com/', 'google.com'],
    ['http://Example.COM:8080/path', 'example.com'],
    ['android-app://com.google.android.gm/', 'com.google.android.gm'],
    ['m.facebook.com', 'm.facebook.com'],
  ])('%s → %s', (raw, host) => {
    expect(normalizeHost(raw)).toBe(host);
  });

  it.each(['', '   ', 'not a host!', 'http://', 'a..b', null, 42, {}])('rejects %j', (raw) => {
    expect(normalizeHost(raw)).toBeNull();
  });
});

describe('isOwnHost', () => {
  it('treats hioc.in and its subdomains as our own site', () => {
    expect(isOwnHost('hioc.in')).toBe(true);
    expect(isOwnHost('staff.hioc.in')).toBe(true);
    expect(isOwnHost('nothioc.in')).toBe(false);
    expect(isOwnHost('localhost', 'localhost:3001')).toBe(true);
    expect(isOwnHost(null)).toBe(false);
  });
});

describe('cleanUtmValue / cleanUtm', () => {
  it('lower-cases, trims and collapses spaces', () => {
    expect(cleanUtmValue('  Diwali   Offer ')).toBe('diwali offer');
  });

  it('drops markup and quotes, and caps the length at 100', () => {
    expect(cleanUtmValue('<script>"x"</script>')).toBe('scriptx/script');
    expect(cleanUtmValue('a'.repeat(300))).toHaveLength(100);
  });

  it('keeps letters from any language', () => {
    expect(cleanUtmValue('दिवाली')).toBe('दिवाली');
  });

  it('turns empty or non-text into null', () => {
    expect(cleanUtmValue('   ')).toBeNull();
    expect(cleanUtmValue(5)).toBeNull();
  });

  it('reads all five tags from URLSearchParams or an object', () => {
    const fromUrl = cleanUtm(new URLSearchParams('utm_source=IG&utm_medium=bio&x=1'));
    expect(fromUrl).toEqual(utm({ utm_source: 'ig', utm_medium: 'bio' }));
    expect(cleanUtm({ utm_campaign: 'Launch' })).toEqual(utm({ utm_campaign: 'launch' }));
    expect(cleanUtm(null)).toEqual(EMPTY_UTM);
  });
});

describe('classifySource', () => {
  it('is Direct with no linking site, or from our own site', () => {
    expect(classifySource(null, EMPTY_UTM)).toBe('direct');
    expect(classifySource('hioc.in', EMPTY_UTM)).toBe('direct');
  });

  it.each([
    ['google.com', 'google'],
    ['google.co.in', 'google'],
    ['com.google.android.googlequicksearchbox', 'google'],
    ['l.instagram.com', 'instagram'],
    ['instagram.com', 'instagram'],
    ['m.facebook.com', 'facebook'],
    ['lm.facebook.com', 'facebook'],
    ['web.whatsapp.com', 'whatsapp'],
    ['wa.me', 'whatsapp'],
    ['com.google.android.gm', 'email'],
    ['mail.google.com', 'email'],
    ['outlook.live.com', 'email'],
    ['bing.com', 'other_search'],
    ['duckduckgo.com', 'other_search'],
    ['search.yahoo.com', 'other_search'],
    ['youtube.com', 'other_social'],
    ['t.co', 'other_social'],
    ['zomato.com', 'other_site'],
  ])('linking site %s → %s', (host, source) => {
    expect(classifySource(host, EMPTY_UTM)).toBe(source);
  });

  it('lets a utm_source tag win over the linking site', () => {
    expect(classifySource('google.com', utm({ utm_source: 'instagram' }))).toBe('instagram');
    expect(classifySource(null, utm({ utm_source: 'whatsapp', utm_medium: 'offer' }))).toBe('whatsapp');
  });

  it.each([
    ['ig', 'instagram'],
    ['fb', 'facebook'],
    ['wa', 'whatsapp'],
    ['gbp', 'google'],
    ['newsletter', 'email'],
    ['qr', 'print'],
    ['flyer', 'print'],
    ['jar', 'print'],
    ['youtube', 'other_social'],
    ['newspaper', 'other_campaign'],
  ])('utm_source=%s → %s', (tag, source) => {
    expect(classifySource(null, utm({ utm_source: tag }))).toBe(source);
  });

  it('ignores a medium or campaign without a source tag', () => {
    expect(classifySource('google.com', utm({ utm_medium: 'bio' }))).toBe('google');
  });
});

describe('deviceFromUserAgent / isBotUserAgent', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
  const TABLET = 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 Chrome/120 Safari/537.36';
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/120 Safari/537.36';

  it('tells phones, tablets and computers apart', () => {
    expect(deviceFromUserAgent(IPHONE)).toBe('mobile');
    expect(deviceFromUserAgent(ANDROID)).toBe('mobile');
    expect(deviceFromUserAgent(TABLET)).toBe('tablet');
    expect(deviceFromUserAgent(IPAD)).toBe('tablet');
    expect(deviceFromUserAgent(MAC)).toBe('desktop');
    expect(deviceFromUserAgent(null)).toBe('desktop');
  });

  it('spots crawlers but not people', () => {
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe(true);
    expect(isBotUserAgent('facebookexternalhit/1.1')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 HeadlessChrome/120')).toBe(true);
    expect(isBotUserAgent('')).toBe(true);
    expect(isBotUserAgent(IPHONE)).toBe(false);
    expect(isBotUserAgent(ANDROID)).toBe(false);
    // The CUBOT phone brand is a person, not a bot.
    expect(isBotUserAgent('Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36')).toBe(false);
  });
});
