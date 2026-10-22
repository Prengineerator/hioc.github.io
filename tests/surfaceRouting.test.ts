import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  surfaceForHost,
  rewriteForSurface,
  hrefForSurface,
  isHostAgnostic,
  surfaceOfPath,
  surfaceOrigin,
} from '@/lib/routing/surface';

describe('surfaceForHost', () => {
  it('classifies the subdomains', () => {
    expect(surfaceForHost('staff.hioc.in')).toBe('staff');
    expect(surfaceForHost('owner.hioc.in')).toBe('owner');
  });

  it('treats the apex and www as the main site', () => {
    expect(surfaceForHost('hioc.in')).toBe('main');
    expect(surfaceForHost('www.hioc.in')).toBe('main');
  });

  it('matches only the leftmost label — a lookalike host is NOT the staff surface', () => {
    // Getting this wrong would serve the staff portal at a domain someone else
    // could register under a wildcard, or double-prefix every link.
    expect(surfaceForHost('mystaff.hioc.in')).toBe('main');
    expect(surfaceForHost('staffing.hioc.in')).toBe('main');
    expect(surfaceForHost('hioc.in.staff.evil.com')).toBe('main');
  });

  it('ignores case and port', () => {
    expect(surfaceForHost('STAFF.hioc.in')).toBe('staff');
    expect(surfaceForHost('staff.localhost:3001')).toBe('staff');
  });

  it('is main for a missing host rather than throwing', () => {
    expect(surfaceForHost(null)).toBe('main');
    expect(surfaceForHost(undefined)).toBe('main');
    expect(surfaceForHost('')).toBe('main');
  });

  it('recognises the Vercel preview alias shape', () => {
    expect(surfaceForHost('hioc-abc123-hioc.vercel.app')).toBe('main');
  });
});

describe('rewriteForSurface', () => {
  it('prefixes a subdomain path so existing routes keep matching', () => {
    expect(rewriteForSurface('staff', '/orders')).toBe('/staff/orders');
    expect(rewriteForSurface('owner', '/payroll')).toBe('/owner/payroll');
  });

  it('maps the subdomain root onto the surface root', () => {
    expect(rewriteForSurface('staff', '/')).toBe('/staff');
    expect(rewriteForSurface('owner', '/')).toBe('/owner');
  });

  it('does NOT double-prefix an already-canonical path', () => {
    // A link written /staff/orders and clicked while on staff.hioc.in must not
    // become /staff/staff/orders.
    expect(rewriteForSurface('staff', '/staff/orders')).toBeNull();
    expect(rewriteForSurface('staff', '/staff')).toBeNull();
  });

  it('leaves the main domain alone', () => {
    expect(rewriteForSurface('main', '/staff/orders')).toBeNull();
    expect(rewriteForSurface('main', '/')).toBeNull();
  });

  it('never rewrites API routes — /api/orders is the same on every host', () => {
    expect(rewriteForSurface('staff', '/api/orders')).toBeNull();
    expect(rewriteForSurface('owner', '/api/owner/payroll')).toBeNull();
  });

  it('never rewrites Next internals or static assets', () => {
    expect(rewriteForSurface('staff', '/_next/static/chunk.js')).toBeNull();
    expect(rewriteForSurface('staff', '/images/logo-black.png')).toBeNull();
    expect(rewriteForSurface('staff', '/favicon.ico')).toBeNull();
  });

  it('does not swallow a path that merely starts with the prefix letters', () => {
    // /stafffoo is not under /staff.
    expect(rewriteForSurface('staff', '/stafffoo')).toBe('/staff/stafffoo');
  });

  it('serves the ticket page as it is on the staff host', () => {
    // The desktop POS prints staff.hioc.in/staff-print/<id>/<type> in system +
    // driver mode; rewritten to /staff/staff-print/... it printed a 404 page.
    expect(rewriteForSurface('staff', '/staff-print/abc/kot')).toBeNull();
    expect(rewriteForSurface('staff', '/staff-print')).toBeNull();
    // Only the staff surface owns it.
    expect(rewriteForSurface('owner', '/staff-print/abc/kot')).toBe('/owner/staff-print/abc/kot');
  });
});

describe('surfaceOfPath', () => {
  it('places each canonical path on its surface', () => {
    expect(surfaceOfPath('/staff')).toBe('staff');
    expect(surfaceOfPath('/staff/orders/new')).toBe('staff');
    expect(surfaceOfPath('/staff-print/1/kot')).toBe('staff');
    expect(surfaceOfPath('/owner')).toBe('owner');
    expect(surfaceOfPath('/owner/payroll')).toBe('owner');
    expect(surfaceOfPath('/')).toBe('main');
    expect(surfaceOfPath('/menu')).toBe('main');
    expect(surfaceOfPath('/login')).toBe('main');
  });

  it('does not claim a path that merely starts with the prefix letters', () => {
    expect(surfaceOfPath('/staffing')).toBe('main');
    expect(surfaceOfPath('/ownership')).toBe('main');
  });

  it('gives host-agnostic paths to no surface', () => {
    expect(surfaceOfPath('/api/orders')).toBeNull();
    expect(surfaceOfPath('/_next/static/x.js')).toBeNull();
    expect(surfaceOfPath('/pos.webmanifest')).toBeNull();
  });
});

describe('surfaceOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the production hosts', () => {
    expect(surfaceOrigin('main')).toBe('https://hioc.in');
    expect(surfaceOrigin('staff')).toBe('https://staff.hioc.in');
    expect(surfaceOrigin('owner')).toBe('https://owner.hioc.in');
  });

  it('takes an override, without its trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_STAFF_ORIGIN', 'http://staff.localhost:3001/');
    expect(surfaceOrigin('staff')).toBe('http://staff.localhost:3001');
    expect(hrefForSurface('owner', '/staff/orders')).toBe('http://staff.localhost:3001/orders');
  });
});

describe('isHostAgnostic', () => {
  it('spots assets by extension', () => {
    expect(isHostAgnostic('/robots.txt')).toBe(true);
    expect(isHostAgnostic('/some/logo.png')).toBe(true);
  });

  it('treats ordinary routes as rewritable', () => {
    expect(isHostAgnostic('/orders')).toBe(false);
    expect(isHostAgnostic('/attendance')).toBe(false);
  });
});

describe('hrefForSurface', () => {
  it('strips the prefix when the link points at the surface we are on', () => {
    expect(hrefForSurface('staff', '/staff/orders/new')).toBe('/orders/new');
    expect(hrefForSurface('owner', '/owner/payroll')).toBe('/payroll');
  });

  it('maps the surface root to /', () => {
    expect(hrefForSurface('staff', '/staff')).toBe('/');
    expect(hrefForSurface('owner', '/owner')).toBe('/');
  });

  it('sends CROSS-surface links to the other host — a relative one is prefixed here', () => {
    // These used to stay relative, and relative resolves on the CURRENT host:
    // owner.hioc.in/staff became /owner/staff (the owner Team page, not the
    // staff board) and owner.hioc.in/staff/login became /owner/staff/login (404).
    expect(hrefForSurface('owner', '/staff')).toBe('https://staff.hioc.in/');
    expect(hrefForSurface('owner', '/staff/login')).toBe('https://staff.hioc.in/login');
    expect(hrefForSurface('owner', '/staff/login?next=/staff')).toBe(
      'https://staff.hioc.in/login?next=/staff',
    );
    expect(hrefForSurface('staff', '/owner/attendance')).toBe('https://owner.hioc.in/attendance');
  });

  it('sends customer paths from a subdomain to the main site', () => {
    expect(hrefForSurface('staff', '/menu')).toBe('https://hioc.in/menu');
    expect(hrefForSurface('staff', '/privacy')).toBe('https://hioc.in/privacy');
    expect(hrefForSurface('owner', '/order/abc')).toBe('https://hioc.in/order/abc');
  });

  it('keeps the ticket page on the staff host as it is', () => {
    expect(hrefForSurface('staff', '/staff-print/abc/kot?silent=1')).toBe(
      '/staff-print/abc/kot?silent=1',
    );
    expect(hrefForSurface('owner', '/staff-print/abc/kot')).toBe(
      'https://staff.hioc.in/staff-print/abc/kot',
    );
  });

  it('leaves anything that is not an app page alone', () => {
    for (const href of ['/api/orders', '/images/logo-black.png', '#top', '?tab=x', 'https://example.com/x', '//evil.com/x']) {
      expect(hrefForSurface('staff', href)).toBe(href);
      expect(hrefForSurface('owner', href)).toBe(href);
    }
  });

  it('is a no-op on the main domain', () => {
    expect(hrefForSurface('main', '/staff/orders')).toBe('/staff/orders');
  });

  it('round-trips with rewriteForSurface', () => {
    // What a link renders as, rewritten back, must be the canonical path —
    // otherwise a click lands somewhere other than the link said.
    for (const p of ['/staff/orders', '/staff/attendance', '/staff']) {
      const rendered = hrefForSurface('staff', p);
      const resolved = rewriteForSurface('staff', rendered) ?? rendered;
      expect(resolved).toBe(p);
    }
  });
});
