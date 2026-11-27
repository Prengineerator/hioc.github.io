'use client';

// One hook behind both places a customer can switch phone notifications on or off
// (the order page card and Account → Profile). Nothing here asks the browser for
// permission until enable() runs, and enable() runs only from a button tap.

import { useCallback, useEffect, useState } from 'react';
import { flags } from '@/lib/flags';
import { pushAvailability, readPushEnv, urlBase64ToUint8Array } from '@/lib/push/client';
import type { PushStatus } from '@/lib/push/types';

export type PushView =
  | 'loading'
  | 'hidden' // flag off, signed out, not set up: render nothing
  | 'unsupported'
  | 'ios_install'
  | 'denied'
  | 'off'
  | 'on';

type Source = 'order_page' | 'profile';

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

export function usePush(source: Source) {
  const [view, setView] = useState<PushView>('loading');
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!flags.webPush || !process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) return setView('hidden');
    const availability = pushAvailability(readPushEnv());
    try {
      let endpoint = '';
      if (availability === 'ok' || availability === 'denied') {
        endpoint = (await currentSubscription())?.endpoint ?? '';
      }
      const res = await fetch('/api/account/push/status', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      });
      if (!res.ok) return setView('hidden'); // 401 signed out, 404 flag off, 409 not set up
      const status = (await res.json()) as PushStatus;
      setDevices(status.devices);
      if (status.subscribed && availability === 'ok') return setView('on');
      setView(availability === 'ok' ? 'off' : availability);
    } catch {
      setView('hidden');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    setError('');
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setView(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '') as BufferSource,
        }));
      const res = await fetch('/api/account/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sub.toJSON(), source }),
      });
      if (!res.ok) {
        await sub.unsubscribe().catch(() => undefined);
        setError('Sorry, we could not turn that on. Please try again.');
        return;
      }
      setView('on');
      setDevices((n) => n + 1);
    } catch {
      setError('Sorry, we could not turn that on. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [source]);

  const disable = useCallback(async () => {
    setError('');
    setBusy(true);
    try {
      const sub = await currentSubscription();
      if (sub) {
        const res = await fetch('/api/account/push', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint, source }),
        });
        if (!res.ok) throw new Error('delete failed');
        await sub.unsubscribe().catch(() => undefined);
      }
      setView('off');
      setDevices((n) => Math.max(0, n - 1));
    } catch {
      setError('Sorry, we could not turn that off. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [source]);

  const disableAll = useCallback(async () => {
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/account/push', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, source }),
      });
      if (!res.ok) throw new Error('delete failed');
      const sub = await currentSubscription();
      await sub?.unsubscribe().catch(() => undefined);
      setView('off');
      setDevices(0);
    } catch {
      setError('Sorry, we could not turn that off. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [source]);

  return { view, devices, busy, error, enable, disable, disableAll };
}
