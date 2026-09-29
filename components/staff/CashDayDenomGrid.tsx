'use client';

// Denomination counting grid (OPS-2, extended by CC-3 for the 9-row 2026-09
// cash-count rules, refined 2026-09-29 for the cash day handover). One row per
// denomination: − / + steppers around a numeric input, count × value = a live
// subtotal, and a sticky running total with "Clear". The total is DISPLAY-ONLY
// — the server recomputes it authoritatively from the same denom map every time
// (§5.2 guardrail); this just mirrors it for the counting staff.
//
// Optional `expected` adds a Match column: what should be there per
// denomination and the count difference (✓ / +2 / −1), green when equal and red
// otherwise — used to compare the opening float with the float left at the last
// close. Optional `max` caps each row (the float left can't exceed what was
// counted).
//
// Built for a touch tablet at the counter: every tap target is ≥44px, Enter (or
// the keyboard's Next) moves to the next row, and Tab skips the steppers so it
// goes straight from one count to the next.
//
// Rows are grouped "Notes" (₹500–₹10) and "Coins" (₹5, ₹2, ₹1) per the owner's
// 2026-09 decision (CC-D2) — ₹20/₹10 exist as both notes and coins, but they
// live in the Notes group here; the staffer just counts what's in the drawer.

import { useRef } from 'react';
import type { DenomConfig } from '@/lib/cash/denoms';
import { DENOMINATIONS, LEGACY_COINS_KEY, denomsTotalInr } from '@/lib/cash/denoms';
import { formatCountDiff } from '@/lib/cash/day';
import type { CashDenoms } from '@/lib/types';

const MAX_COUNT = 99999; // a sanity ceiling so a stuck key can't make a silly total

function readCount(denoms: CashDenoms, key: string): number {
  const n = Number(denoms[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function CashDayDenomGrid({
  denoms,
  onChange,
  disabled,
  expected,
  expectedLabel = 'Expected',
  max,
  totalLabel = 'Total counted',
}: {
  denoms: CashDenoms;
  onChange: (next: CashDenoms) => void;
  disabled?: boolean;
  /** When set, adds the Match column against these per-denomination counts. */
  expected?: CashDenoms;
  expectedLabel?: string;
  /** When set, no row can exceed its count here. */
  max?: CashDenoms;
  totalLabel?: string;
}) {
  const total = denomsTotalInr(denoms);
  const notes = DENOMINATIONS.filter((d) => d.value >= 10);
  const coins = DENOMINATIONS.filter((d) => d.value < 10);
  // Pre-2026-09 rows stored coins as one lump ₹ amount (lib/cash/denoms.ts,
  // LEGACY_COINS_KEY). It is never entered any more, but a historical denoms
  // map that still carries it must show it — read-only — so the total on
  // screen matches what was actually recorded.
  const legacyCoinsInr = Math.max(0, Math.floor(Number(denoms[LEGACY_COINS_KEY]) || 0));

  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const setCount = (key: string, next: number) => {
    const cap = max ? readCount(max, key) : MAX_COUNT;
    const n = Math.min(Math.max(0, Math.floor(next)), cap, MAX_COUNT);
    onChange({ ...denoms, [key]: Number.isFinite(n) ? n : 0 });
  };

  // Enter → the next row's input (the last row just blurs, dismissing the
  // tablet keyboard). Tab already lands on the next input because the steppers
  // are out of the tab order.
  const focusNext = (key: string) => {
    const i = DENOMINATIONS.findIndex((d) => d.key === key);
    const next = DENOMINATIONS[i + 1];
    const el = next ? inputRefs.current[next.key] : inputRefs.current[key];
    if (next) {
      el?.focus();
      el?.select();
    } else {
      el?.blur();
    }
  };

  const rowProps = {
    denoms,
    expected,
    max,
    disabled,
    onSet: setCount,
    onEnter: focusNext,
    register: (key: string, el: HTMLInputElement | null) => {
      inputRefs.current[key] = el;
    },
  };

  return (
    <div className="rounded-md border border-line bg-cream">
      <div
        className={
          'hidden items-center gap-2 border-b border-line px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-muted sm:grid ' +
          (expected ? 'sm:grid-cols-[3.5rem_1fr_4.5rem_7rem]' : 'sm:grid-cols-[3.5rem_1fr_4.5rem]')
        }
      >
        <span>Note / coin</span>
        <span className="text-center">Count</span>
        <span className="text-right">Subtotal</span>
        {expected ? <span className="text-right">Match ({expectedLabel.toLowerCase()})</span> : null}
      </div>

      <DenomGroup label="Notes" rows={notes} {...rowProps} />
      <DenomGroup label="Coins" rows={coins} {...rowProps} />

      {legacyCoinsInr > 0 ? (
        <div className="flex items-center justify-between border-t border-[#f0ece6] bg-surface px-3 py-2.5">
          <span className="text-sm text-muted">Coins (old lump sum)</span>
          <span className="text-sm font-bold tabular-nums text-muted">₹{legacyCoinsInr}</span>
        </div>
      ) : null}

      {/* Sticky so the running total stays in view while a long grid scrolls on a
          small screen (inside a sheet it sticks to the sheet's scroll area). */}
      <div className="sticky bottom-0 z-10 rounded-b-md border-t border-line bg-cream/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-sm font-bold text-charcoal">{totalLabel}</span>
            <span className="ml-3 text-xl font-bold tabular-nums text-charcoal">₹{total}</span>
          </div>
          <button
            type="button"
            onClick={() => onChange({})}
            disabled={disabled || total === 0}
            className="min-h-[44px] rounded-md border border-[#ddd] px-4 text-sm font-bold text-charcoal transition-colors hover:bg-white disabled:opacity-40"
          >
            Clear
          </button>
        </div>
        {expected ? (
          <div className="mt-1 flex items-center justify-between text-xs text-muted">
            <span>
              {expectedLabel} ₹{denomsTotalInr(expected)}
            </span>
            <TotalDiff diff={total - denomsTotalInr(expected)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TotalDiff({ diff }: { diff: number }) {
  if (diff === 0) return <span className="font-bold text-[#2f6b38]">Matches ✓</span>;
  return (
    <span className="font-bold text-red-600">
      {diff > 0 ? '+' : '−'}₹{Math.abs(diff)} {diff > 0 ? 'more' : 'less'}
    </span>
  );
}

function DenomGroup({
  label,
  rows,
  denoms,
  expected,
  max,
  disabled,
  onSet,
  onEnter,
  register,
}: {
  label: string;
  rows: readonly DenomConfig[];
  denoms: CashDenoms;
  expected?: CashDenoms;
  max?: CashDenoms;
  disabled?: boolean;
  onSet: (key: string, next: number) => void;
  onEnter: (key: string) => void;
  register: (key: string, el: HTMLInputElement | null) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="border-b border-line bg-surface px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
        {label}
      </div>
      <ul>
        {rows.map((d) => {
          const count = readCount(denoms, d.key);
          const cap = max ? readCount(max, d.key) : MAX_COUNT;
          const subtotal = d.value * count;
          const expectedCount = expected ? readCount(expected, d.key) : 0;
          const diff = count - expectedCount;
          return (
            <li
              key={d.key}
              className={
                'grid items-center gap-x-2 gap-y-0.5 border-b border-[#f0ece6] px-3 py-1.5 last:border-b-0 ' +
                (expected ? 'grid-cols-[3.5rem_1fr_4.5rem] sm:grid-cols-[3.5rem_1fr_4.5rem_7rem]' : 'grid-cols-[3.5rem_1fr_4.5rem]')
              }
            >
              <span className="text-sm font-bold text-charcoal">{d.label}</span>

              <div className="flex items-center justify-center gap-1.5">
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={disabled || count <= 0}
                  onClick={() => onSet(d.key, count - 1)}
                  aria-label={`One fewer ${d.label}`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-[#ddd] bg-white text-xl font-bold leading-none text-charcoal transition-colors active:bg-surface disabled:opacity-35"
                >
                  −
                </button>
                <input
                  ref={(el) => register(d.key, el)}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  enterKeyHint="next"
                  autoComplete="off"
                  disabled={disabled}
                  value={count ? String(count) : ''}
                  onChange={(e) => onSet(d.key, Number(e.target.value.replace(/\D/g, '')) || 0)}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onEnter(d.key);
                    }
                  }}
                  placeholder="0"
                  className="h-11 w-16 rounded-md border border-line bg-white px-1 text-center text-base font-bold tabular-nums focus:border-tan focus:outline-none disabled:bg-surface disabled:text-muted"
                  aria-label={`${d.label} count`}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={disabled || count >= cap}
                  onClick={() => onSet(d.key, count + 1)}
                  aria-label={`One more ${d.label}`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-[#ddd] bg-white text-xl font-bold leading-none text-charcoal transition-colors active:bg-surface disabled:opacity-35"
                >
                  +
                </button>
              </div>

              <span className="text-right text-sm tabular-nums text-muted">₹{subtotal}</span>

              {expected ? (
                <span className="col-span-3 flex items-center justify-end gap-2 text-xs tabular-nums sm:col-span-1">
                  <span className="text-muted">
                    {expectedCount} expected
                  </span>
                  <span
                    className={
                      'min-w-[2.25rem] rounded px-1.5 py-0.5 text-center font-bold ' +
                      (diff === 0 ? 'bg-[#e6f2e8] text-[#2f6b38]' : 'bg-red-50 text-red-600')
                    }
                    aria-label={diff === 0 ? 'Matches' : `${Math.abs(diff)} ${diff > 0 ? 'more' : 'fewer'} than expected`}
                  >
                    {formatCountDiff(diff)}
                  </span>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
