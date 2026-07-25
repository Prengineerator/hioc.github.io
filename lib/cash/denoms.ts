// Pure cash-drawer math (OPS-2). Denomination → total, expected cash, and
// over/short — ALL server-authoritative. The UI mirrors these live for the
// counting staff, but the server recomputes every stored figure from the raw
// denomination counts; a client-sent total is never trusted (§5.2 guardrail).

import type { CashDenoms } from '@/lib/types';

// One entry per row of the counting grid, in the order it is displayed.
//  - kind 'note'  → the staff enter a COUNT; the row contributes value × count.
//  - kind 'amount'→ coins are mixed, so the staff enter a lump ₹ figure; the row
//    contributes that figure directly (value = 1, so the same value × n math
//    holds and denomsTotalInr stays a single uniform loop).
export interface DenomConfig {
  key: string; // the CashDenoms record key
  label: string; // grid label, e.g. '₹500'
  value: number; // face value in ₹ (1 for the coins amount bucket)
  kind: 'note' | 'amount';
}

// The denomination set per docs/PHASE-3-SPEC.md OPS-2: ₹500/200/100/50/20/10
// notes entered as counts, plus a single "coins" bucket entered as a ₹ amount.
export const DENOMINATIONS: readonly DenomConfig[] = [
  { key: '500', label: '₹500', value: 500, kind: 'note' },
  { key: '200', label: '₹200', value: 200, kind: 'note' },
  { key: '100', label: '₹100', value: 100, kind: 'note' },
  { key: '50', label: '₹50', value: 50, kind: 'note' },
  { key: '20', label: '₹20', value: 20, kind: 'note' },
  { key: '10', label: '₹10', value: 10, kind: 'note' },
  { key: 'coins', label: 'Coins (₹)', value: 1, kind: 'amount' },
];

// Coerce one raw grid entry to a non-negative integer (a count, or a ₹ amount
// for the coins bucket). Garbage / negatives / fractions floor to a safe value.
function safeCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * The authoritative rupee total of a denomination map:
 *   500·c500 + 200·c200 + 100·c100 + 50·c50 + 20·c20 + 10·c10 + coins
 * Only the DENOMINATIONS keys are counted, so unknown keys (e.g. a stray
 * "2000") never inflate the drawer. Always computed server-side.
 */
export function denomsTotalInr(denoms: CashDenoms | null | undefined): number {
  if (!denoms || typeof denoms !== 'object') return 0;
  let total = 0;
  for (const d of DENOMINATIONS) {
    total += d.value * safeCount(denoms[d.key]);
  }
  return total;
}

/**
 * Normalises a raw denomination map from the client to exactly the known keys,
 * each a non-negative integer — what we persist in opening_denoms/closing_denoms
 * so the stored jsonb can always be re-totalled to the stored *_total_inr.
 */
export function sanitizeDenoms(denoms: unknown): CashDenoms {
  const out: CashDenoms = {};
  const src = (denoms && typeof denoms === 'object' ? denoms : {}) as Record<string, unknown>;
  for (const d of DENOMINATIONS) {
    out[d.key] = safeCount(src[d.key]);
  }
  return out;
}

/**
 * Expected cash in the drawer at close:
 *   opening float + Σ cash settles − Σ cash refunds
 * (online/UPI-gateway money never touches the drawer — OPS-2). Kept pure so it
 * is trivially unit-tested; the route feeds it the three DB-derived figures.
 */
export function expectedCashInr(
  openingTotalInr: number,
  cashSettlesInr: number,
  cashRefundsInr: number,
): number {
  return openingTotalInr + cashSettlesInr - cashRefundsInr;
}

// Signed variance: positive = drawer over, negative = drawer short.
export function overShortInr(countedTotalInr: number, expectedCashInr: number): number {
  return countedTotalInr - expectedCashInr;
}
