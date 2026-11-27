// A read that gives up. `fetch` has no timeout of its own, so a request that
// stalls on flaky cafe wifi used to leave a POS screen on "Loading…" for good —
// to the counter, a hung machine. Every background READ on the POS goes through
// this: after the timeout it fails like any other network error, the screen
// keeps what it already has, and the next refresh (realtime, poll, the Refresh
// button) tries again.
//
// Reads only. A write (placing an order, settling) must never be cut off from
// the client side while the server may still be committing it; those keep their
// own idempotency and error handling.

/** Long enough for a cold function on a slow connection; short enough to read as "stuck". */
export const POS_READ_TIMEOUT_MS = 12_000;

export function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = POS_READ_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const outer = init.signal;
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  });
}
