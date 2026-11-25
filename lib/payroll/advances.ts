// Salary advances — the one place the "what is still owed" balance is worked out.
//
// Pure. Outstanding for a staffer in month M is
//
//   Σ advances (not removed, given on or before the last day of M)
//   − Σ advance_inr already taken in ANY finalized run line of theirs
//
// clamped at 0. Counting every finalized run (not only earlier months) means an
// advance can never be taken twice, even when months are finalized out of
// order; a reversed run stops counting, so its advance returns to the balance
// with no extra code.

export interface AdvanceFact {
  user_id: string;
  amount_inr: number;
  /** YYYY-MM-DD (IST). */
  given_on: string;
  removed_at?: string | null;
}

export interface TakenFact {
  user_id: string;
  advance_inr: number | null | undefined;
  /** Status of the line's run; only 'finalized' counts. */
  run_status: string;
}

export function outstandingAdvanceInr(params: {
  userId: string;
  /** Last day of the month being worked out, YYYY-MM-DD. */
  monthEnd: string;
  advances: AdvanceFact[];
  taken: TakenFact[];
}): number {
  const { userId, monthEnd, advances, taken } = params;
  let given = 0;
  for (const a of advances) {
    if (a.user_id !== userId || a.removed_at || a.given_on > monthEnd) continue;
    given += a.amount_inr;
  }
  let already = 0;
  for (const t of taken) {
    if (t.user_id !== userId || t.run_status !== 'finalized') continue;
    already += t.advance_inr ?? 0;
  }
  return Math.max(0, given - already);
}

/** Sum of a staffer's live advances dated within [from, to]. */
export function advancesInMonthInr(
  userId: string,
  bounds: { from: string; to: string },
  advances: AdvanceFact[],
): number {
  return advances
    .filter(
      (a) => a.user_id === userId && !a.removed_at && a.given_on >= bounds.from && a.given_on <= bounds.to,
    )
    .reduce((s, a) => s + a.amount_inr, 0);
}

/**
 * An advance is LOCKED once a finalized run COUNTED it: that person has a
 * finalized run ending on or after the advance's date, and the run was
 * finalized at or after the advance was created. An advance added after a
 * month was finalized was never counted by it, so it can still be fixed.
 * Pass only finalized runs (a reversed run counts nothing).
 */
export function isAdvanceCounted(
  advance: { user_id: string; given_on: string; created_at: string },
  finalizedRuns: { user_id: string; period_end: string; finalized_at: string | null }[],
): boolean {
  // Compare instants, not strings: the two timestamps can come back with
  // different precision or offset spellings. An unparseable created_at counts
  // as counted (locked) — refusing a removal is the safe side.
  const createdMs = Date.parse(advance.created_at);
  return finalizedRuns.some(
    (r) =>
      r.user_id === advance.user_id &&
      r.period_end >= advance.given_on &&
      r.finalized_at !== null &&
      (Number.isNaN(createdMs) || Date.parse(r.finalized_at) >= createdMs),
  );
}
