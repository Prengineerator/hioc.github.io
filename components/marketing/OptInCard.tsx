'use client';

// The customer opt-in card on the order page (docs/MARKETING-AGENT-SPEC.md §2).
// It sits BELOW the order details and stays quiet: while it is loading, when the
// marketing flag is off, when the customer has already opted in, and on any
// failure, it renders nothing — an order page must never grow an error box, or a
// nag, because of an optional offer.
//
// Consent rules it keeps: never pre-ticked, one explicit tap, and the wording says
// what they are agreeing to (offers and points reminders, on WhatsApp, at most one
// a week) and how to stop. The logged-in path saves through the same
// PATCH /api/account/me the Account page uses; the server records the opt-in
// against the customer's verified phone. Everyone else gets a wa.me link that opens
// WhatsApp with START ready to send: the customer sends it, and the webhook records
// the opt-in.

import { useEffect, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { flags } from '@/lib/flags';
import type { PublicOptinResponse } from '@/lib/marketing/types';
import { chooseOptInMode, classifyMe, usableWaLink, type AccountMe, type OptInMode } from './optInLogic';

type View = OptInMode | 'loading' | 'thanks';

async function getJson<T>(path: string, cache: RequestCache = 'no-store'): Promise<T | null> {
  try {
    const res = await fetch(path, { cache });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function OptInCard() {
  const [view, setView] = useState<View>('loading');
  const [waLink, setWaLink] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!flags.marketing) {
      setView('none');
      return;
    }
    let cancelled = false;
    (async () => {
      // /api/account/me answers 401 for a guest — that is the normal "not signed in" case, not an error to report.
      const me = await getJson<AccountMe>('/api/account/me');
      const verdict = classifyMe(me);
      const optin = verdict === 'no_profile_path' ? await getJson<PublicOptinResponse>('/api/marketing/optin', 'default') : null;
      if (cancelled) return;
      setWaLink(usableWaLink(optin));
      setView(chooseOptInMode(verdict, optin));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const accept = async () => {
    setSaving(true);
    setError(false);
    try {
      const res = await fetch('/api/account/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketing_consent: true }),
      });
      if (res.ok) setView('thanks');
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  if (view === 'loading' || view === 'none') return null;

  return (
    <section aria-label="WhatsApp offers" className="mt-8 rounded-md border border-line bg-surface p-5 text-center">
      {view === 'thanks' ? (
        <p role="status" className="text-sm text-charcoal">
          <span className="font-bold">You&apos;re on the list.</span> We&apos;ll send offers and points reminders on WhatsApp, at most one a week. Reply STOP any time to unsubscribe.
        </p>
      ) : view === 'profile' ? (
        <>
          <p className="text-sm text-charcoal">
            Get offers &amp; points reminders from HIOC on WhatsApp <span aria-hidden="true">&mdash;</span> at most one a week. Reply STOP anytime.
          </p>
          <div className="mt-3">
            <Button size="sm" onClick={accept} loading={saving}>
              Yes, send me offers
            </Button>
          </div>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-red-700">
              Sorry, we couldn&apos;t save that. Please try again.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-sm text-charcoal">
            Want offers &amp; points reminders from HIOC on WhatsApp? At most one a week, and you can reply STOP anytime.
          </p>
          <div className="mt-3">
            <a
              href={waLink ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              Get offers on WhatsApp
            </a>
          </div>
          <p className="mt-2 text-xs text-muted">Opens WhatsApp with START ready to send. Just tap send.</p>
        </>
      )}
    </section>
  );
}
