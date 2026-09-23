'use client';

// Denomination counting grid (OPS-2, extended by CC-3 for the 9-row 2026-09
// cash-count rules). A controlled count input per denomination with a LIVE
// per-row subtotal and grand total. The total is DISPLAY-ONLY — the server
// recomputes it authoritatively from the same denom map every time (§5.2
// guardrail); this just mirrors it for the counting staff.
//
// Rows are grouped "Notes" (₹500–₹10) and "Coins" (₹5, ₹2, ₹1) per the owner's
// 2026-09 decision (CC-D2) — ₹20/₹10 exist as both notes and coins, but they
// live in the Notes group here; the staffer just counts what's in the drawer.
// Big tap targets (inputs ≥44px tall) so this is usable one-handed at 360px.

import type { DenomConfig } from '@/lib/cash/denoms';
import { DENOMINATIONS, LEGACY_COINS_KEY, denomsTotalInr } from '@/lib/cash/denoms';
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
  const notes = DENOMINATIONS.filter((d) => d.value >= 10);
  const coins = DENOMINATIONS.filter((d) => d.value < 10);
  // Pre-2026-09 rows stored coins as one lump ₹ amount (lib/cash/denoms.ts,
  // LEGACY_COINS_KEY). It is never entered any more, but a historical denoms
  // map that still carries it must show it — read-only — so the total on
  // screen matches what was actually recorded.
  const legacyCoinsInr = Math.max(0, Math.floor(Number(denoms[LEGACY_COINS_KEY]) || 0));

  const setKey = (key: string, raw: string) => {
    const n = Math.max(0, Math.floor(Number(raw)));
    onChange({ ...denoms, [key]: Number.isFinite(n) ? n : 0 });
  };

  return (
    <div className="rounded-md border border-[#e5e5e5] bg-cream">
      <div className="grid grid-cols-[1fr_6rem_6rem] items-center gap-2 border-b border-[#e5e5e5] px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-muted">
        <span>Denomination</span>
        <span className="text-right">Count</span>
        <span className="text-right">Subtotal</span>
      </div>

      <DenomGroup label="Notes" rows={notes} denoms={denoms} onSet={setKey} disabled={disabled} />
      <DenomGroup label="Coins" rows={coins} denoms={denoms} onSet={setKey} disabled={disabled} />

      {legacyCoinsInr > 0 ? (
        <div className="flex items-center justify-between border-t border-[#f0ece6] bg-[#f6efe9] px-3 py-2.5">
          <span className="text-sm text-muted">Coins (old lump sum)</span>
          <span className="text-sm font-bold tabular-nums text-muted">₹{legacyCoinsInr}</span>
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-[#e5e5e5] px-3 py-3">
        <span className="text-sm font-bold text-charcoal">Total counted</span>
        <span className="text-xl font-bold tabular-nums text-charcoal">₹{total}</span>
      </div>
    </div>
  );
}

function DenomGroup({
  label,
  rows,
  denoms,
  onSet,
  disabled,
}: {
  label: string;
  rows: readonly DenomConfig[];
  denoms: CashDenoms;
  onSet: (key: string, raw: string) => void;
  disabled?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="border-b border-[#e5e5e5] bg-[#f6efe9] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
        {label}
      </div>
      <ul>
        {rows.map((d) => {
          const count = Math.max(0, Math.floor(Number(denoms[d.key]) || 0));
          const subtotal = d.value * count;
          return (
            <li
              key={d.key}
              className="grid grid-cols-[1fr_6rem_6rem] items-center gap-2 border-b border-[#f0ece6] px-3 py-2 last:border-b-0"
            >
              <span className="text-sm font-medium text-charcoal">{d.label}</span>
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                disabled={disabled}
                value={denoms[d.key] ? String(denoms[d.key]) : ''}
                onChange={(e) => onSet(d.key, e.target.value)}
                placeholder="0"
                className="min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-2 py-2.5 text-right text-base tabular-nums focus:border-tan focus:outline-none disabled:bg-[#f6efe9] disabled:text-muted"
                aria-label={`${d.label} count`}
              />
              <span className="text-right text-sm tabular-nums text-muted">₹{subtotal}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
