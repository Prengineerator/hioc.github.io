import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopExecutor, NoPrintersConfiguredError } from '@/lib/desktop/printExecutor';
import { renderEscPos } from '@/lib/print/escpos';
import type { HiocDesktopBridge, PrinterConfig } from '@/lib/desktop/bridge';
import type { PrintJob } from '@/lib/pos/printQueue';
import type { TicketDoc } from '@/lib/print/ticketDoc';

// PRN-4/PRN-5 — the desktop executor: routes a job to every printer configured
// for its role, renders REAL ESC/POS bytes for raw-capable connections, drives
// system+driver printers through a silent staff-print URL, and confirms only
// when every printer confirmed. Uses the real `renderEscPos` (not a stub) so a
// mismatch between this module and the byte renderer's actual signature would
// fail here, not just in production.

const TICKET_DOC: TicketDoc = {
  type: 'kot',
  orderId: 'order-1',
  blocks: [{ kind: 'text', text: 'Test' }],
};

function printer(overrides: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    id: overrides.id ?? 'kitchen',
    name: overrides.name ?? 'Kitchen',
    connection: overrides.connection ?? { kind: 'network', host: '10.0.0.5', port: 9100 },
    paperWidthMm: overrides.paperWidthMm ?? 80,
    roles: overrides.roles ?? ['kot'],
    copies: overrides.copies ?? {},
    cut: overrides.cut ?? true,
    cutMode: overrides.cutMode,
    drawer: overrides.drawer ?? false,
  };
}

function job(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: overrides.id ?? 'job-1',
    orderId: overrides.orderId ?? 'order-1',
    type: overrides.type ?? 'kot',
    state: overrides.state ?? 'printing',
    attempts: overrides.attempts ?? 1,
  };
}

function fakeBridge(printers: PrinterConfig[], overrides: Partial<HiocDesktopBridge> = {}): HiocDesktopBridge {
  return {
    version: '0.1.0',
    platform: 'darwin',
    printers: {
      list: vi.fn().mockResolvedValue(printers),
      save: vi.fn(),
      detect: vi.fn(),
      status: vi.fn(),
    },
    printRaw: vi.fn().mockResolvedValue({ confirmed: true }),
    printUrl: vi.fn().mockResolvedValue({ confirmed: true }),
    openDrawer: vi.fn(),
    ...overrides,
  } as unknown as HiocDesktopBridge;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ doc: TICKET_DOC }) }));
  vi.stubGlobal('fetch', fetchMock);
  // jsdom-free (node) environment: printUrl branch reads window.location.
  vi.stubGlobal('window', { location: { origin: 'https://staff.hioc.in' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDesktopExecutor — no printers at all', () => {
  it('throws NoPrintersConfiguredError so the caller can fall back to the iframe', async () => {
    const bridge = fakeBridge([]);
    const exec = createDesktopExecutor(bridge);
    await expect(exec(job())).rejects.toBeInstanceOf(NoPrintersConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createDesktopExecutor — no printer for this role', () => {
  it('rejects naming the role, distinct from "no printers at all"', async () => {
    const bridge = fakeBridge([printer({ roles: ['receipt'] })]);
    const exec = createDesktopExecutor(bridge);
    await expect(exec(job({ type: 'kot' }))).rejects.toThrow(
      'No printer is set for KOT — open Printers to assign one.',
    );
  });
});

describe('createDesktopExecutor — raw-capable printers (network / usb / system+raw)', () => {
  it('fetches the ticket doc, renders real ESC/POS bytes and sends them via printRaw', async () => {
    const p = printer({ id: 'kitchen', roles: ['kot'], paperWidthMm: 80, cut: true });
    const bridge = fakeBridge([p]);
    const exec = createDesktopExecutor(bridge);

    const result = await exec(job({ orderId: 'order-42', type: 'kot' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/print/ticket/order-42/kot', { cache: 'no-store' });
    expect(bridge.printRaw).toHaveBeenCalledTimes(1);
    const [printerId, bytes] = (bridge.printRaw as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(printerId).toBe('kitchen');
    expect(bytes).toEqual(renderEscPos(TICKET_DOC, { paperWidthMm: 80, cut: true, cutMode: undefined }));
    expect(result).toEqual({ confirmed: true });
  });

  it('passes the printer\'s saved cutMode through to renderEscPos', async () => {
    const p = printer({ id: 'kitchen', roles: ['kot'], paperWidthMm: 58, cut: true, cutMode: 'legacy' });
    const bridge = fakeBridge([p]);
    const exec = createDesktopExecutor(bridge);

    await exec(job({ orderId: 'order-42', type: 'kot' }));

    const [, bytes] = (bridge.printRaw as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bytes).toEqual(renderEscPos(TICKET_DOC, { paperWidthMm: 58, cut: true, cutMode: 'legacy' }));
  });

  it('sends one printRaw call per configured copy', async () => {
    const p = printer({ roles: ['kot'], copies: { kot: 3 } });
    const bridge = fakeBridge([p]);
    const exec = createDesktopExecutor(bridge);

    await exec(job({ type: 'kot' }));

    expect(bridge.printRaw).toHaveBeenCalledTimes(3);
  });

  it('treats a network printer and a usb printer both as raw-capable', async () => {
    const usb = printer({
      id: 'usb-1',
      roles: ['kot'],
      connection: { kind: 'usb', vendorId: 0x04b8, productId: 0x0202 },
    });
    const bridge = fakeBridge([usb]);
    const exec = createDesktopExecutor(bridge);

    const result = await exec(job({ type: 'kot' }));
    expect(bridge.printRaw).toHaveBeenCalledWith('usb-1', expect.any(Uint8Array));
    expect(result).toEqual({ confirmed: true });
  });

  it('treats system+raw as raw-capable', async () => {
    const sys = printer({
      id: 'sys-raw',
      roles: ['kot'],
      connection: { kind: 'system', deviceName: 'EPSON-TM88', mode: 'raw' },
    });
    const bridge = fakeBridge([sys]);
    const exec = createDesktopExecutor(bridge);

    await exec(job({ type: 'kot' }));
    expect(bridge.printRaw).toHaveBeenCalledWith('sys-raw', expect.any(Uint8Array));
    expect(bridge.printUrl).not.toHaveBeenCalled();
  });

  it('rejects when the ticket fetch is not OK, naming nothing prints', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const bridge = fakeBridge([printer({ roles: ['kot'] })]);
    const exec = createDesktopExecutor(bridge);
    await expect(exec(job({ type: 'kot' }))).rejects.toThrow(/could not load/i);
    expect(bridge.printRaw).not.toHaveBeenCalled();
  });

  it('names the printer when printRaw rejects', async () => {
    const bridge = fakeBridge([printer({ id: 'kitchen', name: 'Kitchen', roles: ['kot'] })], {
      printRaw: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const exec = createDesktopExecutor(bridge);
    await expect(exec(job({ type: 'kot' }))).rejects.toThrow('Kitchen: offline');
  });

  it('fetches the ticket doc only once even when two printers share the role', async () => {
    const kitchen = printer({ id: 'kitchen', roles: ['kot'] });
    const bar = printer({ id: 'bar', roles: ['kot'] });
    const bridge = fakeBridge([kitchen, bar]);
    const exec = createDesktopExecutor(bridge);

    await exec(job({ type: 'kot' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createDesktopExecutor — system+driver printers', () => {
  it('calls bridge.printUrl at the silent staff-print URL, not printRaw', async () => {
    const p = printer({
      id: 'driver-1',
      roles: ['receipt'],
      connection: { kind: 'system', deviceName: 'HP LaserJet', mode: 'driver' },
    });
    const bridge = fakeBridge([p]);
    const exec = createDesktopExecutor(bridge);

    const result = await exec(job({ orderId: 'order-9', type: 'receipt' }));

    expect(bridge.printRaw).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled(); // no ticket-doc fetch needed for a driver print
    expect(bridge.printUrl).toHaveBeenCalledWith(
      'driver-1',
      'https://staff.hioc.in/staff-print/order-9/receipt?silent=1',
    );
    expect(result).toEqual({ confirmed: true });
  });

  it('sends one printUrl call per configured copy', async () => {
    const p = printer({
      roles: ['receipt'],
      copies: { receipt: 2 },
      connection: { kind: 'system', deviceName: 'HP', mode: 'driver' },
    });
    const bridge = fakeBridge([p]);
    const exec = createDesktopExecutor(bridge);
    await exec(job({ type: 'receipt' }));
    expect(bridge.printUrl).toHaveBeenCalledTimes(2);
  });
});

describe('createDesktopExecutor — confirmed aggregation across several printers', () => {
  it('confirms true only when every routed printer confirmed', async () => {
    const kitchen = printer({ id: 'kitchen', roles: ['kot'] });
    const bar = printer({ id: 'bar', roles: ['kot'] });
    const bridge = fakeBridge([kitchen, bar], {
      printRaw: vi
        .fn()
        .mockResolvedValueOnce({ confirmed: true })
        .mockResolvedValueOnce({ confirmed: true }),
    });
    const exec = createDesktopExecutor(bridge);
    const result = await exec(job({ type: 'kot' }));
    expect(result).toEqual({ confirmed: true });
  });

  it('confirms false when any one routed printer did not confirm', async () => {
    const kitchen = printer({ id: 'kitchen', roles: ['kot'] });
    const bar = printer({ id: 'bar', roles: ['kot'] });
    const bridge = fakeBridge([kitchen, bar], {
      printRaw: vi
        .fn()
        .mockResolvedValueOnce({ confirmed: true })
        .mockResolvedValueOnce({ confirmed: false }),
    });
    const exec = createDesktopExecutor(bridge);
    const result = await exec(job({ type: 'kot' }));
    expect(result).toEqual({ confirmed: false });
  });

  it('rejects the whole job if any one routed printer rejects, even if another would succeed', async () => {
    const kitchen = printer({ id: 'kitchen', name: 'Kitchen', roles: ['kot'] });
    const bar = printer({ id: 'bar', name: 'Bar', roles: ['kot'] });
    const bridge = fakeBridge([kitchen, bar], {
      printRaw: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'bar') throw new Error('paper out');
        return { confirmed: true };
      }),
    });
    const exec = createDesktopExecutor(bridge);
    await expect(exec(job({ type: 'kot' }))).rejects.toThrow('Bar: paper out');
  });
});
