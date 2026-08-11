import { describe, expect, it } from 'vitest';
import {
  surfaceForHost,
  rewriteForSurface,
  hrefForSurface,
  isHostAgnostic,
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

  it('leaves CROSS-surface links whole — those are different sites now', () => {
    // The owner login links to /staff/login; on owner.hioc.in that must stay a
    // full path so it resolves on the main domain rather than 404ing locally.
    expect(hrefForSurface('owner', '/staff/login')).toBe('/staff/login');
    expect(hrefForSurface('staff', '/owner/attendance')).toBe('/owner/attendance');
  });

  it('leaves customer paths whole', () => {
    expect(hrefForSurface('staff', '/menu')).toBe('/menu');
    expect(hrefForSurface('staff', '/privacy')).toBe('/privacy');
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
