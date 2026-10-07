import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The counter lock (components/staff/CashDayGate.tsx): on a POS screen it shows
// the cash drawer and what to do instead of the page until the cash day is in
// order; on the cash drawer, attendance and setup pages it never gets in the
// way. The step comes from the server on first render (no flash of the POS).

const nav = { pathname: '/staff' };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { CashDayGate } from '@/components/staff/CashDayGate';
import type { CashDayGateStep } from '@/lib/cash/autoEnd';

function render(step: CashDayGateStep, pathname = '/staff') {
  nav.pathname = pathname;
  return renderToStaticMarkup(
    createElement(CashDayGate, { initialStep: step, initialEndsAt: null, children: createElement('p', null, 'THE POS') }),
  );
}

describe('CashDayGate', () => {
  it('shows the page while the day is open', () => {
    expect(render(null)).toContain('THE POS');
  });

  it('asks to open today before the POS, every day', () => {
    const html = render('open');
    expect(html).not.toContain('THE POS');
    expect(html).toContain('Open today&#x27;s cash day to start.');
    expect(html).toContain('Loading cash day'); // the cash drawer screen, loading
  });

  it('asks to count and close a day left open first', () => {
    const html = render('close_overdue', '/staff/orders/new');
    expect(html).not.toContain('THE POS');
    expect(html).toContain('The last cash day was never closed.');
    expect(html).toContain('It ended on its own at 3:00 am.');
  });

  it('never covers the cash drawer, attendance or setup pages', () => {
    for (const p of ['/staff/cash', '/staff/attendance', '/staff/settings']) {
      expect(render('close_overdue', p)).toContain('THE POS');
    }
  });
});
