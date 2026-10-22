// Smoke-renders the owner header on the server (node environment, no DOM), so it
// only sees the FIRST PAINT: every section panel and the phone drawer are closed,
// no fetch has run and no badge is up. That is exactly what has to be right for
// hydration, and it is where the markup contracts live: one navigation landmark,
// disclosure buttons (not role="menu"), the open page marked on its link and its
// section, and every page present even though the panels are closed. What a
// click, Escape or Tab does is not covered here (no DOM); the nav config itself
// is covered by tests/ownerNav.test.ts.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/owner' }));
// The header reads these three NEXT_PUBLIC flags through ownerNav. Mutable so a
// test can switch one off; reset in beforeEach.
const flagState = vi.hoisted(() => ({ coffeePass: true, marketing: true, attendance: true }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/flags', () => ({ flags: flagState }));

import { OwnerHeader } from '@/components/owner/OwnerHeader';
import { SurfaceProvider } from '@/components/SurfaceLink';
import { ownerNav } from '@/lib/owner/ownerNav';
import type { Surface } from '@/lib/routing/surface';

beforeEach(() => {
  flagState.coffeePass = true;
  flagState.marketing = true;
  flagState.attendance = true;
});

function render(pathname = '/owner', surface: Surface = 'main'): string {
  nav.pathname = pathname;
  const header = createElement(OwnerHeader);
  return renderToStaticMarkup(surface === 'main' ? header : createElement(SurfaceProvider, { surface, children: header }));
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');
const attr = (attrs: string, name: string) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];

interface El {
  attrs: string;
  inner: string;
  text: string;
}
function elements(html: string, tag: string): El[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>(.*?)</${tag}>`, 'gs'))].map((m) => ({
    attrs: m[1],
    inner: m[2],
    text: stripTags(m[2]),
  }));
}
const links = (html: string) => elements(html, 'a');
const buttons = (html: string) => elements(html, 'button');
/** The section buttons: the ones that control a panel (the phone toggle controls the nav). */
const triggers = (html: string) => buttons(html).filter((b) => attr(b.attrs, 'aria-controls')?.startsWith('owner-nav-'));
const toggle = (html: string) => buttons(html).find((b) => attr(b.attrs, 'aria-controls') === 'owner-mobile-nav')!;
const hrefs = (html: string) => links(html).map((l) => attr(l.attrs, 'href'));

const ALL_ON = { coffeePass: true, marketing: true, attendance: true };

describe('OwnerHeader first paint', () => {
  it('is one navigation landmark, with the brand outside it', () => {
    const html = render();
    expect(html.match(/aria-label="Owner navigation"/g)).toHaveLength(1);
    expect(html.match(/<nav\b/g)).toHaveLength(1);
    const navStart = html.indexOf('<nav');
    const inside = html.slice(navStart, html.indexOf('</nav>'));
    // The brand is the logo image (alt "HIOC") and an "Owner" label, both ahead of the <nav>.
    const logo = html.match(/<img\b[^>]*>/)![0];
    expect(attr(logo, 'alt')).toBe('HIOC');
    expect(html.indexOf(logo)).toBeLessThan(navStart);
    expect(html.indexOf('>Owner</span>')).toBeGreaterThan(-1);
    expect(html.indexOf('>Owner</span>')).toBeLessThan(navStart);
    expect(inside).not.toContain('<img');
    expect(inside).not.toContain('>Owner</span>');
    expect(inside).not.toContain('HIOC Owner');
  });

  it('makes the brand one link to the Overview, with a name of its own and no aria-current', () => {
    const html = render('/owner/payments');
    const brand = links(html)[0];
    expect(attr(brand.attrs, 'href')).toBe('/owner');
    expect(attr(brand.attrs, 'href')).toBe(ownerNav(ALL_ON).overview.href);
    expect(attr(brand.attrs, 'aria-label')).toBe('HIOC Owner – Overview');
    expect(brand.inner).toContain('<img');
    expect(brand.text).toBe('Owner');
    // Even on the Overview the nav's own item carries aria-current, not the brand.
    expect(attr(links(render('/owner'))[0].attrs, 'aria-current')).toBeUndefined();
  });

  it('points the brand at the Overview on the owner subdomain', () => {
    expect(attr(links(render('/payments', 'owner'))[0].attrs, 'href')).toBe('/');
  });

  it('is the staff header\'s charcoal bar: solid, sticky, no blur', () => {
    const header = render().match(/<header\b[^>]*>/)![0];
    const classes = attr(header, 'class')!.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['bg-charcoal', 'text-cream', 'sticky', 'top-0']));
    expect(classes).not.toContain('backdrop-blur');
    expect(classes.some((c) => c.startsWith('bg-cream'))).toBe(false);
  });

  it('stays hidden when printed (the GST report prints)', () => {
    expect(render()).toMatch(/<header class="[^"]*\bprint:hidden\b/);
  });

  it('gives each section a collapsed disclosure button — never a menu', () => {
    const html = render();
    const t = triggers(html);
    expect(t.map((b) => b.text.replace(/\s*\(current section\)/, ''))).toEqual(['Sales', 'Menu', 'Customers', 'Team', 'Setup']);
    for (const b of t) {
      expect(attr(b.attrs, 'type')).toBe('button');
      expect(attr(b.attrs, 'aria-expanded')).toBe('false');
      expect(attr(b.attrs, 'aria-controls')).toMatch(/^owner-nav-(sales|menu|customers|team|setup)$/);
    }
    expect(html).not.toContain('role="menu');
    expect(html).not.toContain('aria-haspopup');
    // …and the phone toggle is collapsed too.
    expect(attr(toggle(html).attrs, 'aria-expanded')).toBe('false');
  });

  it('renders every closed panel in the page, hidden, as a plain list of links', () => {
    const html = render();
    for (const b of triggers(html)) {
      const id = attr(b.attrs, 'aria-controls')!;
      // Each button points at a list that exists and is hidden by the attribute.
      expect(html).toMatch(new RegExp(`<ul id="${id}" hidden=""`));
    }
    // The panel's links sit inside that list, in the nav config's order.
    const sales = html.slice(html.indexOf('<ul id="owner-nav-sales"'), html.indexOf('<ul id="owner-nav-menu"'));
    expect(hrefs(sales)).toEqual(['/owner/reports', '/owner/payments', '/owner/online', '/owner/cash']);
  });

  it('never puts a display class on an element that is hidden by the attribute', () => {
    // `hidden` is only display:none until a utility such as `flex` sets display.
    const html = render();
    const hiddenTags = html.match(/<[a-z]+\b[^>]*\shidden=""[^>]*>/g) ?? [];
    expect(hiddenTags.length).toBeGreaterThan(0);
    for (const t of hiddenTags) {
      const classes = (attr(t, 'class') ?? '').split(/\s+/);
      expect(classes.filter((c) => /^(block|inline|inline-block|inline-flex|flex|grid|inline-grid|contents|table)$/.test(c))).toEqual([]);
    }
  });

  it('contains every page, plus Overview and the Staff board, even though all panels are closed', () => {
    const html = render();
    const all = ownerNav(ALL_ON);
    const expected = [all.overview, ...all.groups.flatMap((g) => g.items), all.staffBoard].map((l) => l.href);
    expect(expected.length).toBeGreaterThanOrEqual(21); // none of the old header's 21 links is lost
    for (const href of expected) expect(hrefs(html)).toContain(href);
  });

  it('shows no badge on first paint (the count arrives from an effect)', () => {
    const html = render('/owner/menu');
    expect(html).not.toContain('menu changes waiting');
  });

  it('is identical every time it is rendered for the same page (nothing reads the window)', () => {
    expect(render('/owner/reviews')).toBe(render('/owner/reviews'));
  });
});

describe('the open page', () => {
  it('marks the Payments link and the Sales section, and nothing else', () => {
    const html = render('/owner/payments');
    const current = links(html).filter((l) => attr(l.attrs, 'aria-current') === 'page');
    expect(current.length).toBeGreaterThan(0); // the panel's link and the drawer's
    expect(new Set(current.map((l) => attr(l.attrs, 'href')))).toEqual(new Set(['/owner/payments']));
    expect(current.every((l) => l.text.startsWith('Payments'))).toBe(true);

    const marked = triggers(html).filter((b) => b.text.includes('(current section)'));
    expect(marked).toHaveLength(1);
    expect(attr(marked[0].attrs, 'aria-controls')).toBe('owner-nav-sales');
    expect(marked[0].text).toBe('Sales (current section)');
    // The active look: a cream/10 fill, white text (tan text on it fails AA contrast) and a tan bar.
    expect(attr(marked[0].attrs, 'class')).toContain('bg-cream/10 text-cream');
    expect(attr(marked[0].attrs, 'class')).toContain('after:bg-tan');
    expect(attr(marked[0].attrs, 'class')).not.toContain('text-tan');
  });

  it('shows the page name on the phone toggle, ahead of a spoken prefix', () => {
    const t = toggle(render('/owner/payments'));
    expect(t.text).toBe('Owner sections, current page: Payments');
    expect(t.inner).toContain('<span class="sr-only">Owner sections, current page: </span>');
    expect(attr(t.attrs, 'aria-controls')).toBe('owner-mobile-nav');
  });

  it('keeps a page inside a section lit by its subtree (Reports on its GST report)', () => {
    const html = render('/owner/reports/gst');
    expect(toggle(html).text).toContain('Reports');
    expect(triggers(html).filter((b) => b.text.includes('(current section)'))).toHaveLength(1);
  });

  it('lights Overview alone on the root, and no section', () => {
    const html = render('/owner');
    const current = links(html).filter((l) => attr(l.attrs, 'aria-current') === 'page');
    expect(new Set(current.map((l) => attr(l.attrs, 'href')))).toEqual(new Set(['/owner']));
    expect(toggle(html).text).toContain('Overview');
    expect(html).not.toContain('(current section)');
  });

  it('falls back to "Sections" for a page that is not in the nav', () => {
    const html = render('/owner/somewhere-new');
    expect(toggle(html).text).toBe('Owner Sections');
    expect(html).not.toContain('aria-current');
    expect(html).not.toContain('(current section)');
  });
});

describe('flags', () => {
  it('drops Attendance, Payroll and Cash with the attendance flag off, and Team becomes a plain link', () => {
    flagState.attendance = false;
    const html = render('/owner/staff');
    for (const gone of ['/owner/attendance', '/owner/payroll', '/owner/cash']) expect(hrefs(html)).not.toContain(gone);
    expect(hrefs(html)).toContain('/owner/staff');
    // One page: no button, no panel — a link, marked as the open page.
    expect(triggers(html).map((b) => attr(b.attrs, 'aria-controls'))).toEqual([
      'owner-nav-sales',
      'owner-nav-menu',
      'owner-nav-customers',
      'owner-nav-setup',
    ]);
    expect(html).not.toContain('owner-nav-team');
    const team = links(html).filter((l) => attr(l.attrs, 'href') === '/owner/staff');
    expect(team.every((l) => attr(l.attrs, 'aria-current') === 'page')).toBe(true);
    // The phone drawer still gives it a heading of its own.
    expect(html).toContain('id="owner-mobile-nav-team-heading"');
  });

  it('drops HIOC Ritual and Marketing with their flags off', () => {
    flagState.coffeePass = false;
    flagState.marketing = false;
    const html = render();
    expect(hrefs(html)).not.toContain('/owner/passes');
    expect(hrefs(html)).not.toContain('/owner/marketing');
    expect(hrefs(html)).toContain('/owner/promotions');
  });
});

describe('the phone drawer', () => {
  it('gives every section a heading and a list it labels, and ends with the Staff board', () => {
    const html = render('/owner/customers');
    const drawer = html.slice(html.indexOf('<div class="animate-fade-in lg:hidden">'), html.indexOf('</nav>'));
    for (const g of ownerNav(ALL_ON).groups) {
      const id = `owner-mobile-nav-${g.id}-heading`;
      expect(drawer).toMatch(new RegExp(`<p id="${id}" class="[^"]*uppercase[^"]*">${g.label}</p>`));
      expect(drawer).toContain(`aria-labelledby="${id}"`);
    }
    const last = links(drawer).at(-1)!;
    expect(attr(last.attrs, 'href')).toBe('/staff');
    expect(last.text).toBe('Staff board');
    expect(last.inner).toContain('aria-hidden="true"'); // the arrow icon
  });

  it('is closed on first paint: the nav is display:none below lg, the toggle says so', () => {
    const html = render();
    const navTag = html.match(/<nav\b[^>]*>/)![0];
    expect(attr(navTag, 'id')).toBe('owner-mobile-nav');
    expect(attr(navTag, 'class')!.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:block']));
    expect(attr(navTag, 'class')!.split(/\s+/)).not.toContain('block');
  });
});

describe('on the owner subdomain', () => {
  it('resolves hrefs for the surface and still finds the open page', () => {
    const html = render('/payments', 'owner');
    expect(hrefs(html)).toContain('/payments');
    expect(hrefs(html)).toContain('/menu');
    expect(hrefs(html)).toContain('/'); // Overview
    // Only the Staff board leaves the surface, and it keeps its full path.
    expect(hrefs(html).filter((h) => h!.startsWith('/owner'))).toEqual([]);
    expect(hrefs(html)).toContain('/staff');

    const current = links(html).filter((l) => attr(l.attrs, 'aria-current') === 'page');
    expect(new Set(current.map((l) => attr(l.attrs, 'href')))).toEqual(new Set(['/payments']));
    expect(toggle(html).text).toBe('Owner sections, current page: Payments');
    const marked = triggers(html).filter((b) => b.text.includes('(current section)'));
    expect(marked.map((b) => attr(b.attrs, 'aria-controls'))).toEqual(['owner-nav-sales']);
  });

  it('lights Overview on the bare root, not every page', () => {
    const html = render('/', 'owner');
    const current = links(html).filter((l) => attr(l.attrs, 'aria-current') === 'page');
    expect(new Set(current.map((l) => attr(l.attrs, 'href')))).toEqual(new Set(['/']));
    expect(toggle(html).text).toContain('Overview');
  });

  it('lights Menu on /menu/anything', () => {
    const html = render('/menu/requests', 'owner');
    const current = links(html).filter((l) => attr(l.attrs, 'aria-current') === 'page');
    expect(new Set(current.map((l) => attr(l.attrs, 'href')))).toEqual(new Set(['/menu']));
    expect(toggle(html).text).toContain('Menu');
  });
});
