'use client';

// Small React hooks shared by the marketing tabs.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isAborted, requestJson, type ApiFailure } from './api';

export type ApiState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: ApiFailure };

export interface ApiResource<T> {
  state: ApiState<T>;
  /** Fetch again. The data already on screen stays put until the new answer arrives (no flash of spinner). */
  reload: () => void;
  /** Replace the data locally (after a save that returned the new row) without another round trip. */
  setData: (data: T) => void;
  /**
   * Change the data on screen from what is there NOW, not from what a click handler saw when it was
   * created: two saves finishing out of order must not overwrite each other with a stale copy.
   */
  update: (change: (current: T) => T) => void;
}

/**
 * GET `path` and keep the result. `null` = don't fetch yet. Changing `path` goes
 * back to loading (it is a different question); `reload()` does not (it is the
 * same question asked again). An in-flight request is aborted when the path
 * changes or the component unmounts, so a slow answer can never overwrite a
 * newer one or set state on a screen that is gone.
 */
export function useApi<T>(path: string | null): ApiResource<T> {
  const [state, setState] = useState<ApiState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (path === null) return;
    const ac = new AbortController();
    if (lastPath.current !== path) setState({ status: 'loading' });
    lastPath.current = path;
    requestJson<T>(path, { signal: ac.signal }).then((r) => {
      if (ac.signal.aborted) return;
      if (r.ok) setState({ status: 'ready', data: r.data });
      else if (!isAborted(r.error)) setState({ status: 'error', error: r.error });
    });
    return () => ac.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((data: T) => setState({ status: 'ready', data }), []);
  const update = useCallback(
    (change: (current: T) => T) => setState((s) => (s.status === 'ready' ? { status: 'ready', data: change(s.data) } : s)),
    [],
  );
  return { state, reload, setData, update };
}

/** The rendered width of an element, updated as it resizes (a phone rotating, a sidebar opening). */
export function useElementWidth(ref: RefObject<HTMLElement>, fallback = 320): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width) || fallback);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return width;
}

/** A value that follows `value` after it has stopped changing for `ms` — for the wizard's live projection (spec: 400 ms). */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
