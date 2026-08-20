'use client';

// DEV-3 — "what does THIS machine do by default?", read once per surface.
//
// Two surfaces settle orders and therefore two surfaces print: the POS
// (PosOrderEntry) and the order queue's detail modal. They used to each fetch
// /api/store-settings and call readAutoPrintSettings on the result. With a
// device layer on top that would be the same three-way resolution written
// twice, and the failure it invites is the quiet kind — the counter honours the
// device's "never print" and the queue doesn't, so paper appears depending on
// which button someone used.
//
// Both failures fail SOFT and identically: a store read that fails leaves the
// documented AUTO_PRINT_DEFAULTS, and a device read that fails leaves the
// machine anonymous (store-level behaviour). Neither can stop the counter
// selling, which is the only requirement that matters here.

import { useEffect, useState } from 'react';
import { AUTO_PRINT_DEFAULTS, type AutoPrintSettings } from '@/lib/staff/autoPrint';
import { resolveAutoPrint } from '@/lib/pos/deviceSettings';
import type { PosDeviceContext, StoreSettings } from '@/lib/types';

export interface CounterDefaults {
  /** Device override → store setting → documented default. */
  autoPrint: AutoPrintSettings;
  /** The enrolled machine, or null on a personal phone / unenrolled browser. */
  device: PosDeviceContext | null;
  /** False until both reads have settled, so a caller can avoid acting on the
   *  pre-fetch defaults (the POS uses it to decide whether to seed a control). */
  ready: boolean;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function useCounterDefaults(): CounterDefaults {
  const [state, setState] = useState<CounterDefaults>({
    autoPrint: AUTO_PRINT_DEFAULTS,
    device: null,
    ready: false,
  });

  useEffect(() => {
    let cancelled = false;
    // In parallel: neither answer depends on the other, and this sits on the
    // boot path of the screen someone is waiting to take an order on.
    void Promise.all([
      getJson<{ settings?: StoreSettings }>('/api/store-settings'),
      getJson<{ device?: PosDeviceContext | null }>('/api/device/context'),
    ]).then(([store, ctx]) => {
      if (cancelled) return;
      const device = ctx?.device ?? null;
      setState({ autoPrint: resolveAutoPrint(store?.settings, device), device, ready: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
