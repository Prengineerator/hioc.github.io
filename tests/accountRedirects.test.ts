import { beforeEach, describe, expect, it, vi } from 'vitest';

// /rewards and /ritual lead into the account shell; the account layout 404s
// /account/ritual (not a login redirect) while the Ritual flag is off.

const state: { user: { id: string } | null; coffeePass: boolean; pathname: string | null } = {
  user: null,
  coffeePass: true,
  pathname: null,
};

class Redirected extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
class NotFound extends Error {}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
  notFound: () => {
    throw new NotFound('notFound');
  },
}));
vi.mock('next/headers', () => ({
  headers: () => ({ get: (k: string) => (k === 'x-pathname' ? state.pathname : null) }),
}));
vi.mock('@/lib/api/auth', () => ({ getAuthUser: async () => state.user }));
vi.mock('@/lib/flags', () => ({
  flags: {
    get coffeePass() {
      return state.coffeePass;
    },
  },
}));
vi.mock('@/components/account/AccountHeader', () => ({ AccountHeader: () => null }));
vi.mock('@/components/passes/RitualPage', () => ({ RitualPage: () => null }));

beforeEach(() => {
  state.user = null;
  state.coffeePass = true;
  state.pathname = null;
});

describe('account redirects', () => {
  it('/rewards redirects to /account/rewards', async () => {
    const { default: Page } = await import('@/app/rewards/page');
    expect(() => Page()).toThrow(expect.objectContaining({ to: '/account/rewards' }));
  });

  it('/ritual redirects a signed-in customer to /account/ritual', async () => {
    state.user = { id: 'u1' };
    const { default: Page } = await import('@/app/ritual/page');
    await expect(Page()).rejects.toMatchObject({ to: '/account/ritual' });
  });

  it('/ritual stays public when signed out, and 404s with the flag off', async () => {
    const { default: Page } = await import('@/app/ritual/page');
    await expect(Page()).resolves.toBeTruthy();
    state.coffeePass = false;
    await expect(Page()).rejects.toBeInstanceOf(NotFound);
  });

  it('account layout: flag off + signed out on /account/ritual is a 404, not a login redirect', async () => {
    const { default: Layout } = await import('@/app/account/layout');
    state.coffeePass = false;
    state.pathname = '/account/ritual';
    await expect(Layout({ children: null })).rejects.toBeInstanceOf(NotFound);
  });

  it('account layout: signed out goes to login with next, flag on or on other pages', async () => {
    const { default: Layout } = await import('@/app/account/layout');
    state.pathname = '/account/rewards';
    await expect(Layout({ children: null })).rejects.toMatchObject({
      to: '/login?next=%2Faccount%2Frewards',
    });
    state.coffeePass = false;
    await expect(Layout({ children: null })).rejects.toMatchObject({
      to: '/login?next=%2Faccount%2Frewards',
    });
  });
});
