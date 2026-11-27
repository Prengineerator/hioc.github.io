'use client';

// Offers as phone notifications, on the order page under the WhatsApp card
// (docs/WEB-PUSH-SPEC.md). Quiet like that card: renders nothing while loading,
// with the flag off, signed out, unsupported, or already on. The browser's
// "Allow notifications?" question is asked only after the tap on the button.

import { Button } from '@/components/ui/Button';
import { IosInstallHowTo } from './IosInstallHowTo';
import { usePush } from './usePush';

export function PushOptInCard() {
  const { view, busy, error, enable } = usePush('order_page');
  if (view === 'loading' || view === 'hidden' || view === 'unsupported') return null;

  return (
    <section aria-label="Offers as phone notifications" className="mt-4 rounded-md border border-line bg-surface p-5 text-center">
      {view === 'on' ? (
        <p role="status" className="text-sm text-charcoal">
          <span className="font-bold">Notifications are on.</span> You can switch them off any time on Account, Profile.
        </p>
      ) : view === 'ios_install' ? (
        <>
          <p className="mb-2 text-sm font-bold text-charcoal">Get offers as notifications</p>
          <IosInstallHowTo />
        </>
      ) : view === 'denied' ? (
        <p className="text-sm text-charcoal">Notifications are blocked for hioc.in in this browser. To get offers this way, allow them in the browser or phone settings.</p>
      ) : (
        <>
          <p className="text-sm text-charcoal">Want our offers as notifications on this phone? Free, and you can switch them off any time.</p>
          <div className="mt-3">
            <Button size="sm" variant="secondary" onClick={enable} loading={busy}>
              Get offers as notifications
            </Button>
          </div>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
