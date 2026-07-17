'use client';

// Closed/paused/after-cutoff banner (C3). Shown on /menu and /checkout
// whenever openState.acceptingOrders is false, so customers understand why
// checkout is disabled instead of hitting a surprise 409 at the end.

import type { StoreOpenState } from '@/lib/store/hours';

const REASON_COPY: Record<StoreOpenState['reason'], string> = {
  open: '',
  paused: 'We are not accepting online orders right now — please check back shortly.',
  closed_hours: 'We are currently closed. Please order during opening hours.',
  holiday: 'We are closed today for a holiday. Please check back another day.',
  forced_closed: 'We are currently closed. Please check back later.',
  after_cutoff: 'Online orders for today are closed — please try again tomorrow.',
};

export function StoreStatusBanner({ openState }: { openState: StoreOpenState | null }) {
  if (!openState || openState.acceptingOrders) return null;

  return (
    <div
      role="alert"
      className="mb-6 rounded-md border border-tan bg-[#f6efe9] px-4 py-3 text-center text-sm font-bold text-charcoal"
    >
      {REASON_COPY[openState.reason]}
    </div>
  );
}
