// SET-1 bugfix — the Printers & cash drawer settings screen's Ticket
// routing / Paper & cutting / Cash drawer sections used to build each
// change's `next` list from the `printers` React prop, which only updates
// once bridge.printers.save() resolves. Two quick toggles fired before that
// promise settled both derived from the same stale list, so the second save
// silently clobbered the first, and neither toggle visually flipped until
// its IPC call returned.
//
// This queue fixes both halves of that, and is deliberately framework-free
// (no React) so the ordering/staleness logic is unit-testable without
// mocking a component — see tests/saveQueue.test.ts:
//
//  - enqueue() applies the updater to the latest known value SYNCHRONOUSLY,
//    before any I/O, so the caller can render the result immediately
//    (optimistic update) and a second enqueue() right after the first sees
//    the first's result as `prev`, never a stale snapshot.
//  - The actual save() calls are chained one after another (`tail`), so they
//    reach the caller's I/O in the exact order enqueue() was called, never
//    out of order and never overlapping.
//
// Because each save() call in this app always overwrites the WHOLE list
// (never a diff), this also self-heals an earlier failed save: if update A
// fails but a later update B (built on top of A's optimistic result) then
// succeeds, B's write already contains A's change, so it ends up persisted
// anyway. Only a failure with no further enqueue after it needs an explicit
// recovery — the caller's onSettled sees `status: 'error'` for that case and
// is expected to reload the authoritative list and surface the error.
export interface SaveQueueResult<T> {
  status: 'saved' | 'error';
  value: T;
  error?: unknown;
}

export class SaveQueue<T> {
  private latest: T;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    initial: T,
    private readonly save: (value: T) => Promise<void>,
  ) {
    this.latest = initial;
  }

  /** The most recently enqueued value — what the NEXT enqueue()'s updater
   * receives as `prev`, regardless of whether earlier saves have resolved. */
  get current(): T {
    return this.latest;
  }

  /** Replaces the queue's known-good value without going through save() —
   * for the initial load, for keeping this queue in sync with a save made
   * outside it (e.g. the Add/Edit printer form's own explicit save), and for
   * resetting to a fresh list reloaded after a failed autosave. Does not
   * affect saves already chained onto `tail`. */
  reset(value: T): void {
    this.latest = value;
  }

  /**
   * Applies `updater` to the latest known value, updates it immediately, and
   * queues the actual save behind whatever is already in flight. Returns the
   * new value so the caller can render it right away, before the save
   * settles. `onSettled` fires once THIS save resolves or rejects, in the
   * order `enqueue()` was called — never for a later call's result.
   */
  enqueue(updater: (prev: T) => T, onSettled: (result: SaveQueueResult<T>) => void): T {
    const next = updater(this.latest);
    this.latest = next;
    this.tail = this.tail.then(() =>
      this.save(next).then(
        () => onSettled({ status: 'saved', value: next }),
        (error) => onSettled({ status: 'error', value: next, error }),
      ),
    );
    return next;
  }
}
