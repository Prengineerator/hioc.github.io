'use client';

// Denomination counting grid (OPS-2). A controlled count/amount input per
// denomination with a LIVE per-row subtotal and grand total. The total is
// DISPLAY-ONLY — the server recomputes it authoritatively from the same denom
// map on open/close (§5.2); this just mirrors it for the counting staff.

import { DENOMINATIONS, denomsTotalInr } from '@/lib/cash/denoms';
import type { CashDenoms } from '@/lib/types';

export function CashDayDenomGrid({
  denoms,
  onChange,
  disabled,
}: {
  denoms: CashDenoms;
  onChange: (next: CashDenoms) => void;
  disabled?: boolean;
}) {
  const total = denomsTotalInr(denoms);

  const setKey = (key: string, raw: string) => {
    const n = Math.max(0, Math.floor(Number(raw)));
    onChange({ ...denoms, [key]: Number.isFinite(n) ? n : 0 });
  };

  return (
    <div className="rounded-md border border-[#e5e5e5] bg-cream">
      <div className="grid grid-cols-[1fr_5rem_6rem] items-center gap-2 border-b border-[#e5e5e5] px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-muted">
        <span>Denomination</span>
        <span className="text-right">{'Count / ₹'}</span>
        <span className="text-right">Subtotal</span>
      </div>
      <ul>
        {DENOMINATIONS.map((d) => {
          const count = Math.max(0, Math.floor(Number(denoms[d.key]) || 0));
          const subtotal = d.value * count;
          return (
            <li
              key={d.key}
              className="grid grid-cols-[1fr_5rem_6rem] items-center gap-2 border-b border-[#f0ece6] px-3 py-2 last:border-b-0"
            >
              <span className="text-sm font-medium text-charcoal">
                {d.label}
                {d.kind === 'amount' ? (
                  <span className="ml-1 text-[11px] font-normal text-muted">(lump ₹)</span>
                ) : null}
              </span>
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                disabled={disabled}
                value={denoms[d.key] ? String(denoms[d.key]) : ''}
                onChange={(e) => setKey(d.key, e.target.value)}
                placeholder="0"
                className="w-full rounded-md border border-[#e5e5e5] px-2 py-1.5 text-right text-sm tabular-nums focus:border-tan focus:outline-none disabled:bg-[#f6efe9] disabled:text-muted"
                aria-label={d.kind === 'amount' ? `${d.label} amount` : `${d.label} count`}
              />
              <span className="text-right text-sm tabular-nums text-muted">₹{subtotal}</span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between border-t border-[#e5e5e5] px-3 py-2.5">
        <span className="text-sm font-bold text-charcoal">Total counted</span>
        <span className="text-lg font-bold tabular-nums text-charcoal">₹{total}</span>
      </div>
    </div>
  );
}
