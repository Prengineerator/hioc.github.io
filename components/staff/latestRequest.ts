// "Only the newest answer counts" for a screen that refetches the same list
// from several places (a poll, a realtime event, after its own write). Without
// it, a fetch that STARTED before a write but ANSWERED after it puts the old
// rows back: a bill settled a moment ago reappears as unpaid, a closed cash day
// as open.
//
// Every fetch takes a ticket; its answer is applied only while the ticket is
// still the latest. A write calls `invalidate()` the moment it lands, so every
// fetch already in flight — started before it — is ignored, and the write's own
// refetch (started after) is the one that counts.
//
// Pure (no React), so the rule is unit-tested; a component keeps one in a ref.

export interface LatestRequest {
  /** Start a request; call the returned function before applying its answer. */
  begin(): () => boolean;
  /** Everything in flight is now stale (a write just changed what it would read). */
  invalidate(): void;
}

export function createLatestRequest(): LatestRequest {
  let current = 0;
  return {
    begin() {
      const ticket = ++current;
      return () => ticket === current;
    },
    invalidate() {
      current += 1;
    },
  };
}
