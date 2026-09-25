'use client';

// PIN-2 — the lock/switch screen: tiles for each active staff member with a
// PIN set, tap → 4-digit PIN pad, success → operator unlocked.
//
// Used two ways by app/staff/layout.tsx / StaffPinOverlay:
//  - `fullScreen` (no session at all yet — middleware.ts let a session-less,
//    enrolled-device request through for exactly this): fills the whole
//    viewport, no header, nothing behind it.
//  - overlay (default): a fixed layer over an already-rendered page, so an
//    in-progress cart underneath survives a re-lock (spec E5 — the cart is
//    client state and this never unmounts it).
//
// GET /api/device/operator (tiles) and POST (verify) are both reachable with
// no session at all — see that route's own comment for why that is the one
// deliberate exception to "a device cookie must never authorise anything".
//
// Owner field report (Sept 2026): "Login at POS is not... taking keyboard
// input as the login PIN" — this used to be tap/click only. Every digit,
// Backspace, Escape and Enter now works from a physical/on-screen keyboard
// too (pinKeyAction, lib/staff/pinUi.ts), and the tile screen supports
// type-ahead-by-first-letter plus arrow-key navigation, on top of the native
// Tab/Enter/Space every <button> already gets for free.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  appendPinDigit,
  filterOperatorsByName,
  nextTileIndexForArrow,
  nextTileIndexForLetter,
  pinKeyAction,
  type TileArrowKey,
} from '@/lib/staff/pinUi';

const PIN_LENGTH = 4;
/** Past this many tiles, scanning by eye stops being the fastest way to find
 * a name — a filter box beats scrolling/squinting at a wall of tiles. */
const FILTER_THRESHOLD = 9;
/** Must match the grid's actual `sm:grid-cols-3` breakpoint below — arrow-key
 * navigation needs the real column count to move up/down a row correctly. */
const WIDE_COLUMNS_QUERY = '(min-width: 640px)';

interface Operator {
  id: string;
  name: string;
}

function initialsFor(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

export function LockScreen({
  deviceName,
  fullScreen,
  onUnlocked,
}: {
  deviceName: string;
  fullScreen?: boolean;
  /** Called (in addition to router.refresh()) right after a successful
   * unlock, for a caller that wants to update local state immediately
   * rather than wait on the refresh round trip. */
  onUnlocked?: (operatorName: string) => void;
}) {
  const router = useRouter();
  const [operators, setOperators] = useState<Operator[] | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [selected, setSelected] = useState<Operator | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Bumped on every failed attempt; used as a React `key` on the PIN-dot row
  // so each new failure remounts it and replays the shake animation, rather
  // than needing a setTimeout to reset a boolean.
  const [shakeToken, setShakeToken] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [columns, setColumns] = useState(3);
  const [now, setNow] = useState<Date | null>(null);

  // Refs mirroring the state the global keydown listener needs, so that
  // listener can be attached ONCE (stable deps) instead of re-subscribing on
  // every keystroke/digit/focus change — see the effect below.
  const submittingRef = useRef(false);
  const selectedRef = useRef<Operator | null>(null);
  const focusedIndexRef = useRef(0);
  const columnsRef = useRef(3);
  const operatorNamesRef = useRef<string[]>([]);
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // true right after mount (so the very first render autofocuses tile 0) and
  // again right after leaving the PIN screen — NOT on every keystroke in the
  // filter box, which would otherwise steal focus back to a tile mid-type.
  const refocusTilesRef = useRef(true);
  const lastSelectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/device/operator', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setOperators((data.operators as Operator[] | undefined) ?? []);
      })
      .catch(() => {
        if (!cancelled) setOperators([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live clock + date, header. Starts at null (not `new Date()` inline) so
  // the server-rendered/first-client-render markup never disagrees with a
  // moment later — same pattern as `operators === null` above.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Tracks whether the tile grid is currently 2 or 3 columns wide (matches
  // the `grid-cols-2 sm:grid-cols-3` classes on the grid itself) so arrow-key
  // up/down moves by the right number of tiles.
  useEffect(() => {
    const mq = window.matchMedia(WIDE_COLUMNS_QUERY);
    const update = () => setColumns(mq.matches ? 3 : 2);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);
  useEffect(() => {
    selectedRef.current = selected;
    if (selected) lastSelectedIdRef.current = selected.id;
  }, [selected]);
  useEffect(() => {
    focusedIndexRef.current = focusedIndex;
  }, [focusedIndex]);
  useEffect(() => {
    columnsRef.current = columns;
  }, [columns]);

  const filteredOperators = useMemo(
    () => filterOperatorsByName(operators ?? [], filterQuery),
    [operators, filterQuery],
  );
  useEffect(() => {
    operatorNamesRef.current = filteredOperators.map((op) => op.name);
  }, [filteredOperators]);

  // Autofocus tile 0 on first load, and again whenever we land back on the
  // tile screen (Back/Escape from the PIN pad) — but never mid-filter-typing.
  useEffect(() => {
    if (selected) return;
    if (!refocusTilesRef.current) return;
    if (filteredOperators.length === 0) return;
    refocusTilesRef.current = false;
    const wantId = lastSelectedIdRef.current;
    const idx = wantId ? Math.max(filteredOperators.findIndex((op) => op.id === wantId), 0) : 0;
    setFocusedIndex(idx);
    tileRefs.current[idx]?.focus();
  }, [selected, filteredOperators]);

  const submit = useCallback(
    async (nextPin: string, operator: Operator) => {
      submittingRef.current = true;
      setSubmitting(true);
      setError('');
      try {
        const res = await fetch('/api/device/operator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: operator.id, pin: nextPin }),
        });
        if (res.ok) {
          onUnlocked?.(operator.name);
          router.refresh();
          return;
        }
        const data = await res.json().catch(() => ({}));
        setError((data.error as string | undefined) ?? 'Could not unlock');
        setPin('');
        setShakeToken((t) => t + 1);
      } catch {
        setError('Network error — try again');
        setPin('');
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [onUnlocked, router],
  );

  // Auto-submits the instant the 4th digit lands, from EITHER input source
  // (tap or keyboard) — both just append to `pin` state, so there is exactly
  // one place that decides "that's 4 digits, go", which also means there is
  // exactly one place that needs the double-submit guard.
  useEffect(() => {
    if (!selected) return;
    if (pin.length !== PIN_LENGTH) return;
    if (submittingRef.current) return;
    void submit(pin, selected);
  }, [pin, selected, submit]);

  const pushDigit = useCallback((digit: string) => {
    if (submittingRef.current || !selectedRef.current) return;
    setPin((prev) => appendPinDigit(prev, digit, PIN_LENGTH));
  }, []);

  const backspace = useCallback(() => {
    if (submittingRef.current) return;
    setPin((prev) => prev.slice(0, -1));
  }, []);

  const goBackToTiles = useCallback(() => {
    if (submittingRef.current) return;
    refocusTilesRef.current = true;
    setSelected(null);
    setPin('');
    setError('');
  }, []);

  const focusTileIndex = useCallback((idx: number) => {
    setFocusedIndex(idx);
    tileRefs.current[idx]?.focus();
  }, []);

  function pickOperator(op: Operator, idx: number) {
    setSelected(op);
    setPin('');
    setError('');
    setFocusedIndex(idx);
  }

  // ONE global keydown listener for the whole component's lifetime — every
  // function it calls (pushDigit/backspace/goBackToTiles/focusTileIndex) is
  // stable, and everything else it reads comes from refs, so this never
  // needs to re-subscribe (and can never act on a stale `pin`/`selected`).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const modifiers = { ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey };

      if (selectedRef.current) {
        const action = pinKeyAction(event.key, modifiers);
        if (action.type === 'ignore') return;
        event.preventDefault();
        if (action.type === 'digit') pushDigit(action.digit);
        else if (action.type === 'backspace') backspace();
        else if (action.type === 'back') goBackToTiles();
        return;
      }

      // Tile screen. Let normal typing through to the filter input (or any
      // other field) rather than hijacking it for tile navigation.
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea') return;
      if (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey) return;

      const names = operatorNamesRef.current;
      if (names.length === 0) return;
      const from = Math.min(Math.max(focusedIndexRef.current, 0), names.length - 1);

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        focusTileIndex(nextTileIndexForArrow(event.key as TileArrowKey, from, names.length, columnsRef.current));
        return;
      }
      if (event.key.length === 1 && /[a-z0-9]/i.test(event.key)) {
        const idx = nextTileIndexForLetter(names, event.key, from);
        if (idx !== null) focusTileIndex(idx);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pushDigit, backspace, goBackToTiles, focusTileIndex]);

  const containerClass =
    'fixed inset-0 z-50 flex flex-col items-center overflow-y-auto px-4 py-6 sm:justify-center sm:py-8 ' +
    (fullScreen ? 'bg-charcoal' : 'bg-charcoal/95 backdrop-blur-sm');

  const timeStr = now
    ? now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const dateStr = now
    ? now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : '';

  return (
    <div className={containerClass} role="dialog" aria-modal="true" aria-label={`Unlock ${deviceName}`}>
      <div className={'w-full ' + (selected ? 'max-w-sm' : 'max-w-xl')}>
        {/* Header — logo on a light badge (so it reads on the dark backdrop
            regardless of which logo asset is used), device name, live clock. */}
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cream p-1.5 shadow-sm">
              <Image
                src="/images/logo-black.png"
                alt="HIOC."
                width={480}
                height={291}
                className="h-full w-full object-contain"
              />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-bold text-cream">{deviceName}</p>
              <p className="text-[10px] uppercase tracking-wide text-cream/50">HIOC POS</p>
            </div>
          </div>
          {now ? (
            <div className="shrink-0 text-right leading-tight">
              <p className="font-mono text-sm font-bold tabular-nums text-cream">{timeStr}</p>
              <p className="text-[10px] text-cream/50">{dateStr}</p>
            </div>
          ) : null}
        </div>

        {!selected ? (
          <>
            <h1 className="text-center text-xl font-bold text-cream">Who&apos;s on the till?</h1>

            {operators !== null && operators.length > FILTER_THRESHOLD ? (
              <div className="mt-4">
                <label htmlFor="pin-tile-filter" className="sr-only">
                  Filter staff by name
                </label>
                <input
                  id="pin-tile-filter"
                  type="text"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder="Type a name…"
                  className="w-full rounded-lg border border-cream/20 bg-cream/5 px-3 py-2.5 text-sm text-cream placeholder:text-cream/40 outline-none focus:border-tan"
                />
              </div>
            ) : null}

            {operators === null ? (
              <p className="mt-6 text-center text-sm text-cream/60">Loading…</p>
            ) : operators.length === 0 ? (
              <p className="mt-6 text-center text-sm text-cream/60">
                No one has a PIN set yet — ask the owner to set one under Owner → Staff.
              </p>
            ) : filteredOperators.length === 0 ? (
              <p className="mt-6 text-center text-sm text-cream/60">No one matches &ldquo;{filterQuery}&rdquo;.</p>
            ) : (
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {filteredOperators.map((op, idx) => (
                  <button
                    key={op.id}
                    ref={(el) => {
                      tileRefs.current[idx] = el;
                    }}
                    type="button"
                    tabIndex={idx === focusedIndex ? 0 : -1}
                    aria-label={`Sign in as ${op.name}`}
                    onFocus={() => setFocusedIndex(idx)}
                    onClick={() => pickOperator(op, idx)}
                    className="flex min-h-[88px] flex-col items-center justify-center gap-2.5 rounded-xl border border-cream/15 bg-cream/5 px-3 py-5 text-cream transition-colors hover:bg-cream/10 active:bg-cream/15"
                  >
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-tan text-lg font-bold text-charcoal">
                      {initialsFor(op.name)}
                    </span>
                    <span className="max-w-full truncate text-base font-bold">{op.name}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-8 text-center">
              <a href="/staff/login?classic=1" className="text-sm font-bold text-tan underline underline-offset-2 hover:text-tan/80">
                Sign in with account
              </a>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-center text-xl font-bold text-cream">{selected.name}</h1>
            <p className="mt-1 text-center text-sm text-cream/60">Enter your PIN</p>

            <div key={shakeToken} className={'mt-5 flex justify-center gap-3' + (shakeToken > 0 ? ' animate-shake' : '')}>
              {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                <span
                  key={i}
                  className={
                    'h-4 w-4 rounded-full border-2 ' +
                    (i < pin.length ? 'border-tan bg-tan' : 'border-cream/30 bg-transparent')
                  }
                />
              ))}
            </div>

            {error ? (
              <p role="alert" className="mt-3 text-center text-sm font-bold text-red-300">
                {error}
              </p>
            ) : null}

            <div className="mt-6 grid grid-cols-3 gap-3">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button
                  key={d}
                  type="button"
                  disabled={submitting}
                  onClick={() => pushDigit(d)}
                  className="min-h-[64px] min-w-[64px] rounded-lg bg-cream/10 font-mono text-2xl tabular-nums text-cream transition-transform duration-100 hover:bg-cream/20 active:scale-95 active:bg-cream/25 disabled:opacity-50 disabled:active:scale-100"
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                onClick={goBackToTiles}
                disabled={submitting}
                className="min-h-[64px] rounded-lg text-sm font-bold text-cream/70 transition-colors hover:text-cream disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => pushDigit('0')}
                className="min-h-[64px] min-w-[64px] rounded-lg bg-cream/10 font-mono text-2xl tabular-nums text-cream transition-transform duration-100 hover:bg-cream/20 active:scale-95 active:bg-cream/25 disabled:opacity-50 disabled:active:scale-100"
              >
                0
              </button>
              <button
                type="button"
                onClick={backspace}
                disabled={submitting || pin.length === 0}
                aria-label="Backspace"
                className="min-h-[64px] rounded-lg text-lg font-bold text-cream/70 transition-colors hover:text-cream disabled:opacity-30"
              >
                ⌫
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
