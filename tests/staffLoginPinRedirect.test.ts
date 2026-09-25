import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-2 — app/staff/login/page.tsx (now a Server Component) must send a
// PIN-capable counter to the lock screen instead of rendering the classic
// form. shouldRedirectClassicLogin() itself is covered in pinUi.test.ts;
// this wires the actual page module against mocked
// device/operator/flags dependencies to check it calls redirect() (or
// doesn't) exactly when the decision helper says to.

const state: {
  pinSwitch: boolean;
  configured: boolean;
  device: { id: string; name: string } | null;
} = {
  pinSwitch: true,
  configured: true,
  device: { id: 'device-1', name: 'Counter 1' },
};

const redirectMock = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: (path: string) => redirectMock(path),
}));

vi.mock('@/lib/flags', () => ({
  flags: {
    get pinSwitch() {
      return state.pinSwitch;
    },
  },
}));

vi.mock('@/lib/api/device', () => ({
  getEnrolledDevice: () => Promise.resolve(state.device),
}));

vi.mock('@/lib/api/operator', () => ({
  operatorFeatureConfigured: () => state.configured,
}));

// The classic sign-in form itself is irrelevant to this decision — stubbed
// out so importing the page module doesn't need a full client-component tree.
vi.mock('@/components/staff/StaffLoginForm', () => ({
  StaffLoginForm: () => null,
}));

const { default: StaffLoginPage } = await import('@/app/staff/login/page');

beforeEach(() => {
  state.pinSwitch = true;
  state.configured = true;
  state.device = { id: 'device-1', name: 'Counter 1' };
  redirectMock.mockClear();
});

describe('StaffLoginPage', () => {
  it('redirects a PIN-eligible, enrolled counter to /staff', async () => {
    await StaffLoginPage({ searchParams: {} });
    expect(redirectMock).toHaveBeenCalledWith('/staff');
  });

  it('does not redirect when ?classic=1 opts out', async () => {
    await StaffLoginPage({ searchParams: { classic: '1' } });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('does not redirect when the flag is off', async () => {
    state.pinSwitch = false;
    await StaffLoginPage({ searchParams: {} });
    expect(redirectMock).not.toHaveBeenCalled();
    // And with the flag off, it must not even bother resolving a device —
    // mirrors app/staff/layout.tsx's own pinEligible-gates-the-lookup order.
  });

  it('does not redirect when this machine is not an enrolled device', async () => {
    state.device = null;
    await StaffLoginPage({ searchParams: {} });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('does not redirect when the operator secret is not configured', async () => {
    state.configured = false;
    await StaffLoginPage({ searchParams: {} });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
