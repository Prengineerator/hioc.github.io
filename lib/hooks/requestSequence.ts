// Ordering for overlapping requests on a customer screen, so a slow answer can
// never overwrite a newer one. Pure (no React): a component holds one in a ref.
//
// Two rules, for two kinds of screen:
//
//   latestOnly()     only the most recently STARTED request may touch the
//                    screen. For a request the customer asked for (a tab, a
//                    page, a set of answers): starting another one means they
//                    changed their mind, so the first answer is for something
//                    no longer on screen. invalidate() drops whatever is in
//                    flight without starting anything (e.g. the input was cleared).
//
//   newestApplied()  an answer may touch the screen unless one from a LATER
//                    request already has. For a refresh that several things
//                    trigger at once (a realtime ping, a poll, an action): every
//                    answer is the same question asked at a different moment,
//                    so the newest one that has arrived wins — and a steady
//                    stream of refreshes can't starve the screen the way
//                    latestOnly() would.
//
// The repo did this inline before (a `seq` ref compared after each await — see
// components/checkout/PairsWellWith.tsx); this is that, once, with a name.

export interface LatestOnly {
  /** Call when a request starts; keep the id for when it answers. */
  begin(): number;
  /** May the request with this id still update the screen? */
  isCurrent(id: number): boolean;
  /** Drop everything in flight without starting anything new. */
  invalidate(): void;
}

export function latestOnly(): LatestOnly {
  let current = 0;
  return {
    begin: () => ++current,
    isCurrent: (id) => id === current,
    invalidate: () => {
      current += 1;
    },
  };
}

export interface NewestApplied {
  /** Call when a request starts; keep the id for when it answers. */
  begin(): number;
  /**
   * Call when it answers. True: apply it (and it becomes the newest applied).
   * False: a later request has already been applied, so this one is stale.
   */
  accept(id: number): boolean;
}

export function newestApplied(): NewestApplied {
  let started = 0;
  let applied = 0;
  return {
    begin: () => ++started,
    accept: (id) => {
      if (id <= applied) return false;
      applied = id;
      return true;
    },
  };
}
