import { describe, expect, it } from 'vitest';
import { isActiveTab, moreTabs, primaryTabs } from '@/lib/staff/staffNav';

// The staff header split: the counter's everyday pages up front, back-office
// pages under "More" — so the bar no longer overflows on a tablet.

const allOn = { staffPos: true, attendance: true };

describe('primaryTabs', () => {
  it('puts Live orders, Orders, New order and Tables up front', () => {
    expect(primaryTabs(allOn).map((t) => t.label)).toEqual(['Live orders', 'Orders', 'New order', 'Tables']);
  });

  it('keeps Live orders and Orders when the POS flag is off', () => {
    expect(primaryTabs({ staffPos: false, attendance: true }).map((t) => t.href)).toEqual(['/staff', '/staff/orders']);
  });
});

describe('moreTabs', () => {
  it('holds the back-office pages, Settings last', () => {
    expect(moreTabs(allOn).map((t) => t.label)).toEqual(['Cash', 'Attendance', 'Leave', 'Menu', 'Settings']);
  });

  it('drops flagged-off pages', () => {
    expect(moreTabs({ staffPos: false, attendance: false }).map((t) => t.label)).toEqual(['Menu', 'Settings']);
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
