import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/auth/logout — root cause of "signing out in Chrome kills the
// Electron app's session": supabase-js's signOut() defaults to scope
// 'global', which revokes every refresh token the user holds on every
// device. Logins must be independent per device (owner request, Phase 7),
// so this route must ask for scope: 'local' — this session/cookie only.

const state: {
  user: { id: string } | null;
  signOutCalls: Array<{ scope?: string } | undefined>;
} = { user: null, signOutCalls: [] };

vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => Promise.resolve(state.user),
}));

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({
    auth: {
      signOut: async (options?: { scope?: string }) => {
        state.signOutCalls.push(options);
        return { error: null };
      },
    },
  }),
}));

const { POST } = await import('@/app/api/auth/logout/route');

beforeEach(() => {
  state.user = null;
  state.signOutCalls = [];
});

describe('POST /api/auth/logout', () => {
  it('401s with no session, and never calls signOut', async () => {
    const res = await POST();
    expect(res.status).toBe(401);
    expect(state.signOutCalls).toHaveLength(0);
  });

  it('signs out an authenticated session with LOCAL scope only', async () => {
    state.user = { id: 'u1' };
    const res = await POST();
    expect(res.status).toBe(200);
    expect(state.signOutCalls).toHaveLength(1);
    // THE FIX: not the default ('global', which revokes every device's
    // refresh tokens) — signing out in Chrome must never sign out the
    // Electron POS app on the counter, and vice versa.
    expect(state.signOutCalls[0]).toEqual({ scope: 'local' });
  });
});
