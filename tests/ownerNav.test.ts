import { describe, expect, it } from 'vitest';
import {
  OWNER_MENU_HREF,
  OWNER_ROOT,
  activeOwnerGroup,
  activeOwnerLink,
  isActiveOwnerLink,
  ownerNav,
  type OwnerNav,
  type OwnerNavGroup,
  type OwnerNavInput,
} from '@/lib/owner/ownerNav';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { hrefForSurface } from '@/lib/routing/surface';

// The owner header's navigation (lib/owner/ownerNav.ts). Pinned: the five groups
// and the pages in each with the three feature flags off, on, and one at a time;
// that every page of the old flat header is listed exactly once; and which link
// lights up for a path, on the main domain and on owner.hioc.in.

const OFF: OwnerNavInput = { coffeePass: false, marketing: false, attendance: false };
const ON: OwnerNavInput = { coffeePass: true, marketing: true, attendance: true };

const labels = (links: { label: string }[]) => links.map((l) => l.label);
const itemsOf = (nav: OwnerNav, id: OwnerNavGroup['id']) => nav.groups.find((g) => g.id === id)?.items ?? [];
const allLinks = (nav: OwnerNav) => [nav.overview, ...nav.groups.flatMap((g) => g.items), nav.staffBoard];
const allHrefs = (nav: OwnerNav) => allLinks(nav).map((l) => l.href);
const sorted = (xs: string[]) => [...xs].sort();

// Every owner page the old flat header linked to, plus the counter's board.
const EVERY_PAGE = [
  '/owner',
  '/owner/customers',
  '/owner/menu',
  '/owner/suggestions',
  '/owner/payments',
  '/owner/online',
  '/owner/reports',
  '/owner/promotions',
  '/owner/passes',
  '/owner/marketing',
  '/owner/reviews',
  '/owner/feedback',
  '/owner/tables',
  '/owner/devices',
  '/owner/notifications',
  '/owner/staff',
  '/owner/attendance',
  '/owner/payroll',
  '/owner/cash',
  '/owner/settings',
  '/staff',
];

// owner.hioc.in serves the owner pages without the /owner prefix.
const onOwnerSubdomain = (href: string) => hrefForSurface('owner', href);

describe('ownerNav — all flags off', () => {
  const nav = ownerNav(OFF);

  it('shows the groups as Sales, Menu, Customers, Team, Setup', () => {
    expect(nav.groups.map((g) => g.label)).toEqual(['Sales', 'Menu', 'Customers', 'Team', 'Setup']);
  });

  it('keeps Sales to Reports, Payments, Online orders', () => {
    expect(labels(itemsOf(nav, 'sales'))).toEqual(['Reports', 'Payments', 'Online orders']);
  });

  it('keeps Menu to Menu and Suggestions', () => {
    expect(labels(itemsOf(nav, 'menu'))).toEqual(['Menu', 'Suggestions']);
  });

  it('keeps Customers to Customers, Reviews, Feedback, Promotions', () => {
    expect(labels(itemsOf(nav, 'customers'))).toEqual(['Customers', 'Reviews', 'Feedback', 'Promotions']);
  });

  it('keeps Team to Team alone', () => {
    expect(labels(itemsOf(nav, 'team'))).toEqual(['Team']);
  });

  it('keeps Setup to Settings, Tables, Devices, Notifications', () => {
    expect(labels(itemsOf(nav, 'setup'))).toEqual(['Settings', 'Tables', 'Devices', 'Notifications']);
  });
});

describe('ownerNav — all flags on', () => {
  const nav = ownerNav(ON);

  it('adds Cash to the end of Sales', () => {
    expect(labels(itemsOf(nav, 'sales'))).toEqual(['Reports', 'Payments', 'Online orders', 'Cash']);
  });

  it('adds HIOC Ritual and Marketing after Promotions in Customers', () => {
    expect(labels(itemsOf(nav, 'customers'))).toEqual([
      'Customers',
      'Reviews',
      'Feedback',
      'Promotions',
      PASS_PROGRAM_NAME,
      'Marketing',
    ]);
  });

  it('adds Attendance and Payroll after Team', () => {
    expect(labels(itemsOf(nav, 'team'))).toEqual(['Team', 'Attendance', 'Payroll']);
  });

  it('leaves Menu and Setup as they are', () => {
    expect(labels(itemsOf(nav, 'menu'))).toEqual(['Menu', 'Suggestions']);
    expect(labels(itemsOf(nav, 'setup'))).toEqual(['Settings', 'Tables', 'Devices', 'Notifications']);
  });
});

describe('ownerNav — one flag at a time', () => {
  const base = sorted(allHrefs(ownerNav(OFF)));

  it('coffeePass adds only the Ritual link', () => {
    const nav = ownerNav({ ...OFF, coffeePass: true });
    expect(sorted(allHrefs(nav))).toEqual(sorted([...base, '/owner/passes']));
    expect(labels(itemsOf(nav, 'customers'))).toEqual(['Customers', 'Reviews', 'Feedback', 'Promotions', PASS_PROGRAM_NAME]);
  });

  it('marketing adds only the Marketing link', () => {
    const nav = ownerNav({ ...OFF, marketing: true });
    expect(sorted(allHrefs(nav))).toEqual(sorted([...base, '/owner/marketing']));
    expect(labels(itemsOf(nav, 'customers'))).toEqual(['Customers', 'Reviews', 'Feedback', 'Promotions', 'Marketing']);
  });

  it('attendance adds only Cash, Attendance and Payroll', () => {
    const nav = ownerNav({ ...OFF, attendance: true });
    expect(sorted(allHrefs(nav))).toEqual(sorted([...base, '/owner/cash', '/owner/attendance', '/owner/payroll']));
    expect(labels(itemsOf(nav, 'sales'))).toEqual(['Reports', 'Payments', 'Online orders', 'Cash']);
    expect(labels(itemsOf(nav, 'team'))).toEqual(['Team', 'Attendance', 'Payroll']);
  });
});

describe('ownerNav — every page listed once', () => {
  const nav = ownerNav(ON);

  it('lists exactly the old flat header pages with all flags on', () => {
    expect(sorted(allHrefs(nav))).toEqual(sorted(EVERY_PAGE));
  });

  it('never lists the same href twice', () => {
    const hrefs = allHrefs(nav);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('gives every link a non-empty description', () => {
    for (const link of allLinks(nav)) {
      expect(link.description.trim().length, link.href).toBeGreaterThan(0);
    }
  });
});

describe('ownerNav — fixed links', () => {
  it('has Overview at the owner root and the Staff board on /staff', () => {
    const nav = ownerNav(OFF);
    expect(nav.overview).toMatchObject({ href: '/owner', label: 'Overview' });
    expect(nav.staffBoard).toMatchObject({ href: '/staff', label: 'Staff board' });
  });

  it('exports the owner root and the Menu href', () => {
    expect(OWNER_ROOT).toBe('/owner');
    expect(OWNER_MENU_HREF).toBe('/owner/menu');
  });

  it('points the Menu item at OWNER_MENU_HREF', () => {
    const menu = itemsOf(ownerNav(OFF), 'menu').find((l) => l.label === 'Menu');
    expect(menu?.href).toBe(OWNER_MENU_HREF);
  });
});

describe('ownerNav — no group is ever empty', () => {
  it('keeps all five groups, each with items, under every flag combination', () => {
    const bools = [false, true];
    for (const coffeePass of bools) {
      for (const marketing of bools) {
        for (const attendance of bools) {
          const nav = ownerNav({ coffeePass, marketing, attendance });
          expect(nav.groups.map((g) => g.id)).toEqual(['sales', 'menu', 'customers', 'team', 'setup']);
          for (const g of nav.groups) {
            expect(g.items.length, g.id).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('isActiveOwnerLink', () => {
  it('matches the root only on /owner and /owner/, not on a page under it', () => {
    expect(isActiveOwnerLink('/owner', '/owner', '/owner')).toBe(true);
    expect(isActiveOwnerLink('/owner/', '/owner', '/owner')).toBe(true);
    expect(isActiveOwnerLink('/owner/payments', '/owner', '/owner')).toBe(false);
  });

  it('lights a page on its own exact path', () => {
    expect(isActiveOwnerLink('/owner/payments', '/owner/payments', '/owner')).toBe(true);
  });

  it('keeps Reports lit on a report sub-page', () => {
    expect(isActiveOwnerLink('/owner/reports/gst', '/owner/reports', '/owner')).toBe(true);
  });

  it('keeps Feedback lit on a thread under it', () => {
    expect(isActiveOwnerLink('/owner/feedback/abc', '/owner/feedback', '/owner')).toBe(true);
  });

  it('does not light a sibling that only shares the prefix', () => {
    expect(isActiveOwnerLink('/owner/staffing', '/owner/staff', '/owner')).toBe(false);
  });

  it('on owner.hioc.in, the root matches "/" only', () => {
    expect(isActiveOwnerLink('/', '/', '/')).toBe(true);
    expect(isActiveOwnerLink('/payments', '/', '/')).toBe(false);
  });

  it('on owner.hioc.in, a resolved page href matches its own path', () => {
    expect(isActiveOwnerLink('/payments', '/payments', '/')).toBe(true);
  });
});

describe('activeOwnerLink and activeOwnerGroup', () => {
  const nav = ownerNav(ON);

  it('lights Overview on /owner, and no group', () => {
    expect(activeOwnerLink(nav, '/owner')?.label).toBe('Overview');
    expect(activeOwnerGroup(nav, '/owner')).toBeNull();
  });

  it('lights Payments in Sales on /owner/payments', () => {
    expect(activeOwnerLink(nav, '/owner/payments')?.label).toBe('Payments');
    expect(activeOwnerGroup(nav, '/owner/payments')?.id).toBe('sales');
  });

  it('lights Reports in Sales on /owner/reports/gst', () => {
    expect(activeOwnerLink(nav, '/owner/reports/gst')?.label).toBe('Reports');
    expect(activeOwnerGroup(nav, '/owner/reports/gst')?.id).toBe('sales');
  });

  it('lights Feedback in Customers on /owner/feedback/123', () => {
    expect(activeOwnerLink(nav, '/owner/feedback/123')?.label).toBe('Feedback');
    expect(activeOwnerGroup(nav, '/owner/feedback/123')?.id).toBe('customers');
  });

  it('lights Team in the Team group on /owner/staff', () => {
    expect(activeOwnerLink(nav, '/owner/staff')?.label).toBe('Team');
    expect(activeOwnerGroup(nav, '/owner/staff')?.id).toBe('team');
  });

  it('lights nothing on a page outside the nav', () => {
    expect(activeOwnerLink(nav, '/owner/login')).toBeNull();
    expect(activeOwnerGroup(nav, '/owner/login')).toBeNull();
  });

  it('lights nothing on a flagged-off page', () => {
    const off = ownerNav(OFF);
    expect(activeOwnerLink(off, '/owner/cash')).toBeNull();
    expect(activeOwnerGroup(off, '/owner/cash')).toBeNull();
  });
});

describe('activeOwnerLink and activeOwnerGroup on owner.hioc.in', () => {
  const nav = ownerNav(ON);

  it('lights Payments in Sales on /payments', () => {
    expect(activeOwnerLink(nav, '/payments', onOwnerSubdomain)?.label).toBe('Payments');
    expect(activeOwnerGroup(nav, '/payments', onOwnerSubdomain)?.id).toBe('sales');
  });

  it('lights Overview on / and no group', () => {
    expect(activeOwnerLink(nav, '/', onOwnerSubdomain)?.label).toBe('Overview');
    expect(activeOwnerGroup(nav, '/', onOwnerSubdomain)).toBeNull();
  });

  it('lights Menu in the Menu group on /menu', () => {
    expect(activeOwnerLink(nav, '/menu', onOwnerSubdomain)?.label).toBe('Menu');
    expect(activeOwnerGroup(nav, '/menu', onOwnerSubdomain)?.id).toBe('menu');
  });
});

describe('ownerNav — the warehouse (docs/WAREHOUSE-SPEC.md)', () => {
  it('adds a Stock section with the one Warehouse page, after Menu, only when the warehouse is on', () => {
    const nav = ownerNav({ ...OFF, warehouse: true });
    expect(nav.groups.map((g) => g.id)).toEqual(['sales', 'menu', 'stock', 'customers', 'team', 'setup']);
    expect(itemsOf(nav, 'stock').map((l) => [l.href, l.label])).toEqual([['/owner/warehouse', 'Warehouse']]);
    expect(ownerNav(OFF).groups.map((g) => g.id)).not.toContain('stock');
    expect(ownerNav({ ...ON, warehouse: false }).groups.map((g) => g.id)).not.toContain('stock');
  });

  it('lights up on the page and its tabs', () => {
    const nav = ownerNav({ ...OFF, warehouse: true });
    expect(activeOwnerLink(nav, '/owner/warehouse')?.label).toBe('Warehouse');
    expect(activeOwnerGroup(nav, '/owner/warehouse')?.id).toBe('stock');
  });
});
