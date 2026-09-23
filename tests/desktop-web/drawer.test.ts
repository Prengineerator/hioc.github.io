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
import { openDrawerIfCash } from '@/lib/desktop/drawer';

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

beforeEach(() => {
  state.bridge = null;
});

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
