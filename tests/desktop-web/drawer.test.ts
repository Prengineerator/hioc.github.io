import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HiocDesktopBridge, PrinterConfig } from '@/lib/desktop/bridge';

// PRN-6 — the cash drawer opens on a cash (or cash-part) settle, only inside
// the desktop app, only when a printer is wired to it, and NEVER throws into
// the payment flow — a bad drawer must not turn a paid order into an error
// screen. `getDesktopBridge()` reads `window.hiocDesktop`, which doesn't exist
// in this (node) test environment, so the bridge module is mocked directly
// rather than faking a DOM global.

const state: { bridge: HiocDesktopBridge | null } = { bridge: null };

vi.mock('@/lib/desktop/bridge', () => ({
  getDesktopBridge: () => state.bridge,
}));

// Imported after the mock is declared (vi.mock is hoisted, so this is safe
// either way, but keeping it below documents the dependency).
import { openDrawerIfCash, openDrawerManually } from '@/lib/desktop/drawer';

function printer(overrides: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    id: overrides.id ?? 'counter',
    name: overrides.name ?? 'Counter',
    connection: overrides.connection ?? { kind: 'network', host: '10.0.0.5', port: 9100 },
    paperWidthMm: overrides.paperWidthMm ?? 80,
    roles: overrides.roles ?? ['receipt'],
    copies: overrides.copies ?? {},
    cut: overrides.cut ?? true,
    drawer: overrides.drawer ?? true,
  };
}

function fakeBridge(overrides: Partial<HiocDesktopBridge> = {}): HiocDesktopBridge {
  return {
    version: '0.1.0',
    platform: 'darwin',
    printers: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      detect: vi.fn(),
      status: vi.fn(),
    },
    printRaw: vi.fn(),
    printUrl: vi.fn(),
    openDrawer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as HiocDesktopBridge;
}

const fetchMock = vi.fn();

beforeEach(() => {
  state.bridge = null;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 201 });
  vi.stubGlobal('fetch', fetchMock);
});

function drawerBridge(openDrawer = vi.fn().mockResolvedValue(undefined)): HiocDesktopBridge {
  return fakeBridge({
    printers: {
      list: vi.fn().mockResolvedValue([printer({ id: 'counter-1', drawer: true })]),
      save: vi.fn(),
      detect: vi.fn(),
      status: vi.fn(),
    },
    openDrawer,
  });
}

/** The DRW-2 log body posted for each opening, in order. */
function loggedBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === '/api/cash-drawer/opens')
    .map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);
}

describe('openDrawerIfCash', () => {
  it('does nothing in a plain browser (no bridge)', async () => {
    state.bridge = null;
    const result = await openDrawerIfCash([{ method: 'cash' }]);
    expect(result).toBeNull();
  });

  it('does nothing when no part is cash', async () => {
    const bridge = fakeBridge({
      printers: {
        list: vi.fn().mockResolvedValue([printer()]),
        save: vi.fn(),
        detect: vi.fn(),
        status: vi.fn(),
      },
    });
    state.bridge = bridge;
    const result = await openDrawerIfCash([{ method: 'upi' }, { method: 'card' }]);
    expect(result).toBeNull();
    expect(bridge.openDrawer).not.toHaveBeenCalled();
  });

  it('does nothing when the bridge exists but no printer has the drawer', async () => {
    const bridge = fakeBridge({
      printers: {
        list: vi.fn().mockResolvedValue([printer({ drawer: false })]),
        save: vi.fn(),
        detect: vi.fn(),
        status: vi.fn(),
      },
    });
    state.bridge = bridge;
    const result = await openDrawerIfCash([{ method: 'cash' }]);
    expect(result).toBeNull();
    expect(bridge.openDrawer).not.toHaveBeenCalled();
  });

  it('opens the drawer printer when a part is cash', async () => {
    const drawerPr = printer({ id: 'counter-1', drawer: true });
    const bridge = fakeBridge({
      printers: {
        list: vi.fn().mockResolvedValue([printer({ id: 'kitchen', drawer: false }), drawerPr]),
        save: vi.fn(),
        detect: vi.fn(),
        status: vi.fn(),
      },
    });
    state.bridge = bridge;
    const result = await openDrawerIfCash([{ method: 'cash' }]);
    expect(result).toBeNull();
    expect(bridge.openDrawer).toHaveBeenCalledWith('counter-1');
  });

  it('opens the drawer for a split tender containing cash', async () => {
    const drawerPr = printer({ id: 'counter-1', drawer: true });
    const bridge = fakeBridge({
      printers: {
        list: vi.fn().mockResolvedValue([drawerPr]),
        save: vi.fn(),
        detect: vi.fn(),
        status: vi.fn(),
      },
    });
    state.bridge = bridge;
    const result = await openDrawerIfCash([{ method: 'card' }, { method: 'cash' }]);
    expect(bridge.openDrawer).toHaveBeenCalledWith('counter-1');
    expect(result).toBeNull();
  });

  it('returns a message instead of throwing when the bridge rejects', async () => {
    const drawerPr = printer({ id: 'counter-1', drawer: true });
    const bridge = fakeBridge({
      printers: {
        list: vi.fn().mockResolvedValue([drawerPr]),
        save: vi.fn(),
        detect: vi.fn(),
        status: vi.fn(),
      },
      openDrawer: vi.fn().mockRejectedValue(new Error('drawer offline')),
    });
    state.bridge = bridge;
    await expect(openDrawerIfCash([{ method: 'cash' }])).resolves.toEqual(expect.stringContaining('drawer offline'));
  });

  it('returns a message instead of throwing when listing printers rejects', async () => {
    const bridge = fakeBridge({
      printers: {
        list: vi.fn().mockRejectedValue(new Error('IPC down')),
        save: vi.fn(),
        detect: vi.fn(),
        status: vi.fn(),
      },
    });
    state.bridge = bridge;
    const result = await openDrawerIfCash([{ method: 'cash' }]);
    expect(result).toEqual(expect.stringContaining('IPC down'));
  });

  it('never throws', async () => {
    const bridge = fakeBridge({
      printers: {
        list: vi.fn().mockRejectedValue('not even an Error'),
        save: vi.fn(),
        detect: vi.fn(),
        status: vi.fn(),
      },
    });
    state.bridge = bridge;
    await expect(openDrawerIfCash([{ method: 'cash' }])).resolves.toBeTypeOf('string');
  });
});

describe('DRW-2 — every opening is logged', () => {
  it('logs a cash-payment opening, with the order when there is one', async () => {
    state.bridge = drawerBridge();
    await openDrawerIfCash([{ method: 'cash' }], { orderId: 'order-1' });
    expect(loggedBodies()).toEqual([{ reason: 'cash_payment', order_id: 'order-1' }]);
  });

  it('logs a cash tap before the order exists without an order id', async () => {
    state.bridge = drawerBridge();
    await openDrawerIfCash([{ method: 'cash' }]);
    expect(loggedBodies()).toEqual([{ reason: 'cash_payment' }]);
  });

  it('logs nothing when nothing opened', async () => {
    state.bridge = null;
    await openDrawerIfCash([{ method: 'cash' }]);
    state.bridge = drawerBridge();
    await openDrawerIfCash([{ method: 'upi' }]);
    state.bridge = drawerBridge(vi.fn().mockRejectedValue(new Error('jammed')));
    await openDrawerIfCash([{ method: 'cash' }]);
    expect(loggedBodies()).toEqual([]);
  });

  it('a log that cannot be written never fails the payment', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    state.bridge = drawerBridge();
    await expect(openDrawerIfCash([{ method: 'cash' }])).resolves.toBeNull();
  });
});

describe('openDrawerManually', () => {
  it('opens the drawer printer and logs a manual opening', async () => {
    const bridge = drawerBridge();
    state.bridge = bridge;
    await expect(openDrawerManually()).resolves.toBeNull();
    expect(bridge.openDrawer).toHaveBeenCalledWith('counter-1');
    expect(loggedBodies()).toEqual([{ reason: 'manual' }]);
  });

  it('says why when there is no app or no drawer printer, logging nothing', async () => {
    state.bridge = null;
    await expect(openDrawerManually()).resolves.toContain('only in the HIOC POS app');
    state.bridge = fakeBridge();
    await expect(openDrawerManually()).resolves.toContain('No drawer printer');
    expect(loggedBodies()).toEqual([]);
  });

  it('returns the failure instead of throwing, logging nothing', async () => {
    state.bridge = drawerBridge(vi.fn().mockRejectedValue(new Error('jammed')));
    await expect(openDrawerManually()).resolves.toContain('jammed');
    expect(loggedBodies()).toEqual([]);
  });
});
