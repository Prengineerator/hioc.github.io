'use client';

import { useCallback, useEffect, useState } from 'react';
import { flags } from '@/lib/flags';
import type { RitualOffer } from '@/lib/passes/ui';

// One read of GET /api/passes/plans (public) shared by everything on a page that
// needs to know "is a Ritual on sale?": the menu's "Ritual" chips, the checkout's
// "Save with HIOC Ritual" link and the /ritual page itself. The answer is kept for
// the life of the page (a module-level promise), so the menu does not ask once per
// item and the checkout does not ask again after the menu did. A failed read is
// never remembered: the next caller tries again.

let inflight: Promise<RitualOffer | null> | null = null;

function fetchOffer(): Promise<RitualOffer | null> {
  const request = fetch('/api/passes/plans', { cache: 'no-store' })
    .then((res) => (res.ok ? (res.json() as Promise<Partial<RitualOffer>>) : null))
    .then((data): RitualOffer | null => {
      if (!data || !Array.isArray(data.plans)) return null;
      return {
        plans: data.plans,
        eligible: Array.isArray(data.eligible) ? data.eligible : [],
        online_purchase: data.online_purchase === true,
        gst: data.gst ?? { percent: 0, inclusive: true },
      };
    })
    .catch(() => null);
  inflight = request;
  // Forget a failure so a later caller retries instead of inheriting it.
  void request.then((offer) => {
    if (offer === null && inflight === request) inflight = null;
  });
  return request;
}

/** The plans on sale, from the page-wide cache; `fresh` forces a new read (the /ritual page does). */
export function loadRitualOffer(fresh = false): Promise<RitualOffer | null> {
  if (fresh || !inflight) return fetchOffer();
  return inflight;
}

export type RitualOfferStatus = 'off' | 'loading' | 'ready' | 'error';

/**
 * The Ritual offer for a client component. Reads nothing (status 'off') while the
 * feature flag is off or `enabled` is false, so a page that mounts this costs no
 * request in those cases.
 */
export function useRitualOffer(opts: { fresh?: boolean; enabled?: boolean } = {}): {
  status: RitualOfferStatus;
  offer: RitualOffer | null;
  reload: () => void;
} {
  const fresh = opts.fresh === true;
  const active = flags.coffeePass && opts.enabled !== false;
  const [state, setState] = useState<{ status: RitualOfferStatus; offer: RitualOffer | null }>({
    status: active ? 'loading' : 'off',
    offer: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading', offer: null }));
    loadRitualOffer(fresh || attempt > 0).then((offer) => {
      if (cancelled) return;
      setState(offer ? { status: 'ready', offer } : { status: 'error', offer: null });
    });
    return () => {
      cancelled = true;
    };
  }, [active, fresh, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reload };
}
