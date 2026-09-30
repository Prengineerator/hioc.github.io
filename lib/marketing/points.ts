// "Points expiring soon" — the maths behind the points_expiring playbook
// (spec §1.3). Pure, and built on lib/loyalty/expiry.ts UNCHANGED: the FIFO rule
// that decides which points a real expiry run would write off is the same rule
// that decides which points we warn about, so the two can never disagree.
//
// Loyalty points expire FIFO `expiryDays` after they are earned. The points that
// will be gone within the next `k` days are exactly the ones a real expiry run
// would write off if it ran `k` days from now — i.e. pointsToExpire with the
// cutoff pushed `k` days into the future.
//
// One honest caveat, deliberate: credits that are ALREADY past their expiry but
// which the nightly expire job has not written off yet are counted here too.
// They are still in the customer's balance and still spendable, so warning about
// them is true — but it means expiryDateFor can return a date in the past. The
// contact-stats builder clamps that to "today" before it goes into a message.

import { expiryCutoff, pointsToExpire, type ExpiryRow } from '@/lib/loyalty/expiry';
import { DAY_MS } from './ist';

/**
 * Whole points that will expire within the next `k` days.
 *
 * `rows` is the customer's FULL ledger (credits and debits, including earlier
 * 'expire' rows, which count as spent); `expiryDays` is loyalty_config
 * .points_expiry_days. 0 when expiry is off (expiryDays ≤ 0) or nothing is due.
 */
export function expiringWithin(rows: ExpiryRow[], now: Date, expiryDays: number, k: number): number {
  if (!Number.isFinite(k) || k < 0) return 0;
  const cutoff = expiryCutoff(new Date(now.getTime() + k * DAY_MS), expiryDays);
  if (!cutoff) return 0;
  return pointsToExpire(rows, cutoff);
}

/**
 * The instant the customer's OLDEST unspent points expire: that credit's
 * created_at + `expiryDays`. This is the date shown in the message.
 *
 * Redemptions and earlier expiries are debits that consume credits oldest-first,
 * so the oldest credit that still has points left is the next to go. null when
 * expiry is off or there is nothing unspent.
 */
export function expiryDateFor(rows: ExpiryRow[], expiryDays: number): Date | null {
  if (!Number.isFinite(expiryDays) || expiryDays <= 0) return null;

  let debits = 0;
  const credits: { at: number; points: number }[] = [];
  for (const row of rows) {
    if (row.points > 0) credits.push({ at: new Date(row.created_at).getTime(), points: row.points });
    else debits += -row.points;
  }
  credits.sort((a, b) => a.at - b.at);

  for (const credit of credits) {
    if (!Number.isFinite(credit.at)) continue;
    const remaining = credit.points - debits;
    if (remaining > 0) return new Date(credit.at + expiryDays * DAY_MS);
    debits -= credit.points; // fully consumed; carry the rest of the debits to the next credit
  }
  return null;
}

/** The current spendable balance: the ledger sum, never below zero. */
export function pointsBalance(rows: ExpiryRow[]): number {
  let sum = 0;
  for (const row of rows) sum += row.points;
  return Math.max(0, Math.floor(sum));
}
