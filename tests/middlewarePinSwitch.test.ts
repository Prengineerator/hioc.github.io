import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// PIN-2/3 — middleware.ts's one new branch: a session-less request to
// /staff/** may reach the shell when the flag is on AND an enrolled-device
// cookie is present, so the lock screen can render. Every other property of
// the existing gate (owner routes, the flag off, no cookie, a real session)
// must be byte-identical to before.

const state: { pinSwitch: boolean } = { pinSwitch: true };

vi.mock('@/lib/flags', () => ({
  flags: {
    get pinSwitch() {
      return state.pinSwitch;
    },
  },
}));

// No session, ever, in this file — @supabase/ssr's getUser() always answers
// null so every case here exercises the "!user" branch the new code lives in.
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
  }),
}));

const { middleware } = await import('@/middleware');

beforeEach(() => {
  state.pinSwitch = true;
});

function reqTo(path: string, opts?: { deviceCookie?: string; host?: string }) {
  const url = `https://${opts?.host ?? 'hioc.in'}${path}`;
  const request = new NextRequest(url);
  if (opts?.deviceCookie) request.cookies.set('hioc_device', opts.deviceCookie);
  return request;
}

describe('middleware — PIN-2/3 session-less staff shell', () => {
  it('lets a session-less /staff request through when flag on + device cookie present', async () => {
    const res = await middleware(reqTo('/staff', { deviceCookie: 'sometoken' }));
    expect(res.status).not.toBe(307); // not a redirect
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects to login with no device cookie, flag on', async () => {
    const res = await middleware(reqTo('/staff'));
    expect(res.headers.get('location')).toContain('/staff/login');
  });

  it('redirects to login with a device cookie but the flag OFF — no behaviour change when dark', async () => {
    state.pinSwitch = false;
    const res = await middleware(reqTo('/staff', { deviceCookie: 'sometoken' }));
    expect(res.headers.get('location')).toContain('/staff/login');
  });

  it('NEVER lets a session-less /owner request through, even with the flag on and a device cookie', async () => {
    const res = await middleware(reqTo('/owner', { deviceCookie: 'sometoken' }));
    expect(res.headers.get('location')).toContain('/owner/login');
  });

  it('still lets /staff/login itself through with no session at all', async () => {
    const res = await middleware(reqTo('/staff/login'));
    expect(res.headers.get('location')).toBeNull();
  });
});
