import { describe, expect, it } from 'vitest';
import { isActiveTab, staffNav } from '@/lib/staff/staffNav';

// What each surface's header offers. The POS is the counter's order-taking
// and menu screen; the staff website takes orders only when switched on.

const flags = { staffPos: true, attendance: true };
const labels = (tabs: { label: string }[]) => tabs.map((t) => t.label);

describe('staffNav — POS', () => {
  const nav = staffNav({ surface: 'pos', canTakeOrders: true, ...flags });

  it('shows Live orders, Orders, Settle, New order, Tables, Menu and Settings as tabs', () => {
    expect(labels(nav.primary)).toEqual(['Live orders', 'Orders', 'Settle', 'New order', 'Tables', 'Menu', 'Settings']);
    expect(nav.more).toEqual([]);
    expect(nav.account).toEqual([]);
  });

  it('drops New order and Tables when the POS flag is off', () => {
    const off = staffNav({ surface: 'pos', canTakeOrders: true, staffPos: false, attendance: true });
    expect(labels(off.primary)).toEqual(['Live orders', 'Orders', 'Settle', 'Menu', 'Settings']);
  });

  it('puts Stock on the counter when inventory is on — deliveries are verified there', () => {
    const withStock = staffNav({ surface: 'pos', canTakeOrders: true, ...flags, inventory: true });
    expect(labels(withStock.primary)).toEqual([
      'Live orders',
      'Orders',
      'Settle',
      'New order',
      'Tables',
      'Menu',
      'Stock',
      'Settings',
    ]);
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
    expect(labels(nav.more)).toEqual(['Cash', 'Attendance', 'Leave', 'Menu', 'Settings']);
    expect(nav.account).toEqual([]);
  });

  it('adds Stock under More when inventory is on', () => {
    const nav = staffNav({ surface: 'web', canTakeOrders: false, ...flags, inventory: true });
    expect(labels(nav.more)).toEqual(['Cash', 'Attendance', 'Leave', 'Stock', 'Menu', 'Settings']);
  });

  it('drops flagged-off pages', () => {
    const nav = staffNav({ surface: 'web', canTakeOrders: true, staffPos: false, attendance: false });
    expect(labels(nav.primary)).toEqual(['Live orders', 'Orders', 'Settle']);
    expect(labels(nav.more)).toEqual(['Menu', 'Settings']);
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
