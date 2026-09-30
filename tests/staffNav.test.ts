import { describe, expect, it } from 'vitest';
import { isActiveTab, staffNav } from '@/lib/staff/staffNav';

// What each surface's header offers. The POS is the counter's order-taking
// and menu screen; the staff website takes orders only when switched on.

const flags = { staffPos: true, attendance: true };
const labels = (tabs: { label: string }[]) => tabs.map((t) => t.label);

describe('staffNav — POS', () => {
  const nav = staffNav({ surface: 'pos', canTakeOrders: true, ...flags });

  it('shows Live orders, Orders, Settle, New order and Tables as tabs', () => {
    expect(labels(nav.primary)).toEqual(['Live orders', 'Orders', 'Settle', 'New order', 'Tables']);
    expect(nav.account).toEqual([]);
  });

  it('keeps Cash, Expenses, Attendance, Leave, Menu and Settings under More', () => {
    expect(labels(nav.more)).toEqual(['Cash', 'Expenses', 'Attendance', 'Leave', 'Menu', 'Settings']);
  });

  it('adds Cash in / out after Expenses for a manager or owner only', () => {
    const manager = staffNav({ surface: 'pos', canTakeOrders: true, ...flags, canManageCash: true });
    expect(labels(manager.more)).toEqual(['Cash', 'Expenses', 'Cash in / out', 'Attendance', 'Leave', 'Menu', 'Settings']);
    expect(manager.more.find((t) => t.label === 'Expenses')?.href).toBe('/staff/expenses');
    expect(manager.more.find((t) => t.label === 'Cash in / out')?.href).toBe('/staff/cash-movements');
    const staff = staffNav({ surface: 'pos', canTakeOrders: true, ...flags, canManageCash: false });
    expect(labels(staff.more)).not.toContain('Cash in / out');
  });

  it('drops flagged-off back-office pages from More', () => {
    const off = staffNav({ surface: 'pos', canTakeOrders: true, staffPos: true, attendance: false });
    expect(labels(off.more)).toEqual(['Cash', 'Expenses', 'Menu', 'Settings']);
  });

  it('drops New order and Tables when the POS flag is off', () => {
    const off = staffNav({ surface: 'pos', canTakeOrders: true, staffPos: false, attendance: true });
    expect(labels(off.primary)).toEqual(['Live orders', 'Orders', 'Settle']);
  });

  it('puts Stock under More on the counter when inventory is on', () => {
    const withStock = staffNav({ surface: 'pos', canTakeOrders: true, ...flags, inventory: true });
    expect(labels(withStock.primary)).toEqual(['Live orders', 'Orders', 'Settle', 'New order', 'Tables']);
    expect(labels(withStock.more)).toEqual(['Cash', 'Expenses', 'Attendance', 'Leave', 'Stock', 'Menu', 'Settings']);
  });
});

describe('staffNav — staff website', () => {
  it('hides New order and Tables while web ordering is off (the default)', () => {
    const nav = staffNav({ surface: 'web', canTakeOrders: false, ...flags });
    expect(labels(nav.primary)).toEqual(['Live orders', 'Orders', 'Settle']);
  });

  it('shows them once the owner switches web ordering on', () => {
    const nav = staffNav({ surface: 'web', canTakeOrders: true, ...flags });
    expect(labels(nav.primary)).toEqual(['Live orders', 'Orders', 'Settle', 'New order', 'Tables']);
  });

  it('keeps the back-office pages under More, Settings last', () => {
    const nav = staffNav({ surface: 'web', canTakeOrders: false, ...flags });
    expect(labels(nav.more)).toEqual(['Cash', 'Expenses', 'Attendance', 'Leave', 'Menu', 'Settings']);
    expect(nav.account).toEqual([]);
  });

  it('adds Stock under More when inventory is on', () => {
    const nav = staffNav({ surface: 'web', canTakeOrders: false, ...flags, inventory: true });
    expect(labels(nav.more)).toEqual(['Cash', 'Expenses', 'Attendance', 'Leave', 'Stock', 'Menu', 'Settings']);
  });

  it('drops flagged-off pages', () => {
    const nav = staffNav({ surface: 'web', canTakeOrders: true, staffPos: false, attendance: false, canManageCash: true });
    expect(labels(nav.primary)).toEqual(['Live orders', 'Orders', 'Settle']);
    expect(labels(nav.more)).toEqual(['Menu', 'Settings']);
  });
});

// HIOC Ritual (docs/COFFEE-PASS-SPEC.md CP-D20): "Ritual passes" lives under More,
// behind its flag, for anyone who can take orders (selling a pass is taking an
// order); the page and the API check the sell / manage permissions themselves.
describe('staffNav — Ritual passes', () => {
  it('is absent by default and while the flag is off', () => {
    const off = staffNav({ surface: 'pos', canTakeOrders: true, ...flags });
    expect(labels(off.more)).not.toContain('Ritual passes');
    const explicitOff = staffNav({ surface: 'pos', canTakeOrders: true, ...flags, coffeePass: false });
    expect(labels(explicitOff.more)).not.toContain('Ritual passes');
  });

  it('leads the More menu on the counter when the flag is on', () => {
    const nav = staffNav({ surface: 'pos', canTakeOrders: true, ...flags, coffeePass: true });
    expect(labels(nav.more)).toEqual(['Ritual passes', 'Cash', 'Expenses', 'Attendance', 'Leave', 'Menu', 'Settings']);
    expect(nav.more.find((t) => t.label === 'Ritual passes')?.href).toBe('/staff/passes');
    // Not a primary tab: the counter's all-day tabs are unchanged.
    expect(labels(nav.primary)).toEqual(['Live orders', 'Orders', 'Settle', 'New order', 'Tables']);
  });

  it('shows for anyone who can take orders on the staff website, and hides otherwise', () => {
    const allowed = staffNav({ surface: 'web', canTakeOrders: true, ...flags, coffeePass: true });
    expect(labels(allowed.more)).toContain('Ritual passes');
    // Web ordering switched off: selling is refused (CP-D20), so the entry is not offered.
    const blocked = staffNav({ surface: 'web', canTakeOrders: false, ...flags, coffeePass: true });
    expect(labels(blocked.more)).not.toContain('Ritual passes');
  });

  it('does not depend on the cash, attendance or stock flags', () => {
    const nav = staffNav({
      surface: 'pos',
      canTakeOrders: true,
      staffPos: false,
      attendance: false,
      inventory: false,
      coffeePass: true,
    });
    expect(labels(nav.more)).toEqual(['Ritual passes', 'Menu', 'Settings']);
  });

  it('sits with Stock and Cash in / out when everything is on', () => {
    const nav = staffNav({
      surface: 'pos',
      canTakeOrders: true,
      ...flags,
      inventory: true,
      canManageCash: true,
      coffeePass: true,
    });
    expect(labels(nav.more)).toEqual([
      'Ritual passes',
      'Cash',
      'Expenses',
      'Cash in / out',
      'Attendance',
      'Leave',
      'Stock',
      'Menu',
      'Settings',
    ]);
  });

  it('lights up on its own page only', () => {
    expect(isActiveTab('/staff/passes', '/staff/passes')).toBe(true);
    expect(isActiveTab('/staff/orders', '/staff/passes')).toBe(false);
  });
});

describe('isActiveTab', () => {
  it('matches only the exact path, so Orders is not lit on New order', () => {
    expect(isActiveTab('/staff/orders', '/staff/orders')).toBe(true);
    expect(isActiveTab('/staff/orders/new', '/staff/orders')).toBe(false);
    expect(isActiveTab('/staff/orders', '/staff')).toBe(false);
  });

  it('lights Settings for any settings section', () => {
    expect(isActiveTab('/staff/settings/printers', '/staff/settings')).toBe(true);
  });
});
