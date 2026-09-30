'use client';

// The customer behind the phone on the Ritual passes screen: what they hold,
// what they still owe (GET /api/passes/holder), plus a name to offer when no
// HIOC account holds the number yet (GET /api/customers/lookup, the same recall
// New order uses: a past order's name, or the old POS's).
//
// Same 350 ms debounce as New order's lookup, so a number being typed does not
// fire a request per digit. `refresh` re-reads at once (after a payment, an
// extension) and keeps what is on screen while it does, so the card does not
// flash to a skeleton after every action.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HolderPass, HolderResponse } from '@/lib/pos/ritual';

export type HolderState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; holder: HolderResponse }
  | { status: 'error'; message: string };

const DEBOUNCE_MS = 350;

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? fallback;
}

export function useHolderLookup(lookupPhone: string) {
  const [state, setState] = useState<HolderState>({ status: 'idle' });
  const [nameHint, setNameHint] = useState('');
  const requestId = useRef(0);
  const phoneRef = useRef(lookupPhone);
  phoneRef.current = lookupPhone;

  const load = useCallback(async (phone: string, quiet: boolean): Promise<HolderResponse | null> => {
    const id = ++requestId.current;
    if (!quiet) setState({ status: 'loading' });
    try {
      const res = await fetch(`/api/passes/holder?phone=${phone}`, { cache: 'no-store' });
      if (id !== requestId.current) return null;
      if (!res.ok) {
        const message = await readError(res, 'Could not look up this customer. Try again.');
        if (id !== requestId.current) return null;
        setState({ status: 'error', message });
        return null;
      }
      const holder = (await res.json()) as HolderResponse;
      if (id !== requestId.current) return null;
      setState({ status: 'ready', holder });
      return holder;
    } catch {
      if (id !== requestId.current) return null;
      setState({ status: 'error', message: 'Could not reach the server. Check the connection and try again.' });
      return null;
    }
  }, []);

  useEffect(() => {
    if (!lookupPhone) {
      requestId.current += 1; // drop anything still in flight for the old number
      setState({ status: 'idle' });
      setNameHint('');
      return undefined;
    }
    setState({ status: 'loading' });
    // Forget the last number's name, so the same name arriving for this one still counts as new.
    setNameHint('');
    const t = setTimeout(() => {
      void load(lookupPhone, true);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [lookupPhone, load]);

  // A number no HIOC account holds: offer the name a past order used, if any.
  // An account's own name comes with the holder response instead.
  useEffect(() => {
    if (state.status !== 'ready') return undefined;
    if (state.holder.found) {
      setNameHint(state.holder.name);
      return undefined;
    }
    let cancelled = false;
    fetch(`/api/customers/lookup?phone=${lookupPhone}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { found?: boolean; name?: string } | null) => {
        if (!cancelled) setNameHint(data?.found && data.name ? data.name.trim() : '');
      })
      .catch(() => {
        if (!cancelled) setNameHint('');
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the holder object: a refresh of the same number re-asks, which is cheap.
  }, [state, lookupPhone]);

  const refresh = useCallback(async () => {
    const phone = phoneRef.current;
    if (!phone) return null;
    return load(phone, true);
  }, [load]);

  /** Swap one pass in the loaded holder (after an extension) without a re-read. */
  const patchPass = useCallback((pass: Omit<HolderPass, 'history'>) => {
    setState((cur) =>
      cur.status === 'ready' && cur.holder.found
        ? {
            status: 'ready',
            holder: {
              ...cur.holder,
              passes: cur.holder.passes.map((p) => (p.id === pass.id ? { ...pass, history: p.history } : p)),
            },
          }
        : cur,
    );
  }, []);

  return { state, nameHint, refresh, patchPass };
}
