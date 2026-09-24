import { describe, expect, it } from 'vitest';
import { drawerPrinter, routeJob } from '@/lib/desktop/routing';
import type { PrinterConfig } from '@/lib/desktop/bridge';

// PRN-2 — pure printer routing. `routeJob` decides which configured printers a
// ticket type goes to (and how many copies each gets); `drawerPrinter` picks
// the one printer wired to the cash drawer. Neither knows about bytes, IPC or
// the bridge — that's printExecutor's job.

function printer(overrides: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'Kitchen',
    connection: overrides.connection ?? { kind: 'network', host: '192.168.1.50', port: 9100 },
    paperWidthMm: overrides.paperWidthMm ?? 80,
    roles: overrides.roles ?? ['kot'],
    copies: overrides.copies ?? {},
    cut: overrides.cut ?? true,
    drawer: overrides.drawer ?? false,
  };
}

describe('routeJob', () => {
  it('returns nothing for a role no printer is assigned', () => {
    const printers = [printer({ roles: ['receipt'] })];
    expect(routeJob(printers, 'kot')).toEqual([]);
  });

  it('returns the one printer assigned to a role', () => {
    const kitchen = printer({ id: 'kitchen', roles: ['kot'] });
    expect(routeJob([kitchen], 'kot')).toEqual([{ printer: kitchen, copies: 1 }]);
  });

  it('defaults copies to 1 when none is configured for the role', () => {
    const p = printer({ roles: ['kot'], copies: {} });
    expect(routeJob([p], 'kot')[0].copies).toBe(1);
  });

  it('uses the configured copy count for that role', () => {
    const p = printer({ roles: ['kot'], copies: { kot: 3 } });
    expect(routeJob([p], 'kot')[0].copies).toBe(3);
  });

  it('clamps copies below 1 up to 1', () => {
    const p = printer({ roles: ['kot'], copies: { kot: 0 } });
    expect(routeJob([p], 'kot')[0].copies).toBe(1);
  });

  it('clamps copies above 5 down to 5', () => {
    const p = printer({ roles: ['kot'], copies: { kot: 9 } });
    expect(routeJob([p], 'kot')[0].copies).toBe(5);
  });

  it('truncates a fractional copy count', () => {
    const p = printer({ roles: ['kot'], copies: { kot: 2.9 } });
    expect(routeJob([p], 'kot')[0].copies).toBe(2);
  });

  it('routes one role to several printers — KOT to kitchen AND bar', () => {
    const kitchen = printer({ id: 'kitchen', roles: ['kot'] });
    const bar = printer({ id: 'bar', roles: ['kot', 'receipt'], copies: { kot: 2 } });
    const routed = routeJob([kitchen, bar], 'kot');
    expect(routed).toEqual([
      { printer: kitchen, copies: 1 },
      { printer: bar, copies: 2 },
    ]);
  });

  it('preserves the order printers were configured in', () => {
    const bar = printer({ id: 'bar', roles: ['kot'] });
    const kitchen = printer({ id: 'kitchen', roles: ['kot'] });
    expect(routeJob([bar, kitchen], 'kot').map((r) => r.printer.id)).toEqual(['bar', 'kitchen']);
  });

  it('ignores copies configured for a different role', () => {
    const p = printer({ roles: ['kot'], copies: { receipt: 4 } });
    expect(routeJob([p], 'kot')[0].copies).toBe(1);
  });

  it('a printer with several roles routes independently per role', () => {
    const p = printer({ roles: ['kot', 'receipt'], copies: { kot: 2, receipt: 1 } });
    expect(routeJob([p], 'kot')[0].copies).toBe(2);
    expect(routeJob([p], 'receipt')[0].copies).toBe(1);
  });
});

describe('drawerPrinter', () => {
  it('returns null when no printer has the drawer', () => {
    expect(drawerPrinter([printer({ drawer: false })])).toBeNull();
  });

  it('returns null for an empty printer list', () => {
    expect(drawerPrinter([])).toBeNull();
  });

  it('returns the printer wired to the drawer', () => {
    const receipt = printer({ id: 'counter', drawer: true, roles: ['receipt'] });
    expect(drawerPrinter([printer({ id: 'kitchen' }), receipt])).toBe(receipt);
  });

  it('returns the FIRST drawer printer when more than one is (invalidly) marked', () => {
    const first = printer({ id: 'a', drawer: true });
    const second = printer({ id: 'b', drawer: true });
    expect(drawerPrinter([first, second])).toBe(first);
  });
});
