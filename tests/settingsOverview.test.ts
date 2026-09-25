import { describe, expect, it } from 'vitest';
import {
  summarizeDesktopApp,
  summarizeDevice,
  summarizePrinters,
  summarizeStore,
} from '@/lib/staff/settingsOverview';
import type { PrinterConfig } from '@/lib/desktop/bridge';
import type { StoreOpenState } from '@/lib/store/hours';

// SET-1 — the /staff/settings overview cards' pure status-summary strings.

function printer(overrides: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'Counter',
    connection: overrides.connection ?? { kind: 'network', host: '192.168.1.1', port: 9100 },
    paperWidthMm: overrides.paperWidthMm ?? 80,
    roles: overrides.roles ?? [],
    copies: overrides.copies ?? {},
    cut: overrides.cut ?? true,
    cutMode: overrides.cutMode ?? 'standard',
    drawer: overrides.drawer ?? false,
  };
}

describe('summarizePrinters', () => {
  it('reports "Checking…" while still loading (null)', () => {
    expect(summarizePrinters(null)).toBe('Checking…');
  });

  it('reports no printers configured', () => {
    expect(summarizePrinters([])).toBe('No printers configured yet.');
  });

  it('pluralises the count and names the receipt printer', () => {
    const printers = [printer({ id: 'a', name: 'Counter printer', roles: ['receipt'] })];
    expect(summarizePrinters(printers)).toBe('1 printer, receipt → Counter printer');
  });

  it('pluralises for more than one printer', () => {
    const printers = [
      printer({ id: 'a', name: 'Counter printer', roles: ['receipt'] }),
      printer({ id: 'b', name: 'Kitchen', roles: ['kot'] }),
    ];
    expect(summarizePrinters(printers)).toBe('2 printers, receipt → Counter printer');
  });

  it('joins multiple receipt printers', () => {
    const printers = [
      printer({ id: 'a', name: 'Front', roles: ['receipt'] }),
      printer({ id: 'b', name: 'Back', roles: ['receipt'] }),
    ];
    expect(summarizePrinters(printers)).toBe('2 printers, receipt → Front, Back');
  });

  it('says so when no printer is assigned the receipt role', () => {
    const printers = [printer({ id: 'a', name: 'Kitchen', roles: ['kot'] })];
    expect(summarizePrinters(printers)).toBe('1 printer, no receipt printer assigned');
  });
});

describe('summarizeStore', () => {
  it('reports "Checking…" while still loading (null)', () => {
    expect(summarizeStore(null)).toBe('Checking…');
  });

  it('reports accepting orders', () => {
    const state: StoreOpenState = { isOpen: true, acceptingOrders: true, reason: 'open', nextOpenLabel: null };
    expect(summarizeStore(state)).toBe('Accepting orders');
  });

  it('reports the reason, with underscores turned into spaces, when not accepting', () => {
    const state: StoreOpenState = {
      isOpen: true,
      acceptingOrders: false,
      reason: 'after_cutoff',
      nextOpenLabel: null,
    };
    expect(summarizeStore(state)).toBe('Not accepting orders (after cutoff)');
  });

  it('reports a paused store', () => {
    const state: StoreOpenState = { isOpen: true, acceptingOrders: false, reason: 'paused', nextOpenLabel: null };
    expect(summarizeStore(state)).toBe('Not accepting orders (paused)');
  });
});

describe('summarizeDevice', () => {
  it('names the enrolled device', () => {
    expect(summarizeDevice({ name: 'Counter 1' })).toBe('Enrolled as Counter 1');
  });

  it('reports not enrolled', () => {
    expect(summarizeDevice(null)).toBe('Not enrolled');
  });
});

describe('summarizeDesktopApp', () => {
  it('reports the browser fallback when there is no bridge', () => {
    expect(summarizeDesktopApp(null)).toBe('Browser — install HIOC POS for printing');
  });

  it('formats the version and a friendly platform name', () => {
    expect(summarizeDesktopApp({ version: '1.2.3', platform: 'win32' })).toBe('HIOC POS 1.2.3 · Windows');
    expect(summarizeDesktopApp({ version: '1.2.3', platform: 'darwin' })).toBe('HIOC POS 1.2.3 · macOS');
    expect(summarizeDesktopApp({ version: '1.2.3', platform: 'linux' })).toBe('HIOC POS 1.2.3 · Linux');
  });

  it('falls back to the raw platform string for an unknown value', () => {
    expect(summarizeDesktopApp({ version: '1.0.0', platform: 'freebsd' })).toBe('HIOC POS 1.0.0 · freebsd');
  });
});
