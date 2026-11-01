import { describe, expect, it } from 'vitest';
// The same compiler `next build` runs over middleware.ts's config: its output
// is the regexp written to the middleware manifest, which is what both
// `next start` and Vercel match incoming paths against.
import { getMiddlewareMatchers } from 'next/dist/build/analysis/get-page-static-info';
import { config } from '@/middleware';

// Every middleware run is a Vercel function invocation. The matcher must keep
// it off the paths where it does nothing (API routes, Next and Vercel
// internals), and must never let a back-office path skip the auth gate.

const matchers = getMiddlewareMatchers(config.matcher, {} as never);

function runsOn(pathname: string): boolean {
  return matchers.some((m) => new RegExp(m.regexp).test(pathname));
}

describe('middleware matcher', () => {
  it.each([
    '/api/orders',
    '/api/orders/0b8c/status',
    '/api/store-settings',
    '/api/menu',
    '/api/cron/feedback-requests',
    '/_next/static/chunks/main.js',
    '/_next/image',
    '/_vercel/insights/view',
    '/images/logo-black.png',
    '/fonts/x.woff2',
    '/favicon.ico',
  ])('skips %s', (path) => {
    expect(runsOn(path)).toBe(false);
  });

  it.each([
    // The auth gate: every back-office path, including dotted ones.
    '/staff',
    '/staff/orders/new',
    '/staff/login',
    '/owner',
    '/owner/reports',
    '/owner/feedback/x.png',
    '/staff/anything.json',
    // Subdomain rewrites: staff.hioc.in/orders arrives as /orders.
    '/',
    '/orders',
    '/orders/new',
    '/staff-print/0b8c/kot',
    // x-pathname for the account layout's login redirect.
    '/account/orders',
    // Customer pages, and paths that merely start with "api".
    '/menu',
    '/apiary',
  ])('runs on %s', (path) => {
    expect(runsOn(path)).toBe(true);
  });
});
