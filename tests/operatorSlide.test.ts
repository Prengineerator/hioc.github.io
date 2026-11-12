import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { signOperatorToken, verifyOperatorToken, OPERATOR_COOKIE_MAX_AGE_S } from '@/lib/api/operatorCookie';

// PIN-3: where the operator cookie's 12h expiry is allowed to slide.
//
// Next 14 makes cookies read-only during a Server Component render, and
// cookies().set() there throws "Cookies can only be modified in a Server
// Action or Route Handler". app/staff/layout.tsx and several staff pages
// resolve the counter actor while rendering. Each of those renders used to
// try the slide, throw, and log the error (Vercel, /staff and /staff.rsc,
// since 2026-09-25). Now:
//   - a render resolves with { slide: false }: same checks, no cookie write;
//   - a Route Handler resolves with the default and slides the cookie, but
//     only for a token that has just passed every device+operator check.
//
// The cookies() mock below behaves like Next's: in 'render' mode set() throws
// the production error, in 'route' mode it records the write.

const SECRET = 'x'.repeat(40);
const SLIDE_ERROR = 'resolveOperatorActor: could not slide the operator cookie';

const state: {
  cookieMode: 'render' | 'route';
  operatorCookie: string | undefined;
  device: { id: string; name: string } | null;
  profileRole: string | null;
  authUser: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null;
  setAttempts: { name: string; value: string; options: Record<string, unknown> }[];
} = {
  cookieMode: 'render',
  operatorCookie: undefined,
  device: null,
  profileRole: null,
  authUser: null,
  setAttempts: [],
};

vi.mock('next/headers', () => ({
  headers: () => new Headers({ 'x-pathname': '/staff' }),
  cookies: () => ({
    get: (name: string) => (name === 'hioc_operator' && state.operatorCookie ? { value: state.operatorCookie } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      state.setAttempts.push({ name, value, options });
      if (state.cookieMode === 'render') {
        // Next 14's ReadonlyRequestCookiesError, word for word.
        throw new Error(
          'Cookies can only be modified in a Server Action or Route Handler. Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#cookiessetname-value-options',
        );
      }
    },
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

vi.mock('@/lib/flags', () => ({
  flags: { pinSwitch: true, cashDayGate: false, staffPos: true },
}));

// No classic session anywhere in this file: every case exercises the
// enrolled-device + operator-cookie path, the only one that slides.
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
  }),
  createAdminSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.profileRole ? { role: state.profileRole } : null, error: null }),
        }),
      }),
    }),
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: state.authUser }, error: null }) } },
  }),
}));

vi.mock('@/lib/api/device', () => ({
  getEnrolledDevice: () => Promise.resolve(state.device),
  touchDeviceSeen: () => Promise.resolve(),
}));

// The layout's other reads and its client components are irrelevant here.
// They are stubbed so importing the real layout module needs no browser tree.
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));
vi.mock('@/lib/store/settings', () => ({ getStoreSettings: () => Promise.resolve({ staff_web_ordering: false }) }));
vi.mock('@/lib/cash/dayServer', () => ({ cashDayGateState: () => Promise.resolve(null) }));
vi.mock('@/components/staff/StaffHeader', () => ({ StaffHeader: () => null }));
vi.mock('@/components/staff/StaffShell', () => ({ StaffShell: () => null }));
vi.mock('@/components/staff/PosShortcuts', () => ({ PosShortcuts: () => null }));
vi.mock('@/components/staff/pin/StaffPinOverlay', () => ({ StaffPinOverlay: () => null }));
vi.mock('@/components/staff/pin/LockScreen', () => ({ LockScreen: () => null }));
vi.mock('@/components/staff/CashDayGate', () => ({ CashDayGate: () => null }));

process.env.OPERATOR_JWT_SECRET = SECRET;

const { getCounterActor } = await import('@/lib/api/auth');
const { default: StaffLayout } = await import('@/app/staff/layout');
const { GET: deviceContextGET } = await import('@/app/api/device/context/route');

const nowS = () => Math.floor(Date.now() / 1000);
let errorSpy: ReturnType<typeof vi.spyOn>;

function slideErrors() {
  return errorSpy.mock.calls.filter((args: unknown[]) => args[0] === SLIDE_ERROR);
}

beforeEach(() => {
  process.env.OPERATOR_JWT_SECRET = SECRET;
  state.cookieMode = 'render';
  // Issued an hour ago, so a slide's fresh iat is observably newer.
  state.operatorCookie = signOperatorToken({ op: 'u1', dev: 'device-1', iat: nowS() - 3600 }, SECRET);
  state.device = { id: 'device-1', name: 'Counter 1' };
  state.profileRole = 'staff';
  state.authUser = { id: 'u1', email: 'ravi@example.com', user_metadata: { full_name: 'Ravi' } };
  state.setAttempts = [];
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('render-time resolve (Server Components)', () => {
  it('the harness reproduces the production error when a render tries to slide', async () => {
    // What app/staff/layout.tsx used to do: the default (sliding) call
    // from a render. Resolves, but the write throws and is logged, which is
    // the Vercel error. Pins that the mock really behaves like Next.
    const actor = await getCounterActor();
    expect(actor?.via).toBe('device');
    expect(state.setAttempts).toHaveLength(1);
    expect(slideErrors()).toHaveLength(1);
  });

  it('getCounterActor({ slide: false }) resolves the operator without touching cookies().set', async () => {
    const actor = await getCounterActor({ slide: false });
    expect(actor).toMatchObject({ user: { id: 'u1' }, role: 'staff', via: 'device' });
    expect(state.setAttempts).toEqual([]);
    expect(slideErrors()).toEqual([]);
  });

  it('rendering the real /staff layout for an unlocked counter never attempts a cookie write', async () => {
    const tree = await StaffLayout({ children: null });
    expect(tree).toBeTruthy(); // rendered the shell, did not redirect
    expect(state.setAttempts).toEqual([]);
    expect(slideErrors()).toEqual([]);
  });

  it('keeps every device+operator check when not sliding: a demoted operator still resolves to null', async () => {
    state.profileRole = 'customer';
    expect(await getCounterActor({ slide: false })).toBeNull();
  });

  it('keeps the D6-6 owner cap when not sliding', async () => {
    state.profileRole = 'owner';
    const actor = await getCounterActor({ slide: false });
    expect(actor?.role).toBe('manager');
  });
});

describe('Route Handler resolve: the slide still happens', () => {
  beforeEach(() => {
    state.cookieMode = 'route';
  });

  it('GET /api/device/context slides the operator cookie: same op/dev, fresh iat, 12h', async () => {
    const before = nowS();
    const res = await deviceContextGET();
    expect(res.status).toBe(200);

    expect(state.setAttempts).toHaveLength(1);
    const [write] = state.setAttempts;
    expect(write.name).toBe('hioc_operator');
    expect(write.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: OPERATOR_COOKIE_MAX_AGE_S });

    const payload = verifyOperatorToken(write.value, SECRET);
    expect(payload).toMatchObject({ op: 'u1', dev: 'device-1' });
    expect(payload!.iat).toBeGreaterThanOrEqual(before);
    expect(slideErrors()).toEqual([]);
  });

  it('never slides a token that fails the device check', async () => {
    state.device = { id: 'device-OTHER', name: 'Counter 2' };
    const res = await deviceContextGET();
    expect(res.status).toBe(401);
    expect(state.setAttempts).toEqual([]);
  });

  it('never slides a token whose operator lost their staff role', async () => {
    state.profileRole = 'customer';
    const res = await deviceContextGET();
    expect(res.status).toBe(401);
    expect(state.setAttempts).toEqual([]);
  });
});

// Static check: every Server Component that resolves the counter actor must
// pass { slide: false }, and no Route Handler may (a route that did would
// silently stop sliding). Uses the TypeScript AST so comments that mention
// getCounterActor() don't count as calls.
describe('call sites', () => {
  const ROOT = path.resolve(__dirname, '..');
  const RESOLVERS = new Set(['getCounterActor', 'getCounterManager']);

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  function passesSlideFalse(call: ts.CallExpression): boolean {
    const [arg] = call.arguments;
    if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
    return arg.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === 'slide' &&
        p.initializer.kind === ts.SyntaxKind.FalseKeyword,
    );
  }

  function resolverCalls(file: string): { line: number; slideFalse: boolean }[] {
    const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: { line: number; slideFalse: boolean }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && RESOLVERS.has(node.expression.text)) {
        found.push({
          line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          slideFalse: passesSlideFalse(node),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
    return found;
  }

  const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'components'))];
  const isRouteHandler = (f: string) => /^route\.tsx?$/.test(path.basename(f));
  const rel = (f: string) => path.relative(ROOT, f);

  it('every page/layout call passes { slide: false }', () => {
    const renderCalls = files
      .filter((f) => !isRouteHandler(f))
      .flatMap((f) => resolverCalls(f).map((c) => ({ ...c, file: rel(f) })));

    // Not vacuous: the layout and the pages that resolve an actor are found.
    expect(renderCalls.map((c) => c.file)).toContain('app/staff/layout.tsx');
    expect(renderCalls.length).toBeGreaterThanOrEqual(9);

    const missing = renderCalls.filter((c) => !c.slideFalse).map((c) => `${c.file}:${c.line}`);
    expect(missing, 'render-time callers must pass { slide: false }').toEqual([]);
  });

  it('no Route Handler passes { slide: false }', () => {
    const routeCalls = files
      .filter(isRouteHandler)
      .flatMap((f) => resolverCalls(f).map((c) => ({ ...c, file: rel(f) })));

    expect(routeCalls.length).toBeGreaterThan(0);
    const optedOut = routeCalls.filter((c) => c.slideFalse).map((c) => `${c.file}:${c.line}`);
    expect(optedOut, 'Route Handlers must keep sliding the operator cookie').toEqual([]);
  });
});
