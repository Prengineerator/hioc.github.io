'use client';

// Closed/paused/after-cutoff banner (C3). Shown on /menu and /checkout
// whenever openState.acceptingOrders is false, so customers understand why
// checkout is disabled instead of hitting a surprise 409 at the end. When the
// opening hours say when the cafe opens next (openState.nextOpenLabel, from
// lib/store/hours.ts) the banner says so; it stays silent about it for a pause
// or a forced close, where nobody knows.

import type { StoreOpenState } from '@/lib/store/hours';

const REASON_COPY: Record<StoreOpenState['reason'], string> = {
  open: '',
  paused: 'We are not accepting online orders right now. Please check back shortly.',
  closed_hours: 'We are currently closed.',
  holiday: 'We are closed today for a holiday.',
  forced_closed: 'We are currently closed. Please check back later.',
  after_cutoff: 'Online orders for today are closed.',
};

export function StoreStatusBanner({ openState }: { openState: StoreOpenState | null }) {
  if (!openState || openState.acceptingOrders) return null;

  return (
    <div
      role="alert"
      className="mb-6 flex items-center justify-center gap-2 rounded-md border border-tan bg-surface px-4 py-3 text-center text-sm font-semibold text-charcoal"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0 text-tan-dark">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        {REASON_COPY[openState.reason]}
        {openState.nextOpenLabel ? ` ${openState.nextOpenLabel}.` : ''}
      </span>
    </div>
  );
}
