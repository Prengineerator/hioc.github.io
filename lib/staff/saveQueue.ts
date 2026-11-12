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
  /** Bumped by every enqueue(), so a resync() can tell it was overtaken. */
  private version = 0;

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

  /** Replaces the queue's known-good value without going through save().
   * Does not wait for (or affect) saves already chained onto `tail` — a value
   * read while one of those is in flight is stale the moment it lands, so a
   * reload from storage should use resync() instead. */
  reset(value: T): void {
    this.latest = value;
  }

  /**
   * Reloads the authoritative value — for the initial load and after a failed
   * save — but only once every save already queued has settled, and before any
   * save queued after it starts. A plain reset() in that window raced the
   * in-flight write: the screen showed (and the next change built on) a list
   * that write was about to replace, and the next save then overwrote it.
   *
   * Resolves with the loaded value, which is now `current`; or with null when
   * an enqueue() arrived while it waited — that newer change is already built
   * on `current` and its own save will write the whole value. Rejects when
   * `load` does (the queue carries on regardless).
   */
  resync(load: () => Promise<T>): Promise<T | null> {
    const asked = this.version;
    const run = this.tail.then(load).then((value) => {
      if (this.version !== asked) return null;
      this.latest = value;
      return value;
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    this.version += 1;
    this.tail = this.tail.then(() =>
      this.save(next).then(
        () => onSettled({ status: 'saved', value: next }),
        (error) => onSettled({ status: 'error', value: next, error }),
      ),
    );
    return next;
  }
}
