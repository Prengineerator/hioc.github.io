'use client';

// Account → Profile: "Offers as phone notifications" for this device, with a link
// to turn them off on every device. Renders nothing while the flag is off.

import { IosInstallHowTo } from './IosInstallHowTo';
import { usePush } from './usePush';

export function PushProfileSwitch() {
  const { view, devices, busy, error, enable, disable, disableAll } = usePush('profile');
  if (view === 'loading' || view === 'hidden') return null;

  const usable = view === 'on' || view === 'off';
  return (
    <div className="rounded-md border border-line bg-cream p-5 shadow-sm">
      <label className="flex min-h-[44px] items-center gap-3 text-base text-charcoal">
        <input
          type="checkbox"
          role="switch"
          checked={view === 'on'}
          disabled={busy || !usable}
          onChange={() => (view === 'on' ? void disable() : void enable())}
          className="h-5 w-5 accent-tan-dark"
        />
        Offers as phone notifications
      </label>
      <div className="mt-1 text-sm text-muted">
        {view === 'ios_install' ? <IosInstallHowTo /> : null}
        {view === 'unsupported' ? <p>This browser cannot show notifications.</p> : null}
        {view === 'denied' ? <p>Notifications are blocked for hioc.in. Allow them in your browser or phone settings, then come back.</p> : null}
        {usable ? <p>{view === 'on' ? 'On for this phone.' : 'Off for this phone.'}</p> : null}
      </div>
      {devices > 0 ? (
        <button
          type="button"
          onClick={() => void disableAll()}
          disabled={busy}
          className="mt-2 inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline disabled:opacity-60"
        >
          Turn off on all my devices
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
