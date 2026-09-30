import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// /staff/passes — the thin server page in front of the Ritual passes screen.
// It only decides what to OFFER (the API routes re-check every permission): the
// flag, who may sell (pass_sell AND a screen that may take orders, CP-D20), who
// may extend / give cups back (pass_manage), and the ?phone= that New order's
// "Sell a Ritual" link pre-fills.

const state: {
  flag: boolean;
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  perms: Record<string, boolean>;
  surface: 'pos' | 'web';
  webOrdering: boolean;
  actorCalls: number;
  permCalls: { key: string; role: string | undefined }[];
} = { flag: true, actor: null, perms: {}, surface: 'pos', webOrdering: false, actorCalls: 0, permCalls: [] };

vi.mock('@/lib/flags', () => ({
  flags: {
    get coffeePass() {
      return state.flag;
    },
  },
}));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => {
    state.actorCalls += 1;
    return Promise.resolve(state.actor);
  },
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: (_user: unknown, key: string, role?: string) => {
    state.permCalls.push({ key, role });
    return Promise.resolve(state.perms[key] === true);
  },
}));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve(state.surface) }));
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () => Promise.resolve({ staff_web_ordering: state.webOrdering }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/staff/passes',
}));

const { default: StaffPassesPage } = await import('@/app/staff/passes/page');
const { RitualPassesScreen } = await import('@/components/staff/passes/RitualPassesScreen');
const { ORDERING_OFF_MESSAGE } = await import('@/lib/staff/surfaceRules');

async function render(searchParams: { phone?: string | string[] } = {}) {
  return (await StaffPassesPage({ searchParams })) as unknown as {
    type: unknown;
    props: Record<string, unknown>;
  };
}

beforeEach(() => {
  state.flag = true;
  state.actor = { user: { id: 'u1' }, role: 'staff', via: 'session' };
  state.perms = { pass_sell: true, pass_manage: false };
  state.surface = 'pos';
  state.webOrdering = false;
  state.actorCalls = 0;
  state.permCalls = [];
});

describe('/staff/passes', () => {
  it('says the Ritual is not switched on while the flag is off, and asks nothing else', async () => {
    state.flag = false;
    const page = await StaffPassesPage({ searchParams: {} });
    const html = renderToStaticMarkup(page as never);
    expect(html).toContain('HIOC Ritual is not switched on');
    expect(state.actorCalls).toBe(0);
  });

  it('renders the Ritual passes screen for a counter actor', async () => {
    const page = await render();
    expect(page.type).toBe(RitualPassesScreen);
  });

  it('lets a plain staffer sell but not manage (pass_sell default staff, pass_manage default manager)', async () => {
    const { props } = await render();
    expect(props.canSell).toBe(true);
    expect(props.canManage).toBe(false);
    expect(props.sellBlockedMessage).toBeNull();
  });

  it('lets a manager extend and give cups back', async () => {
    state.actor = { user: { id: 'm1' }, role: 'manager', via: 'session' };
    state.perms = { pass_sell: true, pass_manage: true };
    expect((await render()).props.canManage).toBe(true);
  });

  it('asks about the role the actor already carries, so an enrolled-device PIN operator works too', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'manager', via: 'device' };
    await render();
    expect(state.permCalls).toEqual(
      expect.arrayContaining([
        { key: 'pass_sell', role: 'manager' },
        { key: 'pass_manage', role: 'manager' },
      ]),
    );
  });

  it('refuses to offer Sell without the pass_sell permission, and says so', async () => {
    state.perms = { pass_sell: false, pass_manage: false };
    const { props } = await render();
    expect(props.canSell).toBe(false);
    expect(String(props.sellBlockedMessage)).toMatch(/permission to sell HIOC Ritual/);
  });

  it('refuses to offer Sell on the staff website while web ordering is off (CP-D20)', async () => {
    state.surface = 'web';
    state.webOrdering = false;
    const { props } = await render();
    expect(props.canSell).toBe(false);
    expect(props.sellBlockedMessage).toBe(ORDERING_OFF_MESSAGE);
  });

  it('offers Sell on the staff website once web ordering is switched on', async () => {
    state.surface = 'web';
    state.webOrdering = true;
    expect((await render()).props.canSell).toBe(true);
  });

  it('offers nothing when no counter actor can be resolved (the layout guarantees one; the API re-checks)', async () => {
    state.actor = null;
    const { props } = await render();
    expect(props.canSell).toBe(false);
    expect(props.canManage).toBe(false);
  });

  it.each([
    [{ phone: '9876543210' }, '9876543210'],
    [{ phone: '+91 98765 43210' }, '9876543210'],
    [{ phone: ['9876543210', '9000000000'] }, '9876543210'],
    [{ phone: 'nope' }, ''],
    [{}, ''],
  ])('pre-fills the phone from ?phone= (%j)', async (searchParams, expected) => {
    expect((await render(searchParams)).props.initialPhone).toBe(expected);
  });
});
