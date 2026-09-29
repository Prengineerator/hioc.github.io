// Points expiry maths — pure, so the rule is testable without a database.
//
// FIFO: the oldest credits are spent first. Every negative row (redeem,
// negative reverse/adjust, and earlier 'expire' rows) is a debit against the
// credit pool, so:
//
//   expiring = max(0, sum(credits older than cutoff) − sum(|debits|))
//
// Counting prior 'expire' rows as debits is what makes a re-run a no-op: the
// points already written off are "spent" and can't expire twice. Capped at the
// current balance so a user can never be pushed below zero.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpiryRow {
  points: number;
  created_at: string;
}

/** Credits created before this instant are eligible to expire; null = never expire. */
export function expiryCutoff(now: Date, days: number): Date | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() - days * DAY_MS);
}

export function pointsToExpire(rows: ExpiryRow[], cutoff: Date): number {
  const cutoffMs = cutoff.getTime();
  let oldCredits = 0;
  let debits = 0;
  let balance = 0;

  for (const row of rows) {
    balance += row.points;
    if (row.points > 0) {
      if (new Date(row.created_at).getTime() < cutoffMs) oldCredits += row.points;
    } else {
      debits += -row.points;
    }
  }

  return Math.max(0, Math.floor(Math.min(oldCredits - debits, balance)));
}
